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
    const { action, reason } = req.body; // 'clear', 'warning', 'restrict'
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
    
    if (action === "temp_suspend") {
      const { durationDays } = req.body;
      if (!durationDays || durationDays < 3 || durationDays > 30) {
        return res.status(400).json({ message: "Invalid duration. Must be between 3 and 30 days." });
      }
      user.isSuspended = true;
      user.suspensionType = "temp_suspend";
      user.suspensionReason = reason || null;
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + durationDays);
      user.suspensionEndDate = endDate;
      user.isFlagged = false; // Usually clearing flag when moving to suspension
      user.refreshToken = null;
      user.pushTokens = [];
      await user.save();
      sendToUser(user._id, "account_suspended", { message: `Your account has been temporarily suspended for ${durationDays} days.`, type: "temp_suspend" });
      return res.json({ message: "Account temporarily suspended", user });
    }

    if (action === "suspend_resolved") {
      user.isSuspended = true;
      user.suspensionType = "suspend_resolved";
      user.suspensionReason = reason || null;
      user.suspensionEndDate = null;
      user.isFlagged = false;
      user.refreshToken = null;
      user.pushTokens = [];
      await user.save();
      sendToUser(user._id, "account_suspended", { message: "Your account has been suspended until resolved.", type: "suspend_resolved" });
      return res.json({ message: "Account suspended until resolved", user });
    }

    if (action === "perm_suspend") {
      user.isSuspended = true;
      user.suspensionType = "perm_suspend";
      user.suspensionReason = reason || null;
      user.suspensionEndDate = null;
      user.isFlagged = false;
      user.refreshToken = null;
      user.pushTokens = [];
      await user.save();
      sendToUser(user._id, "account_suspended", { message: "Your account has been permanently suspended.", type: "perm_suspend" });
      return res.json({ message: "Account permanently suspended", user });
    }

    return res.status(400).json({ message: "Invalid action" });
  } catch (error) {
    console.error("[admin-flagged-patch]", error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
