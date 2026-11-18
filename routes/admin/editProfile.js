const express = require("express");
const rateLimit = require("express-rate-limit");
const User = require("../../models/User");
const jwt = require("jsonwebtoken");
const { authenticate, requireRole } = require("../../middleware/auth");
const { logAdminAction } = require("../../utils/auditLogger");
const { sendSmsOtp, createAndSendEmailOtp, verifyOtp } = require("../../utils/otpManager");
const { validateEmailFormat, validateEmailLength, validatePasswordLength, validatePasswordPolicy, validateName, validateMobileFormat } = require('../../utils/validators');

const router = express.Router();

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

// Edit Profile Limiter: max 10 attempts per 15 minutes per IP
const editProfileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again in 15 minutes." },
});

router.patch("/", editProfileLimiter, authenticate, requireRole('admin'), async (req, res) => {
  const { firstName, lastName, email, mobileNumber, password, currentPassword } = req.body;

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
    const passwordError = validatePasswordPolicy(password);
    if (passwordError) errors.push(passwordError);
    if (!currentPassword) errors.push("Current password is required to change password.");
  }

  if (errors.length > 0) {
    return res.status(400).json({ message: errors.join(" ") });
  }

  try {
    const updatedUser = await User.findById(req.user.id);
    if (!updatedUser) return res.status(404).json({ message: "User not found." });

    if (password !== undefined) {
      const isMatch = await updatedUser.comparePassword(currentPassword);
      if (!isMatch) {
        return res.status(400).json({ message: "Current password is incorrect." });
      }
      if (currentPassword === password) {
        return res.status(400).json({ message: "New password cannot be the same as your current password." });
      }
    }

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

    const action = updateData.password ? "PASSWORD_CHANGED" : "PROFILE_EDITED";
    const details = updateData.password ? "Admin updated profile and changed password" : "Admin updated profile details";
    await logAdminAction(req, updatedUser._id, updatedUser.firstName + " " + updatedUser.lastName, action, details);

    return res.status(200).json({
      message: "Profile updated successfully.",
      user: {
        id: updatedUser._id,
        role: updatedUser.role,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        email: updatedUser.email,
        mobileNumber: updatedUser.mobileNumber,
        profilePicture: updatedUser.profilePicture || null,
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

// ---------------------------------------------------------------------------
// Change Password with Email OTP
// ---------------------------------------------------------------------------

router.post("/change-password", editProfileLimiter, authenticate, requireRole('admin'), async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword) {
    return res.status(400).json({ message: "Current password is required." });
  }
  if (!newPassword) {
    return res.status(400).json({ message: "New password is required." });
  }

  const passwordError = validatePasswordPolicy(newPassword);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ message: "New password cannot be the same as your current password." });
    }

    const otpKey = req.user.id + "_adminPasswordChange";
    await createAndSendEmailOtp(otpKey, user.email, { password: newPassword });

    return res.status(200).json({
      pendingPasswordOtp: true,
      message: "An OTP has been sent to your registered email address to verify this password change.",
    });
  } catch (err) {
    console.error("[admin-change-password]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

router.post("/verify-password-change", editProfileLimiter, authenticate, requireRole('admin'), async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
    return res.status(400).json({ message: "A valid 6-digit OTP code is required." });
  }

  const otpKey = req.user.id + "_adminPasswordChange";
  const otpResult = verifyOtp(otpKey, code.trim());

  if (!otpResult.valid) {
    return res.status(401).json({ message: otpResult.message || "Invalid or expired OTP." });
  }

  try {
    const { password } = otpResult.payload;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    user.password = password;
    await user.save();

    await logAdminAction(req, user._id, user.firstName + " " + user.lastName, "PASSWORD_CHANGED", "Admin changed password");

    return res.status(200).json({
      message: "Password changed successfully."
    });
  } catch (err) {
    console.error("[admin-verify-password-change]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;