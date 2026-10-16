const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const { authenticate, requireRole } = require('../middleware/auth');
const { getIO } = require('../services/socket');

const router = express.Router();

// Helper to generate unique reference numbers
const generateRefNumber = (prefix) => {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${timestamp}-${random}`;
};

// ---------------------------------------------------------------------------
// GET /wallet/balance - Retrieve current user's wallet balance & details
// ---------------------------------------------------------------------------
router.get('/balance', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('walletBalance savedPayoutDetails role firstName lastName');
    if (!user) return res.status(404).json({ message: 'User not found.' });

    res.json({
      balance: user.walletBalance || 0,
      savedPayoutDetails: user.savedPayoutDetails || null,
      role: user.role,
      name: `${user.firstName} ${user.lastName}`.trim(),
    });
  } catch (err) {
    console.error('[wallet-balance]', err);
    res.status(500).json({ message: 'Server error retrieving wallet balance.' });
  }
});

// ---------------------------------------------------------------------------
// GET /wallet/transactions - Retrieve user transaction history
// ---------------------------------------------------------------------------
router.get('/transactions', authenticate, async (req, res) => {
  try {
    const { type, limit = 50 } = req.query;
    const filter = { userId: req.user.id };

    if (type === 'money_in') {
      filter.type = { $in: ['cash_in', 'fare_earning', 'refund'] };
    } else if (type === 'money_out') {
      filter.type = { $in: ['cash_out', 'fare_deduction'] };
    }

    const transactions = await WalletTransaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit, 10));

    res.json({ transactions });
  } catch (err) {
    console.error('[wallet-transactions]', err);
    res.status(500).json({ message: 'Server error retrieving transactions.' });
  }
});

// ---------------------------------------------------------------------------
// POST /wallet/cash-in/initiate - Passenger Cash In via PayMongo QR Ph
// ---------------------------------------------------------------------------
router.post('/cash-in/initiate', authenticate, requireRole('passenger'), async (req, res) => {
  try {
    const { amount } = req.body;
    const numAmount = parseFloat(amount);

    if (isNaN(numAmount) || numAmount < 50 || numAmount > 2000) {
      return res.status(400).json({
        message: 'Invalid amount. Cash-in amount must be between ₱50.00 and ₱2,000.00.',
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    // Enforce ₱5,000 maximum balance ceiling
    if ((user.walletBalance || 0) + numAmount > 5000) {
      return res.status(400).json({
        message: `Cash-in exceeds wallet limit. Your maximum wallet balance is ₱5,000.00 (Current: ₱${(user.walletBalance || 0).toFixed(2)}).`,
      });
    }

    // Rate-limit check: max 5 pending links per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const pendingCount = await WalletTransaction.countDocuments({
      userId: user._id,
      type: 'cash_in',
      status: 'pending',
      createdAt: { $gte: oneHourAgo },
    });

    if (pendingCount >= 5) {
      return res.status(429).json({
        message: 'You have too many pending cash-in requests. Please wait before creating a new one.',
      });
    }

    // Convenience fee: ₱5.00 flat + 2%
    const fee = Math.round((5 + numAmount * 0.02) * 100) / 100;
    const grossAmount = Math.round((numAmount + fee) * 100) / 100;
    const grossAmountCentavos = Math.round(grossAmount * 100);

    const refNumber = generateRefNumber('CIN');

    // Create PayMongo Payment Link with QR Ph exclusively
    const paymongoRes = await axios.post(
      'https://api.paymongo.com/v1/links',
      {
        data: {
          attributes: {
            amount: grossAmountCentavos,
            description: `FINDER Wallet Top-up (₱${numAmount.toFixed(2)} + ₱${fee.toFixed(2)} fee)`,
            remarks: refNumber,
            payment_method_types: ['qrph'],
          },
        },
      },
      {
        auth: {
          username: process.env.PAYMONGO_SECRET_KEY,
          password: '',
        },
      }
    );

    const linkData = paymongoRes.data.data;
    const checkoutUrl = linkData.attributes.checkout_url;
    const paymongoLinkId = linkData.id;

    // Save pending transaction
    const transaction = new WalletTransaction({
      userId: user._id,
      userRole: 'passenger',
      type: 'cash_in',
      amount: numAmount,
      fee: fee,
      grossAmount: grossAmount,
      status: 'pending',
      referenceNumber: refNumber,
      paymongoLinkId: paymongoLinkId,
      description: `Wallet Top-up via QR Ph (Fee: ₱${fee.toFixed(2)})`,
    });

    await transaction.save();

    res.json({
      checkoutUrl,
      paymongoLinkId,
      referenceNumber: refNumber,
      amount: numAmount,
      fee,
      grossAmount,
    });
  } catch (err) {
    console.error('[wallet-cash-in-initiate]', err.response?.data || err);
    res.status(500).json({
      message: err.response?.data?.errors?.[0]?.detail || 'Failed to initiate cash-in with PayMongo.',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /wallet/cash-out/request - Driver Cash Out via GCash (Zero-Fee Model)
// ---------------------------------------------------------------------------
router.post(['/cash-out/request', '/wallet/cash-out/request'], authenticate, requireRole('driver'), async (req, res) => {
  try {
    const { amount, accountName, mobileNumber } = req.body;
    const numAmount = parseFloat(amount);

    if (isNaN(numAmount) || numAmount < 100 || numAmount > 2000) {
      return res.status(400).json({
        message: 'Invalid cash-out amount. Minimum is ₱100.00 and maximum is ₱2,000.00 per cash-out.',
      });
    }

    if (!accountName || !accountName.trim()) {
      return res.status(400).json({ message: 'GCash account name is required.' });
    }

    if (!mobileNumber || !/^09\d{9}$/.test(mobileNumber.trim())) {
      return res.status(400).json({ message: 'Valid 11-digit GCash mobile number (09XXXXXXXXX) is required.' });
    }

    const driver = await User.findById(req.user.id);
    if (!driver) return res.status(404).json({ message: 'Driver not found.' });

    if ((driver.walletBalance || 0) < numAmount) {
      return res.status(400).json({
        message: `Insufficient wallet balance. Available balance: ₱${(driver.walletBalance || 0).toFixed(2)}.`,
      });
    }

    // Enforce 24-hour rate limit: 1 cash out per 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCashOut = await WalletTransaction.findOne({
      userId: driver._id,
      type: 'cash_out',
      status: { $in: ['completed', 'pending'] },
      createdAt: { $gte: twentyFourHoursAgo },
    });

    if (recentCashOut) {
      const waitHours = Math.ceil((recentCashOut.createdAt.getTime() + 24 * 60 * 60 * 1000 - Date.now()) / (60 * 60 * 1000));
      return res.status(429).json({
        message: `Cash-out is limited to once every 24 hours. Please wait approximately ${waitHours} more hour(s).`,
      });
    }

    // Atomic deduction & record creation
    driver.walletBalance = parseFloat(((driver.walletBalance || 0) - numAmount).toFixed(2));
    driver.savedPayoutDetails = {
      method: 'gcash',
      accountName: accountName.trim(),
      mobileNumber: mobileNumber.trim(),
    };
    await driver.save();

    const refNumber = generateRefNumber('COUT');

    const transaction = new WalletTransaction({
      userId: driver._id,
      userRole: 'driver',
      type: 'cash_out',
      amount: numAmount,
      fee: 0, // Zero fee for drivers!
      grossAmount: numAmount,
      status: 'completed', // Simulated completed payout
      referenceNumber: refNumber,
      payoutDetails: {
        method: 'gcash',
        accountName: accountName.trim(),
        mobileNumber: mobileNumber.trim(),
      },
      description: `Disbursement to GCash (${mobileNumber.trim()})`,
    });

    await transaction.save();

    res.json({
      message: `Successfully cashed out ₱${numAmount.toFixed(2)} to GCash (${mobileNumber.trim()}).`,
      newBalance: driver.walletBalance,
      transaction,
    });
  } catch (err) {
    console.error('[wallet-cash-out-request]', err);
    res.status(500).json({ message: 'Server error processing cash-out.' });
  }
});

module.exports = router;
