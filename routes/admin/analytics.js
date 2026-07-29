const express = require('express');
const router = express.Router();
const Ride = require('../../models/Ride');
const User = require('../../models/User');
const ActiveDriver = require('../../models/ActiveDriver');
const { authenticate, requireRole } = require('../../middleware/auth');

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

/**
 * Helper: build a { $gte, $lt } date range for a given month/year.
 * month is 1-indexed (1 = January).
 */
function monthRange(year, month) {
  const y = parseInt(year);
  const m = parseInt(month) - 1; // convert to 0-indexed for Date constructor
  return {
    $gte: new Date(y, m, 1),
    $lt:  new Date(y, m + 1, 1),
  };
}

// ---------------------------------------------------------------------------
// GET /admin/analytics
//
// Query params:
//   month  – month number 1-12  (default: current month)
//   year   – full year e.g. 2025 (default: current year)
//
// Returns:
//   stats           – summary cards
//   dailyTrips      – per-day completed trips for the month
//   peakHours       – trip count bucketed by hour (6 am – 5 pm shown in chart)
//   completionRate  – completed vs cancelled counts
//   topDrivers      – top 7 drivers by trips in the period
// ---------------------------------------------------------------------------
router.get(
  '/',
  authenticate,
  requireRole('admin'),
  async (req, res) => {
    try {
      const now = new Date();
      const year  = req.query.year  || now.getFullYear();
      const month = req.query.month || (now.getMonth() + 1); // 1-indexed

      const range = monthRange(year, month);

      // ── Base match for the selected month ───────────────────────────────
      const monthMatch = { createdAt: range };
      const finishedMatch = {
        createdAt: range,
        status: { $in: ['completed', 'cancelled'] },
      };

      // ── This-week boundaries (Mon–Sun of current real week) ─────────────
      const today = new Date();
      const dayOfWeek = today.getDay(); // 0 = Sun
      const diffToMon = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
      const weekStart = new Date(today);
      weekStart.setHours(0, 0, 0, 0);
      weekStart.setDate(today.getDate() + diffToMon);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 7);

      const prevWeekStart = new Date(weekStart);
      prevWeekStart.setDate(weekStart.getDate() - 7);

      // ── Run all aggregations in parallel ────────────────────────────────
      const [
        thisWeekTrips,
        lastWeekTrips,
        completionAgg,
        dailyAgg,
        peakHourAgg,
        topDriversAgg,
      ] = await Promise.all([

        // 1. This week's trip count
        Ride.countDocuments({
          createdAt: { $gte: weekStart, $lt: weekEnd },
          status: { $in: ['completed', 'cancelled'] },
        }),

        // 2. Last week's trip count (for % change)
        Ride.countDocuments({
          createdAt: { $gte: prevWeekStart, $lt: weekStart },
          status: { $in: ['completed', 'cancelled'] },
        }),

        // 3. Completed vs cancelled for selected month
        Ride.aggregate([
          { $match: finishedMatch },
          {
            $group: {
              _id: null,
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
              cancelled:  { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] },  1, 0] } },
            },
          },
        ]),

        // 4. Daily trip counts for selected month (completed rides only)
        Ride.aggregate([
          { $match: { createdAt: range, status: 'completed' } },
          {
            $group: {
              _id: { $dayOfMonth: '$createdAt' },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),

        // 5. Peak hour distribution (all rides in month, by hour of createdAt)
        Ride.aggregate([
          { $match: monthMatch },
          {
            $group: {
              _id: { $hour: '$createdAt' },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),

        // 6. Top 7 most active drivers this month
        Ride.aggregate([
          { $match: { createdAt: range, status: 'completed', driverId: { $ne: null } } },
          { $group: { _id: '$driverId', trips: { $sum: 1 } } },
          { $sort: { trips: -1 } },
          { $limit: 7 },
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'user',
            },
          },
          { $unwind: '$user' },
          {
            $lookup: {
              from: 'activedrivers',
              localField: '_id',
              foreignField: 'driverId',
              as: 'active',
            },
          },
          {
            $project: {
              _id: 0,
              driverId: '$_id',
              trips: 1,
              firstName: '$user.firstName',
              lastName:  '$user.lastName',
              isOnline: { $ifNull: [{ $arrayElemAt: ['$active.isOnline', 0] }, false] },
              isBusy:   { $ifNull: [{ $arrayElemAt: ['$active.isBusy',   0] }, false] },
            },
          },
        ]),
      ]);

      // ── Stats cards ──────────────────────────────────────────────────────
      const completed = completionAgg[0]?.completed ?? 0;
      const cancelled = completionAgg[0]?.cancelled  ?? 0;
      const totalFinished = completed + cancelled;
      const completionRate = totalFinished > 0
        ? Math.round((completed / totalFinished) * 100)
        : 0;

      const weekTrend = lastWeekTrips > 0
        ? Math.round(((thisWeekTrips - lastWeekTrips) / lastWeekTrips) * 100)
        : null;

      // Days in selected month
      const daysInMonth = new Date(parseInt(year), parseInt(month), 0).getDate();
      const avgDailyTrip = daysInMonth > 0 ? Math.round(completed / daysInMonth) : 0;

      // ── Daily trips array (one entry per day 1..daysInMonth) ─────────────
      const dailyMap = {};
      dailyAgg.forEach(d => { dailyMap[d._id] = d.count; });
      const dailyTrips = [];
      for (let day = 1; day <= daysInMonth; day++) {
        dailyTrips.push({ day, count: dailyMap[day] ?? 0 });
      }

      // ── Peak hours (hours 0-23, front-end can display any window) ────────
      const peakMap = {};
      peakHourAgg.forEach(h => { peakMap[h._id] = h.count; });
      const peakHours = Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        count: peakMap[i] ?? 0,
      }));

      // Determine peak hour label
      const peakHourEntry = peakHours.reduce(
        (max, h) => (h.count > max.count ? h : max),
        { hour: 0, count: 0 }
      );
      function hourLabel(h) {
        if (h === 0)  return '12am';
        if (h < 12)   return `${h}am`;
        if (h === 12) return '12pm';
        return `${h - 12}pm`;
      }
      const peakLabel = `${hourLabel(peakHourEntry.hour)}-${hourLabel(peakHourEntry.hour + 1)}`;

      // ── Top drivers: derive acceptance rate from total assigned rides ─────
      // Simple proxy: completed / (completed + cancelled) per driver would need
      // another query; for now we compute it with an extra aggregation only if
      // topDriversAgg has results.
      let topDrivers = topDriversAgg;
      if (topDriversAgg.length > 0) {
        const driverIds = topDriversAgg.map(d => d.driverId);
        const rateAgg = await Ride.aggregate([
          {
            $match: {
              createdAt: range,
              driverId: { $in: driverIds },
              status: { $in: ['completed', 'cancelled'] },
            },
          },
          {
            $group: {
              _id: '$driverId',
              done:  { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
              total: { $sum: 1 },
            },
          },
        ]);
        const rateMap = {};
        rateAgg.forEach(r => {
          rateMap[r._id.toString()] = r.total > 0
            ? Math.round((r.done / r.total) * 100)
            : 0;
        });

        topDrivers = topDriversAgg.map(d => {
          const statusLabel = d.isBusy
            ? 'busy'
            : d.isOnline
              ? 'online'
              : 'offline';
          return {
            name:   `${d.firstName} ${d.lastName}`,
            trips:  d.trips,
            rate:   `${rateMap[d.driverId.toString()] ?? 0}%`,
            status: statusLabel,
          };
        });
      }

      res.json({
        success: true,
        month: MONTH_NAMES[parseInt(month) - 1],
        year: parseInt(year),
        stats: {
          thisWeekTrips,
          weekTrendPct: weekTrend,
          completionRate,
          avgDailyTrip,
          peakHour: peakLabel,
        },
        completionCounts: { completed, cancelled },
        dailyTrips,   // [{ day:1, count:12 }, ...]
        peakHours,    // [{ hour:0, count:3 }, ... hour:23]
        topDrivers,   // [{ name, trips, rate, status }]
      });

    } catch (err) {
      console.error('Analytics error:', err);
      res.status(500).json({ success: false, message: 'Failed to load analytics.' });
    }
  }
);

module.exports = router;
