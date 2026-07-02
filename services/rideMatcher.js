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
        const currentRide = await Ride.findById(rideId);
        if (currentRide && currentRide.status === "pending") {
          currentRide.status = "cancelled";
          await currentRide.save();
          // Notify passenger (broadcast to room AND directly to user to avoid race conditions)
          broadcastToRide(currentRide._id, "ride_cancelled", { reason: "No drivers available" });
          sendToUser(currentRide.passengerId, "ride_cancelled", { reason: "No drivers available" });
        }
      }, 2000);
      return;
    }

    // Send request to driver
    sendToUser(nearestDriver.driverId, "ride_request", {
      rideId: ride._id,
      pickup: ride.pickup,
      dropoff: ride.dropoff,
      fare: ride.fare,
      distanceKm: ride.distanceKm,
    });

    // Set timeout to wait for response
    setTimeout(async () => {
      const currentRide = await Ride.findById(rideId);
      // If still pending, the driver ignored it
      if (currentRide && currentRide.status === "pending") {
        currentRide.ignoredDrivers.push(nearestDriver.driverId);
        await currentRide.save();
        // Notify driver that request expired
        sendToUser(nearestDriver.driverId, "ride_request_expired", { rideId: currentRide._id });
        // Try matching again
        matchRide(currentRide._id);
      }
    }, MATCH_TIMEOUT_MS);

  } catch (err) {
    console.error("[rideMatcher]", err);
  }
}

module.exports = { matchRide };
