const BookingBuffer = require("../models/BookingBuffer");
const ActiveDriver = require("../models/ActiveDriver");
const Ride = require("../models/Ride");
const { sendToUser, broadcastToRide } = require("./socket");
const { sendPushToUser } = require("./notification");
const {
  calculateDistanceMeters,
  getMvgfciTerminal,
  applyQueuePenalty,
  GRACE_PERIOD_MS,
  DEFAULT_MVGFCI_COORDS,
  DEFAULT_CATCHMENT_RADIUS,
} = require("./terminalQueue");

const OFFER_TIMEOUT_MS = 25000; // 25 seconds
const ACK_TIMEOUT_MS = 6000;    // 6 seconds fast-failover for unreachable devices
const TOTAL_SEARCH_LIFESPAN_MS = 90000; // 90 seconds search window
const MAX_CANDIDATES = 10;
const MAX_SEARCH_DISTANCE_METERS = 10000; // 10km

// In-memory watchdog timers indexed by bufferId string
const activeTimers = new Map();

function clearBufferTimers(bufferIdStr) {
  const existing = activeTimers.get(bufferIdStr);
  if (existing) {
    if (existing.ackTimer) clearTimeout(existing.ackTimer);
    if (existing.offerTimer) clearTimeout(existing.offerTimer);
    activeTimers.delete(bufferIdStr);
  }
}

/**
 * Handles buffer exhaustion when all candidates have been tried or time expired
 */
async function handleExhausted(buffer, reason = "No drivers available") {
  clearBufferTimers(buffer._id.toString());
  try {
    buffer.status = "exhausted";
    buffer.currentCandidate.driverId = null;
    await buffer.save();

    const currentRide = await Ride.findById(buffer.rideId);
    if (currentRide && currentRide.status === "pending") {
      currentRide.status = "cancelled";
      currentRide.currentCandidateDriverId = null;
      await currentRide.save();

      // Notify passenger
      broadcastToRide(currentRide._id, "ride_cancelled", { reason });
      sendToUser(currentRide.passengerId, "ride_cancelled", { reason });
    }
  } catch (err) {
    console.error("[bookingDistributor-handleExhausted-err]", err);
  }
}

/**
 * Enqueues a new ride into the BookingBuffer and starts distribution
 * @param {String|ObjectId} rideId
 */
