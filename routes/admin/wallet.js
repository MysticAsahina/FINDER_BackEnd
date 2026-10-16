const express = require('express');
const User = require('../../models/User');
const WalletTransaction = require('../../models/WalletTransaction');
const { authenticate, requireRole } = require('../../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /admin/wallet/summary - Platform Digital Float & Metrics
// ---------------------------------------------------------------------------
router.get('/summary', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const passengerBalances = await User.aggregate([
      { $match: { role: 'passenger' } },
      { $group: { _id: null, total: { $sum: '$walletBalance' } } },
    ]);

    const driverBalances = await User.aggregate([
      { $match: { role: 'driver' } },
      { $group: { _id: null, total: { $sum: '$walletBalance' } } },
    ]);

    const feesCollected = await WalletTransaction.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$fee' } } },
    ]);

    const totalCashIn = await WalletTransaction.aggregate([
      { $match: { type: 'cash_in', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    const totalCashOut = await WalletTransaction.aggregate([
      { $match: { type: 'cash_out', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    res.json({
      totalPassengerFloat: passengerBalances[0]?.total || 0,
      totalDriverFloat: driverBalances[0]?.total || 0,
      totalFeesCollected: feesCollected[0]?.total || 0,
      totalCashInVolume: totalCashIn[0]?.total || 0,
      totalCashOutVolume: totalCashOut[0]?.total || 0,
    });
  } catch (err) {
    console.error('[admin-wallet-summary]', err);
    res.status(500).json({ message: 'Server error retrieving wallet summary.' });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/wallet/transactions - List transactions with optional query filters
// ---------------------------------------------------------------------------
router.get('/transactions', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { type, role, status, date, search, page, limit, month, year } = req.query;
    const filter = {};

    if (type && type !== 'ALL') filter.type = type;
    if (role && role !== 'ALL') filter.userRole = role;
    if (status && status !== 'ALL') filter.status = status;

    if (month && year) {
      const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
      ];
      const monthIndex = monthNames.indexOf(month);
      if (monthIndex !== -1 && !isNaN(parseInt(year, 10))) {
        const start = new Date(parseInt(year, 10), monthIndex, 1);
        const end = new Date(parseInt(year, 10), monthIndex + 1, 1);
        filter.createdAt = { $gte: start, $lt: end };
      }
    } else if (date && date !== 'ALL') {
      const now = new Date();
      if (date === 'TODAY') {
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        filter.createdAt = { $gte: startOfDay };
      } else if (date === 'WEEK') {
        const weekAgo = new Date();
        weekAgo.setDate(now.getDate() - 7);
        filter.createdAt = { $gte: weekAgo };
      } else if (date === 'MONTH') {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        filter.createdAt = { $gte: startOfMonth };
      }
    }

    if (search && search.trim()) {
      const q = search.trim();
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const userMatches = await User.find({
        $or: [
          { firstName: { $regex: escaped, $options: 'i' } },
          { lastName: { $regex: escaped, $options: 'i' } },
          { mobileNumber: { $regex: escaped, $options: 'i' } },
        ],
      }).select('_id');

      const userIds = userMatches.map((u) => u._id);

      filter.$or = [
        { referenceNumber: { $regex: escaped, $options: 'i' } },
        { description: { $regex: escaped, $options: 'i' } },
        { userId: { $in: userIds } },
      ];
    }

    const query = WalletTransaction.find(filter)
      .populate('userId', 'firstName lastName mobileNumber role')
      .populate('rideId', 'pickup dropoff fare status')
      .sort({ createdAt: -1 });

    if (page && limit) {
      const p = Math.max(1, parseInt(page, 10));
      const l = Math.max(1, parseInt(limit, 10));
      const skip = (p - 1) * l;
      query.skip(skip).limit(l);
    } else if (limit) {
      query.limit(parseInt(limit, 10));
    }

    const [transactions, total] = await Promise.all([
      query.exec(),
      WalletTransaction.countDocuments(filter),
    ]);

    res.json({ transactions, total });
  } catch (err) {
    console.error('[admin-wallet-transactions]', err);
    res.status(500).json({ message: 'Server error retrieving transactions.' });
  }
});

module.exports = router;
