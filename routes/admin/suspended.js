const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const User = require("../../models/User");
const { sendToUser } = require("../../services/socket");
const rateLimit = require("express-rate-limit");

const actionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50,
  message: { message: "Too many actions performed, please try again later." }
});

const router = express.Router();

// GET /admin/suspended-accounts
router.get("/", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const suspendedUsers = await User.find({ isSuspended: true }).sort({ updatedAt: -1 }).lean();

    const mapped = suspendedUsers.map(user => {
      let typeLabel = "Suspended";
      if (user.suspensionType === "temp_suspend") {
        typeLabel = "Temporary Suspension";
      } else if (user.suspensionType === "suspend_resolved") {
        typeLabel = "Suspend Until Resolved";
      } else if (user.suspensionType === "perm_suspend") {
        typeLabel = "Permanent Suspension";
      }

      return {
        id: user._id.toString(),
        name: `${user.firstName} ${user.lastName}`,
        role: user.role.charAt(0).toUpperCase() + user.role.slice(1),
        suspensionType: typeLabel,
        suspensionEndDate: user.suspensionEndDate
      };
    });

    res.json(mapped);
  } catch (error) {
    console.error("[admin-suspended-get]", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /admin/suspended-accounts/:id/lift
router.post("/:id/lift", authenticate, requireRole("admin"), actionLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.isSuspended) {
      return res.status(400).json({ message: "User is not currently suspended" });
    }

    if (user.suspensionType === "perm_suspend") {
      return res.status(403).json({ message: "Cannot lift a permanent suspension" });
    }

    user.isSuspended = false;
    user.suspensionType = null;
    user.suspensionEndDate = null;
    await user.save();

    sendToUser(user._id, "account_restored", { message: "Your account suspension has been lifted. You may now log in." });

    return res.json({ message: "Suspension lifted successfully", user });
  } catch (error) {
    console.error("[admin-suspended-lift]", error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