async function enqueueRide(rideId) {
  try {
    const ride = await Ride.findById(rideId).populate(
      "passengerId",
      "firstName lastName mobileNumber profilePicture"
    );

    if (!ride || ride.status !== "pending") return null;

    // Check if buffer already exists
    let buffer = await BookingBuffer.findOne({ rideId: ride._id });
    if (buffer) {
      if (buffer.status === "distributing") return buffer;
      if (buffer.status === "fulfilled" || buffer.status === "cancelled") return buffer;
    }

    const passengerDetails = {
      firstName: ride.passengerId?.firstName || "Passenger",
      lastName: ride.passengerId?.lastName || "",
      mobileNumber: ride.passengerId?.mobileNumber || "",
      profilePicture: ride.passengerId?.profilePicture || null,
    };

    const bookingData = {
      pickup: ride.pickup,
      dropoff: ride.dropoff,
      fare: ride.fare,
      undiscountedFare: ride.undiscountedFare || ride.fare,
      distanceKm: ride.distanceKm || 0,
      durationMins: ride.durationMins || 0,
      paymentMethod: ride.paymentMethod,
      passengerCount: ride.passengerCount || 1,
      discountCount: ride.discountCount || 0,
      bookingFor: ride.bookingFor || "myself",
      passengerDetails,
    };

    // Query candidates: Check if pickup is within terminal catchment radius
    const now = new Date();
    const terminal = await getMvgfciTerminal();
    const terminalCoords = terminal.location?.coordinates || DEFAULT_MVGFCI_COORDS;
    const catchmentRadius = terminal.catchmentRadiusMeters || DEFAULT_CATCHMENT_RADIUS;
    const pickupCoords = ride.pickup.coordinates.coordinates;
    const distToTerminal = calculateDistanceMeters(pickupCoords, terminalCoords);

    let candidateDrivers = [];

    if (distToTerminal <= catchmentRadius) {
      console.log(
        `[bookingDistributor] Pickup is within ${catchmentRadius}m catchment (${Math.round(distToTerminal)}m) of ${terminal.code}. Prioritizing TODA terminal queue.`
      );

      // Tier 1: Terminal queue drivers sorted by FIFO (enteredTerminalAt ASC)
      const tier1Candidates = await ActiveDriver.find({
        terminalId: terminal.code,
        isOnline: true,
        isBusy: false,
        enteredTerminalAt: { $ne: null },
        driverId: { $nin: ride.ignoredDrivers || [] },
        $or: [
          { reservedUntil: null },
          { reservedUntil: { $lte: now } },
        ],
      }).sort({ enteredTerminalAt: 1 });

      // Filter drivers whose grace period hasn't expired
      const tier1Drivers = tier1Candidates.filter((d) => {
        if (d.leftTerminalAt) {
          const timeOutside = now.getTime() - new Date(d.leftTerminalAt).getTime();
          if (timeOutside > GRACE_PERIOD_MS) return false;
        }
        return true;
      }).slice(0, MAX_CANDIDATES);

      const tier1DriverIds = tier1Drivers.map((d) => d.driverId);

      // Tier 2: Outside / roaming drivers sorted by proximity to pickup
      let tier2Drivers = [];
      const remainingSlots = MAX_CANDIDATES - tier1Drivers.length;
      if (remainingSlots > 0) {
        tier2Drivers = await ActiveDriver.find({
          isOnline: true,
          isBusy: false,
          driverId: { $nin: [...(ride.ignoredDrivers || []), ...tier1DriverIds] },
          $or: [
            { reservedUntil: null },
            { reservedUntil: { $lte: now } },
          ],
          location: {
            $near: {
              $geometry: {
                type: "Point",
                coordinates: pickupCoords,
              },
              $maxDistance: MAX_SEARCH_DISTANCE_METERS,
            },
          },
        }).limit(remainingSlots);
      }

      candidateDrivers = [...tier1Drivers, ...tier2Drivers];
    } else {
      // Standard proximity query when outside catchment
      candidateDrivers = await ActiveDriver.find({
        isOnline: true,
        isBusy: false,
        driverId: { $nin: ride.ignoredDrivers || [] },
        $or: [
          { reservedUntil: null },
          { reservedUntil: { $lte: now } },
        ],
        location: {
          $near: {
            $geometry: {
              type: "Point",
              coordinates: pickupCoords,
            },
            $maxDistance: MAX_SEARCH_DISTANCE_METERS,
          },
        },
      }).limit(MAX_CANDIDATES);
    }

    const candidatePool = candidateDrivers.map((d) => ({
      driverId: d.driverId,
      status: "pending",
    }));

    buffer = await BookingBuffer.create({
      rideId: ride._id,
      passengerId: ride.passengerId._id,
      status: "distributing",
      bookingData,
      candidatePool,
      searchExpiresAt: new Date(Date.now() + TOTAL_SEARCH_LIFESPAN_MS),
    });

    console.log(
      `[bookingDistributor] Ride ${rideId} enqueued into buffer ${buffer._id} with ${candidatePool.length} candidates`
    );

    sendToUser(ride.passengerId._id, "distributor_status", {
      status: "searching",
      totalCandidates: candidatePool.length,
    });

    // Start staged distribution
    distributeNext(buffer._id);

    return buffer;
  } catch (err) {
    console.error("[bookingDistributor-enqueue-err]", err);
    return null;
  }
}

/**
 * Distributes the buffered ride to the next eligible candidate in the pool
 * @param {String|ObjectId} bufferId
 */
