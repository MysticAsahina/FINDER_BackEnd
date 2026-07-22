const mongoose = require("mongoose");

const locationSchema = new mongoose.Schema(
  {
    address: { type: String, required: true },
    coordinates: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
      },
    },
  },
  { _id: false }
);

const rideSchema = new mongoose.Schema(
  {
    passengerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    pickup: {
      type: locationSchema,
      required: true,
    },
    dropoff: {
      type: locationSchema,
      required: true,
    },
    status: {
      type: String,
      enum: [
        "pending",          // Looking for driver
        "driver_assigned",  // Driver accepted, on the way
        "arrived_pickup",   // Driver at pickup location, waiting for passenger / cash
        "trip_started",     // Passenger in vehicle, going to dropoff
        "completed",        // Arrived at dropoff, trip done
        "cancelled"         // Cancelled by passenger or system
      ],
      default: "pending",
    },
    paymentMethod: {
      type: String,
      enum: ["cash", "ewallet"],
      default: "cash",
    },
    fare: {
      type: Number,
      required: true,
    },
    distanceKm: {
      type: Number,
      required: true,
    },
    durationMins: {
      type: Number,
      required: true,
    },
    tripStartedAt: {
      type: Date,
      default: null,
    },
    tripCompletedAt: {
      type: Date,
      default: null,
    },
    actualDistanceKm: {
      type: Number,
      default: null,
    },
    actualDurationMins: {
      type: Number,
      default: null,
    },
    ignoredDrivers: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    }], // List of drivers who declined or ignored the request
    chatMessages: [{
      senderRole: { type: String, enum: ['passenger', 'driver'] },
      senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      text: { type: String, default: null },
      mediaUrl: { type: String, default: null },
      mediaType: { type: String, enum: ['image', 'video'], default: null },
      time: { type: String },
      id: { type: String }, // For frontend React keys
      createdAt: { type: Date, default: Date.now }
    }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Ride", rideSchema);
