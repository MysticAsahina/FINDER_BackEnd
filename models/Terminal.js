const mongoose = require("mongoose");

const terminalSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number],
        // [longitude, latitude] -> Default: MVGFCI Waiting Area outside campus
        default: [120.958028, 15.478000],
      },
    },
    terminalRadiusMeters: {
      type: Number,
      default: 60, // 60 meters terminal geofence for the TODA waiting area
    },
    catchmentRadiusMeters: {
      type: Number,
      default: 400, // 400 meters enclosing the entire MVGFCI campus
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

terminalSchema.index({ location: "2dsphere" });

// Helper to seed/fetch default MVGFCI terminal
terminalSchema.statics.getMvgfciTerminal = async function () {
  let terminal = await this.findOne({ code: "MVGFCI" });
  if (!terminal) {
    terminal = await this.create({
      code: "MVGFCI",
      name: "MVGFCI Main Gate TODA Terminal",
      location: {
        type: "Point",
        coordinates: [120.958028, 15.478000],
      },
      terminalRadiusMeters: 60,
      catchmentRadiusMeters: 400,
      isActive: true,
    });
    console.log("[Terminal] Seeded default MVGFCI Terminal into database.");
  }
  return terminal;
};

module.exports = mongoose.model("Terminal", terminalSchema);