async function distributeNext(bufferId) {
  const bufferIdStr = bufferId.toString();
  clearBufferTimers(bufferIdStr);

  try {
    const buffer = await BookingBuffer.findById(bufferId);
    if (!buffer || buffer.status !== "distributing") return;

    // Check overall lifespan
    if (buffer.searchExpiresAt && new Date() >= buffer.searchExpiresAt) {
      await handleExhausted(buffer, "Search expired. No available drivers accepted your request.");
      return;
    }

    // Verify ride is still pending
    const ride = await Ride.findById(buffer.rideId);
    if (!ride || ride.status !== "pending") {
      buffer.status = ride ? ride.status : "cancelled";
      await buffer.save();
      return;
    }

    // Find next pending candidate
    let candidate = buffer.candidatePool.find((c) => c.status === "pending");

    // If candidatePool is exhausted, attempt a refresh query for newly online/free drivers
    if (!candidate) {
      const alreadyConsidered = buffer.candidatePool.map((c) => c.driverId);
      const now = new Date();
      const freshDrivers = await ActiveDriver.find({
        isOnline: true,
        isBusy: false,
        driverId: {
          $nin: [...alreadyConsidered, ...(ride.ignoredDrivers || [])],
        },
        $or: [
          { reservedUntil: null },
          { reservedUntil: { $lte: now } },
        ],
        location: {
          $near: {
            $geometry: {
              type: "Point",
              coordinates: buffer.bookingData.pickup.coordinates.coordinates,
            },
            $maxDistance: MAX_SEARCH_DISTANCE_METERS,
          },
        },
      }).limit(5);

      if (freshDrivers.length > 0) {
        freshDrivers.forEach((d) => {
          buffer.candidatePool.push({
            driverId: d.driverId,
            status: "pending",
          });
        });
        await buffer.save();
        candidate = buffer.candidatePool.find((c) => c.status === "pending");
      }
    }

    // If still no candidates, finalize buffer
    if (!candidate) {
      await handleExhausted(buffer, "No drivers available nearby");
      return;
    }

    const offerExpiresAt = new Date(Date.now() + OFFER_TIMEOUT_MS);

    // Atomically reserve the driver in ActiveDriver
    const reserved = await ActiveDriver.findOneAndUpdate(
      {
        driverId: candidate.driverId,
        isOnline: true,
        isBusy: false,
        $or: [
          { reservedUntil: null },
          { reservedUntil: { $lte: new Date() } },
        ],
      },
      {
        reservedUntil: offerExpiresAt,
        reservedBufferId: buffer._id,
      },
      { new: true }
    );

    if (!reserved) {
      // Driver was claimed by another dispatch or went offline; skip immediately
      candidate.status = "unreachable";
      await buffer.save();
      return distributeNext(bufferId);
    }

    // Update candidate and buffer state
    candidate.status = "offered";
    candidate.offeredAt = new Date();
    buffer.currentCandidate = {
      driverId: candidate.driverId,
      offerExpiresAt,
      acknowledged: false,
      acknowledgedAt: null,
    };
    await buffer.save();

    // Update ride's current candidate pointer
    ride.currentCandidateDriverId = candidate.driverId;
    await ride.save();

    const offerPayload = {
      bufferId: buffer._id,
      rideId: buffer.rideId,
      pickup: buffer.bookingData.pickup,
      dropoff: buffer.bookingData.dropoff,
      fare: buffer.bookingData.fare,
      distanceKm: buffer.bookingData.distanceKm,
      durationMins: buffer.bookingData.durationMins,
      paymentMethod: buffer.bookingData.paymentMethod,
      passengerCount: buffer.bookingData.passengerCount,
      bookingFor: buffer.bookingData.bookingFor,
      passenger: buffer.bookingData.passengerDetails,
      expiresAt: offerExpiresAt,
      timeoutMs: OFFER_TIMEOUT_MS,
    };

    // Emit socket events to driver
    sendToUser(candidate.driverId, "dispatch_offer", offerPayload);
    sendToUser(candidate.driverId, "ride_request", offerPayload); // Backward compatibility

    // Push notification to driver
    sendPushToUser(
      candidate.driverId,
      "New Ride Request",
      "You have a new ride request! Open the app to view and accept.",
      {
        type: "ride_request",
        rideId: buffer.rideId.toString(),
        bufferId: buffer._id.toString(),
      }
    );

    // Update passenger on progress
    const triedCount = buffer.candidatePool.filter((c) => c.status !== "pending").length;
    sendToUser(buffer.passengerId, "distributor_status", {
      status: "contacting_driver",
      attempt: triedCount,
      totalCandidates: buffer.candidatePool.length,
    });

    console.log(
      `[bookingDistributor] Offered buffer ${bufferId} to driver ${candidate.driverId} (expires: ${offerExpiresAt.toISOString()})`
    );

    // 1. Fast-Failover Watchdog: If device doesn't ACK receipt in ACK_TIMEOUT_MS
    const ackTimer = setTimeout(async () => {
      try {
        const freshB = await BookingBuffer.findById(bufferId);
        if (
          freshB &&
          freshB.status === "distributing" &&
          freshB.currentCandidate?.driverId?.toString() === candidate.driverId.toString()
        ) {
          if (!freshB.currentCandidate.acknowledged) {
            console.log(
              `[bookingDistributor] Driver ${candidate.driverId} unacknowledged after ${ACK_TIMEOUT_MS}ms. Fast failover.`
            );
            const cand = freshB.candidatePool.find(
              (c) => c.driverId.toString() === candidate.driverId.toString()
            );
            if (cand) cand.status = "unreachable";
            freshB.currentCandidate.driverId = null;
            await freshB.save();

            // Release driver reservation
            await ActiveDriver.findOneAndUpdate(
              { driverId: candidate.driverId, reservedBufferId: freshB._id },
              { reservedUntil: null, reservedBufferId: null }
            );

            sendToUser(candidate.driverId, "ride_request_expired", {
              rideId: freshB.rideId,
              bufferId: freshB._id,
            });

            distributeNext(bufferId);
          }
        }
      } catch (e) {
        console.error("[bookingDistributor-ackTimer-err]", e);
      }
    }, ACK_TIMEOUT_MS);

    // 2. Full Decision Watchdog: If driver doesn't accept/decline in OFFER_TIMEOUT_MS
    const offerTimer = setTimeout(async () => {
      try {
        const freshB = await BookingBuffer.findById(bufferId);
        if (
          freshB &&
          freshB.status === "distributing" &&
          freshB.currentCandidate?.driverId?.toString() === candidate.driverId.toString()
        ) {
          console.log(
            `[bookingDistributor] Driver ${candidate.driverId} offer timed out after ${OFFER_TIMEOUT_MS}ms.`
          );
          const cand = freshB.candidatePool.find(
            (c) => c.driverId.toString() === candidate.driverId.toString()
          );
          if (cand) cand.status = "timed_out";
          freshB.currentCandidate.driverId = null;
          await freshB.save();

          // Release reservation
          await ActiveDriver.findOneAndUpdate(
            { driverId: candidate.driverId, reservedBufferId: freshB._id },
            { reservedUntil: null, reservedBufferId: null }
          );

          // Add to ignoredDrivers on Ride
          await Ride.findByIdAndUpdate(freshB.rideId, {
            $addToSet: { ignoredDrivers: candidate.driverId },
            currentCandidateDriverId: null,
          });

          // Apply queue penalty if driver was in terminal queue (demote to back of line)
          await applyQueuePenalty(candidate.driverId);

          sendToUser(candidate.driverId, "ride_request_expired", {
            rideId: freshB.rideId,
            bufferId: freshB._id,
          });

          distributeNext(bufferId);
        }
      } catch (e) {
        console.error("[bookingDistributor-offerTimer-err]", e);
      }
    }, OFFER_TIMEOUT_MS);

    activeTimers.set(bufferIdStr, { ackTimer, offerTimer });
  } catch (err) {
    console.error("[bookingDistributor-distributeNext-err]", err);
  }
}

