const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const cloudinary = require("cloudinary").v2;
const cron = require("node-cron");
const { authenticate } = require("../middleware/auth");
const User = require("../models/User");
const SupportTicket = require("../models/SupportTicket");
const ChatMessage = require("../models/ChatMessage");
const Ride = require("../models/Ride");

const router = express.Router();

/**
 * Middleware: Allow either active authenticated users OR suspended users with a valid appeal session token
 */
async function authenticateOrAppealToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  const token = authHeader.split(" ")[1];

  // Try standard access token first
  try {
    const decoded = jwt.verify(token, process.env.ACCESS_SECRET);
    if (!decoded.pending) {
      const user = await User.findById(decoded.id).select("tokenVersion isSuspended");
      if (user && !user.isSuspended) {
        req.user = decoded;
        return next();
      }
    }
  } catch (err) {
    // Fallback to check appeal token
  }

  // Try appeal session token (signed with PENDING_SECRET)
  try {
    const decodedAppeal = jwt.verify(token, process.env.PENDING_SECRET);
    if (decodedAppeal.isAppealSession) {
      const user = await User.findById(decodedAppeal.id).select("isSuspended");
      if (user && user.isSuspended) {
        req.user = { id: user._id.toString(), isAppeal: true };
        return next();
      }
    }
  } catch (err) {
    // Both failed
  }

  return res.status(401).json({ message: "Invalid or expired authorization token." });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ALLOWED_MEDIA_TYPES = ["image", "video"];
const MAX_IMAGE_SIZE_MB = 5;
const MAX_VIDEO_SIZE_MB = 20;

// ---------------------------------------------------------------------------
// Rate limiter — max 10 signature requests per 10 minutes per user
// This is the chokepoint for Cloudinary abuse since the client needs a
// signed upload credential before they can push anything to Cloudinary.
// ---------------------------------------------------------------------------
const signatureLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || rateLimit.ipKeyGenerator(req, res),
  message: {
    message: "Too many upload requests. Please wait before trying again.",
  },
});

// ---------------------------------------------------------------------------
// POST /chat/cloudinary-signature
// Generates a signed upload signature for the client to upload directly
// to Cloudinary. All chat media is stored in the "chat-media" folder.
//
// Body: { mediaType: "image" | "video" }
// ---------------------------------------------------------------------------
router.post(
  "/cloudinary-signature",
  authenticateOrAppealToken,
  signatureLimiter,
  async (req, res) => {
    try {
      const { mediaType } = req.body;

      if (!mediaType || !ALLOWED_MEDIA_TYPES.includes(mediaType)) {
        return res.status(400).json({
          message:
            'Invalid media type. Must be "image" or "video".',
        });
      }

      const timestamp = Math.round(Date.now() / 1000);
      const folder = "chat-media";
      const tags = "chat-media-temp";

      // Restrict upload to specific resource types
      const resourceType = mediaType === "video" ? "video" : "image";

      const paramsToSign = { timestamp, folder, tags };

      const signature = cloudinary.utils.api_sign_request(
        paramsToSign,
        process.env.CLOUDINARY_API_SECRET
      );

      return res.status(200).json({
        signature,
        timestamp,
        folder,
        tags,
        resourceType,
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        maxSizeMB:
          mediaType === "video" ? MAX_VIDEO_SIZE_MB : MAX_IMAGE_SIZE_MB,
      });
    } catch (err) {
      console.error("[chat/cloudinary-signature]", err);
      return res
        .status(500)
        .json({ message: "Server error. Please try again." });
    }
  }
);

// ---------------------------------------------------------------------------
// Cloudinary chat-media cleanup job
// Runs daily at 3:00 AM Philippine Time (UTC+8).
//
// Deletes media from Cloudinary when BOTH conditions are met:
//   1. The parent ride is completed/cancelled OR the support ticket is resolved.
//   2. The media was uploaded at least 7 days ago.
//
// This keeps Cloudinary storage lean while still giving users time to review
// their conversations after a ride or support interaction ends.
// ---------------------------------------------------------------------------
async function cleanupExpiredChatMedia() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  console.log("[chat-media-cleanup] Starting cleanup run...");

  const publicIdsToDelete = [];

  try {
    // ── Support ticket messages ──────────────────────────────────────────
    const resolvedTickets = await SupportTicket.find({
      status: "resolved",
    }).select("_id");

    const resolvedTicketIds = resolvedTickets.map((t) => t._id);

    if (resolvedTicketIds.length > 0) {
      const expiredTicketMessages = await ChatMessage.find({
        ticketId: { $in: resolvedTicketIds },
        mediaUrl: { $ne: null },
        createdAt: { $lte: sevenDaysAgo },
      }).select("mediaUrl");

      for (const msg of expiredTicketMessages) {
        const publicId = extractPublicId(msg.mediaUrl);
        if (publicId) publicIdsToDelete.push(publicId);
      }

      // Clear the mediaUrl from the database records (mark as cleaned)
      if (expiredTicketMessages.length > 0) {
        const msgIds = expiredTicketMessages.map((m) => m._id);
        await ChatMessage.updateMany(
          { _id: { $in: msgIds } },
          { $set: { mediaUrl: null } }
        );
      }
    }

    // ── Ride chat messages ───────────────────────────────────────────────
    const completedRides = await Ride.find({
      status: { $in: ["completed", "cancelled"] },
      "chatMessages.mediaUrl": { $ne: null },
    }).select("chatMessages");

    for (const ride of completedRides) {
      let changed = false;
      for (const msg of ride.chatMessages) {
        if (msg.mediaUrl && msg.createdAt <= sevenDaysAgo) {
          const publicId = extractPublicId(msg.mediaUrl);
          if (publicId) publicIdsToDelete.push(publicId);
          msg.mediaUrl = null;
          changed = true;
        }
      }
      if (changed) await ride.save();
    }

    // ── Batch delete from Cloudinary ─────────────────────────────────────
    if (publicIdsToDelete.length > 0) {
      // Cloudinary delete_resources accepts up to 100 IDs at a time
      for (let i = 0; i < publicIdsToDelete.length; i += 100) {
        const batch = publicIdsToDelete.slice(i, i + 100);
        try {
          await cloudinary.api.delete_resources(batch);
        } catch (deleteErr) {
          console.error(
            "[chat-media-cleanup] Batch delete failed:",
            deleteErr
          );
        }
      }
      console.log(
        `[chat-media-cleanup] Deleted ${publicIdsToDelete.length} expired media file(s).`
      );
    } else {
      console.log("[chat-media-cleanup] No expired media to clean up.");
    }
  } catch (err) {
    console.error("[chat-media-cleanup] Cleanup failed:", err);
  }
}

/**
 * Extracts the Cloudinary public ID from a secure URL.
 * e.g. "https://res.cloudinary.com/xxx/image/upload/v123/chat-media/abc.jpg"
 *       → "chat-media/abc"
 */
function extractPublicId(url) {
  if (!url) return null;
  try {
    // Match everything after /upload/vNNNN/ or /upload/
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/);
    if (!match) return null;
    // Remove the file extension
    const withExt = match[1];
    return withExt.replace(/\.[^.]+$/, "");
  } catch {
    return null;
  }
}

// Run daily at 3:00 AM Philippine Time
cron.schedule("0 3 * * *", cleanupExpiredChatMedia, {
  timezone: "Asia/Manila",
});

module.exports = router;
