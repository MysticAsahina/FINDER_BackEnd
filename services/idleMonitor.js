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

function startIdleMonitor() {
  // Run every 15 minutes
  setInterval(checkIdleDrivers, 15 * 60 * 1000);
  console.log("[idleMonitor] Started idle driver monitor.");
}

module.exports = { startIdleMonitor };