/**
 * Driver app acknowledges receiving the dispatch offer
 * @param {String|ObjectId} bufferId
 * @param {String|ObjectId} driverId
 */
async function acknowledgeOffer(bufferId, driverId) {
  try {
    const buffer = await BookingBuffer.findById(bufferId);
    if (!buffer || buffer.status !== "distributing") {
      return { success: false, message: "Offer is no longer active" };
    }

    if (buffer.currentCandidate?.driverId?.toString() !== driverId.toString()) {
      return { success: false, message: "Offer does not belong to this driver" };
    }

    buffer.currentCandidate.acknowledged = true;
    buffer.currentCandidate.acknowledgedAt = new Date();

    const cand = buffer.candidatePool.find(
      (c) => c.driverId.toString() === driverId.toString()
    );
    if (cand) {
      cand.status = "acknowledged";
      cand.ackAt = new Date();
    }

    await buffer.save();
    return { success: true, message: "Offer acknowledged" };
  } catch (err) {
    console.error("[bookingDistributor-acknowledgeOffer-err]", err);
    return { success: false, message: "Server error" };
  }
}

/**
 * Driver accepts the offer
 * @param {String|ObjectId} bufferId
 * @param {String|ObjectId} driverId
 */
async function acceptOffer(bufferId, driverId) {
  clearBufferTimers(bufferId.toString());
  try {
    const buffer = await BookingBuffer.findOneAndUpdate(
      {
        _id: bufferId,
        status: "distributing",
        "currentCandidate.driverId": driverId,
      },
      {
        status: "fulfilled",
      },
      { new: true }
    );

    if (!buffer) {
      return { success: false, message: "Ride offer has already expired or been cancelled." };
    }

    // Release driver reservation, set isBusy: true, and clear queue status (driver is now on trip)
    await ActiveDriver.findOneAndUpdate(
      { driverId },
      {
        isBusy: true,
        reservedUntil: null,
        reservedBufferId: null,
        enteredTerminalAt: null,
        leftTerminalAt: null,
        terminalId: null,
      }
    );

    // Update Ride
    const ride = await Ride.findById(buffer.rideId);
    if (!ride || ride.status !== "pending") {
      // Revert if ride was somehow cancelled
      await ActiveDriver.findOneAndUpdate({ driverId }, { isBusy: false });
      return { success: false, message: "Ride is no longer available." };
    }

    ride.driverId = driverId;
    ride.status = "driver_assigned";
    if (!ride.cancellationData) ride.cancellationData = {};
    ride.cancellationData.driverAssignedAt = new Date();

    const driverState = await ActiveDriver.findOne({ driverId });
    if (driverState && driverState.location) {
      ride.cancellationData.driverAcceptedLocation = driverState.location;
    }
    await ride.save();

    const populatedRide = await Ride.findById(ride._id)
      .populate("driverId", "firstName lastName mobileNumber profilePicture driverDetails")
      .populate("passengerId", "firstName lastName mobileNumber profilePicture");

    broadcastToRide(ride._id, "ride_accepted", { ride: populatedRide });

    console.log(`[bookingDistributor] Buffer ${bufferId} accepted by driver ${driverId}`);
    return { success: true, ride: populatedRide };
  } catch (err) {
    console.error("[bookingDistributor-acceptOffer-err]", err);
    return { success: false, message: "Server error" };
  }
}

