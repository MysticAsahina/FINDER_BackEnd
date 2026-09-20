const express = require('express');
const router = express.Router();
const Ride = require('../../models/Ride');
const { authenticate, requireRole } = require('../../middleware/auth');

// GET /admin/reports
router.get('/', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { month, year, page = 1, limit = 10 } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Base query for finalized trips
    const query = {
      status: { $in: ['completed', 'cancelled'] }
    };

    // Date filtering using createdAt
    if (month && year) {
      // month is 1-indexed from frontend or standard
      // We will assume month is string name (e.g., 'February') or number (e.g., '2')
      // Actually, frontend mockup has strings 'February', 'January'. Let's handle month strings.
      const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
      ];
      const monthIndex = monthNames.indexOf(month);

      if (monthIndex !== -1 && !isNaN(parseInt(year))) {
        const start = new Date(year, monthIndex, 1);
        const end = new Date(year, monthIndex + 1, 1);
        query.createdAt = {
          $gte: start,
          $lt: end
        };
      }
    }

    const User = require('../../models/User');

    // Run parallel queries: count total, get paginated, and aggregate stats
    const [totalTrips, trips, statsAgg, supportMessagesCount, rideMessagesAgg, registeredPassengers, registeredDrivers, activeDrivers, inactiveDrivers] = await Promise.all([
      Ride.countDocuments(query),
      Ride.find(query)
        .populate('driverId', 'firstName lastName')
        .populate('passengerId', 'firstName lastName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Ride.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalCompleted: {
              $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] }
            },
            totalCancelled: {
              $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] }
            }
          }
        }
      ]),
      require('../../models/ChatMessage').countDocuments(query.createdAt ? { createdAt: query.createdAt } : {}),
      Ride.aggregate([
        { $match: query.createdAt ? { createdAt: query.createdAt } : {} },
        { $project: { numMessages: { $size: { $ifNull: ["$chatMessages", []] } } } },
        { $group: { _id: null, total: { $sum: "$numMessages" } } }
      ]),
      User.countDocuments({ role: 'passenger', ...(query.createdAt ? { createdAt: query.createdAt } : {}) }),
      User.countDocuments({ role: 'driver', ...(query.createdAt ? { createdAt: query.createdAt } : {}) }),
      User.countDocuments({ role: 'driver', isOnline: true, ...(query.createdAt ? { createdAt: query.createdAt } : {}) }),
      User.countDocuments({ role: 'driver', isOnline: false, ...(query.createdAt ? { createdAt: query.createdAt } : {}) })
    ]);

    // Format stats
    let totalCompleted = 0;
    let totalCancelled = 0;
    let totalCount = 0;
    
    if (statsAgg.length > 0) {
      totalCompleted = statsAgg[0].totalCompleted;
      totalCancelled = statsAgg[0].totalCancelled;
      totalCount = statsAgg[0].totalCompleted + statsAgg[0].totalCancelled;
    }

    const completedRate = totalCount > 0 ? ((totalCompleted / totalCount) * 100).toFixed(1) : 0;

    // Calculate Average Daily Trips
    let daysInMonth = 30; // default fallback
    if (month && year) {
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const monthIndex = monthNames.indexOf(month);
      if (monthIndex !== -1 && !isNaN(parseInt(year))) {
        daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
      }
    } else {
      // If no month provided, use current month's days
      const now = new Date();
      daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    }
    
    const averageDailyTrips = totalCount > 0 ? (totalCount / daysInMonth).toFixed(1) : 0;

    // Calculate Amount of Messages
    const rideMessagesCount = rideMessagesAgg.length > 0 ? rideMessagesAgg[0].total : 0;
    const totalMessages = supportMessagesCount + rideMessagesCount;

    res.json({
      success: true,
      trips,
      pagination: {
        total: totalTrips,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalTrips / limitNum)
      },
      stats: {
        totalTrips: totalCount,
        completedTrips: totalCompleted,
        cancelledTrips: totalCancelled,
        completedRate: parseFloat(completedRate),
        averageDailyTrips: parseFloat(averageDailyTrips),
        totalMessages: totalMessages,
        registeredPassengers,
        registeredDrivers,
        activeDrivers,
        inactiveDrivers
      }
    });

  } catch (error) {
    console.error("Error fetching reports:", error);
    res.status(500).json({ success: false, message: "Failed to fetch reports." });
  }
});

module.exports = router;
