const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const Ride = require("../../models/Ride");
const ActiveDriver = require("../../models/ActiveDriver");
const SystemSettings = require("../../models/SystemSettings");
const { matchRide } = require("../../services/rideMatcher");
const { broadcastToRide, joinUserToRoom } = require("../../services/socket");

const router = express.Router();

// Get current active ride
router.get("/current", authenticate, requireRole("passenger"), async (req, res) => {
  try {
    const ride = await Ride.findOne({
      passengerId: req.user.id,
      status: { $nin: ["completed", "cancelled"] },
    }).populate("driverId", "firstName lastName mobileNumber driverDetails");
    
    res.json({ ride });
  } catch (err) {
    console.error("[passenger-ride-current]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get passenger ride history
router.get("/history", authenticate, requireRole("passenger"), async (req, res) => {
  try {
    const rides = await Ride.find({
      passengerId: req.user.id,
      status: { $in: ["completed", "cancelled"] },
    })
      .sort({ createdAt: -1 })
      .populate("driverId", "firstName lastName mobileNumber driverDetails");
    
    res.json({ rides });
  } catch (err) {
    console.error("[passenger-ride-history]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Request a new ride
router.post("/request", authenticate, requireRole("passenger"), async (req, res) => {
  const { pickup, dropoff, paymentMethod, fare, distanceKm, durationMins } = req.body;

  try {
    // Check if passenger already has an active ride
    const existingRide = await Ride.findOne({
      passengerId: req.user.id,
      status: { $nin: ["completed", "cancelled"] },
    });

    if (existingRide) {
      console.log("Existing ride found:", existingRide);
      return res.status(400).json({ message: "You already have an active ride." });
    }

    if (paymentMethod !== "cash") {
      console.log("Unsupported payment method:", paymentMethod);
      return res.status(400).json({ message: "Only cash payments are supported currently." });
    }

    // Fetch fare settings
    let fareSettings = await SystemSettings.findOne({ key: "fare" });
    if (!fareSettings) {
      fareSettings = { baseFare: 25, perKmFare: 8.5, baseDistance: 2 };
    }

    // Calculate fare server-side
    const dist = distanceKm || 0;
    const extraKm = Math.max(0, dist - fareSettings.baseDistance);
    const calculatedFare = parseFloat((fareSettings.baseFare + extraKm * fareSettings.perKmFare).toFixed(2));

    const ride = new Ride({
      passengerId: req.user.id,
      pickup: {
        address: pickup.address,
        coordinates: {
          type: "Point",
          coordinates: [pickup.longitude, pickup.latitude],
        },
      },
      dropoff: {
        address: dropoff.address,
        coordinates: {
          type: "Point",
          coordinates: [dropoff.longitude, dropoff.latitude],
        },
      },
      paymentMethod: "cash",
      fare: calculatedFare,
      distanceKm: distanceKm || 0,
      durationMins: durationMins || 0,
    });

    console.log("Ride before save:", JSON.stringify(ride, null, 2));

    await ride.save();

    // Instantly join the passenger to the ride's socket room
    joinUserToRoom(req.user.id, ride._id.toString());

    // Start matching process asynchronously
    matchRide(ride._id);

    res.status(201).json({ ride });
  } catch (err) {
    console.error("[passenger-ride-request]", err);
    res.status(500).json({ message: "Server error" });
    console.log("Error details:", err);
  }
});

// Cancel a ride
router.post("/:id/cancel", authenticate, requireRole("passenger"), async (req, res) => {
  try {
    const ride = await Ride.findOne({ _id: req.params.id, passengerId: req.user.id });
    
    if (!ride) {
      return res.status(404).json({ message: "Ride not found." });
    }

    if (ride.status === "completed" || ride.status === "cancelled") {
      return res.status(400).json({ message: "Ride is already completed or cancelled." });
    }

    ride.status = "cancelled";
    await ride.save();

    broadcastToRide(ride._id, "ride_cancelled", { reason: "Cancelled by passenger" });

    // If driver was assigned, free them up
    if (ride.driverId) {
      await ActiveDriver.findOneAndUpdate({ driverId: ride.driverId }, { isBusy: false });
    }

    res.json({ message: "Ride cancelled successfully", ride });
  } catch (err) {
    console.error("[passenger-ride-cancel]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Override driver status
router.post("/:id/override", authenticate, requireRole("passenger"), async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["arrived_pickup", "completed"];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: "Invalid override status." });
  }

  try {
    const ride = await Ride.findOne({ _id: req.params.id, passengerId: req.user.id });
    
    if (!ride) {
      return res.status(404).json({ message: "Ride not found." });
    }

    if (ride.status === "completed" || ride.status === "cancelled") {
      return res.status(400).json({ message: "Ride is already completed or cancelled." });
    }

    if (status === "completed") {
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

    // Broadcast update so driver and passenger screens advance
    broadcastToRide(ride._id, "ride_status_update", { 
      rideId: ride._id, 
      status, 
      actualDurationMins: ride.actualDurationMins, 
      actualDistanceKm: ride.actualDistanceKm 
    });

    if (status === "completed") {
      // Free up driver
      if (ride.driverId) {
        await ActiveDriver.findOneAndUpdate({ driverId: ride.driverId }, { isBusy: false });
      }
    }

    res.json({ message: "Ride status overridden successfully", ride });
  } catch (err) {
    console.error("[passenger-ride-override]", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
