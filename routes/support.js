const express  = require("express");
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../middleware/auth");
const User           = require("../models/User");
const SupportTicket  = require("../models/SupportTicket");
const ChatMessage    = require("../models/ChatMessage");
const Ride           = require("../models/Ride");
const { broadcastToTicket, broadcastTicketResolved, broadcastToAdmins, isUserOnline } = require("../services/socket");
const { sendPushToUser } = require("../services/notification");
const { logAdminAction } = require("../utils/auditLogger");

const ALLOWED_MEDIA_TYPES = ["image", "video"];

// Rate limiter — max 30 messages per minute per user
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || rateLimit.ipKeyGenerator(req, res),
  message: { message: "You are sending messages too quickly. Please slow down." },
});

// Rate limiter — max 5 ticket creations per hour per user
const ticketLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || rateLimit.ipKeyGenerator(req, res),
  message: { message: "Too many tickets created. Please try again later." },
});

const router = express.Router();

// Register or refresh a device's Expo push token
router.post("/push-token", authenticate, async (req, res) => {
  try {
  const { pushToken } = req.body;

  if (!pushToken) {
    return res.status(400).json({ message: "pushToken is required." });
  }

  // $addToSet ensures the token is only added if it doesn't already exist.
  // This prevents duplicates if the app sends the same token on every launch.
  await User.findByIdAndUpdate(req.user.id, {
    $addToSet: { pushTokens: pushToken },
  });

  return res.status(200).json({ message: "Push token registered." });
  } catch (error) {
    console.error("[support/push-token]", error);
    return res.status(500).json({ message: "Server error" });
  }
});

const VALID_CATEGORIES = [
  "Fare Dispute",
  "Lost Item",
  "Driver Complaint",
  "App Issue",
  "Account & Profile",
  "General Support",
  "Ride Report",
  "Other"
];

