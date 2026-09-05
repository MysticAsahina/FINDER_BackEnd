const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const User = require("../../models/User");
const ActiveDriver = require("../../models/ActiveDriver");
const Ride = require("../../models/Ride");

const router = express.Router();

router.get("/", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const drivers = await User.find({ role: "driver" }).select("-password -pushTokens -refreshToken");
    
    // We will aggregate stats and online status concurrently
    const driverIds = drivers.map(d => d._id);

    const [activeStatuses, rides] = await Promise.all([
      ActiveDriver.find({ driverId: { $in: driverIds } }),
      Ride.find({ 
        driverId: { $in: driverIds },
        status: { $in: ["completed", "cancelled"] }
      }).select("driverId status")
    ]);

    const activeMap = {};
    for (const status of activeStatuses) {
      activeMap[status.driverId.toString()] = status;
    }

    const ridesMap = {};
    for (const r of rides) {
      const dId = r.driverId.toString();
      if (!ridesMap[dId]) ridesMap[dId] = { completed: 0, cancelled: 0 };
      ridesMap[dId][r.status]++;
    }

    const formattedDrivers = drivers.map(d => {
      const dId = d._id.toString();
      
      // Determine status
      let status = "Inactive";
      const act = activeMap[dId];
      if (act) {
        status = act.isOnline ? "Online" : "Offline";
      }

      // Calculate trips and rate
      const rStats = ridesMap[dId] || { completed: 0, cancelled: 0 };
      const totalFinished = rStats.completed + rStats.cancelled;
      const rate = totalFinished > 0 
        ? Math.round((rStats.completed / totalFinished) * 100)
        : 100;

      // Extract details safely
      const details = d.driverDetails || {};
      
      const initials = `${d.firstName.charAt(0)}${d.lastName.charAt(0)}`.toUpperCase();

      return {
        _id: dId,
        id: `#${dId.slice(-6).toUpperCase()}`, // formatted ID with # and last 6 chars
        name: `${d.firstName} ${d.lastName}`,
        initials,
        contact: d.mobileNumber,
        status,
        trips: rStats.completed,
        rate: `${rate}%`,
        rating: (details.averageRating && details.totalReviews > 0) ? details.averageRating.toFixed(1) : "5.0",
        vehicle: `${details.motorcycleBrand || "Unknown"} • ${details.plateNumber || "N/A"}`,
        motorcycleBrand: details.motorcycleBrand,
        plateNumber: details.plateNumber,
        tricycleImgFront: details.tricycleImgFront,
        licenseImgFront: details.licenseImgFront,
      };
    });

    return res.status(200).json({ drivers: formattedDrivers });
  } catch (err) {
    console.error("[admin-drivers] Fetch error:", err);
    return res.status(500).json({ message: "Server error fetching drivers." });
  }
});

module.exports = router;
