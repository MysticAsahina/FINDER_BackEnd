const mongoose = require('mongoose');

const walletTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    userRole: {
      type: String,
      enum: ['passenger', 'driver'],
      required: true,
    },
    type: {
      type: String,
      enum: ['cash_in', 'cash_out', 'fare_deduction', 'fare_earning', 'refund'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    fee: {
      type: Number,
      default: 0,
    },
    grossAmount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'cancelled'],
      default: 'completed',
    },
    referenceNumber: {
      type: String,
      required: true,
      unique: true,
    },
    paymongoLinkId: {
      type: String,
      default: null,
      index: true,
    },
    rideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ride',
      default: null,
    },
    payoutDetails: {
      method: { type: String, default: 'gcash' },
      accountName: { type: String },
      mobileNumber: { type: String },
    },
    description: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