/**
 * Driver declines the offer
 * @param {String|ObjectId} bufferId
 * @param {String|ObjectId} driverId
 */
async function declineOffer(bufferId, driverId) {
  clearBufferTimers(bufferId.toString());
  try {
    const buffer = await BookingBuffer.findById(bufferId);
    if (!buffer || buffer.status !== "distributing") {
      return { success: false, message: "Buffer not active" };
    }

    const cand = buffer.candidatePool.find(
      (c) => c.driverId.toString() === driverId.toString()
    );
    if (cand) {
      cand.status = "declined";
      cand.respondedAt = new Date();
    }
    buffer.currentCandidate.driverId = null;
    await buffer.save();

    // Release reservation
    await ActiveDriver.findOneAndUpdate(
      { driverId, reservedBufferId: buffer._id },
      { reservedUntil: null, reservedBufferId: null }
    );

    // Add driver to ignoredDrivers
    await Ride.findByIdAndUpdate(buffer.rideId, {
      $addToSet: { ignoredDrivers: driverId },
      currentCandidateDriverId: null,
    });

    // Apply queue penalty if driver was in terminal queue (demote to back of line)
    await applyQueuePenalty(driverId);

    console.log(`[bookingDistributor] Buffer ${bufferId} declined by driver ${driverId}. Next candidate...`);

    // Move to next candidate
    distributeNext(bufferId);

    return { success: true, message: "Offer declined" };
  } catch (err) {
    console.error("[bookingDistributor-declineOffer-err]", err);
    return { success: false, message: "Server error" };
  }
}

