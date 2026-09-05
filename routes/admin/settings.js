const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const SystemSettings = require("../../models/SystemSettings");
const { logAdminAction } = require("../../utils/auditLogger");
const { validateFareValue } = require('../../utils/validators');

const router = express.Router();

router.use(authenticate, requireRole("admin"));

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------



// GET /admin/settings/fare
router.get("/fare", async (req, res) => {
  try {
    let settings = await SystemSettings.findOne({ key: "fare" });
    if (!settings) {
      settings = await SystemSettings.create({
        key: "fare",
        baseFare: 25,
        perKmFare: 8.5,
        baseDistance: 2,
      });
    }
    return res.status(200).json({
      baseFare: settings.baseFare,
      perKmFare: settings.perKmFare,
      baseDistance: settings.baseDistance,
      updatedAt: settings.updatedAt,
    });
  } catch (err) {
    console.error("[admin/settings/fare GET]", err);
    return res.status(500).json({ message: "Server error." });
  }
});

// PUT /admin/settings/fare
router.put("/fare", async (req, res) => {
  try {
    const { baseFare, perKmFare } = req.body;

    const baseFareErr = validateFareValue(baseFare, "Base Fare");
    if (baseFareErr) return res.status(400).json({ message: baseFareErr });

    const perKmFareErr = validateFareValue(perKmFare, "Per Km Fare");
    if (perKmFareErr) return res.status(400).json({ message: perKmFareErr });

    // Sanitize values to 2 decimal places max
    const cleanBaseFare = parseFloat(Number(baseFare).toFixed(2));
    const cleanPerKmFare = parseFloat(Number(perKmFare).toFixed(2));

    let settings = await SystemSettings.findOne({ key: "fare" });
    const oldBaseFare = settings?.baseFare ?? 25;
    const oldPerKmFare = settings?.perKmFare ?? 8.5;

    if (!settings) {
      settings = new SystemSettings({ key: "fare" });
    }

    settings.baseFare = cleanBaseFare;
    settings.perKmFare = cleanPerKmFare;
    settings.updatedBy = req.user.id;
    await settings.save();

    // Create audit log using the standard utility so it broadcasts via sockets
    const details = `Updated fare settings: Base Fare ₱${oldBaseFare} → ₱${cleanBaseFare}, Per Km Fare ₱${oldPerKmFare} → ₱${cleanPerKmFare}`;
    await logAdminAction(req, req.user.id, req.user.name, "UPDATE_FARE_SETTINGS", details);

    return res.status(200).json({
      message: "Fare settings updated successfully.",
      baseFare: settings.baseFare,
      perKmFare: settings.perKmFare,
      baseDistance: settings.baseDistance,
      updatedAt: settings.updatedAt,
    });
  } catch (err) {
    console.error("[admin/settings/fare PUT]", err);
    return res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
