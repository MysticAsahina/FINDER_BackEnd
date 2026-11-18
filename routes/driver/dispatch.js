const express = require("express");
const { authenticate, requireRole } = require("../../middleware/auth");
const bookingDistributor = require("../../services/bookingDistributor");

const router = express.Router();

// Acknowledge receipt of dispatch offer
router.post("/ack", authenticate, requireRole("driver"), async (req, res) => {
  try {
    const { bufferId } = req.body;
    if (!bufferId) {
      return res.status(400).json({ message: "bufferId is required" });
    }

    const result = await bookingDistributor.acknowledgeOffer(bufferId, req.user.id);
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error("[driver-dispatch-ack]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get current active buffered offer (e.g. on app resume or foreground)
router.get("/active", authenticate, requireRole("driver"), async (req, res) => {
  try {
    const offer = await bookingDistributor.getActiveOfferForDriver(req.user.id);
    res.json({ offer });
  } catch (err) {
    console.error("[driver-dispatch-active]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Accept a buffered dispatch offer
router.post("/:bufferId/accept", authenticate, requireRole("driver"), async (req, res) => {
  try {
    const result = await bookingDistributor.acceptOffer(req.params.bufferId, req.user.id);
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error("[driver-dispatch-accept]", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Decline a buffered dispatch offer
router.post("/:bufferId/decline", authenticate, requireRole("driver"), async (req, res) => {
  try {
    const result = await bookingDistributor.declineOffer(req.params.bufferId, req.user.id);
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error("[driver-dispatch-decline]", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
