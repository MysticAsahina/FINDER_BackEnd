const mongoose = require("mongoose");

const candidateSchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    distanceMeters: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["pending", "offered", "acknowledged", "declined", "timed_out", "unreachable"],
      default: "pending",
    },
    offeredAt: {
      type: Date,
      default: null,
    },
    ackAt: {
      type: Date,
      default: null,
    },
    respondedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const bookingBufferSchema = new mongoose.Schema(
  {
    rideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ride",
      required: true,
      unique: true,
      index: true,
    },
    passengerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["buffered", "distributing", "fulfilled", "exhausted", "cancelled"],
      default: "buffered",
      index: true,
    },
    bookingData: {
      pickup: {
        address: { type: String, required: true },
        coordinates: {
          type: { type: String, default: "Point" },
          coordinates: [Number], // [lng, lat]
        },
      },
      dropoff: {
        address: { type: String, required: true },
        coordinates: {
          type: { type: String, default: "Point" },
          coordinates: [Number],
        },
      },
      fare: { type: Number, required: true },
      undiscountedFare: { type: Number, default: 0 },
      distanceKm: { type: Number, default: 0 },
      durationMins: { type: Number, default: 0 },
      paymentMethod: { type: String, default: "cash" },
      passengerCount: { type: Number, default: 1 },
      discountCount: { type: Number, default: 0 },
      bookingFor: { type: String, default: "myself" },
      passengerDetails: {
        firstName: String,
        lastName: String,
        mobileNumber: String,
        profilePicture: String,
      },
    },
    candidatePool: [candidateSchema],
    currentCandidate: {
      driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
        index: true,
      },
      offerExpiresAt: {
        type: Date,
        default: null,
      },
      acknowledged: {
        type: Boolean,
        default: false,
      },
      acknowledgedAt: {
        type: Date,
        default: null,
      },
    },
    searchExpiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

bookingBufferSchema.index({ status: 1, searchExpiresAt: 1 });
bookingBufferSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7200 }); // Auto-clean after 2 hours

module.exports = mongoose.model("BookingBuffer", bookingBufferSchema);
