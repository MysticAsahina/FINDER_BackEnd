const express = require("express");
const SystemSettings = require("../../models/SystemSettings");

const router = express.Router();

// GET /passenger/settings/fare — public endpoint (no auth required)
router.get("/fare", async (req, res) => {
  try {
    let settings = await SystemSettings.findOne({ key: "fare" });
    if (!settings) {
      settings = await SystemSettings.create({
        key: "fare",
        baseFare: 25,
        perKmFare: 8.5,
        baseDistance: 3,
      });
    }
    return res.status(200).json({
      baseFare: settings.baseFare,
      perKmFare: settings.perKmFare,
      baseDistance: settings.baseDistance,
      ordinanceUrl: settings.ordinanceUrl,
    });
  } catch (err) {
    console.error("[passenger/settings/fare GET]", err);
    return res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
