const mongoose = require("mongoose");

const appealMessageSchema = new mongoose.Schema(
  {
    senderRole: {
      type: String,
      enum: ["user", "admin", "system"],
      required: true,
    },
    senderName: {
      type: String,
      default: "",
    },
    body: {
      type: String,
      required: true,
    },
    mediaUrl: {
      type: String,
      default: null,
    },
    mediaType: {
      type: String,
      enum: ["image", "video", null],
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const appealSchema = new mongoose.Schema(
  {
    ticketNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    userRole: {
      type: String,
      enum: ["passenger", "driver"],
      required: true,
    },
    suspensionType: {
      type: String,
      enum: ["temp_suspend", "suspend_resolved", "perm_suspend"],
      required: true,
    },
    suspensionReason: {
      type: String,
      default: null,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    proofMedia: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "lifted", "disabled"],
      default: "pending",
    },
    attemptNumber: {
      type: Number,
      default: 1,
    },
    messages: [appealMessageSchema],
    hasUnreadAdmin: {
      type: Boolean,
      default: true,
    },
    hasUnreadUser: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

appealSchema.index({ userId: 1, status: 1 });
appealSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Appeal", appealSchema);
