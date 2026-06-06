const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const cloudinary = require("cloudinary").v2;
const cron = require("node-cron");
const DriverApplication = require("../models/DriverApplication");
const User = require("../models/User");

// Configure Cloudinary from env
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const router = express.Router();

// ---------------------------------------------------------------------------
// Cloudinary cleanup job
// Runs daily at 2:00 AM Philippine Time (UTC+8).
// Deletes any assets still tagged 'driver-reg-temp' that are older than
// 24 hours — these are definitively abandoned registrations.
// Submitted applications have their tags replaced to 'driver-application'
// at submit time, so they are never touched by this job.
// ---------------------------------------------------------------------------
async function cleanupTempUploads() {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const result = await cloudinary.api.resources({
      type: "upload",
      prefix: "driver-applications/",
      tags: true,
      max_results: 500,
    });

    const toDelete = result.resources
      .filter(r =>
        r.tags?.includes("driver-reg-temp") &&
        r.created_at < oneDayAgo
      )
      .map(r => r.public_id);

    if (toDelete.length > 0) {
      await cloudinary.api.delete_resources(toDelete);
      console.log(`[cleanup] Deleted ${toDelete.length} abandoned temp upload(s).`);
    } else {
      console.log("[cleanup] No abandoned temp uploads found.");
    }
  } catch (err) {
    console.error("[cleanup] Failed to run Cloudinary cleanup:", err);
  }
}

// Asia/Manila is UTC+8 — Philippine Standard Time
// TODO: for some reason cleanup does not detect tagged images that are temp
cron.schedule("0 2 * * *", cleanupTempUploads, {
  timezone: "Asia/Manila",
});

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// OTP store — keyed by mobileNumber
// ---------------------------------------------------------------------------
const otpStore = new Map();

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

// Signature: max 20 per 30 minutes per IP
// This is the chokepoint for Cloudinary abuse — see driverRegister.js notes
const signatureLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many upload requests. Please wait before trying again." },
});

// OTP send/resend: max 10 per 10 minutes per IP
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many OTP requests. Please wait before trying again." },
});

// Submit: max 5 per 30 minutes per IP
const submitLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many submission attempts. Please wait before trying again." },
});

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

function validateMobileFormat(mobileNumber) {
  const mobileRegex = /^09\d{9}$/;
  if (!mobileRegex.test(mobileNumber)) return "Invalid mobile number format.";
  return null;
}

function validatePasswordLength(password) {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password is too long.";
  return null;
}

function validateMpinFormat(mpin) {
  if (!/^\d{4}$/.test(mpin)) return "MPIN must be exactly 4 digits.";
  return null;
}

function validateName(value, field) {
  if (!value || !value.trim()) return `${field} is required.`;
  if (value.trim().length > 50) return `${field} is too long.`;
  return null;
}

function validateUrl(value, field) {
  if (!value || typeof value !== "string" || !value.startsWith("https://")) {
    return `${field} must be a valid Cloudinary URL.`;
  }
  return null;
}

function validateLicenseNumber(value) {
  if (!value || !value.trim()) return "License number is required.";
  if (value.trim().length > 20) return "License number is too long.";
  return null;
}

function validatePlateNumber(value) {
  if (!value || !value.trim()) return "Plate number is required.";
  if (value.trim().length > 10) return "Plate number is too long.";
  return null;
}

function validateMotorcycleBrand(value) {
  if (!value || !value.trim()) return "Motorcycle brand is required.";
  if (value.trim().length > 50) return "Motorcycle brand is too long.";
  return null;
}

