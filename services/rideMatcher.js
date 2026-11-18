const bookingDistributor = require("./bookingDistributor");

/**
 * Finds the nearest available driver for a ride and manages staged distribution
 * Delegates to the bookingDistributor service with persistent data buffer.
 * @param {String|ObjectId} rideId 
 */
async function matchRide(rideId) {
  return bookingDistributor.enqueueRide(rideId);
}

module.exports = {
  matchRide,
  ...bookingDistributor,
};
