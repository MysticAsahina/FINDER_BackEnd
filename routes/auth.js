const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const cloudinary = require("cloudinary").v2;
const User = require("../models/User");
const Appeal = require("../models/Appeal");
const ActiveDriver = require("../models/ActiveDriver");
const Ride = require("../models/Ride");
const { logAdminAction } = require("../utils/auditLogger");
const { sendSmsOtp: sendOtp, verifyOtp, createAndSendEmailOtp } = require("../utils/otpManager");
const { validateEmailFormat, validateEmailLength, validatePasswordLength, validateMobileFormat, validatePasswordPolicy } = require('../utils/validators');
const { authenticate, requireRole } = require("../middleware/auth");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function buildUserPayload(user) {
  const payload = {
    id: user._id,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    mobileNumber: user.mobileNumber,
    email: user.email || null,
    profilePicture: user.profilePicture || (user.role === "driver" ? user.driverDetails?.faceImg : null) || null,
    emergencyContact: user.emergencyContact || null,
  };

  if (user.role === "passenger") {
    payload.isDiscountVerified = user.isDiscountVerified;
    payload.discountType = user.discountType;
  }

  if (user.role === "driver") {
    payload.hasMpin = !!user.driverDetails?.mpin;
  }

  return payload;
}

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

// OTP resend: max 3 per 15 minutes per IP
const otpResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many resend requests. Please wait before requesting another OTP." },
});

// Forgot Password: max 5 requests per 15 minutes per IP
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many forgot password requests. Please try again later." },
});

// MPIN submit: max 5 attempts per 15 minutes per IP
const mpinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many MPIN attempts. Please wait before trying again." },
});

// Delete Account: max 3 attempts per 15 minutes per IP
const deleteAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many delete account requests. Please try again later." },
});

// Profile Picture: max 15 updates per 15 minutes per IP/user
const profilePictureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many profile picture updates. Please try again in 15 minutes." },
});

// ---------------------------------------------------------------------------
// Field validators
// Each function returns an error message string if invalid, null if valid.
// ---------------------------------------------------------------------------











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
    { id: user._id, role: user.role, tokenVersion: user.tokenVersion || 0 },
    process.env.ACCESS_SECRET,
    { expiresIn: "15m" }
  );
}

function signRefreshToken(user, rememberMe = false) {
  return jwt.sign(
    { id: user._id, rememberMe: !!rememberMe, tokenVersion: user.tokenVersion || 0 },
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

function signForgotPasswordPendingToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, forgotPasswordPending: true },
    process.env.PENDING_SECRET,
    { expiresIn: "10m" }
  );
}

function signResetPasswordToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, resetPasswordAllowed: true },
    process.env.PENDING_SECRET,
    { expiresIn: "10m" }
  );
}

function signAppealToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, isAppealSession: true },
    process.env.PENDING_SECRET,
    { expiresIn: "24h" }
  );
}

