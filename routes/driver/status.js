const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const ActiveDriver = require("../../models/ActiveDriver");
const Ride = require("../../models/Ride");
const {
  processDriverLocation,
  getDriverQueueInfo,
} = require("../../services/terminalQueue");
const router = express.Router();

// Get current status and queue position
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

    const queueInfo = await getDriverQueueInfo(req.user.id);
    res.json({
      ...activeDriver.toObject(),
      queueInfo,
    });
  } catch (err) {
    console.error("[driver-status-get]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Lightweight queue status poll
router.get("/queue", authenticate, requireRole("driver"), async (req, res) => {
  try {
    const queueInfo = await getDriverQueueInfo(req.user.id);
    res.json(queueInfo);
  } catch (err) {
    console.error("[driver-status-queue-get]", err);
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

    let coordinates = activeDriver.location?.coordinates || [0, 0];
    if (latitude !== undefined && longitude !== undefined) {
      coordinates = [longitude, latitude];
      activeDriver.location = {
        type: "Point",
        coordinates,
      };
    }

    // Process terminal queue entry, exit, grace period, or disconnect
    await processDriverLocation(activeDriver, coordinates, activeDriver.isOnline);

    activeDriver.lastUpdated = Date.now();
    await activeDriver.save();

    const queueInfo = await getDriverQueueInfo(req.user.id);

    res.json({
      ...activeDriver.toObject(),
      queueInfo,
    });
  } catch (err) {
    console.error("[driver-status-update]", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
