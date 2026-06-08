const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");

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

router.post("/", editProfileLimiter, async (req, res) => {
    const authHeader = req.headers.authorization;
    const { firstName, lastName, email, mobileNumber } = req.body;

    if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({ message: "No token provided." });
    }

    if (!firstName || !lastName || !mobileNumber) {
    return res.status(400).json({
        message: "Required fields are missing."
    });
    }

    try {
        const decoded = jwt.verify(authHeader.split(" ")[1], process.env.ACCESS_SECRET);

        if (decoded.role !== "passenger") {
        return res.status(403).json({ message: "Unauthorized." });
        }

        const updateData = {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            mobileNumber: mobileNumber.trim(),
        };

        if (email?.trim()) {
            updateData.email = email.trim();
        }

        const updatedUser = await User.findByIdAndUpdate(decoded.id, updateData, { new: true, runValidators: true });

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
    } catch {
        return res.status(401).json({ message: "Invalid token." });
    }
});