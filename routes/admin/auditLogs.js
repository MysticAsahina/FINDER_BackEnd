const express = require("express");
const AuditLog = require("../../models/AuditLog");
const { authenticate, requireRole } = require("../../middleware/auth");

const router = express.Router();

router.use(authenticate, requireRole("admin"));

// GET /admin/audit-logs
router.get("/", async (req, res) => {
  try {
    const action = req.query.action || "";
    const dateFilter = req.query.date || "";
    const search = req.query.search?.trim() || "";
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const query = {};

    // Filter by action group
    if (action && action !== "All Actions") {
      if (action === "Login/Logout") {
        query.action = { $in: ["LOGIN_SUCCESS", "LOGIN_FAILED", "LOGOUT"] };
      } else if (action === "Driver Approvals") {
        query.action = { $in: ["DRIVER_APPROVED", "DRIVER_REJECTED"] };
      } else if (action === "Fare Changes") {
        // Placeholder for future feature
        query.action = "UPDATE_FARE_SETTINGS";
      } else if (action === "Config Changes") {
        query.action = "CONFIG_UPDATED";
      }
    }

    // Filter by date
    if (req.query.month && req.query.year) {
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const monthIndex = monthNames.indexOf(req.query.month);
      if (monthIndex !== -1) {
        const year = parseInt(req.query.year);
        const startOfMonth = new Date(year, monthIndex, 1);
        const endOfMonth = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
        query.createdAt = { $gte: startOfMonth, $lte: endOfMonth };
      }
    } else if (dateFilter) {
      const now = new Date();
      if (dateFilter === "Today") {
        const startOfDay = new Date(now.setHours(0, 0, 0, 0));
        query.createdAt = { $gte: startOfDay };
      } else if (dateFilter === "This Week") {
        const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
        startOfWeek.setHours(0,0,0,0);
        query.createdAt = { $gte: startOfWeek };
      } else if (dateFilter === "This Month") {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        query.createdAt = { $gte: startOfMonth };
      }
    }

    // Search text
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, "i");
      query.$or = [
        { adminName: regex },
        { details: regex },
        { action: regex }
      ];
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments(query),
    ]);

    return res.status(200).json({
      logs,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("[admin/auditLogs GET]", err);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

module.exports = router;
