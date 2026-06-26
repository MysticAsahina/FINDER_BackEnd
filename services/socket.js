const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

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

    // Clean up when the socket disconnects (e.g. user closes the app)
    socket.on("disconnect", () => {
      const sockets = activeUsers.get(userId) || [];
      const index = sockets.indexOf(socket.id);
      if (index !== -1) sockets.splice(index, 1);

      // If the user has no remaining connections, remove them entirely
      if (sockets.length === 0) {
        activeUsers.delete(userId);
      }
    });
  });

  return io;
}

// ── Helper functions (used by routes/support.js) ───────────────────────────

// Broadcast a message to all clients currently viewing a specific ticket
function broadcastToTicket(ticketId, message) {
  if (!io) return;
  io.to(ticketId).emit("receive_message", message);
}

// Broadcast that a ticket was resolved
function broadcastTicketResolved(ticketId) {
  if (!io) return;
  io.to(ticketId).emit("ticket_resolved");
}

// Broadcast an event to all connected admins
function broadcastToAdmins(event, payload) {
  if (!io) return;
  io.to("admin_room").emit(event, payload);
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

module.exports = { init, broadcastToTicket, broadcastTicketResolved, broadcastToAdmins, isUserOnline, getIO };