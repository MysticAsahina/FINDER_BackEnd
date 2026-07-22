const AuditLog = require("../models/AuditLog");
const User = require("../models/User");
const { broadcastToAdmins } = require("../services/socket");

/**
 * Logs an administrative action.
 * @param {Object} req - The express request object (used to extract IP)
 * @param {String|null} adminId - The ID of the admin performing the action (or null if unknown)
 * @param {String} adminName - The name of the admin or email attempted
 * @param {String} action - The action constant (e.g. 'DRIVER_APPROVED')
 * @param {String} details - Human readable details about the action
 */
async function logAdminAction(req, adminId, adminName, action, details) {
  try {
    let name = adminName;
    
    // If we have an adminId but no explicit name was provided, try to fetch it
    if (adminId && (!name || name.trim() === "")) {
      const admin = await User.findById(adminId).select("firstName lastName");
      if (admin) {
        name = `${admin.firstName} ${admin.lastName}`.trim();
      } else {
        name = "Unknown Admin";
      }
    }

    let ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    if (ipAddress === "::1") {
      ipAddress = "127.0.0.1";
    } else if (ipAddress && ipAddress.startsWith("::ffff:")) {
      ipAddress = ipAddress.replace("::ffff:", "");
    }

    const logEntry = await AuditLog.create({
      adminId: adminId || null,
      adminName: name || "System",
      action,
      details,
      ipAddress: ipAddress || null,
    });
    
    // Broadcast the new log to any connected admins via socket
    broadcastToAdmins("new_audit_log", logEntry);
  } catch (err) {
    console.error("[auditLogger] Failed to write audit log:", err);
  }
}

module.exports = { logAdminAction };
