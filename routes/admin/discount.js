const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const DiscountApplication = require("../../models/DiscountApplication");
const User = require("../../models/User");
const rateLimit = require("express-rate-limit");

const actionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50,
  message: { message: "Too many actions performed, please try again later." }
});

const router = express.Router();

// GET /admin/discount-applications
router.get("/", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const status = req.query.status;
    let query = {};
    if (status && status !== 'All') {
      query.status = status.toLowerCase(); // pending, approved, rejected
    }

    const applications = await DiscountApplication.find(query)
      .populate("passengerId", "firstName lastName mobileNumber email")
      .sort({ createdAt: -1 })
      .lean();

    // Map to the frontend's expected structure
    const mapped = applications.map(app => ({
      id: app._id.toString(),
      applicant: app.fullName || (app.passengerId ? `${app.passengerId.firstName} ${app.passengerId.lastName}` : "Unknown"),
      discountType: app.discountType,
      idNumber: app.idNumber,
      submitted: app.createdAt,
      status: app.status.charAt(0).toUpperCase() + app.status.slice(1), // Pending, Approved, Rejected
      email: app.passengerId ? app.passengerId.email : "",
      phone: app.mobileNumber || (app.passengerId ? app.passengerId.mobileNumber : ""),
      institution: app.idType,
      imageUri: app.imageUri,
      rejectionReason: app.rejectionReason,
    }));

    res.json(mapped);
  } catch (error) {
    console.error("[admin-discount-applications-get]", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /admin/discount-applications/:id
router.patch("/:id", authenticate, requireRole("admin"), actionLimiter, async (req, res) => {
  try {
    const { status, reason } = req.body;
    
    if (!["approved", "rejected"].includes(status.toLowerCase())) {
      return res.status(400).json({ message: "Invalid status." });
    }

    const app = await DiscountApplication.findById(req.params.id);
    if (!app) {
      return res.status(404).json({ message: "Application not found." });
    }

    app.status = status.toLowerCase();
    if (app.status === "rejected") {
      app.rejectionReason = reason || "Application rejected by Admin.";
    }

    await app.save();

    // Update the user's discount profile if approved
    if (app.status === "approved") {
      const user = await User.findById(app.passengerId);
      if (user) {
        user.isDiscountVerified = true;
        user.discountType = app.discountType;
        user.discountIdNumber = app.idNumber;
        user.discountExpiration = app.expirationDate;
        await user.save();
      }
    }

    res.json({ message: `Application ${app.status} successfully.`, application: app });
  } catch (error) {
    console.error("[admin-discount-applications-patch]", error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
