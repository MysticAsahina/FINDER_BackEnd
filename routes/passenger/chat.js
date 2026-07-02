const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const Ride = require("../../models/Ride");
const { broadcastToRide } = require("../../services/socket");

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

// Send a chat message
router.post("/:rideId/chat", authenticate, requireRole("passenger"), async (req, res) => {
  try {
    const { text, time, id } = req.body;
    if (!text) return res.status(400).json({ message: "Message text is required" });

    const ride = await Ride.findOne({ _id: req.params.rideId, passengerId: req.user.id });
    if (!ride) return res.status(404).json({ message: "Ride not found." });

    if (["pending", "completed", "cancelled"].includes(ride.status)) {
      return res.status(400).json({ message: "Chat is not available for this ride status." });
    }

    const newMessage = {
      senderRole: "passenger",
      senderId: req.user.id,
      text,
      time,
      id: id || Date.now().toString(),
      createdAt: new Date(),
    };

    ride.chatMessages.push(newMessage);
    await ride.save();

    // Broadcast the message via socket
    broadcastToRide(ride._id, "receive_ride_message", {
      from: "passenger",
      text: newMessage.text,
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
