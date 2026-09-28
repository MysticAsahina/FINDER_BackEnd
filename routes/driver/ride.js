const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const Ride = require("../../models/Ride");
const ActiveDriver = require("../../models/ActiveDriver");
const { broadcastToRide, sendToUser } = require("../../services/socket");
const { matchRide } = require("../../services/rideMatcher");
const { getDistanceInMeters } = require("../../utils/geo");
const SystemSettings = require("../../models/SystemSettings");

const router = express.Router();

// Get current active ride
router.get("/current", authenticate, requireRole("driver"), async (req, res) => {
  try {
    const ride = await Ride.findOne({
      driverId: req.user.id,
      status: { $nin: ["completed", "cancelled"] },
    }).populate("passengerId", "firstName lastName mobileNumber");
    
    res.json({ ride });
  } catch (err) {
    console.error("[driver-ride-current]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get driver ride history
router.get("/history", authenticate, requireRole("driver"), async (req, res) => {
  try {
    const rides = await Ride.find({
      driverId: req.user.id,
      status: { $in: ["completed", "cancelled"] },
    })
      .sort({ createdAt: -1 })
      .populate("passengerId", "firstName lastName mobileNumber");
    
    res.json({ rides });
  } catch (err) {
    console.error("[driver-ride-history]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Accept a ride
router.post("/:id/accept", authenticate, requireRole("driver"), async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: "Ride not found." });

    if (ride.status !== "pending") {
      return res.status(400).json({ message: "Ride is no longer available." });
    }

    // Assign driver and update status
    ride.driverId = req.user.id;
    ride.status = "driver_assigned";
    
    const driverState = await ActiveDriver.findOne({ driverId: req.user.id });
    if (!ride.cancellationData) ride.cancellationData = {};
    ride.cancellationData.driverAssignedAt = new Date();
    if (driverState && driverState.location) {
      ride.cancellationData.driverAcceptedLocation = driverState.location;
    }
    
    await ride.save();

    // Set driver as busy
    await ActiveDriver.findOneAndUpdate({ driverId: req.user.id }, { isBusy: true });

    // Notify passenger
    const populatedRide = await Ride.findById(ride._id)
      .populate("driverId", "firstName lastName mobileNumber driverDetails")
      .populate("passengerId", "firstName lastName mobileNumber");
    broadcastToRide(ride._id, "ride_accepted", { ride: populatedRide });

    res.json({ message: "Ride accepted", ride: populatedRide });
  } catch (err) {
    console.error("[driver-ride-accept]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Decline a ride
router.post("/:id/decline", authenticate, requireRole("driver"), async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: "Ride not found." });

    if (ride.status !== "pending") {
      return res.status(400).json({ message: "Ride is no longer pending." });
    }

    ride.ignoredDrivers.push(req.user.id);
    await ride.save();

    matchRide(ride._id);

    res.json({ message: "Ride declined" });
  } catch (err) {
    console.error("[driver-ride-decline]", err);
    res.status(500).json({ message: "Server error" });
  }
});

const { validateCancellation, recordStrikeAndEvaluate } = require("../../services/strikes");

// Cancel a ride (by driver)
router.post("/:id/cancel", authenticate, requireRole("driver"), async (req, res) => {
  try {
    const { reason, forceStandardCancel } = req.body;
    const ride = await Ride.findOne({ _id: req.params.id, driverId: req.user.id });
    
    if (!ride) {
      return res.status(404).json({ message: "Ride not found." });
    }

    if (ride.status === "completed" || ride.status === "cancelled") {
      return res.status(400).json({ message: "Ride is already completed or cancelled." });
    }

    if (ride.status === "trip_started") {
      return res.status(400).json({ message: "Cannot cancel a ride that has already started." });
    }

    // Strike evaluation
    const validation = await validateCancellation(ride, "driver", reason, forceStandardCancel);
    if (!validation.valid) {
      if (validation.errorCode) {
        return res.status(400).json({ code: validation.errorCode, message: validation.error });
      }
      return res.status(400).json({ message: validation.error });
    }

    if (!ride.cancellationData) ride.cancellationData = {};
    ride.cancellationData.cancelledBy = "driver";
    ride.cancellationData.reason = reason || null;

    ride.status = "cancelled";
    await ride.save();

    if (validation.strikeType && validation.targetUserId) {
      await recordStrikeAndEvaluate(validation.targetUserId, validation.strikeType, ride._id);
    }

    broadcastToRide(ride._id, "ride_cancelled", { reason: reason || "The driver has cancelled the ride." });

    // Free up driver
    await ActiveDriver.findOneAndUpdate({ driverId: req.user.id }, { isBusy: false });

    res.json({ message: "Ride cancelled successfully", ride });
  } catch (err) {
    console.error("[driver-ride-cancel]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update ride status (arrive, start, complete)
router.patch("/:id/status", authenticate, requireRole("driver"), async (req, res) => {
    const { status, latitude, longitude, discountedPassengers } = req.body;
    const validStatuses = ["arrived_pickup", "trip_started", "completed"];

    if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: "Invalid status." });
    }

    try {
        const ride = await Ride.findOne({ _id: req.params.id, driverId: req.user.id });
        if (!ride) return res.status(404).json({ message: "Ride not found." });

        if (ride.status === "cancelled" || ride.status === "completed") {
            return res.status(400).json({ message: "Ride is already cancelled or completed." });
        }

        if (status === "arrived_pickup" || status === "completed") {
            if (latitude === undefined || longitude === undefined) {
                return res.status(400).json({ message: "Latitude and longitude are required for this status update." });
            }
            let targetCoords;
            if (status === "arrived_pickup") {
                targetCoords = ride.pickup.coordinates.coordinates; // [lng, lat]
            } else if (status === "completed") {
                targetCoords = ride.dropoff.coordinates.coordinates;
            }

            if (targetCoords && targetCoords.length === 2) {
                const distance = getDistanceInMeters(latitude, longitude, targetCoords[1], targetCoords[0]);
                if (distance > 100) {
                    // Broadcast to room just in case, but also send directly to passenger's socket to prevent sync issues
                    broadcastToRide(ride._id, "override_request", { rideId: ride._id, status });
                    sendToUser(ride.passengerId, "override_request", { rideId: ride._id, status });
                    return res.status(400).json({ code: "GPS_TOO_FAR", message: "You are too far from the location. Waiting for passenger override." });
                }
            }
        }
        if (status === "arrived_pickup" && discountedPassengers !== undefined) {
            // Re-calculate the fare based on verified driver input
            let fareSettings = await SystemSettings.findOne({ key: "fare" });
            if (!fareSettings) {
                fareSettings = { baseFare: 25, perKmFare: 8.5, baseDistance: 3 };
            }
            
            const pCount = ride.passengerCount || 1;
            const dCount = Math.min(pCount, discountedPassengers);
            const regularCount = pCount - dCount;
            
            const extraKm = Math.max(0, Math.ceil((ride.distanceKm || 0) - fareSettings.baseDistance));
            const effectiveBaseFare = pCount === 1 ? fareSettings.baseFare * 2 : fareSettings.baseFare;
            
            const regularFarePerPerson = effectiveBaseFare + (extraKm * fareSettings.perKmFare);
            const discountedFarePerPerson = (effectiveBaseFare * 0.8) + (extraKm * fareSettings.perKmFare * 0.8);
            
            const regularFareTotal = regularCount * regularFarePerPerson;
            const discountedFareTotal = dCount * discountedFarePerPerson;
            
            ride.discountCount = dCount;
            ride.fare = parseFloat((regularFareTotal + discountedFareTotal).toFixed(2));
        }

        if (status === "trip_started") {
            ride.tripStartedAt = new Date();
        } else if (status === "completed") {
            ride.tripCompletedAt = new Date();
            if (ride.tripStartedAt) {
                ride.actualDurationMins = parseFloat(((ride.tripCompletedAt - ride.tripStartedAt) / 60000).toFixed(1));
            }
            if (req.body.actualDistanceKm !== undefined) {
                ride.actualDistanceKm = req.body.actualDistanceKm;
            }
        }
        
        ride.status = status;
    await ride.save();

    // Broadcast update
    broadcastToRide(ride._id, "ride_status_update", { 
      rideId: ride._id, 
      status, 
      actualDurationMins: ride.actualDurationMins, 
      actualDistanceKm: ride.actualDistanceKm,
      fare: ride.fare
    });

    if (status === "completed") {
      // Free up driver
      await ActiveDriver.findOneAndUpdate({ driverId: req.user.id }, { isBusy: false });
    }

    res.json({ message: `Status updated to ${status}`, ride });
  } catch (err) {
    console.error("[driver-ride-status]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get daily earnings
router.get("/earnings/daily", authenticate, requireRole("driver"), async (req, res) => {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(new Date());
    const d = {};
    parts.forEach(p => { d[p.type] = p.value; });
    
    const startOfDay = new Date(`${d.year}-${d.month}-${d.day}T00:00:00.000+08:00`);
    const endOfDay = new Date(`${d.year}-${d.month}-${d.day}T23:59:59.999+08:00`);

    const rides = await Ride.find({
      driverId: req.user.id,
      status: "completed",
      tripCompletedAt: { $gte: startOfDay, $lte: endOfDay }
    });

    const totalEarnings = rides.reduce((sum, ride) => sum + (ride.fare || 0), 0);
    
    res.json({ earnings: totalEarnings });
  } catch (err) {
    console.error("[driver-earnings-daily]", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
