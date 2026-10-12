const express = require("express");
const rateLimit = require("express-rate-limit");
const { authenticate, requireRole } = require("../../middleware/auth");
const User = require("../../models/User");
const Appeal = require("../../models/Appeal");
const { logAdminAction } = require("../../utils/auditLogger");
const { sendToUser, broadcastToAdmins } = require("../../services/socket");
const { createAndSendEmailOtp } = require("../../utils/otpManager");

const actionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50,
  message: { message: "Too many actions performed, please try again later." },
});

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /admin/appeals
// ---------------------------------------------------------------------------
router.get("/", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const { role, status } = req.query;

    const filter = {};
    if (role && role !== "all") {
      filter.userRole = role.toLowerCase();
    }
    if (status && status !== "all") {
      filter.status = status.toLowerCase();
    }

    const appeals = await Appeal.find(filter)
      .populate("userId", "firstName lastName email mobileNumber updatedAt isSuspended suspensionType isPermanentlyDisabled")
      .sort({ updatedAt: -1 })
      .lean();

    const mapped = appeals.map((a) => ({
      _id: a._id.toString(),
      ticketNumber: a.ticketNumber,
      userId: a.userId ? a.userId._id.toString() : "",
      userRole: a.userRole,
      userName: a.userId ? `${a.userId.firstName} ${a.userId.lastName}` : "Unknown User",
      userEmail: a.userId?.email || "N/A",
      userPhone: a.userId?.mobileNumber || "N/A",
      suspensionReason: a.suspensionReason || "N/A",
      suspendedAt: a.userId?.updatedAt || a.createdAt,
      appealDeadline: null,
      subject: a.reason,
      status: a.status,
      hasUnreadAdmin: a.hasUnreadAdmin,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      proofMedia: a.proofMedia,
      messages: a.messages || [],
    }));

    return res.status(200).json({ appeals: mapped });
  } catch (err) {
    console.error("[admin/appeals-get]", err);
    return res.status(500).json({ message: "Server error fetching appeals." });
  }
});

// ---------------------------------------------------------------------------
// PATCH /admin/appeals/:id/lift (Approve appeal and restore user account)
// ---------------------------------------------------------------------------
router.patch("/:id/lift", authenticate, requireRole("admin"), actionLimiter, async (req, res) => {
  try {
    const appeal = await Appeal.findById(req.params.id);
    if (!appeal) {
      return res.status(404).json({ message: "Appeal not found." });
    }

    const user = await User.findById(appeal.userId);
    if (!user) {
      return res.status(404).json({ message: "User account not found." });
    }

    const dateStr = new Date().toLocaleDateString("en-US", {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });

    const sysMessage = {
      senderRole: "system",
      body: `Suspension lifted by Administrator on ${dateStr}. Account restored.`,
      createdAt: new Date(),
    };

    appeal.status = "lifted";
    appeal.hasUnreadAdmin = false;
    appeal.messages.push(sysMessage);
    await appeal.save();

    // Cascading update to User
    user.isSuspended = false;
    user.suspensionType = null;
    user.suspensionReason = null;
    user.suspensionEndDate = null;
    user.isPermanentlyDisabled = false;
    await user.save();

    sendToUser(user._id, "account_restored", {
      message: "Your appeal has been approved and your account suspension has been lifted.",
    });

    logAdminAction(
      req,
      req.user.id,
      `${user.firstName} ${user.lastName}`,
      "SUSPENSION_LIFTED",
      `Approved appeal ${appeal.ticketNumber} and lifted suspension for ${user.role} ${user.firstName} ${user.lastName}`
    );

    broadcastToAdmins("appeal_resolved", { appealId: appeal._id });

    return res.status(200).json({
      success: true,
      message: "Suspension lifted and user account restored.",
      appeal,
    });
  } catch (err) {
    console.error("[admin/appeals-lift]", err);
    return res.status(500).json({ message: "Server error lifting suspension." });
  }
});

