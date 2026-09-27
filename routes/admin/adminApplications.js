const express = require("express");
const rateLimit = require("express-rate-limit");
const cloudinary = require("cloudinary").v2;
const bcrypt = require("bcrypt");
const DriverApplication = require("../../models/DriverApplication");
const User = require("../../models/User");
const { authenticate, requireRole } = require("../../middleware/auth");
const { logAdminAction } = require("../../utils/auditLogger");
const { broadcastToAdmins } = require("../../services/socket");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const router = express.Router();

// All routes require a valid JWT with role 'admin'
router.use(authenticate, requireRole("admin"));

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

const readLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please slow down." },
});

const actionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many actions. Please wait before trying again." },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deletes all Cloudinary images associated with an application.
 * Non-fatal — logs errors but does not throw.
 */
async function deleteCloudinaryImages(application) {
  try {
    const publicIds = Object.values(application.cloudinaryPublicIds ?? {})
      .filter(Boolean);

    if (publicIds.length > 0) {
      await cloudinary.api.delete_resources(publicIds);
      console.log(`[adminApplications] Deleted ${publicIds.length} Cloudinary image(s) for application ${application._id}`);
    }
  } catch (err) {
    console.error(`[adminApplications] Cloudinary deletion failed for ${application._id}:`, err);
  }
}

// Converts number to E164 format, used for OTP
function toE164(mobileNumber) {
  return '+63' + mobileNumber.slice(1);
}

/**
 * Sends a notification to the driver via SMS using IProgSMS.
 * This function handles its own errors so it never interrupts the approval/rejection flow.
 */
async function sendNotification(mobileNumber, message) {
  try {
    const iProgSmsToken = process.env.IPROGSMS_API_TOKEN;
    const iProgSmsUrl = process.env.IPROGSMS_API_URL;
    if (!iProgSmsUrl) return;

    const endpoint = iProgSmsUrl.replace(/\/$/, '');
    const payloadBody = {
      api_token: iProgSmsToken,
      phone_number: mobileNumber,
      message: message,
      sms_provider: 1 // Using alternative route to bypass some telco blocks
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payloadBody),
      signal: AbortSignal.timeout(5000)
    });

    if (response.ok) {
      console.log(`[adminApplications] Notification queued for ${mobileNumber}`);
    } else {
      const data = await response.text();
      console.error(`[adminApplications] Notification failed for ${mobileNumber}:`, data);
    }
  } catch (err) {
    console.error(`[adminApplications] Notification error for ${mobileNumber}:`, err.message || err);
  }
}