function validateLicenseExpDate(value) {
  const date = new Date(value);
  if (isNaN(date.getTime())) return "Invalid license expiration date.";
  if (date < new Date()) return "License expiration date must be in the future.";
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function signDriverRegToken(firstName, lastName, mobileNumber) {
  return jwt.sign(
    { firstName, lastName, mobileNumber, type: "driver-registration" },
    process.env.JWT_SECRET,
    { expiresIn: "2h" } // longer window — multi-screen flow takes time
  );
}

// Converts number to E164 format, used for OTP
function toE164(mobileNumber) {
  return '+63' + mobileNumber.slice(1);
}

async function sendOtp(mobileNumber) {
  const code = generateOtp();
  const expiresAt = Date.now() + OTP_EXPIRY_MS;
  const recipient = toE164(mobileNumber);

  const apiUsername = process.env.SMS_GATE_USERNAME;
  const apiPassword = process.env.SMS_GATE_PASSWORD;

  /* Temporary remove due to lack of load
  const response = await fetch("https://api.sms-gate.app/3rdparty/v1/messages", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${apiUsername}:${apiPassword}`),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phoneNumbers: [recipient],
      textMessage: { text: `Your verification code is ${code}. It expires in 5 minutes. Do not share this with anyone.` },
    }),
  }); */

  console.log("Code: " + code);
  const data = await response.json();

  if (!response.ok) {
    const err = new Error(data.message || "Failed to send OTP.");
    err.smsStatus = response.status;
    err.smsCode = data.code;
    throw err;
  }

  otpStore.set(mobileNumber, { code, expiresAt, attempts: 0 });
}

function verifyOtp(mobileNumber, submittedCode) {
  const entry = otpStore.get(mobileNumber);

  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { otpStore.delete(mobileNumber); return false; }

  if (submittedCode !== entry.code) {
    entry.attempts += 1;
    if (entry.attempts >= 10) otpStore.delete(mobileNumber);
    return false;
  }

  otpStore.delete(mobileNumber);
  return true;
}

// ---------------------------------------------------------------------------
// POST /driver-register/send-otp
// Body: { firstName, lastName, mobileNumber }
// First screen submission — validates personal info and sends OTP.
// ---------------------------------------------------------------------------
router.post("/send-otp", otpLimiter, async (req, res) => {
  let { firstName, lastName, mobileNumber } = req.body;

  if (
    typeof firstName !== "string" ||
    typeof lastName !== "string" ||
    typeof mobileNumber !== "string"
  ) {
    return res.status(400).json({ message: "Invalid input types." });
  }

  firstName = firstName.trim();
  lastName = lastName.trim();
  mobileNumber = mobileNumber.trim();

  const firstNameError = validateName(firstName, "First name");
  if (firstNameError) return res.status(400).json({ message: firstNameError });

  const lastNameError = validateName(lastName, "Last name");
  if (lastNameError) return res.status(400).json({ message: lastNameError });

  const mobileError = validateMobileFormat(mobileNumber);
  if (mobileError) return res.status(400).json({ message: mobileError });

  try {
    // Block if number already has a pending application
    const existingApplication = await DriverApplication.findOne({
      mobileNumber,
      status: "pending",
    });
    if (existingApplication) {
      return res.status(409).json({
        message: "A pending application already exists for this number.",
      });
    }

    // Block if number is already a registered driver
    const existingUser = await User.findOne({ mobileNumber, role: "driver" });
    if (existingUser) {
      return res.status(409).json({ message: "This number is already registered as a driver." });
    }

    await sendOtp(mobileNumber);

    // Embed personal info in the token so it carries forward
    const token = jwt.sign(
      { firstName, lastName, mobileNumber, type: "driver-registration" },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    return res.status(200).json({
      driverRegToken: token,
      message: "OTP sent to your mobile number.",
    });
  } catch (err) {
    console.error("[driver-register/send-otp]", err);
    return res.status(500).json({ message: "Failed to send OTP. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /driver-register/resend-otp
// Header: Authorization: Bearer <driverRegToken>
// ---------------------------------------------------------------------------
router.post("/resend-otp", otpLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);

    if (decoded.type !== "driver-registration") {
      return res.status(400).json({ message: "Invalid token." });
    }

    await sendOtp(decoded.mobileNumber);

    return res.status(200).json({ message: "OTP resent." });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    console.error("[driver-register/resend-otp]", err);
    return res.status(500).json({ message: "Failed to resend OTP." });
  }
});

// ---------------------------------------------------------------------------
// POST /driver-register/verify-otp
// Body: { code }
// Header: Authorization: Bearer <driverRegToken>
// ---------------------------------------------------------------------------
router.post("/verify-otp", rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many OTP attempts. Please wait before trying again." },
}), async (req, res) => {
  const { code } = req.body;
  const authHeader = req.headers.authorization;

  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ message: "A valid 6-digit code is required." });
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);

    if (decoded.type !== "driver-registration") {
      return res.status(400).json({ message: "Invalid token." });
    }

    const isValid = verifyOtp(decoded.mobileNumber, code);
    if (!isValid) {
      return res.status(401).json({ message: "Invalid or expired OTP." });
    }

    // Re-sign the same token — OTP is now verified, same payload carries forward
    return res.status(200).json({
      driverRegToken: signDriverRegToken(decoded.firstName, decoded.lastName, decoded.mobileNumber),
      message: "OTP verified.",
    });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    console.error("[driver-register/verify-otp]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /driver-register/cloudinary-signature
// Generates a signed upload signature for the app to upload directly.
// Header: Authorization: Bearer <driverRegToken>
// Body: { folder } — optional, e.g. "driver-applications"
//
// The app uploads directly to Cloudinary using this signature.
// All images are tagged 'driver-reg-temp' and auto-deleted by Cloudinary
// after 1 hour if the application is never submitted.
// ---------------------------------------------------------------------------
router.post("/cloudinary-signature", signatureLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);

    if (decoded.type !== "driver-registration") {
      return res.status(400).json({ message: "Invalid token." });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const folder = "driver-applications";
    const tags = "driver-reg-temp";

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
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    console.error("[driver-register/cloudinary-signature]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /driver-register/submit
// Receives the complete driver application in one payload.
// Header: Authorization: Bearer <driverRegToken>
// Body: all fields listed below
// ---------------------------------------------------------------------------
router.post("/submit", submitLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);

    if (decoded.type !== "driver-registration") {
      return res.status(400).json({ message: "Invalid token." });
    }

    const {
      // Personal info (carried in token from screen 1)
      firstName,
      lastName,
      // License
      licenseImgFront,
      licenseImgBack,
      licenseNumber,
      licenseExpDate,
      // Face verification
      faceImg,
      idImg,
      // Vehicle registration
      tricycleOR,
      regCert,
      // Tricycle details
      tricycleImgFront,
      tricycleImgBack,
      motorcycleBrand,
      plateNumber,
      // Credentials
      password,
      confirmPassword,
      mpin, // optional
      // Cloudinary public IDs (for potential cleanup)
      cloudinaryPublicIds,
    } = req.body;

    // --- Type checks ---
    const stringFields = {
      licenseImgFront, licenseImgBack, licenseNumber,
      faceImg, idImg, tricycleOR, regCert,
      tricycleImgFront, tricycleImgBack, motorcycleBrand, plateNumber,
      password, confirmPassword,
    };

    for (const [key, val] of Object.entries(stringFields)) {
      if (typeof val !== "string") {
        return res.status(400).json({ message: `Invalid value for ${key}.` });
      }
    }

    // --- Field validation ---
    const urlFields = {
      licenseImgFront, licenseImgBack,
      faceImg, idImg, tricycleOR, regCert,
      tricycleImgFront, tricycleImgBack,
    };

    for (const [key, val] of Object.entries(urlFields)) {
      const err = validateUrl(val, key);
      if (err) return res.status(400).json({ message: err });
    }

    const licenseNumberError = validateLicenseNumber(licenseNumber);
    if (licenseNumberError) return res.status(400).json({ message: licenseNumberError });

    const licenseExpError = validateLicenseExpDate(licenseExpDate);
    if (licenseExpError) return res.status(400).json({ message: licenseExpError });

    const plateError = validatePlateNumber(plateNumber);
    if (plateError) return res.status(400).json({ message: plateError });

    const brandError = validateMotorcycleBrand(motorcycleBrand);
    if (brandError) return res.status(400).json({ message: brandError });

    const passwordError = validatePasswordLength(password.trim());
    if (passwordError) return res.status(400).json({ message: passwordError });

    if (password.trim() !== confirmPassword.trim()) {
      return res.status(400).json({ message: "Passwords do not match." });
    }

    if (mpin !== undefined && mpin !== null && mpin !== "") {
      const mpinError = validateMpinFormat(mpin);
      if (mpinError) return res.status(400).json({ message: mpinError });
    }

    // --- Duplicate checks ---
    const existingApplication = await DriverApplication.findOne({
      mobileNumber: decoded.mobileNumber,
      status: "pending",
    });
    if (existingApplication) {
      return res.status(409).json({
        message: "A pending application already exists for this number.",
      });
    }

    const existingUser = await User.findOne({
      mobileNumber: decoded.mobileNumber,
      role: "driver",
    });
    if (existingUser) {
      return res.status(409).json({ message: "This number is already registered as a driver." });
    }

    const existingLicense = await DriverApplication.findOne({
      licenseNumber: licenseNumber.trim(),
    });
    if (existingLicense) {
      return res.status(409).json({ message: "This license number is already in use." });
    }

    const existingPlate = await DriverApplication.findOne({
      plateNumber: plateNumber.trim().toUpperCase(),
    });
    if (existingPlate) {
      return res.status(409).json({ message: "This plate number is already in use." });
    }

    // --- Save application ---
    // Password and mpin are hashed by DriverApplication pre-save hooks
    const application = new DriverApplication({
      firstName: decoded.firstName,
      lastName: decoded.lastName,
      mobileNumber: decoded.mobileNumber,
      licenseImgFront,
      licenseImgBack,
      licenseNumber: licenseNumber.trim(),
      licenseExpDate: new Date(licenseExpDate),
      faceImg,
      idImg,
      tricycleOR,
      regCert,
      tricycleImgFront,
      tricycleImgBack,
      motorcycleBrand: motorcycleBrand.trim(),
      plateNumber: plateNumber.trim().toUpperCase(),
      password: password.trim(),
      mpin: (mpin && mpin.trim()) ? mpin.trim() : null,
      cloudinaryPublicIds: cloudinaryPublicIds ?? {},
    });

    await application.save();

    // Replace temp tag with permanent tag so the cleanup job never touches
    // images belonging to a submitted application
    const publicIds = Object.values(cloudinaryPublicIds ?? {}).filter(Boolean);
    if (publicIds.length > 0) {
      try {
        await cloudinary.uploader.replace_tag("driver-application", publicIds);
      } catch (tagErr) {
        // Non-fatal — application is saved, tag replacement is best-effort
        console.error("[driver-register/submit] Tag replacement failed:", tagErr);
      }
    }

    return res.status(201).json({
      message: "Application submitted successfully. Please wait for admin approval.",
    });

  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    if (err.code === 11000) {
      return res.status(409).json({ message: "Duplicate entry detected. Please check your details." });
    }
    console.error("[driver-register/submit]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;