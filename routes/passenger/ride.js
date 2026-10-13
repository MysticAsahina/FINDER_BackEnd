const express = require("express");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { authenticate, requireRole } = require("../../middleware/auth");
const Ride = require("../../models/Ride");
const ActiveDriver = require("../../models/ActiveDriver");
const SystemSettings = require("../../models/SystemSettings");
const { matchRide } = require("../../services/rideMatcher");
const { broadcastToRide, joinUserToRoom, sendToUser } = require("../../services/socket");

const router = express.Router();

const rideRequestLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP or User to 5 ride requests per 15 minutes
  message: { 
    message: "You are requesting too many rides. Please try again in 15 minutes." 
  },
  // We can limit by User ID instead of IP
  keyGenerator: (req, res) => {
    // We are guaranteed to have a user ID here because of the 'authenticate' middleware
    // We return it as a string to completely bypass the IPv6 IP-fallback warning
    return String(req.user.id);
  }
});

// Get current active ride
router.get("/current", authenticate, requireRole("passenger"), async (req, res) => {
  try {
    const ride = await Ride.findOne({
      passengerId: req.user.id,
      status: { $nin: ["completed", "cancelled"] },
    }).populate("driverId", "firstName lastName mobileNumber profilePicture driverDetails");
    
    res.json({ ride });
  } catch (err) {
    console.error("[passenger-ride-current]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get passenger ride history
router.get("/history", authenticate, requireRole("passenger"), async (req, res) => {
  try {
    const rides = await Ride.find({
      passengerId: req.user.id,
      status: { $in: ["completed", "cancelled"] },
    })
      .sort({ createdAt: -1 })
      .populate("driverId", "firstName lastName mobileNumber profilePicture driverDetails");
    
    res.json({ rides });
  } catch (err) {
    console.error("[passenger-ride-history]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get active driver count
router.get("/active-drivers/count", authenticate, requireRole("passenger"), async (req, res) => {
  try {
    const count = await ActiveDriver.countDocuments({ isOnline: true });
    const availableCount = await ActiveDriver.countDocuments({ isOnline: true, isBusy: false });
    res.json({ totalOnline: count, available: availableCount });
  } catch (err) {
    console.error("[passenger-active-drivers-count]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Helper for Geofencing
const isWithinCabanatuan = (lat, lng) => {
  const minLat = 15.42;
  const maxLat = 15.58;
  const minLng = 120.90;
  const maxLng = 121.05;
  return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
};

// Request a new ride
router.post("/request", authenticate, requireRole("passenger"), rideRequestLimiter, async (req, res) => {
  try {
    const { pickup, dropoff, paymentMethod, fare, distanceKm, durationMins, passengerCount, discountCount, bookingFor } = req.body;

    if (!pickup || !pickup.latitude || !pickup.longitude || !dropoff || !dropoff.latitude || !dropoff.longitude) {
      return res.status(400).json({ message: "Pickup and dropoff locations are required." });
    }

    if (!isWithinCabanatuan(pickup.latitude, pickup.longitude) || !isWithinCabanatuan(dropoff.latitude, dropoff.longitude)) {
      return res.status(400).json({ message: "Sorry, pickup and dropoff locations must be within Cabanatuan City." });
    }

    if (distanceKm !== undefined && (typeof distanceKm !== 'number' || distanceKm < 0)) {
      return res.status(400).json({ message: "Invalid distance." });
    }

    // Check if passenger already has an active ride
    const existingRide = await Ride.findOne({
      passengerId: req.user.id,
      status: { $nin: ["completed", "cancelled"] },
    });

    if (existingRide) {
      return res.status(400).json({ message: "You already have an active ride." });
    }

    if (!paymentMethod) {
      return res.status(400).json({ message: "Payment method is required." });
    }

    if (paymentMethod !== "cash" && paymentMethod !== "wallet" && paymentMethod !== "paymongo") {
      console.log("Unsupported payment method:", paymentMethod);
      return res.status(400).json({ message: "Unsupported payment method." });
    }

    // Check if passenger has an unsettled negative wallet balance
    const User = require("../../models/User");
    const passengerUser = await User.findById(req.user.id);
    if (passengerUser && (passengerUser.walletBalance || 0) < 0) {
      return res.status(400).json({
        message: `You have an unsettled negative balance of ₱${Math.abs(passengerUser.walletBalance).toFixed(2)}. Please cash in to clear your balance before booking.`,
      });
    }

    // Fetch fare settings
    let fareSettings = await SystemSettings.findOne({ key: "fare" });
    if (!fareSettings) {
      fareSettings = { baseFare: 25, perKmFare: 8.5, baseDistance: 3 };
    }

    // Calculate fare server-side
    const bFor = bookingFor === "other" ? "other" : "myself";
    let calculatedFare = 0;
    
    let pCount = 1;
    let dCount = 0;

    if (bFor === "myself") {
      pCount = 1;
      dCount = passengerUser && passengerUser.isDiscountVerified ? 1 : 0;
    } else {
      if (passengerCount && passengerCount > 3) {
        return res.status(400).json({ message: "A maximum of 3 passengers is allowed per booking." });
      }
      pCount = Math.max(1, Math.min(3, passengerCount || 1)); // Max 3 passengers
      dCount = Math.max(0, Math.min(pCount, discountCount || 0)); // Can't have more discounts than passengers
    }

    const regularCount = pCount - dCount;

    const dist = distanceKm || 0;
    const extraKm = Math.max(0, Math.ceil(dist - fareSettings.baseDistance)); // Rounded UP fraction of a km

    // Apply special ride rule for 1 passenger
    const effectiveBaseFare = pCount === 1 ? fareSettings.baseFare * 2 : fareSettings.baseFare;

    // Regular Fare Calculation
    const regularFareTotal = regularCount * (effectiveBaseFare + (extraKm * fareSettings.perKmFare));

    // Discounted Fare Calculation (20% off)
    const discountedBase = effectiveBaseFare * 0.8;
    const discountedPerKm = fareSettings.perKmFare * 0.8;
    const discountedFareTotal = dCount * (discountedBase + (extraKm * discountedPerKm));

    calculatedFare = parseFloat((regularFareTotal + discountedFareTotal).toFixed(2));

    // Undiscounted Fare Calculation (what the full price is without any discounts)
    const undiscountedFare = parseFloat((pCount * (effectiveBaseFare + (extraKm * fareSettings.perKmFare))).toFixed(2));

    // If paying via wallet, passenger MUST have enough balance to cover the undiscounted fare
    if (paymentMethod === "wallet") {
      const currentBalance = passengerUser ? (passengerUser.walletBalance || 0) : 0;
      if (currentBalance < undiscountedFare) {
        return res.status(400).json({
          message: `Insufficient Wallet Balance. You need at least ₱${undiscountedFare.toFixed(2)} in your wallet to book this ride (to cover potential non-discounted fares). Your current balance is ₱${currentBalance.toFixed(2)}.`,
        });
      }
    }

    const ride = new Ride({
      passengerId: req.user.id,
      pickup: {
        address: pickup.address,
        coordinates: {
          type: "Point",
          coordinates: [pickup.longitude, pickup.latitude],
        },
      },
      dropoff: {
        address: dropoff.address,
        coordinates: {
          type: "Point",
          coordinates: [dropoff.longitude, dropoff.latitude],
        },
      },
      paymentMethod: paymentMethod,
      status: paymentMethod === "paymongo" ? "payment_pending" : "pending",
      fare: calculatedFare,
      undiscountedFare: undiscountedFare,
      distanceKm: distanceKm || 0,
      durationMins: durationMins || 0,
      passengerCount: pCount,
      discountCount: dCount,
      bookingFor: bFor,
    });

    let checkout_url = null;

    if (paymentMethod === "paymongo") {
      try {
        const options = {
            method: 'POST',
            url: 'https://api.paymongo.com/v1/links',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
            },
            auth: {
                username: process.env.PAYMONGO_SECRET_KEY,
                password: ''
            },
            data: {
                data: {
                    attributes: {
                        amount: Math.round(calculatedFare * 100), // in centavos
                        description: `Ride Fare - Finder App`,
                        remarks: ride._id.toString(), // Store ride ID for webhook matching
                        success_url: req.body.successUrl || `finderapp://payment-success` // Deep link back to app
                    }
                }
            }
        };
        const pmResponse = await axios.request(options);
        checkout_url = pmResponse.data.data.attributes.checkout_url;
        ride.paymongoLinkId = pmResponse.data.data.id;
      } catch (pmError) {
        console.error("PayMongo Error:", pmError.response?.data || pmError.message);
        return res.status(500).json({ message: 'Failed to create payment link.' });
      }
    }

    await ride.save();

    // Instantly join the passenger to the ride's socket room
    joinUserToRoom(req.user.id, ride._id.toString());

    if (paymentMethod === "cash" || paymentMethod === "wallet") {
      // Start matching process asynchronously for cash and wallet (paymongo will start on webhook)
      matchRide(ride._id);
    }

    res.status(201).json({ ride, checkout_url });
  } catch (err) {
    console.error("[passenger-ride-request]", err);
    res.status(500).json({ message: "Server error" });
    console.log("Error details:", err);
  }
});

const { validateCancellation, recordStrikeAndEvaluate } = require("../../services/strikes");

// Cancel a ride
router.post("/:id/cancel", authenticate, requireRole("passenger"), async (req, res) => {
  try {
    const { reason, forceStandardCancel } = req.body;
    const ride = await Ride.findOne({ _id: req.params.id, passengerId: req.user.id });
    
    if (!ride) {
      return res.status(404).json({ message: "Ride not found." });
    }

    if (ride.status === "completed" || ride.status === "cancelled") {
      return res.status(400).json({ message: "Ride is already completed or cancelled." });
    }

    // Strike evaluation
    const validation = await validateCancellation(ride, "passenger", reason, forceStandardCancel);
    if (!validation.valid) {
      if (validation.errorCode) {
        return res.status(400).json({ code: validation.errorCode, message: validation.error });
      }
      return res.status(400).json({ message: validation.error });
    }

    if (!ride.cancellationData) ride.cancellationData = {};
    ride.cancellationData.cancelledBy = "passenger";
    ride.cancellationData.reason = reason || null;
    
    ride.status = "cancelled";
    await ride.save();

    if (validation.strikeType && validation.targetUserId) {
      await recordStrikeAndEvaluate(validation.targetUserId, validation.strikeType, ride._id);
    }

    broadcastToRide(ride._id, "ride_cancelled", { reason: reason || "Cancelled by passenger" });

    // Cancel buffer if distributing
    const bookingDistributor = require("../../services/bookingDistributor");
    await bookingDistributor.cancelBuffer(ride._id);

    // If driver was assigned, free them up
    if (ride.driverId) {
      await ActiveDriver.findOneAndUpdate({ driverId: ride.driverId }, { isBusy: false, reservedUntil: null, reservedBufferId: null });
    }

    res.json({ message: "Ride cancelled successfully", ride });
  } catch (err) {
    console.error("[passenger-ride-cancel]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Override driver status
router.post("/:id/override", authenticate, requireRole("passenger"), async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["arrived_pickup", "completed"];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: "Invalid override status." });
  }

  try {
    const ride = await Ride.findOne({ _id: req.params.id, passengerId: req.user.id });
    
    if (!ride) {
      return res.status(404).json({ message: "Ride not found." });
    }

    if (ride.status === "completed" || ride.status === "cancelled") {
      return res.status(400).json({ message: "Ride is already completed or cancelled." });
    }

    if (status === "completed") {
      ride.tripCompletedAt = new Date();
      if (ride.tripStartedAt) {
          ride.actualDurationMins = parseFloat(((ride.tripCompletedAt - ride.tripStartedAt) / 60000).toFixed(1));
      }
      if (req.body.actualDistanceKm !== undefined) {
          ride.actualDistanceKm = req.body.actualDistanceKm;
      }
    }

    ride.status = status;
    await ride.save();

    // Broadcast update so driver and passenger screens advance
    const updatePayload = { 
      rideId: ride._id, 
      status, 
      actualDurationMins: ride.actualDurationMins, 
      actualDistanceKm: ride.actualDistanceKm 
    };
    broadcastToRide(ride._id, "ride_status_update", updatePayload);
    if (ride.driverId) {
        sendToUser(ride.driverId, "ride_status_update", updatePayload);
    }

    if (status === "completed") {
      // Free up driver
      if (ride.driverId) {
        await ActiveDriver.findOneAndUpdate({ driverId: ride.driverId }, { isBusy: false });
      }

      // Atomic Wallet Settlement (if paymentMethod was 'wallet')
      if (ride.paymentMethod === "wallet") {
        try {
          const { settleRideWallet } = require("../../services/walletSettlement");
          await settleRideWallet(ride, ride.driverId);
        } catch (walletErr) {
          console.error("[passenger-ride-override-wallet-error]", walletErr);
        }
      }
    }

    res.json({ message: "Ride status overridden successfully", ride });
  } catch (err) {
    console.error("[passenger-ride-override]", err);
    res.status(500).json({ message: "Server error" });
  }
});

const reviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each User to 10 reviews per 15 minutes
  message: { 
    message: "Too many review attempts. Please try again later." 
  },
  keyGenerator: (req, res) => String(req.user.id)
});

// Submit a review for a completed ride
router.post("/:id/review", authenticate, requireRole("passenger"), reviewLimiter, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    
    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be a number between 1 and 5." });
    }

    const ride = await Ride.findOne({ _id: req.params.id, passengerId: req.user.id });
    if (!ride) {
      return res.status(404).json({ message: "Ride not found." });
    }

    if (ride.status !== "completed") {
      return res.status(400).json({ message: "You can only review completed rides." });
    }

    if (ride.rating) {
      return res.status(400).json({ message: "You have already reviewed this ride." });
    }

    // Save review on Ride
    ride.rating = rating;
    ride.reviewComment = comment || null;
    await ride.save();

    // Update driver's average rating
    const User = require("../../models/User");
    const driver = await User.findById(ride.driverId);
    
    if (driver && driver.driverDetails) {
      driver.driverDetails.totalReviews += 1;
      driver.driverDetails.ratingSum += rating;
      driver.driverDetails.averageRating = driver.driverDetails.ratingSum / driver.driverDetails.totalReviews;
      await driver.save();
    }

    res.json({ message: "Review submitted successfully", ride });
  } catch (err) {
    console.error("[passenger-ride-review]", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
