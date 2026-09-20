const express = require("express");
const rateLimit = require("express-rate-limit");
const { authenticate, requireRole } = require("../middleware/auth");
const User = require("../models/User");
const { validateName, validateMobileFormat } = require('../utils/validators');

const router = express.Router();

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------




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

const emergencyTriggerLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 2, // Allow max 2 emergency alerts every 5 minutes to prevent spam/costs
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Emergency alert already triggered recently. Please wait a few minutes." },
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

// POST /emergency-contact/trigger
// Triggers an emergency SMS alert to the configured contact
router.post("/trigger", authenticate, requireRole("passenger"), emergencyTriggerLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("firstName lastName emergencyContact");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.emergencyContact || !user.emergencyContact.mobileNumber) {
      return res.status(400).json({ message: "No emergency contact configured." });
    }

    const { latitude, longitude } = req.body;

    const Ride = require("../models/Ride");
    const activeRide = await Ride.findOne({
      passengerId: user._id,
      status: { $in: ["driver_assigned", "arrived_pickup", "trip_started"] }
    }).populate("driverId", "firstName lastName driverDetails mobileNumber");

    const contact = user.emergencyContact;
    let message = `EMERGENCY ALERT: ${user.firstName} ${user.lastName} has triggered an emergency alert during their Finder ride.`;

    if (activeRide && activeRide.driverId) {
      const driver = activeRide.driverId;
      const plateNo = driver.driverDetails?.plateNumber || 'Unknown';
      const vehicle = driver.driverDetails?.vehicleType || 'Vehicle';
      message += ` Driver: ${driver.firstName} ${driver.lastName}, ${vehicle} (Plate: ${plateNo}).`;
    }

    if (latitude && longitude) {
      message += ` Location: https://maps.google.com/?q=${latitude},${longitude}`;
    }

    const { sendSms } = require("../utils/otpManager");
    await sendSms(contact.mobileNumber, message);

    res.json({ message: "Emergency alert sent successfully." });
  } catch (err) {
    console.error("[post-emergency-trigger]", err);
    res.status(500).json({ message: "Failed to send emergency alert." });
  }
});

module.exports = router;