// ---------------------------------------------------------------------------
// PATCH /admin/appeals/:id/disable (Reject appeal and disable / archive account)
// ---------------------------------------------------------------------------
router.patch("/:id/disable", authenticate, requireRole("admin"), actionLimiter, async (req, res) => {
  try {
    const { reason } = req.body;
    const appeal = await Appeal.findById(req.params.id);
    if (!appeal) {
      return res.status(404).json({ message: "Appeal not found." });
    }

    const user = await User.findById(appeal.userId);
    if (!user) {
      return res.status(404).json({ message: "User account not found." });
    }

    const dateStr = new Date().toLocaleDateString("en-US", {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });

    const reasonNote = reason ? ` Reason: ${reason.trim()}` : "";
    const sysMessage = {
      senderRole: "system",
      body: `Appeal rejected. Decision rendered by Administrator on ${dateStr}.${reasonNote}`,
      createdAt: new Date(),
    };

    appeal.status = "disabled";
    appeal.hasUnreadAdmin = false;
    appeal.messages.push(sysMessage);
    await appeal.save();

    // Cascading quota & disablement check
    let maxAppeals = 1;
    if (user.suspensionType === "suspend_resolved") {
      maxAppeals = 2;
    }

    // If permanent suspension or all appeal quotas exhausted, permanently archive
    if (user.suspensionType === "perm_suspend" || (user.appealCount || 0) >= maxAppeals) {
      user.isPermanentlyDisabled = true;
    }
    await user.save();

    sendToUser(user._id, "appeal_rejected", {
      message: "Your suspension appeal was rejected.",
    });

    logAdminAction(
      req,
      req.user.id,
      `${user.firstName} ${user.lastName}`,
      "APPEAL_REJECTED",
      `Rejected appeal ${appeal.ticketNumber} for ${user.role} ${user.firstName} ${user.lastName}.${reasonNote}`
    );

    broadcastToAdmins("appeal_resolved", { appealId: appeal._id });

    return res.status(200).json({
      success: true,
      message: "Appeal rejected and account status updated.",
      appeal,
    });
  } catch (err) {
    console.error("[admin/appeals-disable]", err);
    return res.status(500).json({ message: "Server error rejecting appeal." });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/appeals/:id/request-reevaluate-otp
// ---------------------------------------------------------------------------
router.post(["/request-reevaluate-otp", "/:id/request-reevaluate-otp"], authenticate, requireRole("admin"), actionLimiter, async (req, res) => {
  try {
    const adminUser = await User.findById(req.user.id);
    if (!adminUser || !adminUser.email) {
      return res.status(400).json({ message: "Admin email address not found." });
    }

    await createAndSendEmailOtp(adminUser._id, adminUser.email);

    return res.status(200).json({
      success: true,
      message: `OTP sent to ${adminUser.email}`,
    });
  } catch (err) {
    console.error("[admin/appeals-request-otp]", err);
    return res.status(500).json({ message: "Failed to send verification OTP." });
  }
});

// ---------------------------------------------------------------------------
// PATCH /admin/appeals/:id/reopen (Re-evaluate previous decision)
// ---------------------------------------------------------------------------
router.patch("/:id/reopen", authenticate, requireRole("admin"), actionLimiter, async (req, res) => {
  try {
    const appeal = await Appeal.findById(req.params.id);
    if (!appeal) {
      return res.status(404).json({ message: "Appeal not found." });
    }

    const user = await User.findById(appeal.userId);
    if (!user) {
      return res.status(404).json({ message: "User account not found." });
    }

    const dateStr = new Date().toLocaleDateString("en-US", {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });
    const timeStr = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const sysMessage = {
      senderRole: "system",
      body: `Appeal re-opened for re-evaluation by Administrator following two-factor security verification on ${dateStr} at ${timeStr}.`,
      createdAt: new Date(),
    };

    appeal.status = "pending";
    appeal.hasUnreadAdmin = true;
    appeal.messages.push(sysMessage);
    await appeal.save();

    // Revert permanent lockout if re-opened
    user.isPermanentlyDisabled = false;
    user.isSuspended = true;
    await user.save();

    logAdminAction(
      req,
      req.user.id,
      `${user.firstName} ${user.lastName}`,
      "APPEAL_REOPENED",
      `Re-opened appeal ${appeal.ticketNumber} for re-evaluation`
    );

    broadcastToAdmins("appeal_updated", { appealId: appeal._id });

    return res.status(200).json({
      success: true,
      message: "Appeal successfully returned to Pending Review.",
      appeal,
    });
  } catch (err) {
    console.error("[admin/appeals-reopen]", err);
    return res.status(500).json({ message: "Server error reopening appeal." });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/appeals/:id/messages (Admin replies to appeal thread)
// ---------------------------------------------------------------------------
router.post("/:id/messages", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) {
      return res.status(400).json({ message: "Message body is required." });
    }

    const appeal = await Appeal.findById(req.params.id);
    if (!appeal) {
      return res.status(404).json({ message: "Appeal not found." });
    }

    const adminUser = await User.findById(req.user.id);
    const adminName = adminUser ? `${adminUser.firstName} ${adminUser.lastName}` : "System Administrator";

    const newMsg = {
      senderRole: "admin",
      senderName: adminName,
      body: body.trim(),
      createdAt: new Date(),
    };

    appeal.messages.push(newMsg);
    appeal.hasUnreadUser = true;
    appeal.updatedAt = new Date();
    await appeal.save();

    sendToUser(appeal.userId, "appeal_message", {
      appealId: appeal._id,
      message: newMsg,
    });

    return res.status(201).json({ success: true, message: newMsg });
  } catch (err) {
    console.error("[admin/appeals-post-message]", err);
    return res.status(500).json({ message: "Server error replying to appeal." });
  }
});

module.exports = router;
