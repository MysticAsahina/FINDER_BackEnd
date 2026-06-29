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
      default: 0,
    },
    durationMins: {
      type: Number,
      default: 0,
    },
    ignoredDrivers: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    }], // List of drivers who declined or ignored the request
  },
  { timestamps: true }
);

module.exports = mongoose.model("Ride", rideSchema);
