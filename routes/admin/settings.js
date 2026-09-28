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
        baseDistance: 3,
      });
    }
    return res.status(200).json({
      baseFare: settings.baseFare,
      perKmFare: settings.perKmFare,
      baseDistance: settings.baseDistance,
      ordinanceUrl: settings.ordinanceUrl,
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
    const { baseFare, perKmFare, ordinanceUrl, ordinancePublicId } = req.body;

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
    const oldOrdinancePublicId = settings?.ordinancePublicId;

    if (!settings) {
      settings = new SystemSettings({ key: "fare" });
    }

    settings.baseFare = cleanBaseFare;
    settings.perKmFare = cleanPerKmFare;
    
    let isNewOrdinance = false;
    if (ordinanceUrl !== undefined && ordinanceUrl !== settings.ordinanceUrl) {
      settings.ordinanceUrl = ordinanceUrl;
      settings.ordinancePublicId = ordinancePublicId;
      isNewOrdinance = true;
    }
    
    settings.updatedBy = req.user.id;
    await settings.save();

    // Cleanup old file and lock in new file if changed
    if (isNewOrdinance) {
      // 1. Delete the old file if it existed
      if (oldOrdinancePublicId) {
        try {
          await cloudinary.uploader.destroy(oldOrdinancePublicId);
        } catch (err) {
          console.error("Failed to delete old ordinance:", err);
        }
      }
      
      // 2. Replace the 'admin-settings-temp' tag with 'admin-settings' on the new file
      // so it survives the cron cleanup job.
      if (ordinancePublicId) {
        try {
          await cloudinary.uploader.replace_tag("admin-settings", [ordinancePublicId]);
        } catch (err) {
          console.error("Failed to replace temp tag on new ordinance:", err);
        }
      }
    }

    // Create audit log using the standard utility so it broadcasts via sockets
    const details = `Updated fare settings: Base Fare ₱${oldBaseFare} → ₱${cleanBaseFare}, Per Km Fare ₱${oldPerKmFare} → ₱${cleanPerKmFare}`;
    await logAdminAction(req, req.user.id, req.user.name, "UPDATE_FARE_SETTINGS", details);

    return res.status(200).json({
      message: "Fare settings updated successfully.",
      baseFare: settings.baseFare,
      perKmFare: settings.perKmFare,
      baseDistance: settings.baseDistance,
      ordinanceUrl: settings.ordinanceUrl,
      ordinancePublicId: settings.ordinancePublicId,
      updatedAt: settings.updatedAt,
    });
  } catch (err) {
    console.error("[admin/settings/fare PUT]", err);
    return res.status(500).json({ message: "Server error." });
  }
});

const cloudinary = require("cloudinary").v2;
const cron = require("node-cron");

// POST /admin/settings/cloudinary-signature
router.post("/cloudinary-signature", async (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const folder = "admin-settings";
    const tags = "admin-settings-temp";

    // We allow auto resource_type for pdfs
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder, tags },
      process.env.CLOUDINARY_API_SECRET
    );

    return res.status(200).json({
      signature,
      timestamp,
      folder,
      tags,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
    });
  } catch (err) {
    console.error("[admin/settings/cloudinary-signature]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// Cloudinary cleanup job
// Runs daily at 2:30 AM Philippine Time (UTC+8).
// Deletes any assets still tagged 'admin-settings-temp' that are older than
// 24 hours — these are files the admin uploaded but discarded/abandoned.
// Saved settings have their tags replaced to 'admin-settings'
// at save time, so they are never touched by this job.
// ---------------------------------------------------------------------------
async function cleanupSettingsTempUploads() {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const result = await cloudinary.api.resources_by_tag('admin-settings-temp', {
      max_results: 500,
    });

    const toDelete = [];
    for (const r of result.resources) {
      if (r.created_at < oneDayAgo) {
        toDelete.push(r.public_id);
      }
    }

    if (toDelete.length > 0) {
      await cloudinary.api.delete_resources(toDelete);
      console.log(`[settings-cleanup] Deleted ${toDelete.length} abandoned temp upload(s).`);
    } else {
      console.log("[settings-cleanup] No abandoned temp uploads found.");
    }
  } catch (err) {
    console.error("[settings-cleanup] Failed to run Cloudinary cleanup:", err);
  }
}

cron.schedule("30 2 * * *", cleanupSettingsTempUploads, {
  timezone: "Asia/Manila",
});

module.exports = router;
