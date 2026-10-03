const express = require('express');
const router = express.Router();
const DriverApplication = require('../../models/DriverApplication');
const DiscountApplication = require('../../models/DiscountApplication');
const SupportTicket = require('../../models/SupportTicket');
const { authenticate, requireRole } = require('../../middleware/auth');

router.get(
  '/',
  authenticate,
  requireRole('admin'),
  async (req, res) => {
    try {
      const [pendingApplications, pendingDiscountApplications, unreadPassengerTickets, unreadDriverTickets] = await Promise.all([
        DriverApplication.countDocuments({ status: 'pending' }),
        DiscountApplication.countDocuments({ status: 'pending' }),
        SupportTicket.countDocuments({ hasUnreadAdmin: true, userRole: 'passenger' }),
        SupportTicket.countDocuments({ hasUnreadAdmin: true, userRole: 'driver' })
      ]);

      res.json({
        success: true,
        pendingApplications,
        pendingDiscountApplications,
        unreadPassengerTickets,
        unreadDriverTickets
      });
    } catch (err) {
      console.error('Badges error:', err);
      res.status(500).json({ success: false, message: 'Failed to load badges.' });
    }
  }
);

module.exports = router;