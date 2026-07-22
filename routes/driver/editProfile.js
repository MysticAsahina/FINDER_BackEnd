const express = require("express");
const rateLimit = require("express-rate-limit");
const User = require("../../models/User");
const { authenticate, requireRole } = require("../../middleware/auth");
const { sendSmsOtp, createAndSendEmailOtp, verifyOtp } = require("../../utils/otpManager");

const router = express.Router();

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

function validateName(value, field) {
  if (!value || !value.trim()) return `${field} is required.`;
  if (value.trim().length > 50) return `${field} is too long.`;
  return null;
}

function validateMobileFormat(mobileNumber) {
  if (!/^09\d{9}$/.test(mobileNumber)) return "Invalid mobile number format.";
  return null;
}

function validateEmailFormat(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Invalid email format.";
  return null;
}

function validateEmailLength(email) {
  if (email.length > 254) return "Email is too long.";
  return null;
}

function validatePasswordLength(password) {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password is too long.";
  return null;
}

function validateMpin(mpin) {
  if (!/^\d{4}$/.test(mpin)) return "MPIN must be exactly 4 digits.";
  return null;
}

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
        const pwErr = validatePasswordLength(req.body.password);
        if (pwErr) {
          errors.push(pwErr);
        } else if (req.body.password !== req.body.confirmPassword) {
          errors.push("Passwords do not match.");
        } else {
          // Password is hashed by User pre-save hook
          user.password = req.body.password;
        }
      }

      // ── mpin (driver-specific) ─────────────────────────────────────
      if (req.body.mpin !== undefined) {
        const mpinErr = validateMpin(req.body.mpin);
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
      hasMpin: !!user.driverDetails?.mpin,
    };

    return res.status(200).json({ user: payload, message: "Profile updated." });
  } catch (err) {
    console.error("[driver/verify-profile-update]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;
