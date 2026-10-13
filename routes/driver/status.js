const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const ActiveDriver = require("../../models/ActiveDriver");
const Ride = require("../../models/Ride");
const router = express.Router();

// Get current status
router.get("/", authenticate, requireRole("driver"), async (req, res) => {
  try {
    let activeDriver = await ActiveDriver.findOne({ driverId: req.user.id });
    if (!activeDriver) {
      activeDriver = await ActiveDriver.create({ driverId: req.user.id });
    } else if (activeDriver.isBusy) {
      // Self-heal: If marked busy but no ongoing ride exists, clear busy flag
      const ongoingRide = await Ride.findOne({
        driverId: req.user.id,
        status: { $in: ["driver_assigned", "arrived_pickup", "trip_started"] }
      });
      if (!ongoingRide) {
        activeDriver.isBusy = false;
        await activeDriver.save();
      }
    }
    res.json(activeDriver);
  } catch (err) {
    console.error("[driver-status-get]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update status (online/offline) and/or location
router.post("/", authenticate, requireRole("driver"), async (req, res) => {
  const { isOnline, latitude, longitude, isBusy } = req.body;
  try {
    let activeDriver = await ActiveDriver.findOne({ driverId: req.user.id });
    if (!activeDriver) {
      activeDriver = new ActiveDriver({ driverId: req.user.id });
    }

    if (typeof isOnline === "boolean") {
      activeDriver.isOnline = isOnline;
      if (!isOnline) {
        activeDriver.isBusy = false;
      }
    }

    if (isBusy === false) {
      const ongoingRide = await Ride.findOne({
        driverId: req.user.id,
        status: { $in: ["driver_assigned", "arrived_pickup", "trip_started"] }
      });
      if (!ongoingRide) {
        activeDriver.isBusy = false;
      }
    }

    if (latitude !== undefined && longitude !== undefined) {
      activeDriver.location = {
        type: "Point",
        coordinates: [longitude, latitude],
      };
    }

    activeDriver.lastUpdated = Date.now();
    await activeDriver.save();

    res.json(activeDriver);
  } catch (err) {
    console.error("[driver-status-update]", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
