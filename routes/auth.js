const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const { logAdminAction } = require("../utils/auditLogger");
const { sendSmsOtp: sendOtp, verifyOtp } = require("../utils/otpManager");

const router = express.Router();

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

  email    = email.trim().toLowerCase();
  password = password.trim();

  if (!email || !password) {
    throw Object.assign(new Error("Email and password are required."), { status: 400 });
  }

  const emailFormatError  = validateEmailFormat(email);
  if (emailFormatError)   throw Object.assign(new Error(emailFormatError),  { status: 400 });

  const emailLengthError  = validateEmailLength(email);
  if (emailLengthError)   throw Object.assign(new Error(emailLengthError),  { status: 400 });

  const passwordLenError  = validatePasswordLength(password);
  if (passwordLenError)   throw Object.assign(new Error(passwordLenError),  { status: 400 });

  return { email, password };
}

function sanitizeMobileLogin(body) {
  let { mobileNumber, password } = body;

  if (typeof mobileNumber !== "string" || typeof password !== "string") {
    throw Object.assign(new Error("Invalid input types."), { status: 400 });
  }

  mobileNumber = mobileNumber.trim();
  password     = password.trim();

  if (!mobileNumber || !password) {
    throw Object.assign(new Error("Mobile number and password are required."), { status: 400 });
  }

  const mobileFormatError = validateMobileFormat(mobileNumber);
  if (mobileFormatError)  throw Object.assign(new Error(mobileFormatError), { status: 400 });

  const passwordLenError  = validatePasswordLength(password);
  if (passwordLenError)   throw Object.assign(new Error(passwordLenError),  { status: 400 });

  return { mobileNumber, password };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signAccessToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role },
    process.env.ACCESS_SECRET,
    { expiresIn: "15m" }
  );
}

function signRefreshToken(user, rememberMe = false) {
  return jwt.sign(
    { id: user._id, rememberMe: !!rememberMe },
    process.env.REFRESH_SECRET,
    { expiresIn: rememberMe ? process.env.EXPIRY_REMEMBER : process.env.EXPIRY_REGULAR }
  );
}

function signPendingToken(user, rememberMe = false) {
  return jwt.sign(
    { id: user._id, role: user.role, pending: true, rememberMe: !!rememberMe },
    process.env.PENDING_SECRET,
    { expiresIn: "10m" }
  );
}

function hashToken (token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const invalidCredentials = (res) =>
  res.status(401).json({ message: "Invalid credentials." });

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
  if (!user) {
    logAdminAction(req, null, email, "LOGIN_FAILED", `Failed login attempt (user not found) for email: ${email}`);
    return invalidCredentials(res);
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    logAdminAction(req, user._id, user.firstName + " " + user.lastName, "LOGIN_FAILED", `Failed login attempt (incorrect password)`);
    return invalidCredentials(res);
  }

  const rememberMe = req.body.rememberMe === true;
  await sendOtp(user._id, user.mobileNumber);

  return res.status(200).json({
    pendingToken: signPendingToken(user, rememberMe),
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

  const rememberMe = req.body.rememberMe === true;
  await sendOtp(user._id, user.mobileNumber);

  return res.status(200).json({
    pendingToken: signPendingToken(user, rememberMe),
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

  const rememberMe = req.body.rememberMe === true;
  await sendOtp(user._id, user.mobileNumber);

  return res.status(200).json({
    pendingToken: signPendingToken(user, rememberMe),
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
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.PENDING_SECRET);

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
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.PENDING_SECRET);

    if (!decoded.pending) {
      return res.status(400).json({ message: "A pending token is required." });
    }

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const otpResult = verifyOtp(user._id, code);
    if (!otpResult.valid) {
      return res.status(401).json({ message: otpResult.message || "Invalid or expired OTP." });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user, decoded.rememberMe);

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: decoded.rememberMe ? 7 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000,
    });

    user.refreshToken = hashToken(refreshToken);
    await user.save();

    if (user.role === "admin") {
      logAdminAction(req, user._id, user.firstName + " " + user.lastName, "LOGIN_SUCCESS", "Admin logged in successfully");
    }

    const userPayload = {
      id: user._id,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      mobileNumber: user.mobileNumber,
      emergencyContact: user.emergencyContact || null,
    };

    if (user.role === "admin")  userPayload.email   = user.email;
    if (user.role === "driver") userPayload.hasMpin = !!user.driverDetails?.mpin;

    return res.status(200).json({ accessToken, refreshToken, user: userPayload });

  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    console.error("[auth/verify-otp]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
    console.log(err);
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
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.ACCESS_SECRET);

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

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------
router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({
        message: "Refresh token required"
      });
    }

    const decoded = jwt.verify(
      refreshToken,
      process.env.REFRESH_SECRET
    );

    const user = await User.findById(decoded.id);

    if (!user || user.refreshToken !== hashToken(refreshToken)) {
      return res.status(401).json({
        message: "Invalid refresh token"
      });
    }

    const accessToken = signAccessToken(user);
    const newRefreshToken = signRefreshToken(user, decoded.rememberMe);

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: decoded.rememberMe ? 7 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000,
    });

    user.refreshToken = hashToken(newRefreshToken);
    await user.save();

    const userPayload = {
        id: user._id,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        mobileNumber: user.mobileNumber,
        emergencyContact: user.emergencyContact || null,
    };

    if (user.role === "admin")  userPayload.email   = user.email;
    if (user.role === "driver") userPayload.hasMpin = !!user.driverDetails?.mpin;

    return res.json({ accessToken, refreshToken: newRefreshToken, user: userPayload });

  } catch {
    return res.status(401).json({
      message: "Invalid or expired refresh token"
    });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------
router.post("/logout", async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;

  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  });

  if (!refreshToken) return res.status(200).json({ message: "Logged out." });

  try {
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_SECRET);
    const user = await User.findById(decoded.id);
    if (user && user.role === "admin") {
      logAdminAction(req, user._id, user.firstName + " " + user.lastName, "LOGOUT", "Admin logged out");
    }
    await User.findByIdAndUpdate(decoded.id, { refreshToken: null, pushTokens: [] });
    return res.status(200).json({ message: "Logged out." });
  } catch {
    // Even if the token is expired/invalid, treat as logged out
    // Try to decode without verification to clear the tokens anyway
    try {
      const decoded = jwt.decode(refreshToken);
      if (decoded && decoded.id) {
        await User.findByIdAndUpdate(decoded.id, { refreshToken: null, pushTokens: [] });
      }
    } catch (e) {
      // Ignored
    }
    return res.status(200).json({ message: "Logged out." });
  }
});

module.exports = router;