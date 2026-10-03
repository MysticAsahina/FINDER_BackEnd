const User = require("../models/User");
const ActiveDriver = require("../models/ActiveDriver");
const { sendToUser } = require("./socket");

function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Validates if the cancellation reason is eligible for a strike, or if the claim is false.
 * Returns { valid: boolean, error?: string, strikeType?: string, targetUserId?: string }
 */
async function validateCancellation(ride, cancelledByRole, reason, forceStandardCancel) {
  const isDriverUnresponsive = reason === "Driver Unresponsive / Not Moving (Wait 10 mins)";
  const isPassengerUnresponsive = reason === "Passenger Unresponsive (Wait 5 mins)";

  if (cancelledByRole === "passenger") {
    if (isDriverUnresponsive && !forceStandardCancel) {
      if (!ride.cancellationData?.driverAssignedAt) {
        return { valid: false, error: "Cannot verify driver assignment time." };
      }

      const assignedTime = new Date(ride.cancellationData.driverAssignedAt).getTime();
      const now = Date.now();
      const elapsedMins = (now - assignedTime) / 60000;
      
      // Scenario: Too early
      if (elapsedMins < 10) {
        return { valid: false, error: "10 minutes have not elapsed since driver assignment." };
      }

      // Determine if driver moved >150m
      let movedDistanceGreaterThan150 = false;
      const driverState = await ActiveDriver.findOne({ driverId: ride.driverId });
      const acceptedLoc = ride.cancellationData.driverAcceptedLocation;
      
      if (driverState && driverState.location && acceptedLoc && acceptedLoc.coordinates) {
        const currentLon = driverState.location.coordinates[0];
        const currentLat = driverState.location.coordinates[1];
        const acceptedLon = acceptedLoc.coordinates[0];
        const acceptedLat = acceptedLoc.coordinates[1];
        const dist = getDistanceInMeters(currentLat, currentLon, acceptedLat, acceptedLon);
        if (dist > 150) {
          movedDistanceGreaterThan150 = true;
        }
      }

      // Scenario: Stuck/delayed (moved >150m) -> Cancel + NO strike
      if (movedDistanceGreaterThan150) {
        return { valid: true, strikeType: null };
      }

      // If driver didn't move >150m, check communication
      const lastComm = ride.cancellationData.lastDriverCommunicationAt 
        ? new Date(ride.cancellationData.lastDriverCommunicationAt).getTime() 
        : 0;
      const communicatedInLast10Min = (now - lastComm) < 10 * 60 * 1000;

      // Scenario: Lazy, stalling (20+ min without moving) -> Cancel + driver strike (ignore chat)
      if (elapsedMins >= 20) {
        return { valid: true, strikeType: "unresponsive_driver", targetUserId: ride.driverId };
      }

      // Between 10 and 20 mins:
      // Scenario: Lazy, chatty -> Reject (benefit of doubt)
      if (communicatedInLast10Min) {
        return { valid: false, errorCode: "DRIVER_IS_ACTIVE", error: "The driver has recently communicated." };
      }

      // Scenario: Lazy, silent -> Cancel + driver strike
      return { valid: true, strikeType: "unresponsive_driver", targetUserId: ride.driverId };
    }

    // Standard passenger cancellation
    // If they cancel after matched, it's a strike against them
    if (ride.status === "driver_assigned" || ride.status === "arrived_pickup") {
      return { valid: true, strikeType: "frequent_cancellation", targetUserId: ride.passengerId };
    }
  }

  if (cancelledByRole === "driver") {
    if (isPassengerUnresponsive && !forceStandardCancel) {
      if (ride.status !== "arrived_pickup") {
        return { valid: false, error: "You must be at the pickup location to use this reason." };
      }

      if (!ride.cancellationData?.arrivedPickupAt) {
        return { valid: false, error: "Cannot verify arrival time." };
      }

      const arrivedTime = new Date(ride.cancellationData.arrivedPickupAt).getTime();
      const now = Date.now();

      if (now - arrivedTime < 5 * 60 * 1000) {
        return { valid: false, error: "5 minutes have not elapsed since you arrived." };
      }

      // Check communication
      const lastComm = ride.cancellationData.lastPassengerCommunicationAt 
        ? new Date(ride.cancellationData.lastPassengerCommunicationAt).getTime() 
        : 0;

      if (now - lastComm < 5 * 60 * 1000) {
        return { valid: false, errorCode: "PASSENGER_IS_ACTIVE", error: "The passenger has recently communicated." };
      }

      return { valid: true, strikeType: "unresponsive_passenger", targetUserId: ride.passengerId };
    }

    // Standard driver cancellation
    if (ride.status === "driver_assigned" || ride.status === "arrived_pickup") {
      return { valid: true, strikeType: "frequent_cancellation", targetUserId: ride.driverId };
    }
  }

  return { valid: true };
}

/**
 * Records a strike against a user and evaluates if they should be flagged.
 */
async function recordStrikeAndEvaluate(userId, strikeType, rideId) {
  if (!strikeType || !userId) return;

  const user = await User.findById(userId);
  if (!user) return;

  user.strikes.push({
    type: strikeType,
    rideId,
    createdAt: new Date()
  });

  // Evaluate flags based on rolling windows
  const now = new Date();
  
  if (strikeType === "frequent_cancellation") {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const recentCancels = user.strikes.filter(s => s.type === "frequent_cancellation" && s.createdAt >= sevenDaysAgo);
    
    if (recentCancels.length >= 3 && !user.isFlagged) {
      user.isFlagged = true;
      user.flagReason = "Frequent Cancellation";
      user.flaggedAt = now;
      await user.save();
      sendToUser(user._id, "account_warning", { message: "Your account has been flagged for frequent cancellations." });
      return;
    }
  }

  if (strikeType === "unresponsive_passenger") {
    const unresps = user.strikes.filter(s => s.type === "unresponsive_passenger");
    if (unresps.length >= 3 && !user.isFlagged) {
      user.isFlagged = true;
      user.flagReason = "No-show Pattern"; // Or "Unresponsive"
      user.flaggedAt = now;
      await user.save();
      sendToUser(user._id, "account_warning", { message: "Your account has been flagged for unresponsiveness." });
      return;
    }
  }

  if (strikeType === "unresponsive_driver") {
    const unresps = user.strikes.filter(s => s.type === "unresponsive_driver");
    if (unresps.length >= 3 && !user.isFlagged) {
      user.isFlagged = true;
      user.flagReason = "Unresponsive";
      user.flaggedAt = now;
      await user.save();
      sendToUser(user._id, "account_warning", { message: "Your account has been flagged for unresponsiveness." });
      return;
    }
  }

  await user.save();
}

module.exports = {
  validateCancellation,
  recordStrikeAndEvaluate
};
