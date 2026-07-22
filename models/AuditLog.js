const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null, // null for failed logins where admin isn't found
    },
    adminName: {
      type: String,
      required: true,
      trim: true,
    },
    action: {
      type: String,
      required: true,
      enum: [
        "LOGIN_SUCCESS",
        "LOGIN_FAILED",
        "LOGOUT",
        "DRIVER_APPROVED",
        "DRIVER_REJECTED",
        "TICKET_RESOLVED",
        "PROFILE_EDITED",
        "UPDATE_FARE_SETTINGS"
      ],
    },
    details: {
      type: String,
      required: true,
    },
    ipAddress: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AuditLog", auditLogSchema);
