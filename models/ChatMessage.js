const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema(
  {
    ticketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SupportTicket",
      required: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    senderRole: {
      type: String,
      enum: ["passenger", "driver", "admin"],
      required: true,
    },
    body: {
      type: String,
      default: null,
    },
    mediaUrl: {
      type: String,
      default: null,
    },
    mediaType: {
      type: String,
      enum: ["image", "video"],
      default: null,
    },
  },
  { timestamps: true }
);

// A message must have at least a text body or a media attachment
chatMessageSchema.pre("validate", function (next) {
  if (!this.body && !this.mediaUrl) {
    return next(new Error("A message must have either a body or a media attachment."));
  }
  next();
});

module.exports = mongoose.model("ChatMessage", chatMessageSchema);