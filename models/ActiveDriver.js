const mongoose = require("mongoose");

const activeDriverSchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    isBusy: {
      type: Boolean,
      default: false,
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number],
        default: [0, 0], // [longitude, latitude]
      },
    },
    socketId: {
      type: String,
      default: null,
    },
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
    reservedUntil: {
      type: Date,
      default: null,
      index: true,
    },
    reservedBufferId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BookingBuffer",
      default: null,
    },
    terminalId: {
      type: String,
      default: null,
      index: true,
    },
    enteredTerminalAt: {
      type: Date,
      default: null,
      index: true,
    },
    leftTerminalAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// 2dsphere index for spatial queries
activeDriverSchema.index({ location: "2dsphere" });
activeDriverSchema.index({ isOnline: 1, lastUpdated: 1 });
activeDriverSchema.index({ terminalId: 1, isOnline: 1, isBusy: 1, enteredTerminalAt: 1 });

module.exports = mongoose.model("ActiveDriver", activeDriverSchema);