// ---------------------------------------------------------------------------
// GET /admin/applications
// Returns a list of driver applications.
// Query params:
//   status  — filter by status (pending | approved | rejected), default: pending
//   search  — search by name, mobile number, or license number
//   page    — page number (default: 1)
//   limit   — results per page (default: 20)
// ---------------------------------------------------------------------------
router.get("/", readLimiter, async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const search = req.query.search?.trim() || "";
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const query = { status };

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, "i");
      query.$or = [
        { firstName: regex },
        { lastName: regex },
        { mobileNumber: regex },
        { licenseNumber: regex },
        { plateNumber: regex },
      ];
    }

    const [applications, total] = await Promise.all([
      DriverApplication.find(query)
        .select("-password -mpin")    // never expose credentials
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      DriverApplication.countDocuments(query),
    ]);

    return res.status(200).json({
      applications,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("[admin/applications GET]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/applications/:id
// Returns the full details of a single application.
// ---------------------------------------------------------------------------
router.get("/:id", readLimiter, async (req, res) => {
  try {
    const application = await DriverApplication.findById(req.params.id)
      .select("-password -mpin")
      .lean();

    if (!application) {
      return res.status(404).json({ message: "Application not found." });
    }

    return res.status(200).json({ application });
  } catch (err) {
    console.error("[admin/applications/:id GET]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/applications/:id/approve
// Approves the application:
//   1. Checks for duplicate mobile number / license / plate in User collection
//   2. Creates a User document from the application data
//   3. Deletes the DriverApplication document
// The password and mpin are already hashed in DriverApplication — they are
// copied directly into the User document so bcrypt doesn't double-hash them.
// ---------------------------------------------------------------------------
router.post("/:id/approve", actionLimiter, async (req, res) => {
  try {
    const application = await DriverApplication.findById(req.params.id);

    if (!application) {
      return res.status(404).json({ message: "Application not found." });
    }

    if (application.status !== "pending") {
      return res.status(409).json({
        message: `Application is already ${application.status}.`,
      });
    }

    // Guard against duplicates that may have appeared since submission
    const duplicateMobile = await User.findOne({
      mobileNumber: application.mobileNumber,
      role: "driver",
    });
    if (duplicateMobile) {
      return res.status(409).json({
        message: "A driver with this mobile number already exists.",
      });
    }

    const duplicateLicense = await User.findOne({
      "driverDetails.licenseNumber": application.licenseNumber,
    });
    if (duplicateLicense) {
      return res.status(409).json({
        message: "A driver with this license number already exists.",
      });
    }

    const duplicatePlate = await User.findOne({
      "driverDetails.plateNumber": application.plateNumber,
    });
    if (duplicatePlate) {
      return res.status(409).json({
        message: "A driver with this plate number already exists.",
      });
    }

    // Build the User document.
    // Password and mpin are already bcrypt-hashed in the application —
    // we set them directly on the raw object and bypass the pre-save hook
    // by using $set via updateOne after creation. The cleanest approach is
    // to use insertOne via the Model bypassing hooks for these two fields.
    const userData = {
      firstName: application.firstName,
      lastName: application.lastName,
      mobileNumber: application.mobileNumber,
      password: application.password, // already hashed
      role: "driver",
      driverDetails: {
        licenseImgFront: application.licenseImgFront,
        licenseImgBack: application.licenseImgBack,
        licenseNumber: application.licenseNumber,
        licenseExpDate: application.licenseExpDate,
        faceImg: application.faceImg,
        idImg: application.idImg,
        tricycleOR: application.tricycleOR,
        regCert: application.regCert,
        tricycleImgFront: application.tricycleImgFront,
        tricycleImgBack: application.tricycleImgBack,
        motorcycleBrand: application.motorcycleBrand,
        plateNumber: application.plateNumber,
        mpin: application.mpin, // already hashed or null
      },
    };

    // Insert directly to bypass pre-save hashing hooks (password is
    // already hashed — running it through bcrypt again would corrupt it)
    await User.collection.insertOne({
      ...userData,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Remove the application — it is no longer needed
    await DriverApplication.findByIdAndDelete(application._id);

    await logAdminAction(req, req.user.id, "", "DRIVER_APPROVED", `Approved driver application for ${application.firstName} ${application.lastName} (License: ${application.licenseNumber})`);

    // Fire and forget: don't await so it never blocks the response!
    const approveMsg = `Finder: Your driver application is APPROVED! You can now log in.`;
    sendNotification(application.mobileNumber, approveMsg).catch(console.error);
    
    broadcastToAdmins('application_resolved', { applicationId: application._id });

    return res.status(200).json({ message: "Application approved. Driver account created." });

  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Duplicate entry detected." });
    }
    console.error("[admin/applications/:id/approve]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/applications/:id/reject
// Body: { reason } — optional rejection reason shown to driver (future use)
// Rejects the application:
//   1. Deletes all Cloudinary images immediately
//   2. Deletes the DriverApplication document
// No status transition back to pending is possible after rejection.
// ---------------------------------------------------------------------------
router.post("/:id/reject", actionLimiter, async (req, res) => {
  try {
    const application = await DriverApplication.findById(req.params.id);

    if (!application) {
      return res.status(404).json({ message: "Application not found." });
    }

    if (application.status !== "pending") {
      return res.status(409).json({
        message: `Application is already ${application.status}.`,
      });
    }

    const reason = (typeof req.body.reason === "string")
      ? req.body.reason.trim()
      : null;

    // Delete Cloudinary images first — if this fails we still proceed,
    // the error is logged but the application is deleted regardless
    await deleteCloudinaryImages(application);

    // Hard delete — rejected applications cannot resurface
    await DriverApplication.findByIdAndDelete(application._id);

    await logAdminAction(req, req.user.id, "", "DRIVER_REJECTED", `Rejected driver application for ${application.firstName} ${application.lastName} (License: ${application.licenseNumber}). Reason: ${reason || "None provided"}`);
    
    // Fire and forget
    const rejectMsg = `Finder: Your driver application was REJECTED. ${reason ? 'Reason: ' + reason : 'Please contact support.'}`;
    sendNotification(application.mobileNumber, rejectMsg).catch(console.error);

    broadcastToAdmins('application_resolved', { applicationId: application._id });

    return res.status(200).json({
      message: "Application rejected and removed.",
      reason: reason ?? null,
    });

  } catch (err) {
    console.error("[admin/applications/:id/reject]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;