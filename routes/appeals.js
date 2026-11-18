const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const cloudinary = require("cloudinary").v2;
const User = require("../models/User");
const Appeal = require("../models/Appeal");
const { broadcastToAdmins } = require("../services/socket");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const router = express.Router();

// ---------------------------------------------------------------------------
// Rate Limiters
// ---------------------------------------------------------------------------
const appealSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many appeal submission attempts. Please try again later." },
});

const appealReadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please slow down." },
});

// ---------------------------------------------------------------------------
// Middleware: Scoped Authentication for Suspended Users
// ---------------------------------------------------------------------------
async function authenticateAppealToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No appeal token provided." });
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.PENDING_SECRET);

    if (!decoded.isAppealSession) {
      return res.status(403).json({ message: "Invalid appeal session token." });
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(404).json({ message: "User account not found." });
    }

    if (!user.isSuspended) {
      return res.status(400).json({ message: "Account is not currently suspended." });
    }

    req.user = decoded;
    req.suspendedUser = user;
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Your appeal session has expired. Please log in again." });
    }
    console.error("[authenticateAppealToken]", err);
    return res.status(500).json({ message: "Server error authenticating appeal session." });
  }
}

// ---------------------------------------------------------------------------
// POST /appeals/submit
// ---------------------------------------------------------------------------
router.post("/submit", authenticateAppealToken, appealSubmitLimiter, async (req, res) => {
  try {
    const user = req.suspendedUser;
    const { reason, imageBase64 } = req.body;

    if (user.isPermanentlyDisabled) {
      return res.status(403).json({
        message: "Your account has been permanently disabled and cannot submit further appeals.",
      });
    }

    if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
      return res.status(400).json({
        message: "Please provide a detailed appeal statement (at least 10 characters).",
      });
    }

    // Determine max appeals for user's suspension tier
    let maxAppeals = 1;
    if (user.suspensionType === "suspend_resolved") {
      maxAppeals = 2;
    }

    // Enforce 1 active pending appeal at a time
    const existingPending = await Appeal.findOne({ userId: user._id, status: "pending" });
    if (existingPending) {
      return res.status(409).json({
        message: "You already have a pending appeal under review. Please wait for the administrator's decision.",
        pendingAppealId: existingPending._id,
      });
    }

    // Enforce quota
    if ((user.appealCount || 0) >= maxAppeals) {
      return res.status(403).json({
        message: "You have already reached the maximum number of appeals for this suspension.",
      });
    }

    let proofMedia = null;
    if (imageBase64) {
      try {
        const uploadRes = await cloudinary.uploader.upload(imageBase64, {
          folder: "appeals",
        });
        proofMedia = uploadRes.secure_url;
      } catch (uploadErr) {
        console.error("[appeals/upload]", uploadErr);
        return res.status(500).json({ message: "Failed to upload proof photo. Please try again." });
      }
    }

    // Generate formatted ticket number e.g. APL-2026-081
    const currentYear = new Date().getFullYear();
    const count = await Appeal.countDocuments();
    const ticketSeq = String(count + 1).padStart(3, "0");
    const ticketNumber = `APL-${currentYear}-${ticketSeq}`;

    const newAppeal = new Appeal({
      ticketNumber,
      userId: user._id,
      userRole: user.role,
      suspensionType: user.suspensionType,
      suspensionReason: user.suspensionReason,
      reason: reason.trim(),
      proofMedia,
      status: "pending",
      attemptNumber: (user.appealCount || 0) + 1,
      messages: [
        {
          senderRole: "user",
          senderName: `${user.firstName} ${user.lastName}`,
          body: reason.trim(),
          mediaUrl: proofMedia,
          mediaType: proofMedia ? "image" : null,
          createdAt: new Date(),
        },
      ],
      hasUnreadAdmin: true,
      hasUnreadUser: false,
    });

    await newAppeal.save();

    user.appealCount = (user.appealCount || 0) + 1;
    await user.save();

    // Notify connected admins
    broadcastToAdmins("new_appeal", {
      _id: newAppeal._id,
      ticketNumber: newAppeal.ticketNumber,
      userName: `${user.firstName} ${user.lastName}`,
      userRole: user.role,
      subject: newAppeal.reason.slice(0, 50),
      createdAt: newAppeal.createdAt,
    });

    return res.status(201).json({
      success: true,
      message: "Appeal submitted successfully.",
      appeal: newAppeal,
    });
  } catch (err) {
    console.error("[appeals/submit]", err);
    return res.status(500).json({ message: "Server error while processing your appeal." });
  }
});

