const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const twilio = require("twilio");

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const VERIFIED_TEST_NUMBER = "+447868223964";

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Full access token — issued only after OTP is verified.
 */
function signToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "24h" }
  );
}

/**
 * Pending token — issued right after credentials pass, before OTP.
 * Short-lived (10 min). The verify-otp endpoint checks pending: true
 * to distinguish it from a real access token.
 */
function signPendingToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, pending: true },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
}

/**
 * Shared 401 — intentionally vague to prevent credential enumeration.
 */
const invalidCredentials = (res) =>
  res.status(401).json({ message: "Invalid credentials." });

// E.164 converter
function toE164(mobileNumber) {
  return mobileNumber.replace(/^0/, "+63");
}

/**
 * Sends OTP via Twilio Verify to the given number.
 * mobileNumber must be E.164 format: +639XXXXXXXXX
 */
async function sendOtp(mobileNumber) {
  const converted = toE164(mobileNumber);
  await client.verify.v2
    .services(process.env.TWILIO_VERIFY_SID)
    .verifications.create({ to: VERIFIED_TEST_NUMBER, channel: "sms" });
}

// ---------------------------------------------------------------------------
// Role-specific login strategies
// All strategies now:
//   1. Validate credentials
//   2. Send OTP to the user's mobileNumber
//   3. Return a short-lived pending token (no user data yet)
// The real token is issued only after OTP is verified at /auth/verify-otp.
// ---------------------------------------------------------------------------

// Admin
async function loginAdmin(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  const user = await User.findOne({ email: email.toLowerCase(), role: "admin" });
  if (!user) return invalidCredentials(res);

  const isMatch = await user.comparePassword(password);
  if (!isMatch) return invalidCredentials(res);

  /* Temporary no OTP direct route, you know how to change this */

    const token = signToken(user);

    const userPayload = {
      id: user._id,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      mobileNumber: user.mobileNumber,
    };

    if (user.role === "admin")     userPayload.email   = user.email;
    if (user.role === "driver")    userPayload.hasMpin = !!user.driverDetails?.mpin;

    return res.status(200).json({ token, user: userPayload });

  /* Code for test OTP
  await sendOtp(user.mobileNumber);

  return res.status(200).json({
    pendingToken: signPendingToken(user),
    message: "Credentials verified. OTP sent to your registered mobile number.",
  });
  */
}

// Passenger
async function loginPassenger(req, res) {
  const { mobileNumber, password } = req.body;

  if (!mobileNumber || !password) {
    return res.status(400).json({ message: "Mobile number and password are required." });
  }

  const user = await User.findOne({ mobileNumber, role: "passenger" });
  if (!user) return invalidCredentials(res);

  const isMatch = await user.comparePassword(password);
  if (!isMatch) return invalidCredentials(res);

  await sendOtp(user.mobileNumber);

  return res.status(200).json({
    pendingToken: signPendingToken(user),
    message: "Credentials verified. OTP sent to your registered mobile number.",
  });
}

// Driver
async function loginDriver(req, res) {
  const { mobileNumber, password } = req.body;

  if (!mobileNumber || !password) {
    return res.status(400).json({ message: "Mobile number and password are required." });
  }

  const user = await User.findOne({ mobileNumber, role: "driver" });
  if (!user) return invalidCredentials(res);

  const isMatch = await user.comparePassword(password);
  if (!isMatch) return invalidCredentials(res);

  await sendOtp(user.mobileNumber);

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
// Body: { role, email?, mobileNumber?, password }
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

    if (err.code === 21608) {
      return res.status(403).json({
        message: "This number is not verified in your Twilio trial account.",
      });
    }

    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/verify-otp
// Completes the login flow. Requires the pending token from /auth/login.
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
    const decoded = jwt.verify(
      authHeader.split(" ")[1],
      process.env.JWT_SECRET
    );

    // Reject real tokens — only pending tokens are accepted here
    if (!decoded.pending) {
      return res.status(400).json({ message: "A pending token is required." });
    }

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const check = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: VERIFIED_TEST_NUMBER, code });

    if (check.status !== "approved") {
      return res.status(401).json({ message: "Invalid or expired OTP." });
    }

    // OTP passed — issue the real access token and return user data
    const token = signToken(user);

    const userPayload = {
      id: user._id,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      mobileNumber: user.mobileNumber,
    };

    if (user.role === "admin")     userPayload.email   = user.email;
    if (user.role === "driver")    userPayload.hasMpin = !!user.driverDetails?.mpin;

    return res.status(200).json({ token, user: userPayload });

  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    if (err.code === 20404) {
      return res.status(401).json({ message: "Invalid or expired OTP." });
    }
    console.error("[auth/verify-otp]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/verify-mpin  (driver only, requires real JWT)
// Used as a secondary action gate — NOT a login step.
// Body: { mpin }
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
    const decoded = jwt.verify(
      authHeader.split(" ")[1],
      process.env.JWT_SECRET
    );

    // Reject pending tokens — mpin requires a fully authenticated session
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