const express = require('express');
const User = require('../../models/User');
const WalletTransaction = require('../../models/WalletTransaction');
const authenticate = require('../../middleware/authenticate');
const requireRole = require('../../middleware/requireRole');

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
      { $match: { type: 'cash_in', status: 'completed' } },
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
// GET /admin/wallet/transactions - List all transactions across users
// ---------------------------------------------------------------------------
router.get('/transactions', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { type, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (type) filter.type = type;

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const [transactions, total] = await Promise.all([
      WalletTransaction.find(filter)
        .populate('userId', 'firstName lastName mobileNumber role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      WalletTransaction.countDocuments(filter),
    ]);

    res.json({ transactions, total, page: parseInt(page, 10) });
  } catch (err) {
    console.error('[admin-wallet-transactions]', err);
    res.status(500).json({ message: 'Server error retrieving transactions.' });
  }
});

module.exports = router;