/**
 * Passenger cancels a ride while buffer is distributing
 * @param {String|ObjectId} rideId
 */
async function cancelBuffer(rideId) {
  try {
    const buffer = await BookingBuffer.findOne({ rideId });
    if (!buffer) return;

    clearBufferTimers(buffer._id.toString());

    if (buffer.status === "distributing") {
      buffer.status = "cancelled";
      const assignedCandidateDriverId = buffer.currentCandidate?.driverId;
      buffer.currentCandidate.driverId = null;
      await buffer.save();

      if (assignedCandidateDriverId) {
        // Release reservation
        await ActiveDriver.findOneAndUpdate(
          { driverId: assignedCandidateDriverId, reservedBufferId: buffer._id },
          { reservedUntil: null, reservedBufferId: null }
        );
        sendToUser(assignedCandidateDriverId, "ride_request_expired", {
          rideId: buffer.rideId,
          bufferId: buffer._id,
        });
      }
    }
  } catch (err) {
    console.error("[bookingDistributor-cancelBuffer-err]", err);
  }
}

/**
 * Fetch current active buffered offer for driver (reconciliation on foreground)
 * @param {String|ObjectId} driverId
 */
async function getActiveOfferForDriver(driverId) {
  try {
    const now = new Date();
    const buffer = await BookingBuffer.findOne({
      status: "distributing",
      "currentCandidate.driverId": driverId,
      "currentCandidate.offerExpiresAt": { $gt: now },
    });

    if (!buffer) return null;

    return {
      bufferId: buffer._id,
      rideId: buffer.rideId,
      pickup: buffer.bookingData.pickup,
      dropoff: buffer.bookingData.dropoff,
      fare: buffer.bookingData.fare,
      distanceKm: buffer.bookingData.distanceKm,
      durationMins: buffer.bookingData.durationMins,
      paymentMethod: buffer.bookingData.paymentMethod,
      passengerCount: buffer.bookingData.passengerCount,
      bookingFor: buffer.bookingData.bookingFor,
      passenger: buffer.bookingData.passengerDetails,
      expiresAt: buffer.currentCandidate.offerExpiresAt,
    };
  } catch (err) {
    console.error("[bookingDistributor-getActiveOfferForDriver-err]", err);
    return null;
  }
}

/**
 * Recovers dangling distributing buffers upon server restart
 */
async function recoverDanglingBuffers() {
  try {
    const danglingBuffers = await BookingBuffer.find({ status: "distributing" });
    if (danglingBuffers.length === 0) return;

    console.log(`[bookingDistributor] Recovering ${danglingBuffers.length} dangling booking buffers...`);
    const now = new Date();

    for (const buf of danglingBuffers) {
      if (buf.searchExpiresAt && now >= buf.searchExpiresAt) {
        await handleExhausted(buf, "Server recovery: search expired");
      } else {
        // Resume distribution
        distributeNext(buf._id);
      }
    }
  } catch (err) {
    console.error("[bookingDistributor-recoverDanglingBuffers-err]", err);
  }
}

module.exports = {
  enqueueRide,
  distributeNext,
  acknowledgeOffer,
  acceptOffer,
  declineOffer,
  cancelBuffer,
  getActiveOfferForDriver,
  recoverDanglingBuffers,
};
