const mongoose = require("mongoose");

const systemSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
    },
    baseFare: {
      type: Number,
      default: 25,
    },
    perKmFare: {
      type: Number,
      default: 8.5,
    },
    baseDistance: {
      type: Number,
      default: 2,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SystemSettings", systemSettingsSchema);
