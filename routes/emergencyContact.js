const express = require("express");
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../middleware/auth");
const User = require("../models/User");

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
  // PH mobile format: 09XXXXXXXXX (11 digits starting with 09)
  const mobileRegex = /^09\d{9}$/;
  if (!mobileRegex.test(mobileNumber)) return "Invalid mobile number format.";
  return null;
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
const emergencyContactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again in 15 minutes." },
});

// GET /emergency-contact
// Fetches the logged-in user's emergency contact
router.get("/", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("emergencyContact");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json({ emergencyContact: user.emergencyContact });
  } catch (err) {
    console.error("[get-emergency-contact]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /emergency-contact
// Updates the logged-in user's emergency contact
router.patch("/", emergencyContactLimiter, authenticate, async (req, res) => {
  try {
    const { firstName, lastName, mobileNumber } = req.body;
    
    // If the body is explicitly sending null or empty fields, they might be deleting it
    let emergencyContact = null;
    if (firstName && lastName && mobileNumber) {
        const errors = [];
        const fnError = validateName(firstName, "First Name");
        if (fnError) errors.push(fnError);
        
        const lnError = validateName(lastName, "Last Name");
        if (lnError) errors.push(lnError);

        const mobileError = validateMobileFormat(mobileNumber.trim());
        if (mobileError) errors.push(mobileError);

        if (errors.length > 0) {
          return res.status(400).json({ message: errors.join(" ") });
        }

        emergencyContact = { 
          firstName: firstName.trim(), 
          lastName: lastName.trim(), 
          mobileNumber: mobileNumber.trim() 
        };
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { emergencyContact },
      { returnDocument: 'after', runValidators: true }
    ).select("emergencyContact");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "Emergency contact updated", emergencyContact: user.emergencyContact });
  } catch (err) {
    console.error("[patch-emergency-contact]", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
