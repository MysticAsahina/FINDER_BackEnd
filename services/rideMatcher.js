const Ride = require("../models/Ride");
const ActiveDriver = require("../models/ActiveDriver");
const { sendToUser, broadcastToRide } = require("./socket");

const MATCH_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Finds the nearest available driver for a ride and sends a request.
 * If the driver ignores or declines, it tries the next one.
 * @param {String} rideId 
 */
async function matchRide(rideId) {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride || ride.status !== "pending") return;

    console.log("[rideMatcher] ride.pickup =", JSON.stringify(ride.pickup, null, 2));

    // Find nearest online, not busy driver, within 10km, not in ignoredDrivers
    const nearestDriver = await ActiveDriver.findOne({
      isOnline: true,
      isBusy: false,
      driverId: { $nin: ride.ignoredDrivers },
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: ride.pickup.coordinates.coordinates,
          },
          $maxDistance: 10000, // 10km
        },
      },
    });

    if (!nearestDriver) {
      // Simulate searching for drivers and give frontend time to join socket room
      setTimeout(async () => {
        try {
          const currentRide = await Ride.findById(rideId);
          if (currentRide && currentRide.status === "pending") {
            currentRide.status = "cancelled";
            await currentRide.save();
            // Notify passenger (broadcast to room AND directly to user to avoid race conditions)
            broadcastToRide(currentRide._id, "ride_cancelled", { reason: "No drivers available" });
            sendToUser(currentRide.passengerId, "ride_cancelled", { reason: "No drivers available" });
          }
        } catch (error) {
          console.error("[rideMatcher] setTimeout 1 error:", error);
        }
      }, 2000);
      return;
    }

    // Update DB with current candidate so it can be fetched via API
    ride.currentCandidateDriverId = nearestDriver.driverId;
    await ride.save();

    // Send request to driver via socket
    sendToUser(nearestDriver.driverId, "ride_request", {
      rideId: ride._id,
      pickup: ride.pickup,
      dropoff: ride.dropoff,
      fare: ride.fare,
      distanceKm: ride.distanceKm,
      paymentMethod: ride.paymentMethod,
    });

    // Send push notification to driver
    const { sendPushToUser } = require("./notification");
    sendPushToUser(nearestDriver.driverId, "New Ride Request", "You have a new ride request! Open the app to view and accept.", {
      type: "ride_request",
      rideId: ride._id.toString()
    });

    // Set timeout to wait for response
    setTimeout(async () => {
      try {
        const currentRide = await Ride.findById(rideId);
        // If still pending, the driver ignored it
        if (currentRide && currentRide.status === "pending" && currentRide.currentCandidateDriverId?.toString() === nearestDriver.driverId.toString()) {
          currentRide.ignoredDrivers.push(nearestDriver.driverId);
          currentRide.currentCandidateDriverId = null;
          await currentRide.save();
          // Notify driver that request expired
          sendToUser(nearestDriver.driverId, "ride_request_expired", { rideId: currentRide._id });
          // Try matching again
          matchRide(currentRide._id);
        }
      } catch (error) {
        console.error("[rideMatcher] setTimeout 2 error:", error);
      }
    }, MATCH_TIMEOUT_MS);

  } catch (err) {
    console.error("[rideMatcher]", err);
  }
}

module.exports = { matchRide };
