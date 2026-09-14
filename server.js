require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const cookieParser = require('cookie-parser');
const mongoose = require("mongoose");
const helmet   = require('helmet');

const authRouter             = require("./routes/auth");
const registerRouter         = require('./routes/register');
const driverRegisterRouter   = require('./routes/driverRegister');
const adminApplicationsRouter = require('./routes/admin/adminApplications');
const editProfileRouter       = require('./routes/passenger/editProfile');
const driverEditProfileRouter = require('./routes/driver/editProfile');
const adminEditProfileRouter      = require('./routes/admin/editProfile');
const adminAuditLogsRouter        = require('./routes/admin/auditLogs');
const adminDriversRouter          = require('./routes/admin/drivers');
const adminReportsRouter          = require('./routes/admin/reports');
const supportRouter          = require('./routes/support');
const driverStatusRouter     = require('./routes/driver/status');
const passengerRideRouter    = require('./routes/passenger/ride');
const driverRideRouter       = require('./routes/driver/ride');
const passengerChatRouter    = require('./routes/passenger/chat');
const driverChatRouter       = require('./routes/driver/chat');
const emergencyContactRouter = require('./routes/emergencyContact');
const adminSettingsRouter       = require('./routes/admin/settings');
const passengerSettingsRouter   = require('./routes/passenger/settings');
const mapsRouter                = require('./routes/maps');
const chatMediaRouter           = require('./routes/chatMedia');
const adminDashboardRouter        = require('./routes/admin/dashboard');
const adminAnalyticsRouter         = require('./routes/admin/analytics');
const adminBadgesRouter            = require('./routes/admin/badges');
const paymentRouter                 = require('./routes/passenger/payment');

const http = require("http");
const socketService = require("./services/socket");

require('dns').setDefaultResultOrder('ipv4first');

const app    = express();
app.use(helmet());
app.set('trust proxy', 1); // Trust the proxy from Render
const server = http.createServer(app);
const port   = process.env.PORT;

app.use(cors({
  origin: ['https://finder-admin.mcreysc980.workers.dev'],
  credentials: true
}));

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf; // This saves the raw text so we can verify the PayMongo signature
  }
}));

app.use(cookieParser());

app.use("/auth",               authRouter);
app.use('/register',           registerRouter);
app.use('/driver-register',    driverRegisterRouter);
app.use('/admin/applications', adminApplicationsRouter);

app.use('/passenger/edit-profile', editProfileRouter);
app.use('/driver/edit-profile', driverEditProfileRouter);
app.use('/admin/edit-profile', adminEditProfileRouter);
app.use('/admin/audit-logs', adminAuditLogsRouter);
app.use('/admin/drivers', adminDriversRouter);
app.use('/admin/settings', adminSettingsRouter);
app.use('/admin/reports', adminReportsRouter);
app.use('/admin/dashboard', adminDashboardRouter);
app.use('/admin/analytics', adminAnalyticsRouter);
app.use('/admin/badges', adminBadgesRouter);

app.use('/support', supportRouter);
app.use('/driver/status', driverStatusRouter);
app.use('/passenger/ride', passengerRideRouter);
app.use('/driver/ride', driverRideRouter);
app.use('/passenger/ride', passengerChatRouter);
app.use('/driver/ride', driverChatRouter);
app.use('/emergency-contact', emergencyContactRouter);
app.use('/passenger/settings', passengerSettingsRouter);
app.use('/maps', mapsRouter);
app.use('/chat', chatMediaRouter);

app.use('/passenger/payment', paymentRouter);

app.get('/', (_req, res) => {
  res.send('No errors here, probably.');
});

// Health check
app.get("/health", async (_req, res) => {
  const state = mongoose.connection.readyState;
  if (state !== 1) {
    return res.status(500).json({ status: "db-fail", readyState: state });
  }

  try {
    // Send a real network packet to MongoDB to keep the TCP socket alive
    // and verify the connection isn't a dead "zombie" socket.
    await mongoose.connection.db.command({ ping: 1 });
    res.json({ status: "ok", uptime: process.uptime() });
  } catch (error) {
    console.error("Health check ping failed:", error);
    res.status(500).json({ status: "db-fail", error: error.message });
  }
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal server error." });
});

mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 10000, // 10s (staggered below the 15s client timeout)
  maxIdleTimeMS: 60000, // Close idle connections before the cloud firewall silently drops them
})
  .then(() => {
    console.log("MongoDB connected");

    // Internal Keep-Alive: Ping MongoDB every 3 minutes to prevent the cloud firewall 
    // from silently dropping the TCP socket due to inactivity (usually drops after 4-5 mins).
    // This runs completely independently of your 10-minute external health checker!
    setInterval(() => {
      if (mongoose.connection.readyState === 1) {
        mongoose.connection.db.command({ ping: 1 }).catch(console.error);
      }
    }, 3 * 60 * 1000);

    socketService.init(server);
    server.listen(port, () => {
      console.log(`Listening on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });