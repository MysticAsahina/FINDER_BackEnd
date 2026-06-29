const express = require("express");
const rateLimit = require("express-rate-limit");
const User = require("../../models/User");
const jwt = require("jsonwebtoken");
const { authenticate, requireRole } = require("../../middleware/auth");

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

router.patch("/", editProfileLimiter, authenticate, requireRole('passenger'), async (req, res) => {
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

  if (email && email.trim()) {
    const emailFormatError = validateEmailFormat(email.trim());
    if (emailFormatError) errors.push(emailFormatError);
    const emailLengthError = validateEmailLength(email.trim());
    if (emailLengthError) errors.push(emailLengthError);
  }

  if (password !== undefined) {
    const passwordLenError = validatePasswordLength(password);
    if (passwordLenError) errors.push(passwordLenError);
  }

  if (errors.length > 0) {
    return res.status(400).json({ message: errors.join(" ") });
  }

  try {
    const updateData = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      mobileNumber: mobileNumber.trim(),
    };

    if (email && email.trim()) {
      updateData.email = email.trim();
    }

    const updatedUser = await User.findById(req.user.id);
    if (!updatedUser) return res.status(404).json({ message: "User not found." });

    Object.assign(updatedUser, updateData);
    if (password !== undefined) {
      updatedUser.password = password;
    }
    await updatedUser.save();

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
    console.error("[passenger-edit-profile]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }

});

module.exports = router;