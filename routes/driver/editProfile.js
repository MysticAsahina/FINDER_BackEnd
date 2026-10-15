const express = require("express");
const rateLimit = require("express-rate-limit");
const User = require("../../models/User");
const { authenticate, requireRole } = require("../../middleware/auth");
const { sendSmsOtp, createAndSendEmailOtp, verifyOtp } = require("../../utils/otpManager");
const { validateEmailFormat, validateEmailLength, validatePasswordLength, validatePasswordPolicy, validateName, validateMobileFormat, validateMpinFormat } = require('../../utils/validators');

const router = express.Router();

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------













// ---------------------------------------------------------------------------
// Rate limiter: max 10 attempts per 15 minutes per IP
// ---------------------------------------------------------------------------
const editProfileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message:
      "Too many edit profile attempts. Please try again in 15 minutes.",
  },
});

// ---------------------------------------------------------------------------
// PATCH /driver/edit-profile
// Authenticated driver can update firstName, lastName, mobileNumber,
// email, password, or mpin (one or more at a time).
// ---------------------------------------------------------------------------
router.patch(
  "/",
  editProfileLimiter,
  authenticate,
  requireRole("driver"),
  async (req, res) => {
    try {
      const user = await User.findById(req.user.id);
      if (!user)
        return res.status(404).json({ message: "User not found." });

      const updates = {};
      const errors = [];

      // ── firstName ──────────────────────────────────────────────────
      if (req.body.firstName !== undefined) {
        const err = validateName(req.body.firstName, "First name");
        if (err) errors.push(err);
        else updates.firstName = req.body.firstName.trim();
      }

      // ── lastName ───────────────────────────────────────────────────
      if (req.body.lastName !== undefined) {
        const err = validateName(req.body.lastName, "Last name");
        if (err) errors.push(err);
        else updates.lastName = req.body.lastName.trim();
      }

      // ── mobileNumber ──────────────────────────────────────────────
      if (req.body.mobileNumber !== undefined) {
        const err = validateMobileFormat(req.body.mobileNumber);
        if (err) {
          errors.push(err);
        } else {
          const existing = await User.findOne({
            mobileNumber: req.body.mobileNumber,
            role: "driver",
            _id: { $ne: user._id },
          });
          if (existing) {
            errors.push("This mobile number is already in use.");
          } else {
            updates.mobileNumber = req.body.mobileNumber;
          }
        }
      }

      // ── email ──────────────────────────────────────────────────────
      if (req.body.email !== undefined) {
        const email = req.body.email.trim().toLowerCase();
        if (email) {
          const fmtErr = validateEmailFormat(email);
          const lenErr = validateEmailLength(email);
          if (fmtErr) errors.push(fmtErr);
          else if (lenErr) errors.push(lenErr);
          else {
            const existing = await User.findOne({
              email,
              _id: { $ne: user._id },
            });
            if (existing) errors.push("This email is already in use.");
            else updates.email = email;
          }
        } else {
          updates.email = null; // allow clearing
        }
      }

      // ── password ───────────────────────────────────────────────────
      if (req.body.password !== undefined) {
        if (!req.body.currentPassword) {
          errors.push("Current password is required to change password.");
        } else {
          const isMatch = await user.comparePassword(req.body.currentPassword);
          if (!isMatch) {
            errors.push("Current password is incorrect.");
          } else if (req.body.currentPassword === req.body.password) {
            errors.push("New password cannot be the same as your current password.");
          }
        }
        const pwErr = validatePasswordPolicy(req.body.password);
        if (pwErr) {
          errors.push(pwErr);
        } else if (req.body.password !== req.body.confirmPassword) {
          errors.push("Passwords do not match.");
        }
      }

      // ── mpin (driver-specific) ─────────────────────────────────────
      if (req.body.mpin !== undefined) {
        const mpinErr = validateMpinFormat(req.body.mpin);
        if (mpinErr) {
          errors.push(mpinErr);
        } else if (req.body.mpin !== req.body.confirmMpin) {
          errors.push("MPINs do not match.");
        } else {
          // MPIN is hashed by User pre-save hook
          user.driverDetails.mpin = req.body.mpin;
        }
      }

      if (errors.length) {
        return res.status(400).json({ message: errors.join(" ") });
      }

      const isEmailChanged = updates.email !== undefined && updates.email !== user.email;
      const isMobileChanged = updates.mobileNumber !== undefined && updates.mobileNumber !== user.mobileNumber;

      if (isEmailChanged && isMobileChanged) {
        return res.status(400).json({ message: "Please update your email and mobile number separately." });
      }

      const updateData = { ...updates };
      if (req.body.password !== undefined) updateData.password = req.body.password;
      if (req.body.mpin !== undefined) updateData.mpin = req.body.mpin;

      const otpKey = req.user.id + "_driverProfileUpdate";

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

      await sendSmsOtp(otpKey, user.mobileNumber, updateData);
      return res.status(200).json({
          pendingProfileOtp: true,
          destination: "current mobile",
          message: "An OTP has been sent to your registered mobile number to verify these changes.",
      });
    } catch (err) {
      console.error("[driver/edit-profile]", err);
      return res
        .status(500)
        .json({ message: "Server error. Please try again." });
    }
  }
);

router.post("/verify-update", editProfileLimiter, authenticate, requireRole("driver"), async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ message: "A valid 6-digit OTP code is required." });
  }

  const otpKey = req.user.id + "_driverProfileUpdate";
  const otpResult = verifyOtp(otpKey, code);

  if (!otpResult.valid) {
    return res.status(401).json({ message: otpResult.message || "Invalid or expired OTP." });
  }

  try {
    const updateData = otpResult.payload;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const { password, mpin, ...simpleUpdates } = updateData;

    Object.assign(user, simpleUpdates);
    if (password !== undefined) user.password = password;
    if (mpin !== undefined) user.driverDetails.mpin = mpin;

    await user.save();

    const payload = {
      id: user._id,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      mobileNumber: user.mobileNumber,
      email: user.email ?? null,
      profilePicture: user.profilePicture || user.driverDetails?.faceImg || null,
      hasMpin: !!user.driverDetails?.mpin,
    };

    return res.status(200).json({ user: payload, message: "Profile updated." });
  } catch (err) {
    console.error("[driver/verify-profile-update]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// Change Password with SMS OTP
// ---------------------------------------------------------------------------

router.post("/change-password", editProfileLimiter, authenticate, requireRole('driver'), async (req, res) => {
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

    const otpKey = req.user.id + "_driverPasswordChange";
    await sendSmsOtp(otpKey, user.mobileNumber, { password: newPassword });

    return res.status(200).json({
      pendingPasswordOtp: true,
      message: "An OTP has been sent to your registered mobile number to verify this password change.",
    });
  } catch (err) {
    console.error("[driver-change-password]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

router.post("/verify-password-change", editProfileLimiter, authenticate, requireRole('driver'), async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
    return res.status(400).json({ message: "A valid 6-digit OTP code is required." });
  }

  const otpKey = req.user.id + "_driverPasswordChange";
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
    console.error("[driver-verify-password-change]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;
