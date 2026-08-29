const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const ActiveDriver = require("../models/ActiveDriver");

let io;

// Map<userId (string), socketId[] (array of strings)>
// Tracks all active socket connections per user.
// A user may have multiple connections (e.g. two browser tabs for admin).
const activeUsers = new Map();

function init(server) {
  io = new Server(server, {
    cors: { origin: "*" },
  });

  // ── Authentication middleware ──────────────────────────────────────────
  // Runs once when a client first connects (the handshake).
  // The client must pass their access token in the `auth` object:
  //   io("http://...", { auth: { token: "eyJhbG..." } })
  //
  // This is the exact same verification logic as middleware/auth.js,
  // but adapted for Socket.IO's middleware signature (socket, next).
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("No token provided."));

    try {
      const decoded = jwt.verify(token, process.env.ACCESS_SECRET);
      if (decoded.pending) return next(new Error("Token not fully authenticated."));
      socket.user = decoded; // Attach user info (id, role) to the socket instance
      next();
    } catch (err) {
      next(new Error("Invalid or expired token."));
    }
  });

  // ── Connection handler ─────────────────────────────────────────────────
  io.on("connection", (socket) => {
    const userId = socket.user.id;

    // Register this socket in the activeUsers map
    if (!activeUsers.has(userId)) {
      activeUsers.set(userId, []);
    }
    activeUsers.get(userId).push(socket.id);

    // If user is an admin, join the admin broadcast room
    if (socket.user.role === "admin") {
      socket.join("admin_room");
    }

    // When the client opens a specific ticket's chat screen,
    // they emit "join_ticket" to start receiving real-time messages for it.
    socket.on("join_ticket", ({ ticketId }) => {
      socket.join(ticketId);
    });

    // When the client leaves the chat screen (navigates away),
    // they emit "leave_ticket" to stop receiving messages for that ticket.
    socket.on("leave_ticket", ({ ticketId }) => {
      socket.leave(ticketId);
    });

    // ── Rides ──────────────────────────────────────────────────────────────
    // When a passenger or driver opens a ride screen, they join the ride room
    socket.on("join_ride", ({ rideId }) => {
      console.log(`[Socket] User ${userId} joining ride room: ${rideId}`);
      socket.join(rideId);
    });

    socket.on("leave_ride", ({ rideId }) => {
      socket.leave(rideId);
    });

    // ── WebRTC Signaling ───────────────────────────────────────────────────
    socket.on("webrtc_call_initiated", ({ rideId, callerName, isVideo }) => {
      // Broadcast to the other party in the ride room
      socket.to(rideId.toString()).emit("webrtc_call_initiated", { callerName, isVideo, rideId });
    });

    socket.on("webrtc_call_accepted", ({ rideId }) => {
      socket.to(rideId.toString()).emit("webrtc_call_accepted");
    });

    socket.on("webrtc_call_denied", ({ rideId }) => {
      socket.to(rideId.toString()).emit("webrtc_call_denied");
    });

    socket.on("webrtc_offer", ({ rideId, offer }) => {
      socket.to(rideId.toString()).emit("webrtc_offer", offer);
    });

    socket.on("webrtc_answer", ({ rideId, answer }) => {
      socket.to(rideId.toString()).emit("webrtc_answer", answer);
    });

    socket.on("webrtc_ice_candidate", ({ rideId, candidate }) => {
      socket.to(rideId.toString()).emit("webrtc_ice_candidate", candidate);
    });

    socket.on("webrtc_end_call", ({ rideId }) => {
      socket.to(rideId.toString()).emit("webrtc_end_call");
    });

    socket.on("webrtc_video_toggled", ({ rideId, isVideoOn }) => {
      socket.to(rideId.toString()).emit("webrtc_video_toggled", { isVideoOn });
    });

    // Driver sends their location during an active trip
    socket.on("driver_location_update", ({ rideId, location }) => {
      // Broadcast this location update to anyone else in the ride room (the passenger)
      broadcastToRide(rideId, "driver_location_update", location);
    });

    // Clean up when the socket disconnects (e.g. user closes the app)
    socket.on("disconnect", async () => {
      const sockets = activeUsers.get(userId) || [];
      const index = sockets.indexOf(socket.id);
      if (index !== -1) sockets.splice(index, 1);

      // If the user has no remaining connections, remove them entirely
      if (sockets.length === 0) {
        activeUsers.delete(userId);
        
        // If they are a driver, mark them offline since they completely closed the app
        if (socket.user.role === "driver") {
          try {
            await ActiveDriver.findOneAndUpdate(
              { driverId: userId },
              { isOnline: false }
            );
            console.log(`[Socket] Driver ${userId} completely disconnected. Set to offline.`);
          } catch (err) {
            console.error(`[Socket] Failed to set driver ${userId} offline on disconnect:`, err);
          }
        }
      }
    });
  });

  return io;
}

// ── Helper functions (used by routes/support.js and routes/ride.js) ────────

// Broadcast a message to all clients currently viewing a specific ticket
function broadcastToTicket(ticketId, message) {
  if (!io) return;
  io.to(ticketId.toString()).emit("receive_message", message);
}

// Broadcast that a ticket was resolved
function broadcastTicketResolved(ticketId) {
  if (!io) return;
  io.to(ticketId.toString()).emit("ticket_resolved");
}

// Broadcast an event to all connected admins
function broadcastToAdmins(event, payload) {
  if (!io) return;
  io.to("admin_room").emit(event, payload);
}

// Broadcast to a specific ride room (for state updates, location tracking, chat)
function broadcastToRide(rideId, event, payload) {
  if (!io) return;
  console.log(`[Socket] Broadcasting ${event} to room: ${rideId}`);
  io.to(rideId.toString()).emit(event, payload);
}

// Send an event to a specific user (e.g., sending a ride request to a driver)
function sendToUser(userId, event, payload) {
  if (!io) return;
  const sockets = activeUsers.get(userId.toString());
  if (sockets && sockets.length > 0) {
    sockets.forEach(socketId => {
      io.to(socketId).emit(event, payload);
    });
  }
}

// Check if a specific user has any active socket connections
function isUserOnline(userId) {
  return activeUsers.has(userId.toString());
}

// Return the io instance (in case other parts of the app need it)
function getIO() {
  if (!io) throw new Error("Socket.io not initialized.");
  return io;
}

// Force all active sockets of a user to join a specific room
function joinUserToRoom(userId, roomName) {
  if (!io) return;
  const sockets = activeUsers.get(userId.toString());
  if (sockets && sockets.length > 0) {
    sockets.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.join(roomName);
      }
    });
  }
}

module.exports = { 
  init, 
  broadcastToTicket, 
  broadcastTicketResolved, 
  broadcastToAdmins, 
  broadcastToRide,
  sendToUser,
  isUserOnline, 
  getIO,
  joinUserToRoom
};