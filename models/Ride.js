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
    currentCandidateDriverId: {
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
        "payment_pending",  // Waiting for passenger to complete payment in PayMongo
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
      enum: ["cash", "ewallet", "wallet", "paymongo"],
      required: true,
    },
    paymongoLinkId: {
      type: String,
      default: null,
    },
    passengerCount: {
      type: Number,
      default: 1,
    },
    discountCount: {
      type: Number,
      default: 0,
    },
    bookingFor: {
      type: String,
      enum: ["myself", "other"],
      default: "myself",
    },
    fare: {
      type: Number,
      required: true,
    },
    undiscountedFare: {
      type: Number,
      default: 0,
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
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    reviewComment: {
      type: String,
      default: null,
    },
    cancellationData: {
      cancelledBy: { type: String, enum: ['passenger', 'driver', 'system'], default: null },
      reason: { type: String, default: null },
      driverAcceptedLocation: {
        type: { type: String, enum: ['Point'] },
        coordinates: { type: [Number] }
      },
      lastPassengerCommunicationAt: { type: Date, default: null },
      lastDriverCommunicationAt: { type: Date, default: null },
      driverAssignedAt: { type: Date, default: null },
      arrivedPickupAt: { type: Date, default: null },
      driverEtaToPickupMins: { type: Number, default: null }
    },
  },
  { timestamps: true }
);

rideSchema.index({ passengerId: 1 });
rideSchema.index({ driverId: 1 });
rideSchema.index({ status: 1 });
rideSchema.index({ createdAt: -1 });
rideSchema.index({ paymongoLinkId: 1 });
rideSchema.index({ status: 1, updatedAt: 1 });

module.exports = mongoose.model("Ride", rideSchema);
