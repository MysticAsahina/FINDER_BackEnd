const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");

const router = express.Router();

// OTP expires in 5 minutes
const OTP_EXPIRY_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// OTP store
// Keyed by userId (string) so multiple users can have active OTPs at once.
// Each entry: { code, expiresAt, attempts }
// ---------------------------------------------------------------------------
const otpStore = new Map();

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

// Login: max 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again in 15 minutes." },
});

// OTP submit: max 10 attempts per 5 minutes per IP
const otpSubmitLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many OTP attempts. Please wait before trying again." },
});

// OTP resend: max 1 per 5 minutes per IP
const otpResendLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many resend requests. Please wait before requesting another OTP." },
});

// ---------------------------------------------------------------------------
// Field validators
// Each function returns an error message string if invalid, null if valid.
// ---------------------------------------------------------------------------

function validateEmailFormat(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return "Invalid email format.";
  return null;
}

function validateEmailLength(email) {
  if (email.length > 254) return "Email is too long.";
  return null;
}

function validatePasswordLength(password) {
  // Upper cap prevents bcrypt DoS via oversized inputs
  if (password.length > 128) return "Password is too long.";
  return null;
}

function validateMobileFormat(mobileNumber) {
  // PH mobile format: 09XXXXXXXXX (11 digits starting with 09)
  const mobileRegex = /^09\d{9}$/;
  if (!mobileRegex.test(mobileNumber)) return "Invalid mobile number format.";
  return null;
}

// ---------------------------------------------------------------------------
// Input sanitization
// Calls the individual validators above and throws on any failure.
// ---------------------------------------------------------------------------

function sanitizeAdminLogin(body) {
  let { email, password } = body;

  if (typeof email !== "string" || typeof password !== "string") {
    throw Object.assign(new Error("Invalid input types."), { status: 400 });
  }

  email = email.trim().toLowerCase();
  password = password.trim();

  if (!email || !password) {
    throw Object.assign(new Error("Email and password are required."), { status: 400 });
  }

  const emailFormatError = validateEmailFormat(email);
  if (emailFormatError) throw Object.assign(new Error(emailFormatError), { status: 400 });

  const emailLengthError = validateEmailLength(email);
  if (emailLengthError) throw Object.assign(new Error(emailLengthError), { status: 400 });

  const passwordLenError = validatePasswordLength(password);
  if (passwordLenError) throw Object.assign(new Error(passwordLenError), { status: 400 });

  return { email, password };
}

function sanitizeMobileLogin(body) {
  let { mobileNumber, password } = body;

  if (typeof mobileNumber !== "string" || typeof password !== "string") {
    throw Object.assign(new Error("Invalid input types."), { status: 400 });
  }

  mobileNumber = mobileNumber.trim();
  password = password.trim();

  if (!mobileNumber || !password) {
    throw Object.assign(new Error("Mobile number and password are required."), { status: 400 });
  }

  const mobileFormatError = validateMobileFormat(mobileNumber);
  if (mobileFormatError) throw Object.assign(new Error(mobileFormatError), { status: 400 });

  const passwordLenError = validatePasswordLength(password);
  if (passwordLenError) throw Object.assign(new Error(passwordLenError), { status: 400 });

  return { mobileNumber, password };
}

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

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

// Converts number to E164 format, used for OTP
function toE164(mobileNumber) {
  return '+63' + mobileNumber.slice(1);
}

async function sendOtp(userId, mobileNumber) {
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
      phoneNumbers: [ recipient ],
      textMessage: {text: `Your verification code is ${code}. It expires in 5 minutes. Do not share this with anyone.`},
    }),
  });

  console.log("Code: " + code);
  const data = await response.json();

  if (!response.ok) {
    const err = new Error(data.message || "Failed to send OTP.");
    err.smsStatus = response.status;
    err.smsCode   = data.code;
    throw err;
  } */

  console.log("Code: " + code);
  otpStore.set(String(userId), { code, expiresAt, attempts: 0 });
}

function verifyOtp(userId, submittedCode) {
  const key = String(userId);
  const entry = otpStore.get(key);

  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { otpStore.delete(key); return false; }

  if (submittedCode !== entry.code) {
    entry.attempts += 1;
    if (entry.attempts >= 3) otpStore.delete(key); // burn after 3 wrong attempts
    return false;
  }

  otpStore.delete(key); // correct — consume it
  return true;
}

// ---------------------------------------------------------------------------
// Role-specific login strategies
// ---------------------------------------------------------------------------

async function loginAdmin(req, res) {
  let email, password;
  try {
    ({ email, password } = sanitizeAdminLogin(req.body));
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.message });
  }

  const user = await User.findOne({ email, role: "admin" });
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
  let mobileNumber, password;
  try {
    ({ mobileNumber, password } = sanitizeMobileLogin(req.body));
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.message });
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
  let mobileNumber, password;
  try {
    ({ mobileNumber, password } = sanitizeMobileLogin(req.body));
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.message });
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
  admin: loginAdmin,
  passenger: loginPassenger,
  driver: loginDriver,
};

// POST /auth/login
router.post("/login", loginLimiter, async (req, res) => {
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
// ---------------------------------------------------------------------------
router.post("/resend-otp", otpResendLimiter, async (req, res) => {
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
router.post("/verify-otp", otpSubmitLimiter, async (req, res) => {
  const { code } = req.body;
  const authHeader = req.headers.authorization;

  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ message: "A valid 6-digit OTP code is required." });
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

    if (user.role === "admin") userPayload.email = user.email;
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