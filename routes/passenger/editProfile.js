const express = require("express");
const rateLimit = require("express-rate-limit");
const User = require("../../models/User");
const jwt = require("jsonwebtoken");
const { authenticate, requireRole } = require("../../middleware/auth");
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
  message: { message: "Too many edit profile attempts. Please try again in 15 minutes." },
});

router.patch("/", editProfileLimiter, authenticate, requireRole('passenger'), async (req, res) => {
  const { firstName, lastName, email, mobileNumber, password, currentPassword } = req.body;

  const errors = [];
  
  const fnError = validateName(firstName, "First Name");
  if (fnError) errors.push(fnError);
  
  const lnError = validateName(lastName, "Last Name");
  if (lnError) errors.push(lnError);

  if (mobileNumber) {
    const mobileError = validateMobileFormat(mobileNumber.trim());
    if (mobileError) {
      errors.push(mobileError);
    } else {
      const existing = await User.findOne({ mobileNumber: mobileNumber.trim(), role: "passenger", _id: { $ne: req.user.id } });
      if (existing) errors.push("This mobile number is already in use.");
    }
  } else {
    errors.push("Mobile number is required.");
  }

  if (email && email.trim()) {
    const emailFormatError = validateEmailFormat(email.trim());
    if (emailFormatError) errors.push(emailFormatError);
    const emailLengthError = validateEmailLength(email.trim());
    if (emailLengthError) errors.push(emailLengthError);
  }

  if (password !== undefined) {
    const passwordError = validatePasswordPolicy(password);
    if (passwordError) errors.push(passwordError);
    if (!currentPassword) {
      errors.push("Current password is required to change password.");
    }
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
    };
    if (email && email.trim()) {
      updateData.email = email.trim();
    }
    if (password !== undefined) {
      updateData.password = password; // pre-save hook handles hashing
    }

    const otpKey = req.user.id + "_profileUpdate";

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

    // Neither changed (just name/password), send to current mobile to verify identity
    await sendSmsOtp(otpKey, updatedUser.mobileNumber, updateData);
    return res.status(200).json({
        pendingProfileOtp: true,
        destination: "current mobile",
        message: "An OTP has been sent to your registered mobile number to verify these changes.",
    });
  } catch (err) {
    console.error("[passenger-edit-profile]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

router.post("/verify-update", editProfileLimiter, authenticate, requireRole('passenger'), async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ message: "A valid 6-digit OTP code is required." });
  }

  const otpKey = req.user.id + "_profileUpdate";
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
        isDiscountVerified: updatedUser.isDiscountVerified,
        discountType: updatedUser.discountType,
      }
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Email or mobile number is already in use." });
    }
    console.error("[passenger-verify-profile-update]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// Change Password with SMS OTP
// ---------------------------------------------------------------------------

router.post("/change-password", editProfileLimiter, authenticate, requireRole('passenger'), async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword) {
    return res.status(400).json({ message: "Current password is required." });
  }
  if (!newPassword) {
    return res.status(400).json({ message: "New password is required." });
  }
  if (confirmPassword && newPassword !== confirmPassword) {
    return res.status(400).json({ message: "Passwords do not match." });
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

    const otpKey = req.user.id + "_passengerPasswordChange";
    await sendSmsOtp(otpKey, user.mobileNumber, { password: newPassword });

    return res.status(200).json({
      pendingPasswordOtp: true,
      message: "An OTP has been sent to your registered mobile number to verify this password change.",
    });
  } catch (err) {
    console.error("[passenger-change-password]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

router.post("/verify-password-change", editProfileLimiter, authenticate, requireRole('passenger'), async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
    return res.status(400).json({ message: "A valid 6-digit OTP code is required." });
  }

  const otpKey = req.user.id + "_passengerPasswordChange";
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

    return res.status(200).json({
      message: "Password changed successfully."
    });
  } catch (err) {
    console.error("[passenger-verify-password-change]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;