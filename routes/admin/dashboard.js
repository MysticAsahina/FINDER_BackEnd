const express = require('express');
const router = express.Router();
const Ride = require('../../models/Ride');
const User = require('../../models/User');
const DriverApplication = require('../../models/DriverApplication');
const ActiveDriver = require('../../models/ActiveDriver');
const AuditLog = require('../../models/AuditLog');
const { authenticate, requireRole } = require('../../middleware/auth');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start of today (midnight local) as UTC Date */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Start of yesterday (midnight local) as UTC Date */
function startOfYesterday() {
  const d = startOfToday();
  d.setDate(d.getDate() - 1);
  return d;
}

/** Start of current week (Monday 00:00) */
function startOfThisWeek() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

/** Returns a YYYY-MM-DD label for a Date object */
function dateLabel(d) {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /admin/dashboard
// Protected: admin only
//
// Returns:
//   stats           – four summary cards
//   last7Days       – per-day completed + cancelled for the bar chart
//   onlineDrivers   – count of currently online drivers
// ---------------------------------------------------------------------------
router.get(
  '/',
  authenticate,
  requireRole('admin'),
  async (req, res) => {
    try {
      const todayStart     = startOfToday();
      const todayEnd       = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
      const yesterdayStart = startOfYesterday();
      const weekStart      = startOfThisWeek();

      // ── Run all queries in parallel ────────────────────────────────────
      const [
        totalDrivers,
        newDriversThisWeek,
        pendingApplications,
        todayRidesAgg,
        yesterdayRidesAgg,
        last7DaysAgg,
        onlineDrivers,
        recentActivityRaw,
      ] = await Promise.all([

        // 1. Total registered drivers
        User.countDocuments({ role: 'driver' }),

        // 2. New drivers registered this week
        User.countDocuments({
          role: 'driver',
          createdAt: { $gte: weekStart },
        }),

        // 3. Pending driver applications
        DriverApplication.countDocuments({ status: 'pending' }),

        // 4. Today's completed + cancelled rides
        Ride.aggregate([
          {
            $match: {
              createdAt: { $gte: todayStart, $lt: todayEnd },
              status: { $in: ['completed', 'cancelled'] },
            },
          },
          {
            $group: {
              _id: null,
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
              cancelled:  { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] },  1, 0] } },
            },
          },
        ]),

        // 5. Yesterday's cancelled rides (for trend comparison)
        Ride.aggregate([
          {
            $match: {
              createdAt: { $gte: yesterdayStart, $lt: todayStart },
              status: 'cancelled',
            },
          },
          { $count: 'count' },
        ]),

        // 6. Last 7 days — completed + cancelled per day
        Ride.aggregate([
          {
            $match: {
              createdAt: {
                $gte: new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000),
                $lt: todayEnd,
              },
              status: { $in: ['completed', 'cancelled'] },
            },
          },
          {
            $group: {
              _id: {
                year:  { $year:  '$createdAt' },
                month: { $month: '$createdAt' },
                day:   { $dayOfMonth: '$createdAt' },
              },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
              cancelled:  { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] },  1, 0] } },
            },
          },
          { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
        ]),

        // 7. Currently online drivers
        ActiveDriver.countDocuments({ isOnline: true }),

        // 8. Recent activity — last 5 audit log entries
        AuditLog.find()
          .sort({ createdAt: -1 })
          .limit(5)
          .select('action details adminName createdAt')
          .lean(),
      ]);

      // ── Process today's rides ──────────────────────────────────────────
      const todayCompleted  = todayRidesAgg[0]?.completed  ?? 0;
      const todayCancelled  = todayRidesAgg[0]?.cancelled  ?? 0;
      const todayTotal      = todayCompleted + todayCancelled;
      const completionRate  = todayTotal > 0
        ? Math.round((todayCompleted / todayTotal) * 100)
        : 0;

      const yesterdayCancelled = yesterdayRidesAgg[0]?.count ?? 0;
      const cancelledDiff      = todayCancelled - yesterdayCancelled; // positive = more today

      // ── Build last-7-days array (fill missing days with 0) ────────────
      const last7Days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000);
        const label = dateLabel(d);
        // Match against aggregation result
        const found = last7DaysAgg.find(entry => {
          const entryDate = new Date(entry._id.year, entry._id.month - 1, entry._id.day);
          return dateLabel(entryDate) === label;
        });
        last7Days.push({
          date:      label,
          // Short label for chart x-axis e.g. "Mon", "Tue"
          label:     d.toLocaleDateString('en-US', { weekday: 'short' }),
          completed: found?.completed ?? 0,
          cancelled:  found?.cancelled  ?? 0,
        });
      }

      // ── Shape recent activity ──────────────────────────────────────────
      const recentActivity = recentActivityRaw.map(log => ({
        action:    log.action,
        details:   log.details,
        adminName: log.adminName,
        time:      log.createdAt, // ISO string — FE formats as "X mins ago"
      }));

      res.json({
        success: true,
        stats: {
          totalDrivers,
          newDriversThisWeek,
          pendingApplications,
          completedTripsToday:  todayCompleted,
          completionRateToday:  completionRate,
          cancelledTripsToday:  todayCancelled,
          cancelledVsYesterday: cancelledDiff,   // + means more cancelled today, - means fewer
          onlineDrivers,
        },
        last7Days, // [{ date, label, completed, cancelled }, ...]
        recentActivity, // [{ action, details, adminName, time }, ...] last 5
      });

    } catch (err) {
      console.error('Dashboard error:', err);
      res.status(500).json({ success: false, message: 'Failed to load dashboard.' });
    }
  }
);

module.exports = router;