// ---------------------------------------------------------------------------
// GET /appeals/my-appeal
// ---------------------------------------------------------------------------
router.get("/my-appeal", authenticateAppealToken, appealReadLimiter, async (req, res) => {
  try {
    const user = req.suspendedUser;

    const appeal = await Appeal.findOne({ userId: user._id }).sort({ createdAt: -1 });

    let maxAppeals = 1;
    if (user.suspensionType === "suspend_resolved") {
      maxAppeals = 2;
    }
    const appealsRemaining = Math.max(0, maxAppeals - (user.appealCount || 0));

    return res.status(200).json({
      success: true,
      appeal,
      suspension: {
        type: user.suspensionType,
        reason: user.suspensionReason,
        endDate: user.suspensionEndDate,
        appealsUsed: user.appealCount || 0,
        maxAppeals,
        appealsRemaining,
        hasPendingAppeal: !!(appeal && appeal.status === "pending"),
        isPermanentlyDisabled: !!user.isPermanentlyDisabled,
      },
    });
  } catch (err) {
    console.error("[appeals/my-appeal]", err);
    return res.status(500).json({ message: "Server error fetching appeal status." });
  }
});

// ---------------------------------------------------------------------------
// POST /appeals/:id/messages OR POST /appeals/my-appeal/messages
// (Appellant sends a message in their appeal thread)
// ---------------------------------------------------------------------------
router.post(["/my-appeal/messages", "/:id/messages"], authenticateAppealToken, appealSubmitLimiter, async (req, res) => {
  try {
    const user = req.suspendedUser;
    const { body, imageBase64, mediaUrl: clientMediaUrl, mediaType: clientMediaType } = req.body;

    let appeal;
    if (req.params.id && req.params.id !== "my-appeal") {
      // Validate ObjectId to prevent CastError
      if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
        return res.status(400).json({ message: "Invalid appeal ID format." });
      }
      appeal = await Appeal.findById(req.params.id);
    } else {
      // Resolve currently active/latest appeal for the authenticated suspended user
      appeal = await Appeal.findOne({ userId: user._id }).sort({ createdAt: -1 });
    }

    if (!appeal) {
      return res.status(404).json({ message: "Appeal not found." });
    }

    if (appeal.userId.toString() !== user._id.toString()) {
      return res.status(403).json({ message: "Unauthorized access to this appeal." });
    }

    if (appeal.status !== "pending") {
      return res.status(400).json({ message: "Cannot reply to an appeal that has already been resolved." });
    }

    if ((!body || !body.trim()) && !imageBase64 && !clientMediaUrl) {
      return res.status(400).json({ message: "Message body or media attachment is required." });
    }

    let mediaUrl = clientMediaUrl || null;
    let mediaType = clientMediaType || null;

    if (imageBase64) {
      const uploadRes = await cloudinary.uploader.upload(imageBase64, {
        folder: "appeals",
        resource_type: "auto",
      });
      mediaUrl = uploadRes.secure_url;
      mediaType = uploadRes.resource_type === "video" ? "video" : "image";
    }

    if (mediaUrl && !mediaType) {
      const cleanUrl = mediaUrl.split("?")[0].toLowerCase();
      if (
        cleanUrl.includes("/video/upload/") ||
        cleanUrl.endsWith(".mp4") ||
        cleanUrl.endsWith(".mov") ||
        cleanUrl.endsWith(".webm") ||
        cleanUrl.endsWith(".m4v")
      ) {
        mediaType = "video";
      } else {
        mediaType = "image";
      }
    }

    const newMsg = {
      senderRole: "user",
      senderName: `${user.firstName} ${user.lastName}`,
      body: body ? body.trim() : "",
      mediaUrl,
      mediaType,
      createdAt: new Date(),
    };

    appeal.messages.push(newMsg);
    appeal.hasUnreadAdmin = true;
    appeal.updatedAt = new Date();
    await appeal.save();

    broadcastToAdmins("appeal_updated", {
      appealId: appeal._id,
      updatedAt: appeal.updatedAt,
      ticketNumber: appeal.ticketNumber,
    });

    return res.status(201).json({ success: true, message: newMsg });
  } catch (err) {
    console.error("[appeals/:id/messages]", err);
    return res.status(500).json({ message: "Server error sending message." });
  }
});

module.exports = router;
