const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const User = require("../../models/User");
const { sendToUser } = require("../../services/socket");
const rateLimit = require("express-rate-limit");

const actionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 50, // Limit each IP to 50 actions per window
  message: { message: "Too many actions performed, please try again later." }
});

const router = express.Router();

// GET /admin/flagged-accounts
router.get("/", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const roleFilter = req.query.role; // "All", "Passenger", "Driver"
    
    let query = { isFlagged: true };
    if (roleFilter && roleFilter !== "All") {
      query.role = roleFilter.toLowerCase();
    }

    const flaggedUsers = await User.find(query).sort({ flaggedAt: -1 }).lean();

    const mapped = flaggedUsers.map(user => {
      let status = "Flagged";
      if (user.restrictionEndDate && user.restrictionEndDate > new Date()) {
        status = "Restricted";
      }

      return {
        id: user._id.toString(),
        name: `${user.firstName} ${user.lastName}`,
        role: user.role.charAt(0).toUpperCase() + user.role.slice(1),
        reason: user.flagReason || "Unknown",
        date: user.flaggedAt ? user.flaggedAt.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }) : "Unknown",
        status: status,
      };
    });

    res.json(mapped);
  } catch (error) {
    console.error("[admin-flagged-get]", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /admin/flagged-accounts/:id/action
router.patch("/:id/action", authenticate, requireRole("admin"), actionLimiter, async (req, res) => {
  try {
    const { action } = req.body; // 'clear', 'warning', 'restrict'
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (action === "clear") {
      user.isFlagged = false;
      user.flagReason = null;
      user.flaggedAt = null;
      user.restrictionEndDate = null;
      await user.save();
      return res.json({ message: "Flag cleared", user });
    } 
    
    if (action === "warning") {
      user.warningCount += 1;
      await user.save();
      sendToUser(user._id, "account_warning", { message: "You have received an official warning from Finder Administrators regarding recent policy violations." });
      return res.json({ message: "Warning sent", user });
    } 
    
    if (action === "restrict") {
      // Temp restriction for 7 days
      const restrictUntil = new Date();
      restrictUntil.setDate(restrictUntil.getDate() + 7);
      user.restrictionEndDate = restrictUntil;
      await user.save();
      sendToUser(user._id, "account_restricted", { message: "Your account has been temporarily restricted for 7 days." });
      return res.json({ message: "Account restricted for 7 days", user });
    }

    return res.status(400).json({ message: "Invalid action" });
  } catch (error) {
    console.error("[admin-flagged-patch]", error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
