const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const DiscountApplication = require("../../models/DiscountApplication");
const User = require("../../models/User");
const rateLimit = require("express-rate-limit");

const applyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many discount applications submitted, please try again later." }
});

const router = express.Router();

router.post("/apply", authenticate, requireRole("passenger"), applyLimiter, async (req, res) => {
  try {
    const {
      discountType,
      fullName,
      mobileNumber,
      dob,
      idType,
      idNumber,
      expirationDate,
      imageBase64,
    } = req.body;

    if (!discountType || !fullName || !mobileNumber || !dob || !idType || !idNumber || !imageBase64) {
      return res.status(400).json({ message: "All fields including ID image are required." });
    }

    // Check if there is already a pending application for this user
    const existingPending = await DiscountApplication.findOne({
      passengerId: req.user.id,
      status: "pending",
    });

    if (existingPending) {
      return res.status(400).json({ message: "You already have a pending discount application." });
    }

    // Initialize Cloudinary
    const cloudinary = require("cloudinary").v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    // Upload to Cloudinary
    const uploadRes = await cloudinary.uploader.upload(imageBase64, {
      folder: "discount_applications",
    });

    const newApplication = new DiscountApplication({
      passengerId: req.user.id,
      discountType,
      fullName,
      mobileNumber,
      dob,
      idType,
      idNumber,
      expirationDate,
      imageUri: uploadRes.secure_url,
    });

    await newApplication.save();

    res.status(201).json({ message: "Application submitted successfully.", application: newApplication });
  } catch (error) {
    console.error("[passenger-discount-apply]", error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