function hashToken (token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const invalidCredentials = (res) =>
  res.status(401).json({ message: "Invalid credentials." });

async function checkSuspension(user, res) {
  if (user.isSuspended) {
    if (user.suspensionType === 'temp_suspend' && user.suspensionEndDate && new Date() > user.suspensionEndDate) {
      // Suspension has expired, lift it
      user.isSuspended = false;
      user.suspensionType = null;
      user.suspensionEndDate = null;
      user.appealCount = 0;
      await user.save();
      return false; // Proceed with login
    }

    // Check if account is permanently disabled/archived
    if (user.isPermanentlyDisabled) {
      res.status(403).json({
        status: "suspended",
        message: "Your appeal was rejected. Your account has been permanently disabled and cannot be recovered.",
        suspension: {
          type: "perm_suspend",
          reason: user.suspensionReason,
          endDate: null,
          appealsUsed: user.appealCount || 1,
          maxAppeals: 1,
          appealsRemaining: 0,
          hasPendingAppeal: false,
          pendingAppealId: null,
          canAppeal: false,
          isPermanentlyDisabled: true,
        },
      });
      return true;
    }

    // Determine max appeals allowed for this suspension tier
    let maxAppeals = 1;
    if (user.suspensionType === 'suspend_resolved') {
      maxAppeals = 2;
    } else if (user.suspensionType === 'temp_suspend' || user.suspensionType === 'perm_suspend') {
      maxAppeals = 1;
    }

    const appealsUsed = user.appealCount || 0;
    const appealsRemaining = Math.max(0, maxAppeals - appealsUsed);

    // Check if an appeal is currently pending review
    const pendingAppeal = await Appeal.findOne({ userId: user._id, status: 'pending' });
    const hasPendingAppeal = !!pendingAppeal;

    const canAppeal = appealsRemaining > 0 && !hasPendingAppeal;

    let msg = "Your account is suspended.";
    if (hasPendingAppeal) {
      msg = "Your appeal is currently pending administrative review.";
    } else if (appealsRemaining === 0) {
      if (user.suspensionType === 'temp_suspend') {
        const dateStr = user.suspensionEndDate ? new Date(user.suspensionEndDate).toLocaleDateString() : 'the scheduled end date';
        msg = `Your appeal was rejected. Your account is temporarily suspended until ${dateStr}. You have exhausted your appeals (1/1) and must wait for the suspension period to conclude.`;
      } else if (user.suspensionType === 'perm_suspend') {
        msg = "Your appeal was rejected. Your account has been permanently disabled and cannot be recovered.";
      } else if (user.suspensionType === 'suspend_resolved') {
        msg = "Your appeals were rejected (2/2 appeals used). Your account is permanently suspended pending administrative action.";
      }
    } else {
      if (user.suspensionType === 'temp_suspend') {
        const dateStr = user.suspensionEndDate ? new Date(user.suspensionEndDate).toLocaleDateString() : 'a later date';
        msg = `Your account is temporarily suspended until ${dateStr}. You have 1 appeal available.`;
      } else if (user.suspensionType === 'suspend_resolved') {
        msg = `Your account is suspended indefinitely pending resolution. You have ${appealsRemaining} of 2 appeals remaining.`;
      } else if (user.suspensionType === 'perm_suspend') {
        msg = "Your account has been permanently suspended. You may submit 1 appeal.";
      }
    }

    const appealToken = signAppealToken(user);

    res.status(403).json({
      status: "suspended",
      message: msg,
      suspension: {
        type: user.suspensionType,
        reason: user.suspensionReason,
        endDate: user.suspensionEndDate,
        appealsUsed,
        maxAppeals,
        appealsRemaining,
        hasPendingAppeal,
        pendingAppealId: pendingAppeal ? pendingAppeal._id : null,
        canAppeal,
        isPermanentlyDisabled: false,
      },
      appealToken,
    });
    return true; // Indicates suspension blocked login
  }
  return false;
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
  if (!user) {
    logAdminAction(req, null, email, "LOGIN_FAILED", `Failed login attempt (user not found) for email: ${email}`);
    return invalidCredentials(res);
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    logAdminAction(req, user._id, user.firstName + " " + user.lastName, "LOGIN_FAILED", `Failed login attempt (incorrect password)`);
    return invalidCredentials(res);
  }

  if (await checkSuspension(user, res)) return;

  const rememberMe = req.body.rememberMe === true;
  await createAndSendEmailOtp(user._id, user.email);

  return res.status(200).json({
    pendingToken: signPendingToken(user, rememberMe),
    message: "Credentials verified. OTP sent to your registered email address.",
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

  if (await checkSuspension(user, res)) return;

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

  if (await checkSuspension(user, res)) return;

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

const axios = require("axios");

// POST /auth/login
router.post("/login", loginLimiter, async (req, res) => {
  const { role, captchaToken } = req.body;

  if (!role || !strategies[role]) {
    return res.status(400).json({
      message: "A valid role is required (admin, passenger, or driver).",
    });
  }

  if (role === "admin") {
    if (!captchaToken) {
      return res.status(400).json({ message: "Please complete the CAPTCHA." });
    }

    try {
      const response = await axios.post(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        `secret=${process.env.TURNSTILE_SECRET_KEY}&response=${captchaToken}`,
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      if (!response.data.success) {
        return res.status(400).json({ message: "CAPTCHA verification failed. Please try again." });
      }
    } catch (err) {
      console.error("[Turnstile Verification Error]", err);
      return res.status(500).json({ message: "Failed to verify CAPTCHA. Please try again." });
    }
  }

  try {
    await strategies[role](req, res);
  } catch (err) {
    console.error(`[auth/login:${role}]`, err);
    return res.status(500).json({ message: "Failed to process login. Please try again." });
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

    if (user.role === "admin") {
      await createAndSendEmailOtp(user._id, user.email);
    } else {
      await sendOtp(user._id, user.mobileNumber);
    }

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

    user.tokenVersion = (user.tokenVersion || 0) + 1;
    
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

    const userPayload = buildUserPayload(user);

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
router.post("/verify-mpin", mpinLimiter, async (req, res) => {
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
    if (!isMatch) return res.status(401).json({ message: "Invalid MPIN." });

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

    if (await checkSuspension(user, res)) return;

    const tokenV = decoded.tokenVersion || 0;
    if (user.tokenVersion !== tokenV) {
      return res.status(401).json({
        message: "Session expired due to login on another device."
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
    const userPayload = buildUserPayload(user);

    return res.json({ accessToken, refreshToken: newRefreshToken, user: userPayload });

  } catch {
    return res.status(401).json({
      message: "Invalid or expired refresh token"
    });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------
router.get("/me", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const userPayload = buildUserPayload(user);

    res.json({ user: userPayload });
  } catch (err) {
    console.error("[auth/me]", err);
    res.status(500).json({ message: "Server error" });
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
    if (user && user.role === "driver") {
      await ActiveDriver.findOneAndUpdate({ driverId: user._id }, { isOnline: false });
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

// ---------------------------------------------------------------------------
// POST /auth/forgot-password/admin
// ---------------------------------------------------------------------------
router.post("/forgot-password/admin", forgotPasswordLimiter, async (req, res) => {
  let { email } = req.body;

  if (typeof email !== "string") {
    return res.status(400).json({ message: "Invalid input." });
  }

  email = email.trim().toLowerCase();

  try {
    const user = await User.findOne({ email, role: "admin" });
    if (!user) {
      return res.status(404).json({ message: "No admin account found with this email." });
    }

    await createAndSendEmailOtp(user._id, user.email);

    return res.status(200).json({
      token: signForgotPasswordPendingToken(user),
      message: "OTP sent to your registered email address.",
    });
  } catch (err) {
    console.error("[auth/forgot-password/admin]", err);
    return res.status(500).json({ message: "Failed to process request." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password
// ---------------------------------------------------------------------------
router.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
  let { mobileNumber, role } = req.body;

  if (typeof mobileNumber !== "string" || !role) {
    return res.status(400).json({ message: "Invalid input." });
  }

  mobileNumber = mobileNumber.trim();
  const mobileError = validateMobileFormat(mobileNumber);
  if (mobileError) return res.status(400).json({ message: mobileError });

  try {
    const user = await User.findOne({ mobileNumber, role });
    if (!user) {
      // Don't reveal if user exists or not for security? 
      // It's a mobile number, usually fine. But returning 404 is okay.
      return res.status(404).json({ message: "No account found with this number." });
    }

    // Send OTP
    await sendOtp(user._id, user.mobileNumber);

    return res.status(200).json({
      token: signForgotPasswordPendingToken(user),
      message: "OTP sent to your registered mobile number.",
    });
  } catch (err) {
    console.error("[auth/forgot-password]", err);
    return res.status(500).json({ message: "Failed to process request." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password/verify-otp
// ---------------------------------------------------------------------------
router.post("/forgot-password/verify-otp", otpSubmitLimiter, async (req, res) => {
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

    if (!decoded.forgotPasswordPending) {
      return res.status(400).json({ message: "A valid pending token is required." });
    }

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const otpResult = verifyOtp(user._id, code);
    if (!otpResult.valid) {
      return res.status(401).json({ message: otpResult.message || "Invalid or expired OTP." });
    }

    return res.status(200).json({
      token: signResetPasswordToken(user),
      message: "OTP verified.",
    });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    console.error("[auth/forgot-password/verify-otp]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-mpin
// ---------------------------------------------------------------------------
router.post("/forgot-mpin", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.ACCESS_SECRET);
    if (decoded.role !== "driver") return res.status(403).json({ message: "Drivers only." });

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    await sendOtp(user._id, user.mobileNumber);
    return res.status(200).json({ message: "OTP sent to your registered mobile number." });
  } catch (err) {
    console.error("[auth/forgot-mpin]", err);
    return res.status(500).json({ message: "Failed to process request." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-mpin/verify-otp
// ---------------------------------------------------------------------------
router.post("/forgot-mpin/verify-otp", otpSubmitLimiter, async (req, res) => {
  const { code } = req.body;
  const authHeader = req.headers.authorization;

  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ message: "A valid 6-digit OTP code is required." });
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.ACCESS_SECRET);
    if (decoded.role !== "driver") return res.status(403).json({ message: "Drivers only." });

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const otpResult = verifyOtp(user._id, code);
    if (!otpResult.valid) {
      return res.status(401).json({ message: otpResult.message || "Invalid or expired OTP." });
    }

    user.driverDetails.mpin = null;
    await user.save();

    return res.status(200).json({ message: "MPIN has been reset successfully." });
  } catch (err) {
    console.error("[auth/forgot-mpin/verify-otp]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password/reset
// ---------------------------------------------------------------------------
router.post("/forgot-password/reset", forgotPasswordLimiter, async (req, res) => {
  const { password, confirmPassword } = req.body;
  const authHeader = req.headers.authorization;

  if (typeof password !== "string" || typeof confirmPassword !== "string") {
    return res.status(400).json({ message: "Invalid input." });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ message: "Passwords do not match." });
  }

  const passwordError = validatePasswordPolicy(password);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.PENDING_SECRET);

    if (!decoded.resetPasswordAllowed) {
      return res.status(400).json({ message: "A valid reset token is required." });
    }

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    user.password = password;
    // Let the pre-save hook hash it
    await user.save();

    return res.status(200).json({ message: "Password has been reset successfully." });
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    console.error("[auth/forgot-password/reset]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/delete-account/request-otp
// ---------------------------------------------------------------------------
router.post("/delete-account/request-otp", authenticate, requireRole("passenger", "driver"), deleteAccountLimiter, async (req, res) => {
  const { confirmationText, password } = req.body;

  if (confirmationText !== "DELETE") {
    return res.status(400).json({ message: "You must type 'DELETE' to confirm account deletion." });
  }

  if (!password) {
    return res.status(400).json({ message: "Password is required to delete your account." });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(401).json({ message: "Incorrect password." });

    // Ensure they have no active rides
    const activeRide = await Ride.findOne({
      $or: [{ passengerId: req.user.id }, { driverId: req.user.id }],
      status: { $in: ['pending', 'driver_assigned', 'arrived_pickup', 'trip_started'] }
    });

    if (activeRide) {
      return res.status(400).json({ message: "You cannot delete your account while involved in an active ride. Please complete or cancel the ride first." });
    }

    await sendOtp(req.user.id + "_deleteAccount", user.mobileNumber, { confirmationText: "DELETE" });

    return res.status(200).json({
      pendingOtp: true,
      message: "An OTP has been sent to your registered mobile number.",
    });
  } catch (err) {
    console.error("[auth/delete-account/request-otp]", err);
    return res.status(500).json({ message: "Server error while processing delete account request." });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/delete-account/resend-otp
// ---------------------------------------------------------------------------
router.post("/delete-account/resend-otp", authenticate, requireRole("passenger", "driver"), otpResendLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    await sendOtp(req.user.id + "_deleteAccount", user.mobileNumber, { confirmationText: "DELETE" });

    return res.status(200).json({ message: "OTP has been resent to your registered mobile number." });
  } catch (err) {
    console.error("[auth/delete-account/resend-otp]", err);
    return res.status(500).json({ message: "Failed to resend OTP." });
  }
});

// ---------------------------------------------------------------------------
// DELETE /auth/delete-account
// ---------------------------------------------------------------------------
router.delete("/delete-account", authenticate, requireRole("passenger", "driver"), otpSubmitLimiter, async (req, res) => {
  const { confirmationText, password, code } = req.body;

  if (confirmationText !== "DELETE") {
    return res.status(400).json({ message: "You must type 'DELETE' to confirm account deletion." });
  }

  if (!password) {
    return res.status(400).json({ message: "Password is required to delete your account." });
  }

  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
    return res.status(400).json({ message: "A valid 6-digit OTP code is required." });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(401).json({ message: "Incorrect password." });

    const otpResult = verifyOtp(req.user.id + "_deleteAccount", code.trim());
    if (!otpResult.valid) {
      return res.status(400).json({ message: otpResult.message || "Invalid or expired OTP." });
    }

    // Ensure they have no active rides
    const activeRide = await Ride.findOne({
      $or: [{ passengerId: req.user.id }, { driverId: req.user.id }],
      status: { $in: ['pending', 'driver_assigned', 'arrived_pickup', 'trip_started'] }
    });

    if (activeRide) {
      return res.status(400).json({ message: "You cannot delete your account while involved in an active ride. Please complete or cancel the ride first." });
    }

    if (user.role === "driver") {
      await ActiveDriver.findOneAndDelete({ driverId: user._id });
    }

    // Perform a hard delete as requested
    await User.findByIdAndDelete(req.user.id);

    return res.status(200).json({ message: "Your account has been successfully deleted." });
  } catch (err) {
    console.error("[auth/delete-account]", err);
    return res.status(500).json({ message: "Server error while deleting account." });
  }
});

/**
 * Helper to safely extract Cloudinary public ID for profile picture assets.
 * Only targets images stored in the "profile-pictures" folder to prevent
 * accidental deletion of verification documents or chat media.
 */
function extractProfilePicturePublicId(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/);
    if (!match) return null;
    const withExt = match[1];
    const publicId = withExt.replace(/\.[^.]+$/, "");
    if (publicId.startsWith("profile-pictures/")) {
      return publicId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Helper to delete an old profile picture from Cloudinary.
 */
async function deleteOldProfilePicture(url) {
  const publicId = extractProfilePicturePublicId(url);
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    console.warn(`[auth/profile-picture] Failed to delete old image ${publicId}:`, err?.message || err);
  }
}

const MAX_PROFILE_PICTURE_BYTES = 5 * 1024 * 1024; // 5MB

// ---------------------------------------------------------------------------
// PATCH /auth/profile-picture & POST /auth/profile-picture
// Updates or removes the authenticated user's profile picture.
// ---------------------------------------------------------------------------
const handleProfilePictureUpdate = async (req, res) => {
  try {
    const { profilePicture } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const previousPicture = user.profilePicture;

    if (!profilePicture) {
      user.profilePicture = null;
      await user.save();
      if (previousPicture) {
        await deleteOldProfilePicture(previousPicture);
      }
    } else if (typeof profilePicture === "string" && profilePicture.startsWith("data:image/")) {
      // Calculate binary size from base64 string
      const base64Data = profilePicture.split(",")[1] || profilePicture;
      const sizeInBytes = (base64Data.length * 3) / 4;
      if (sizeInBytes > MAX_PROFILE_PICTURE_BYTES) {
        return res.status(400).json({ message: "Profile picture size must not exceed 5MB." });
      }

      const uploadRes = await cloudinary.uploader.upload(profilePicture, {
        folder: "profile-pictures",
        transformation: [
          { width: 500, height: 500, crop: "fill", gravity: "face" }
        ],
      });
      user.profilePicture = uploadRes.secure_url;
      await user.save();

      if (previousPicture && previousPicture !== user.profilePicture) {
        await deleteOldProfilePicture(previousPicture);
      }
    } else if (typeof profilePicture === "string" && (profilePicture.startsWith("http://") || profilePicture.startsWith("https://"))) {
      user.profilePicture = profilePicture;
      await user.save();

      if (previousPicture && previousPicture !== user.profilePicture) {
        await deleteOldProfilePicture(previousPicture);
      }
    } else {
      return res.status(400).json({ message: "Invalid image format." });
    }

    const userPayload = buildUserPayload(user);

    return res.status(200).json({
      message: user.profilePicture ? "Profile picture updated successfully." : "Profile picture removed successfully.",
      profilePicture: userPayload.profilePicture,
      user: userPayload,
    });
  } catch (err) {
    console.error("[auth/profile-picture]", err);
    return res.status(500).json({ message: "Failed to update profile picture. Please try again." });
  }
};

router.patch("/profile-picture", authenticate, profilePictureLimiter, handleProfilePictureUpdate);
router.post("/profile-picture", authenticate, profilePictureLimiter, handleProfilePictureUpdate);

module.exports = router;