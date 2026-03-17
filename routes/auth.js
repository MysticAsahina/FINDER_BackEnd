const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");

const router = express.Router();

// ---------------------------------------------------------------------------
// OTP store
// Keyed by userId (string) so multiple users can have active OTPs at once.
// Each entry: { code, expiresAt }
// ---------------------------------------------------------------------------
const otpStore = new Map();

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "24h" }
  );
}

function signPendingToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, pending: true },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
}

const invalidCredentials = (res) =>
  res.status(401).json({ message: "Invalid credentials." });

// E.164 converter
function toE164(mobileNumber) {
  return mobileNumber.replace(/^0/, "+63");
}

/**
 * Generates a cryptographically random 6-digit OTP string.
 */
function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

/**
 * Sends OTP via smsapiph and stores the code against the userId.
 * Overwrites any existing OTP for that user (handles resend).
 */
async function sendOtp(userId, mobileNumber) {
  const code = generateOtp();
  const expiresAt = Date.now() + OTP_EXPIRY_MS;

  /* This does not work right now, DO NOT USE:
  const response = await fetch("https://smsapiph.onrender.com/api/v1/send/sms", {
    method: "POST",
    headers: {
      "x-api-key": process.env.SMSAPIPH_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient: mobileNumber,
      message: `Your verification code is ${code}. It expires in 5 minutes. Do not share this with anyone.`,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    const err = new Error(data.message || "Failed to send OTP.");
    err.smsStatus = response.status;
    err.smsCode = data.code;
    throw err;
  }
  */

  // TODO: replace with real SMS provider before production
  console.log(`[DEV OTP] code for ${mobileNumber}: ${code}`);

  // Store after successful send — keyed by userId so each user is independent
  otpStore.set(String(userId), { code, expiresAt, attempts: 0 });
}

/**
 * Verifies a submitted code against the store.
 * Returns true on match, false otherwise.
 * Deletes the entry on any outcome (one-time use).
 */
function verifyOtp(userId, submittedCode) {
  const key = String(userId);
  const entry = otpStore.get(key);

  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;
  if (submittedCode !== entry.code) {
    entry.attempts += 1;
    if (entry.attempts >= 3) otpStore.delete(key); // burn after 3 wrong attempts
    return false;
  }

  otpStore.delete(key); // consume after correct OTP submission
  return true;
}

// ---------------------------------------------------------------------------
// Role-specific login strategies
// ---------------------------------------------------------------------------

async function loginAdmin(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  const user = await User.findOne({ email: email.toLowerCase(), role: "admin" });
  if (!user) return invalidCredentials(res);

  const isMatch = await user.comparePassword(password);
  if (!isMatch) return invalidCredentials(res);

  await sendOtp(user._id, user.mobileNumber);

  return res.status(200).json({
    pendingToken: signPendingToken(user),
    message: "Credentials verified. OTP sent to your registered mobile number.",
  });
}

async function loginPassenger(req, res) {
  const { mobileNumber, password } = req.body;

  if (!mobileNumber || !password) {
    return res.status(400).json({ message: "Mobile number and password are required." });
  }

  const user = await User.findOne({ mobileNumber, role: "passenger" });
  if (!user) return invalidCredentials(res);

  const isMatch = await user.comparePassword(password);
  if (!isMatch) return invalidCredentials(res);

  await sendOtp(user._id, user.mobileNumber);

  return res.status(200).json({
    pendingToken: signPendingToken(user),
    message: "Credentials verified. OTP sent to your registered mobile number.",
  });
}

async function loginDriver(req, res) {
  const { mobileNumber, password } = req.body;

  if (!mobileNumber || !password) {
    return res.status(400).json({ message: "Mobile number and password are required." });
  }

  const user = await User.findOne({ mobileNumber, role: "driver" });
  if (!user) return invalidCredentials(res);

  const isMatch = await user.comparePassword(password);
  if (!isMatch) return invalidCredentials(res);

  await sendOtp(user._id, user.mobileNumber);

  return res.status(200).json({
    pendingToken: signPendingToken(user),
    message: "Credentials verified. OTP sent to your registered mobile number.",
  });
}

// ---------------------------------------------------------------------------
// Route dispatcher
// ---------------------------------------------------------------------------

const strategies = {
  admin:     loginAdmin,
  passenger: loginPassenger,
  driver:    loginDriver,
};

// POST /auth/login
router.post("/login", async (req, res) => {
  const { role } = req.body;

  if (!role || !strategies[role]) {
    return res.status(400).json({
      message: "A valid role is required (admin, passenger, or driver).",
    });
  }

  try {
    await strategies[role](req, res);
  } catch (err) {
    console.error(`[auth/login:${role}]`, err);
    return res.status(500).json({ message: "Failed to send OTP. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/resend-otp
// Re-sends a fresh OTP. Requires the pending token.
// ---------------------------------------------------------------------------
router.post("/resend-otp", async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);

    if (!decoded.pending) {
      return res.status(400).json({ message: "A pending token is required." });
    }

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    await sendOtp(user._id, user.mobileNumber);

    return res.status(200).json({ message: "OTP resent." });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    console.error("[auth/resend-otp]", err);
    return res.status(500).json({ message: "Failed to resend OTP." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/verify-otp
// Body: { code }
// Header: Authorization: Bearer <pendingToken>
// ---------------------------------------------------------------------------
router.post("/verify-otp", async (req, res) => {
  const { code } = req.body;
  const authHeader = req.headers.authorization;

  if (!code) {
    return res.status(400).json({ message: "OTP code is required." });
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);

    if (!decoded.pending) {
      return res.status(400).json({ message: "A pending token is required." });
    }

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const isValid = verifyOtp(user._id, code);
    if (!isValid) {
      return res.status(401).json({ message: "Invalid or expired OTP." });
    }

    const token = signToken(user);

    const userPayload = {
      id: user._id,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      mobileNumber: user.mobileNumber,
    };

    if (user.role === "admin")  userPayload.email   = user.email;
    if (user.role === "driver") userPayload.hasMpin = !!user.driverDetails?.mpin;

    return res.status(200).json({ token, user: userPayload });

  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    console.error("[auth/verify-otp]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/verify-mpin  (driver only, requires real JWT)
// ---------------------------------------------------------------------------
router.post("/verify-mpin", async (req, res) => {
  const { mpin } = req.body;
  const authHeader = req.headers.authorization;

  if (!mpin) {
    return res.status(400).json({ message: "mpin is required." });
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);

    if (decoded.pending) {
      return res.status(401).json({ message: "Complete OTP verification first." });
    }

    if (decoded.role !== "driver") {
      return res.status(403).json({ message: "mpin verification is for drivers only." });
    }

    const driver = await User.findById(decoded.id);
    if (!driver) return res.status(404).json({ message: "User not found." });

    const isMatch = await driver.compareMpin(mpin);
    if (!isMatch) return res.status(401).json({ message: "Invalid mpin." });

    return res.status(200).json({ verified: true });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    console.error("[auth/verify-mpin]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;