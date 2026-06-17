const express  = require("express");
const { authenticate } = require("../middleware/auth");
const User           = require("../models/User");
const SupportTicket  = require("../models/SupportTicket");
const ChatMessage    = require("../models/ChatMessage");
const { broadcastToTicket, isUserOnline } = require("../services/socket");
const { sendPushToUser } = require("../services/notification");

const router = express.Router();

// Register or refresh a device's Expo push token
router.post("/push-token", authenticate, async (req, res) => {
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
});

// Create a new support ticket (passengers and drivers only)
router.post("/tickets", authenticate, async (req, res) => {
  const { subject } = req.body;

  if (req.user.role === "admin") {
    return res.status(403).json({ message: "Admins cannot create tickets." });
  }

  if (!subject || !subject.trim()) {
    return res.status(400).json({ message: "Subject is required." });
  }

  const ticket = await SupportTicket.create({
    userId: req.user.id,
    subject: subject.trim(),
  });

  return res.status(201).json({ ticket });
});

// Fetch tickets — admin sees all, others see only their own
router.get("/tickets", authenticate, async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { userId: req.user.id };

  const tickets = await SupportTicket.find(filter)
    .populate("userId", "firstName lastName role")
    .sort({ updatedAt: -1 });

  return res.status(200).json({ tickets });
});

// Fetch message history for a specific ticket
router.get("/tickets/:ticketId/messages", authenticate, async (req, res) => {
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

  return res.status(200).json({ messages });
});

// Send a message in a ticket
router.post("/tickets/:ticketId/messages", authenticate, async (req, res) => {
  const { body } = req.body;

  if (!body || !body.trim()) {
    return res.status(400).json({ message: "Message body is required." });
  }

  const ticket = await SupportTicket.findById(req.params.ticketId);

  if (!ticket) {
    return res.status(404).json({ message: "Ticket not found." });
  }

  // Non-admin users can only send to their own tickets
  if (req.user.role !== "admin" && ticket.userId.toString() !== req.user.id) {
    return res.status(403).json({ message: "Access denied." });
  }

  const message = await ChatMessage.create({
    ticketId: ticket._id,
    senderId: req.user.id,
    senderRole: req.user.role,
    body: body.trim(),
  });

  // Touch the ticket's updatedAt so it floats to the top of the list
  ticket.updatedAt = new Date();
  await ticket.save();

  // Broadcast to anyone currently viewing this ticket in real-time
  broadcastToTicket(ticket._id.toString(), message);

  // If the other party is offline, send a push notification
  if (req.user.role === "admin") {
    // Admin sent the message → check if the ticket owner (passenger/driver) is online
    if (!isUserOnline(ticket.userId)) {
      await sendPushToUser(ticket.userId, "Support Update 💬", body.trim(), {
        ticketId: ticket._id.toString(),
        type: "support_chat",
      });
    }
  } else {
    // Passenger/driver sent the message → notify all admins who are offline
    const admins = await User.find({ role: "admin" }).select("_id");
    for (const admin of admins) {
      if (!isUserOnline(admin._id)) {
        await sendPushToUser(admin._id, "New Support Message 💬", body.trim(), {
          ticketId: ticket._id.toString(),
          type: "support_chat",
        });
      }
    }
  }

  return res.status(201).json({ message });
});

module.exports = router;