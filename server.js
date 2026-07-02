require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const cookieParser = require('cookie-parser');
const mongoose = require("mongoose");

const authRouter             = require("./routes/auth");
const registerRouter         = require('./routes/register');
const driverRegisterRouter   = require('./routes/driverRegister');
const adminApplicationsRouter = require('./routes/admin/adminApplications');
const editProfileRouter       = require('./routes/passenger/editProfile');
const driverEditProfileRouter = require('./routes/driver/editProfile');
const adminEditProfileRouter      = require('./routes/admin/editProfile');
const supportRouter          = require('./routes/support');
const driverStatusRouter     = require('./routes/driver/status');
const passengerRideRouter    = require('./routes/passenger/ride');
const driverRideRouter       = require('./routes/driver/ride');
const passengerChatRouter    = require('./routes/passenger/chat');
const driverChatRouter       = require('./routes/driver/chat');
const emergencyContactRouter = require('./routes/emergencyContact');

const http = require("http");
const socketService = require("./services/socket");

const app    = express();
const server = http.createServer(app);
const port   = process.env.PORT;

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

app.use("/auth",               authRouter);
app.use('/register',           registerRouter);
app.use('/driver-register',    driverRegisterRouter);
app.use('/admin/applications', adminApplicationsRouter);

app.use('/passenger/edit-profile', editProfileRouter);
app.use('/driver/edit-profile', driverEditProfileRouter);
app.use('/admin/edit-profile', adminEditProfileRouter);

app.use('/support', supportRouter);
app.use('/driver/status', driverStatusRouter);
app.use('/passenger/ride', passengerRideRouter);
app.use('/driver/ride', driverRideRouter);
app.use('/passenger/ride', passengerChatRouter);
app.use('/driver/ride', driverChatRouter);
app.use('/emergency-contact', emergencyContactRouter);

app.get('/', (_req, res) => {
  res.send('Hello World.');
});

// Health check
app.get("/health", (_req, res) => {
  const state = mongoose.connection.readyState;
  // 0: disconnected, 1: connected, 2: connecting, 3: disconnecting
  if (state === 1) {
    res.json({ status: "ok", uptime: process.uptime() });
  } else {
    res.status(500).json({ status: "db-fail", readyState: state });
  }
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
    socketService.init(server);
    server.listen(port, () => {
      console.log(`Listening on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  });