const express = require("express");
const rateLimit = require("express-rate-limit");
const User = require("../../models/User");
const jwt = require("jsonwebtoken");
const { authenticate, requireRole } = require("../../middleware/auth");
const { logAdminAction } = require("../../utils/auditLogger");
const { sendSmsOtp, createAndSendEmailOtp, verifyOtp } = require("../../utils/otpManager");

const router = express.Router();

// ---------------------------------------------------------------------------
// Field validators
// Each function returns an error message string if invalid, null if valid.
// TODO: Group these into a single file and import as needed.
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

function validateName(value, field) {
  if (!value || !value.trim()) return `${field} is required.`;
  if (value.trim().length > 50) return `${field} is too long.`;
  return null;
}

function validateMobileFormat(mobileNumber) {
  // PH mobile format: 09XXXXXXXXX (11 digits starting with 09)
  const mobileRegex = /^09\d{9}$/;
  if (!mobileRegex.test(mobileNumber)) return "Invalid mobile number format.";
  return null;
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

// Edit Profile Limiter: max 10 attempts per 15 minutes per IP
const editProfileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many edit profile attempts. Please try again in 15 minutes." },
});

router.patch("/", editProfileLimiter, authenticate, requireRole('admin'), async (req, res) => {
  const { firstName, lastName, email, mobileNumber, password } = req.body;

  const errors = [];
  
  const fnError = validateName(firstName, "First Name");
  if (fnError) errors.push(fnError);
  
  const lnError = validateName(lastName, "Last Name");
  if (lnError) errors.push(lnError);

  if (mobileNumber) {
    const mobileError = validateMobileFormat(mobileNumber.trim());
    if (mobileError) errors.push(mobileError);
  } else {
    errors.push("Mobile number is required.");
  }

  if (email) {
    const emailFormatError = validateEmailFormat(email.trim());
    if (emailFormatError) errors.push(emailFormatError);
    const emailLengthError = validateEmailLength(email.trim());
    if (emailLengthError) errors.push(emailLengthError);
  } else {
    errors.push("Email is required.");
  }

  if (password !== undefined) {
    const passwordLenError = validatePasswordLength(password);
    if (passwordLenError) errors.push(passwordLenError);
  }

  if (errors.length > 0) {
    return res.status(400).json({ message: errors.join(" ") });
  }

  try {
    const updatedUser = await User.findById(req.user.id);
    if (!updatedUser) return res.status(404).json({ message: "User not found." });

    const isEmailChanged = email && email.trim() && email.trim() !== updatedUser.email;
    const isMobileChanged = mobileNumber && mobileNumber.trim() && mobileNumber.trim() !== updatedUser.mobileNumber;

    if (isEmailChanged && isMobileChanged) {
      return res.status(400).json({ message: "Please update your email and mobile number separately." });
    }

    const updateData = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      mobileNumber: mobileNumber.trim(),
      email: email.trim()
    };

    if (password !== undefined) {
      updateData.password = password;
    }

    const otpKey = req.user.id + "_adminProfileUpdate";

    if (isEmailChanged) {
      await createAndSendEmailOtp(otpKey, updateData.email, updateData);
      return res.status(200).json({
        pendingProfileOtp: true,
        destination: "new email",
        message: "An OTP has been sent to your new email address to verify this change.",
      });
    }

    if (isMobileChanged) {
      await sendSmsOtp(otpKey, updateData.mobileNumber, updateData);
      return res.status(200).json({
        pendingProfileOtp: true,
        destination: "new mobile",
        message: "An OTP has been sent to your new mobile number to verify this change.",
      });
    }

    // Neither changed (just name/password), send to current email to verify identity
    await createAndSendEmailOtp(otpKey, updatedUser.email, updateData);
    return res.status(200).json({
        pendingProfileOtp: true,
        destination: "current email",
        message: "An OTP has been sent to your registered email address to verify these changes.",
    });
  } catch (err) {
    console.error("[admin-edit-profile]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

router.post("/verify-update", editProfileLimiter, authenticate, requireRole('admin'), async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ message: "A valid 6-digit OTP code is required." });
  }

  const otpKey = req.user.id + "_adminProfileUpdate";
  const otpResult = verifyOtp(otpKey, code);

  if (!otpResult.valid) {
    return res.status(401).json({ message: otpResult.message || "Invalid or expired OTP." });
  }

  try {
    const updateData = otpResult.payload;
    const updatedUser = await User.findById(req.user.id);
    if (!updatedUser) return res.status(404).json({ message: "User not found." });

    Object.assign(updatedUser, updateData);
    await updatedUser.save();

    await logAdminAction(req, updatedUser._id, updatedUser.firstName + " " + updatedUser.lastName, "PROFILE_EDITED", "Admin updated profile details");

    return res.status(200).json({
      message: "Profile updated successfully.",
      user: {
        id: updatedUser._id,
        role: updatedUser.role,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        email: updatedUser.email,
        mobileNumber: updatedUser.mobileNumber
      }
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Email or mobile number is already in use." });
    }
    console.error("[admin-verify-profile-update]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;