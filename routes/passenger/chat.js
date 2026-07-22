const express = require("express");
const rateLimit = require("express-rate-limit");
const { authenticate, requireRole } = require("../../middleware/auth");
const Ride = require("../../models/Ride");
const { broadcastToRide } = require("../../services/socket");

const ALLOWED_MEDIA_TYPES = ["image", "video"];

// Rate limiter — max 30 messages per minute per user
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { message: "You are sending messages too quickly. Please slow down." },
});

const router = express.Router();

// Get chat messages for a ride
router.get("/:rideId/chat", authenticate, requireRole("passenger"), async (req, res) => {
  try {
    const ride = await Ride.findOne({ _id: req.params.rideId, passengerId: req.user.id });
    if (!ride) return res.status(404).json({ message: "Ride not found." });

    res.json({ messages: ride.chatMessages || [] });
  } catch (err) {
    console.error("[passenger-chat-get]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Send a chat message (text, media, or both)
router.post("/:rideId/chat", authenticate, requireRole("passenger"), messageLimiter, async (req, res) => {
  try {
    const { text, time, id, mediaUrl, mediaType } = req.body;

    const hasText = text && typeof text === "string" && text.trim();
    const hasMedia = mediaUrl && mediaType;

    if (!hasText && !hasMedia) {
      return res.status(400).json({ message: "A message must have either text or a media attachment." });
    }

    // Validate media fields if present
    if (hasMedia) {
      if (typeof mediaUrl !== "string" || !mediaUrl.startsWith("https://")) {
        return res.status(400).json({ message: "Invalid media URL." });
      }
      if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
        return res.status(400).json({ message: 'Invalid media type. Must be "image" or "video".' });
      }
    }

    const ride = await Ride.findOne({ _id: req.params.rideId, passengerId: req.user.id });
    if (!ride) return res.status(404).json({ message: "Ride not found." });

    if (["pending", "completed", "cancelled"].includes(ride.status)) {
      return res.status(400).json({ message: "Chat is not available for this ride status." });
    }

    const newMessage = {
      senderRole: "passenger",
      senderId: req.user.id,
      time,
      id: id || Date.now().toString(),
      createdAt: new Date(),
    };

    if (hasText) newMessage.text = text;
    if (hasMedia) {
      newMessage.mediaUrl = mediaUrl;
      newMessage.mediaType = mediaType;
    }

    ride.chatMessages.push(newMessage);
    await ride.save();

    // Broadcast the message via socket
    broadcastToRide(ride._id, "receive_ride_message", {
      from: "passenger",
      text: newMessage.text || null,
      mediaUrl: newMessage.mediaUrl || null,
      mediaType: newMessage.mediaType || null,
      time: newMessage.time,
      id: newMessage.id,
    });

    res.json({ message: newMessage });
  } catch (err) {
    console.error("[passenger-chat-post]", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