// Create a new support ticket (passengers and drivers only)
router.post("/tickets", authenticate, ticketLimiter, async (req, res) => {
  try {
  const { subject, rideId } = req.body;

  if (req.user.role === "admin") {
    return res.status(403).json({ message: "Admins cannot create tickets." });
  }

  if (!subject || !subject.trim()) {
    return res.status(400).json({ message: "Subject is required." });
  }

  const trimmedSubject = subject.trim();
  if (!VALID_CATEGORIES.includes(trimmedSubject)) {
    return res.status(400).json({ message: "Invalid subject category." });
  }

  // If a rideId is provided, validate it belongs to the user and is < 7 days old
  if (rideId) {
    const ride = await Ride.findById(rideId);
    if (!ride) {
      return res.status(404).json({ message: "Ride not found." });
    }
    
    // Ensure the ride belongs to the user (either passenger or driver)
    if (ride.passengerId.toString() !== req.user.id && ride.driverId?.toString() !== req.user.id) {
      return res.status(403).json({ message: "You don't have permission to report this ride." });
    }

    // Check if ride is older than 7 days
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const rideDate = ride.tripCompletedAt || ride.createdAt;
    if (Date.now() - new Date(rideDate).getTime() > SEVEN_DAYS_MS) {
      return res.status(400).json({ message: "You can only report rides completed within the last 7 days." });
    }
  }

  const openTicketsCount = await SupportTicket.countDocuments({
    userId: req.user.id,
    status: "open"
  });

  if (openTicketsCount >= 3) {
    return res.status(400).json({ message: "You have reached the maximum number of open tickets (3). Please wait for an existing ticket to be resolved." });
  }

  const ticketData = {
    userId: req.user.id,
    userRole: req.user.role,
    subject: trimmedSubject,
  };
  if (rideId) {
    ticketData.rideId = rideId;
  }

  const ticket = await SupportTicket.create(ticketData);

  // Populate user info so admin panel can display it immediately
  await ticket.populate("userId", "firstName lastName role");
  
  // Notify admins
  broadcastToAdmins("new_ticket", ticket);

  return res.status(201).json({ ticket });
  } catch (error) {
    console.error("[support/post-tickets]", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// Fetch tickets — admin sees all, others see only their own
router.get("/tickets", authenticate, async (req, res) => {
  try {
  const filter = req.user.role === "admin" ? {} : { userId: req.user.id };
  
  if (req.user.role === "admin" && req.query.role) {
    filter.userRole = req.query.role;
  }

  const tickets = await SupportTicket.find(filter)
    .populate("userId", "firstName lastName role")
    .sort({ updatedAt: -1 });

  return res.status(200).json({ tickets });
  } catch (error) {
    console.error("[support/get-tickets]", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// Fetch message history for a specific ticket
router.get("/tickets/:ticketId/messages", authenticate, async (req, res) => {
  try {
  const ticket = await SupportTicket.findById(req.params.ticketId);

  if (!ticket) {
    return res.status(404).json({ message: "Ticket not found." });
  }

  // Non-admin users can only view their own tickets
  if (req.user.role !== "admin" && ticket.userId.toString() !== req.user.id) {
    return res.status(403).json({ message: "Access denied." });
  }

  const messages = await ChatMessage.find({ ticketId: ticket._id })
    .sort({ createdAt: 1 });

  // Clear unread status if admin is viewing
  if (req.user.role === "admin" && ticket.hasUnreadAdmin !== false) {
    ticket.hasUnreadAdmin = false;
    await ticket.save();
  }

  return res.status(200).json({ messages, status: ticket.status });
  } catch (error) {
    console.error("[support/get-messages]", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// Send a message in a ticket (text, media, or both)
router.post("/tickets/:ticketId/messages", authenticate, messageLimiter, async (req, res) => {
  try {
  const { body, mediaUrl, mediaType } = req.body;

  const hasText = body && typeof body === "string" && body.trim();
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

  const ticket = await SupportTicket.findById(req.params.ticketId);

  if (!ticket) {
    return res.status(404).json({ message: "Ticket not found." });
  }

  // Non-admin users can only send to their own tickets
  if (req.user.role !== "admin" && ticket.userId.toString() !== req.user.id) {
    return res.status(403).json({ message: "Access denied." });
  }

  const messageData = {
    ticketId: ticket._id,
    senderId: req.user.id,
    senderRole: req.user.role,
  };

  if (hasText) messageData.body = body.trim();
  if (hasMedia) {
    messageData.mediaUrl = mediaUrl;
    messageData.mediaType = mediaType;
  }

  const message = await ChatMessage.create(messageData);

  // Touch the ticket's updatedAt so it floats to the top of the list
  ticket.updatedAt = new Date();
  if (req.user.role !== "admin") {
    ticket.hasUnreadAdmin = true;
  }
  await ticket.save();

  // Broadcast to anyone currently viewing this ticket in real-time
  broadcastToTicket(ticket._id.toString(), message);
  
  // Notify all admins to update their ticket list preview
  broadcastToAdmins("ticket_updated", {
    ticketId: ticket._id.toString(),
    updatedAt: ticket.updatedAt,
    senderRole: req.user.role,
  });

  // Build push notification body
  const pushBody = hasText
    ? body.trim()
    : hasMedia
      ? `Sent ${mediaType === "video" ? "a video" : "an image"}`
      : "New message";

  // If the other party is offline, send a push notification
  if (req.user.role === "admin") {
    // Admin sent the message → check if the ticket owner (passenger/driver) is online
    if (!isUserOnline(ticket.userId)) {
      await sendPushToUser(ticket.userId, "Support Update 💬", pushBody, {
        ticketId: ticket._id.toString(),
        type: "support_chat",
      });
    }
  } else {
    // Passenger/driver sent the message → notify all admins who are offline
    const admins = await User.find({ role: "admin" }).select("_id");
    for (const admin of admins) {
      if (!isUserOnline(admin._id)) {
        await sendPushToUser(admin._id, "New Support Message 💬", pushBody, {
          ticketId: ticket._id.toString(),
          type: "support_chat",
        });
      }
    }
  }

  return res.status(201).json({ message });
  } catch (error) {
    console.error("[support/post-messages]", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// Resolve a ticket
router.patch("/tickets/:ticketId/resolve", authenticate, async (req, res) => {
  try {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Only admins can resolve tickets." });
  }

  const ticket = await SupportTicket.findById(req.params.ticketId);

  if (!ticket) {
    return res.status(404).json({ message: "Ticket not found." });
  }

  if (ticket.status === "resolved") {
    return res.status(400).json({ message: "Ticket is already resolved." });
  }

  ticket.status = "resolved";
  ticket.updatedAt = new Date();
  await ticket.save();

  await ticket.populate("userId", "firstName lastName");
  await logAdminAction(req, req.user.id, "", "TICKET_RESOLVED", `Resolved support ticket #${ticket._id.toString().slice(-6)} (${ticket.subject}) from ${ticket.userRole} ${ticket.userId.firstName} ${ticket.userId.lastName}`);

  // Create a system message
  const message = await ChatMessage.create({
    ticketId: ticket._id,
    senderId: req.user.id,
    senderRole: "admin",
    body: "This ticket has been marked as resolved by an admin.",
  });

  // Broadcast the system message and the resolved event
  broadcastToTicket(ticket._id.toString(), message);
  broadcastTicketResolved(ticket._id.toString());
  broadcastToAdmins("ticket_updated", {
    ticketId: ticket._id.toString(),
    updatedAt: ticket.updatedAt,
    status: "resolved"
  });

  return res.status(200).json({ ticket });
  } catch (error) {
    console.error("[support/resolve-ticket]", error);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;