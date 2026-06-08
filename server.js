require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const mongoose = require("mongoose");

const authRouter             = require("./routes/auth");
const registerRouter         = require('./routes/register');
const driverRegisterRouter   = require('./routes/driverRegister');
const adminApplicationsRouter = require('./routes/admin/adminApplications');

const app  = express();
const port = process.env.PORT;

app.use(cors());
app.use(express.json());

app.use("/auth",               authRouter);
app.use('/register',           registerRouter);
app.use('/driver-register',    driverRegisterRouter);
app.use('/admin/applications', adminApplicationsRouter);

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
    app.listen(port, () => {
      console.log(`Listening on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  });