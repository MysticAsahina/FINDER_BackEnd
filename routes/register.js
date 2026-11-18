const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const { validateName, validateMobileFormat, validatePasswordPolicy } = require('../utils/validators');
const { sendSmsOtp, verifyOtp } = require("../utils/otpManager");

const router = express.Router();

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

/**
 * Signs a registration token with a stage field.
 * stage 'otp'      — can only call /register/verify-otp
 * stage 'complete' — can only call /register/complete
 */
function signRegistrationToken(mobileNumber, stage) {
  return jwt.sign(
    { mobileNumber, stage, type: "registration" },
    process.env.REGISTER_SECRET,
    { expiresIn: "15m" }
  );
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

    await sendSmsOtp(mobileNumber, mobileNumber);

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
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.REGISTER_SECRET);

    if (decoded.type !== "registration" || decoded.stage !== "otp") {
      return res.status(400).json({ message: "Invalid registration token." });
    }

    await sendSmsOtp(decoded.mobileNumber, decoded.mobileNumber);

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
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.REGISTER_SECRET);

    if (decoded.type !== "registration" || decoded.stage !== "otp") {
      return res.status(400).json({ message: "Invalid registration token." });
    }

    const otpResult = verifyOtp(decoded.mobileNumber, code);
    if (!otpResult.valid) {
      return res.status(401).json({ message: otpResult.message || "Invalid or expired OTP." });
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
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.REGISTER_SECRET);

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

    const passwordError = validatePasswordPolicy(password);
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