const express = require("express");
const User = require("../models/User");
const SystemSettings = require("../models/SystemSettings");

const router = express.Router();

/**
 * GET /public/landing-stats
 * Public endpoint for the official FINDER landing page.
 * Returns registered driver count and current regulated fare settings.
 */
router.get("/landing-stats", async (req, res) => {
  try {
    const [driverCount, fareSettings] = await Promise.all([
      User.countDocuments({ role: "driver" }),
      SystemSettings.findOne({ key: "fare" }),
    ]);

    const fare = fareSettings
      ? {
          baseFare: fareSettings.baseFare,
          perKmFare: fareSettings.perKmFare,
          baseDistance: fareSettings.baseDistance,
          ordinanceUrl: fareSettings.ordinanceUrl,
        }
      : {
          baseFare: 25,
          perKmFare: 8.5,
          baseDistance: 2,
          ordinanceUrl: null,
        };

    return res.status(200).json({
      registeredDrivers: driverCount,
      fare,
    });
  } catch (err) {
    console.error("[public/landing-stats GET]", err);
    return res.status(500).json({
      message: "Failed to fetch landing stats.",
      registeredDrivers: 0,
      fare: {
        baseFare: 25,
        perKmFare: 8.5,
        baseDistance: 2,
        ordinanceUrl: null,
      },
    });
  }
});

module.exports = router;
