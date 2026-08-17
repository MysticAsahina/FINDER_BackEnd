const express = require('express');
const router = express.Router();
const DriverApplication = require('../../models/DriverApplication');
const SupportTicket = require('../../models/SupportTicket');
const { authenticate, requireRole } = require('../../middleware/auth');

router.get(
  '/',
  authenticate,
  requireRole('admin'),
  async (req, res) => {
    try {
      const [pendingApplications, unreadPassengerTickets, unreadDriverTickets] = await Promise.all([
        DriverApplication.countDocuments({ status: 'pending' }),
        SupportTicket.countDocuments({ hasUnreadAdmin: true, userRole: 'passenger' }),
        SupportTicket.countDocuments({ hasUnreadAdmin: true, userRole: 'driver' })
      ]);

      res.json({
        success: true,
        pendingApplications,
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
