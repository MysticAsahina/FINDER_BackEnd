require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const authRouter = require("./routes/auth");
const registerRouter = require('./routes/register');

const app = express();
const port = process.env.PORT;

app.use(cors());
app.use(express.json());

app.use("/auth", authRouter);
app.use('/register', registerRouter);

app.get('/', (req, res) => {
  res.send('Hello World.')
});

// Health checking route
app.get("/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ status: "ok", uptime: process.uptime() }); }
  catch { res.status(500).json({ status: "db-fail" }); }
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
    app.listen(port, () => {
        console.log(`Listening on port ${port}`)
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  });
