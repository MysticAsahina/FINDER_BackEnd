const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const { sendToUser } = require('./socket');

/**
 * Executes atomic wallet settlement upon ride completion.
 * Deducts fare from passenger (if payment was wallet) and credits driver.
 * Safe against double-settlement.
 * 
 * @param {Object} ride Mongoose Ride document
 * @param {String} driverId Driver user ID
 */
async function settleRideWallet(ride, driverId) {
  if (!ride || ride.paymentMethod !== 'wallet') {
    return { settled: false, reason: 'Payment method is not wallet' };
  }

  const fareAmount = parseFloat((ride.fare || 0).toFixed(2));
  if (fareAmount <= 0) {
    return { settled: false, reason: 'Fare amount is zero' };
  }

  // Idempotency: Check if this ride has already been settled
  const existingDriverTx = await WalletTransaction.findOne({
    rideId: ride._id,
    type: 'fare_earning',
  });

  if (existingDriverTx) {
    console.log(`[wallet-settlement] Ride ${ride._id} was already settled.`);
    return { settled: true, alreadySettled: true };
  }

  const effectiveDriverId = driverId || ride.driverId;

  // 1. Deduct from passenger (if not already deducted)
  const existingPassengerTx = await WalletTransaction.findOne({
    rideId: ride._id,
    type: 'fare_deduction',
  });

  if (!existingPassengerTx) {
    const passenger = await User.findById(ride.passengerId);
    if (passenger) {
      passenger.walletBalance = parseFloat(((passenger.walletBalance || 0) - fareAmount).toFixed(2));
      await passenger.save();

      const pTxRef = `WDED-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;
      const passengerTx = new WalletTransaction({
        userId: passenger._id,
        userRole: 'passenger',
        type: 'fare_deduction',
        amount: fareAmount,
        fee: 0,
        grossAmount: fareAmount,
        status: 'completed',
        referenceNumber: pTxRef,
        rideId: ride._id,
        description: `Trip payment for Ride #${ride._id.toString().slice(-6).toUpperCase()}`,
      });
      await passengerTx.save();

      sendToUser(passenger._id.toString(), 'wallet_updated', {
        newBalance: passenger.walletBalance,
        transaction: passengerTx,
        message: `Paid ₱${fareAmount.toFixed(2)} for ride. New balance: ₱${passenger.walletBalance.toFixed(2)}`,
      });
    }
  }

  // 2. Credit to driver with zero fees
  if (effectiveDriverId) {
    const driver = await User.findById(effectiveDriverId);
    if (driver) {
      driver.walletBalance = parseFloat(((driver.walletBalance || 0) + fareAmount).toFixed(2));
      await driver.save();

      const dTxRef = `WEARN-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;
      const driverTx = new WalletTransaction({
        userId: driver._id,
        userRole: 'driver',
        type: 'fare_earning',
        amount: fareAmount,
        fee: 0,
        grossAmount: fareAmount,
        status: 'completed',
        referenceNumber: dTxRef,
        rideId: ride._id,
        description: `Trip earnings for Ride #${ride._id.toString().slice(-6).toUpperCase()}`,
      });
      await driverTx.save();

      sendToUser(driver._id.toString(), 'wallet_updated', {
        newBalance: driver.walletBalance,
        transaction: driverTx,
        message: `Received ₱${fareAmount.toFixed(2)} earnings in wallet!`,
      });

      console.log(`[wallet-settlement] Successfully credited ₱${fareAmount} to driver ${driver._id}. New balance: ₱${driver.walletBalance}`);
    }
  }

  return { settled: true };
}

module.exports = { settleRideWallet };
