const ActiveDriver = require("../models/ActiveDriver");
const Ride = require("../models/Ride");
const { sendToUser } = require("./socket");

const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

async function checkIdleDrivers() {
  try {
    const thresholdDate = new Date(Date.now() - IDLE_TIMEOUT_MS);
    
    // Find drivers who are online but haven't updated location/status in 2 hours
    const idleDrivers = await ActiveDriver.find({
      isOnline: true,
      lastUpdated: { $lt: thresholdDate }
    });

    for (const driver of idleDrivers) {
      // Check if driver is in an active ride
      const activeRide = await Ride.findOne({
        driverId: driver.driverId,
        status: { $in: ['pending', 'driver_assigned', 'arrived_pickup', 'trip_started'] }
      });

      if (!activeRide) {
        // Driver is genuinely idle and not in a ride. Mark offline.
        driver.isOnline = false;
        await driver.save();

        // Emit socket event so their app updates UI and stops background tracking
        sendToUser(driver.driverId, "force_offline", {
          reason: "You have been marked offline due to prolonged inactivity."
        });
        
        console.log(`[idleMonitor] Driver ${driver.driverId} marked offline due to 2-hour inactivity.`);
      }
    }
  } catch (error) {
    console.error("[idleMonitor] Error checking idle drivers:", error);
  }
}

const RIDE_STUCK_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours

async function checkStuckRides() {
  try {
    const thresholdDate = new Date(Date.now() - RIDE_STUCK_TIMEOUT_MS);
    
    // Find rides that have been stuck in an active state with no updates for 3 hours
    const stuckRides = await Ride.find({
      status: { $in: ['driver_assigned', 'arrived_pickup', 'trip_started'] },
      updatedAt: { $lt: thresholdDate }
    });

    for (const ride of stuckRides) {
      if (!ride.cancellationData) ride.cancellationData = {};
      ride.cancellationData.cancelledBy = "system";
      ride.cancellationData.reason = "Ride was automatically cancelled due to prolonged inactivity (abandoned ride).";
      ride.status = "cancelled";
      await ride.save();

      // Free up driver
      if (ride.driverId) {
        await ActiveDriver.findOneAndUpdate({ driverId: ride.driverId }, { isBusy: false });
        sendToUser(ride.driverId, "ride_cancelled", { reason: "Ride was automatically cancelled due to prolonged inactivity (abandoned ride)." });
      }

      // Notify passenger
      sendToUser(ride.passengerId, "ride_cancelled", { reason: "Ride was automatically cancelled due to prolonged inactivity (abandoned ride)." });
      
      console.log(`[idleMonitor] Ride ${ride._id} automatically cancelled (stuck for > 3 hours).`);
    }
  } catch (error) {
    console.error("[idleMonitor] Error checking stuck rides:", error);
  }
}

function startIdleMonitor() {
  // Run every 15 minutes
  setInterval(() => {
    checkIdleDrivers();
    checkStuckRides();
  }, 15 * 60 * 1000);
  console.log("[idleMonitor] Started idle driver & stuck ride monitor.");
}

module.exports = { startIdleMonitor };
