const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");

const router = express.Router();

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// OTP store — separate from the login OTP store in auth.js
// Keyed by mobileNumber (string). Each entry: { code, expiresAt, attempts }
// ---------------------------------------------------------------------------
const regOtpStore = new Map();

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

// Send OTP: max 10 per 10 minutes per IP
const sendOtpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many OTP requests. Please wait before trying again." },
});

// Verify OTP: max 10 per 5 minutes per IP
const verifyOtpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please wait before trying again." },
});

// Complete registration: max 10 per 15 minutes per IP
const completeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again later." },
});

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

function validateMobileFormat(mobileNumber) {
  // Stored format: 09XXXXXXXXX (11 digits)
  const mobileRegex = /^09\d{9}$/;
  if (!mobileRegex.test(mobileNumber)) return "Invalid mobile number format.";
  return null;
}

function validatePasswordLength(password) {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password is too long.";
  return null;
}

function validateName(value, field) {
  if (!value || !value.trim()) return `${field} is required.`;
  if (value.trim().length > 50) return `${field} is too long.`;
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

/**
 * Signs a registration token with a stage field.
 * stage 'otp'      — can only call /register/verify-otp
 * stage 'complete' — can only call /register/complete
 */
function signRegistrationToken(mobileNumber, stage) {
  return jwt.sign(
    { mobileNumber, stage, type: "registration" },
    process.env.JWT_SECRET,
    { expiresIn: "15m" }
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

  // Keyed by mobileNumber — one pending registration per number at a time
  regOtpStore.set(mobileNumber, { code, expiresAt, attempts: 0 });
}

function verifyOtp(mobileNumber, submittedCode) {
  const entry = regOtpStore.get(mobileNumber);

  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { regOtpStore.delete(mobileNumber); return false; }

  if (submittedCode !== entry.code) {
    entry.attempts += 1;
    if (entry.attempts >= 10) regOtpStore.delete(mobileNumber);
    return false;
  }

  regOtpStore.delete(mobileNumber); // correct — consume it
  return true;
}

// ---------------------------------------------------------------------------
// POST /register/send-otp
// Body: { mobileNumber } — must be in 09XXXXXXXXX format (server receives it ready)
// ---------------------------------------------------------------------------
router.post("/send-otp", sendOtpLimiter, async (req, res) => {
  let { mobileNumber } = req.body;

  if (typeof mobileNumber !== "string") {
    return res.status(400).json({ message: "Invalid input." });
  }

  mobileNumber = mobileNumber.trim();

  const mobileError = validateMobileFormat(mobileNumber);
  if (mobileError) return res.status(400).json({ message: mobileError });

  try {
    // Block if number is already registered as a passenger
    const existing = await User.findOne({ mobileNumber, role: "passenger" });
    if (existing) {
      return res.status(409).json({ message: "This number is already registered." });
    }

    await sendOtp(mobileNumber);

    return res.status(200).json({
      registrationToken: signRegistrationToken(mobileNumber, "otp"),
      message: "OTP sent to your mobile number.",
    });
  } catch (err) {
    console.error("[register/send-otp]", err);
    return res.status(500).json({ message: "Failed to send OTP. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /register/resend-otp
// Header: Authorization: Bearer <registrationToken stage='otp'>
// ---------------------------------------------------------------------------
router.post("/resend-otp", sendOtpLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);

    if (decoded.type !== "registration" || decoded.stage !== "otp") {
      return res.status(400).json({ message: "Invalid registration token." });
    }

    await sendOtp(decoded.mobileNumber);

    // Issue a fresh token to reset the 15-min window
    return res.status(200).json({
      registrationToken: signRegistrationToken(decoded.mobileNumber, "otp"),
      message: "OTP resent.",
    });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    console.error("[register/resend-otp]", err);
    return res.status(500).json({ message: "Failed to resend OTP." });
  }
});

// ---------------------------------------------------------------------------
// POST /register/verify-otp
// Body: { code }
// Header: Authorization: Bearer <registrationToken stage='otp'>
// ---------------------------------------------------------------------------
router.post("/verify-otp", verifyOtpLimiter, async (req, res) => {
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

    if (decoded.type !== "registration" || decoded.stage !== "otp") {
      return res.status(400).json({ message: "Invalid registration token." });
    }

    const isValid = verifyOtp(decoded.mobileNumber, code);
    if (!isValid) {
      return res.status(401).json({ message: "Invalid or expired OTP." });
    }

    // Advance stage — this token is the only thing that can call /complete
    return res.status(200).json({
      registrationToken: signRegistrationToken(decoded.mobileNumber, "complete"),
      message: "OTP verified.",
    });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    console.error("[register/verify-otp]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /register/complete
// Body: { firstName, lastName, password, confirmPassword }
// Header: Authorization: Bearer <registrationToken stage='complete'>
// ---------------------------------------------------------------------------
router.post("/complete", completeLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);

    if (decoded.type !== "registration" || decoded.stage !== "complete") {
      return res.status(400).json({ message: "Invalid registration token." });
    }

    let { firstName, lastName, password, confirmPassword } = req.body;

    if (
      typeof firstName !== "string" ||
      typeof lastName !== "string" ||
      typeof password !== "string" ||
      typeof confirmPassword !== "string"
    ) {
      return res.status(400).json({ message: "Invalid input types." });
    }

    firstName = firstName.trim();
    lastName = lastName.trim();
    password = password.trim();

    const firstNameError = validateName(firstName, "First name");
    if (firstNameError) return res.status(400).json({ message: firstNameError });

    const lastNameError = validateName(lastName, "Last name");
    if (lastNameError) return res.status(400).json({ message: lastNameError });

    const passwordError = validatePasswordLength(password);
    if (passwordError) return res.status(400).json({ message: passwordError });

    if (password !== confirmPassword.trim()) {
      return res.status(400).json({ message: "Passwords do not match." });
    }

    // Guard against the number being registered between OTP verify and complete
    const existing = await User.findOne({ mobileNumber: decoded.mobileNumber, role: "passenger" });
    if (existing) {
      return res.status(409).json({ message: "This number is already registered." });
    }

    // bcrypt hashing is handled by the User model's pre-save hook
    const user = new User({
      firstName,
      lastName,
      mobileNumber: decoded.mobileNumber,
      password,
      role: "passenger",
    });

    await user.save();

    return res.status(201).json({ message: "Account created successfully." });

  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    if (err.code === 11000) {
      return res.status(409).json({ message: "This number is already registered." });
    }
    console.error("[register/complete]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;