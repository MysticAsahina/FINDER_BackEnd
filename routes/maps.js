const express = require('express');
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { authenticate } = require('../middleware/auth');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Helper middleware to format errors like Google Maps so the React Native library logs the actual reason
const gmapsAuth = (req, res, next) => {
  const originalJson = res.json;
  res.json = function(data) {
    if (res.statusCode === 401 || res.statusCode === 429 || res.statusCode === 500) {
      if (!data.status) data.status = "REQUEST_DENIED";
      if (!data.error_message) data.error_message = data.message || data.error || "Request blocked by backend proxy (Missing token/Rate limited?)";
    }
    return originalJson.call(this, data);
  };
  authenticate(req, res, next);
};

const gmapsLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || rateLimit.ipKeyGenerator(req, res),
  handler: (req, res) => {
    res.status(429).json({ status: "REQUEST_DENIED", error_message: "Backend 60/min Rate Limit Exceeded" });
  }
});

router.use(gmapsAuth);
router.use(gmapsLimiter);

// Helper function to build query string
const buildQueryString = (queryObj) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(queryObj)) {
    if (key !== 'key') {
      params.append(key, value);
    }
  }
  params.append('key', GOOGLE_MAPS_API_KEY);
  return params.toString();
};

// Places Autocomplete Proxy
router.get('/api/place/autocomplete/json', async (req, res) => {
  try {
    const qs = buildQueryString(req.query);
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${qs}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    res.json(data);
  } catch (error) {
    console.error('Error fetching Places Autocomplete:', error);
    res.status(500).json({ error: 'Failed to fetch autocomplete data' });
  }
});

// Places Details Proxy
router.get('/api/place/details/json', async (req, res) => {
  try {
    const qs = buildQueryString(req.query);
    const url = `https://maps.googleapis.com/maps/api/place/details/json?${qs}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    res.json(data);
  } catch (error) {
    console.error('Error fetching Places Details:', error);
    res.status(500).json({ error: 'Failed to fetch place details' });
  }
});

// Directions Proxy
router.get('/api/directions/json', async (req, res) => {
  try {
    const qs = buildQueryString(req.query);
    const url = `https://maps.googleapis.com/maps/api/directions/json?${qs}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    // Log if Google denies the request
    if (data.status !== 'OK') {
        console.error('[Maps Proxy] Google API Error:', data.status, data.error_message || 'No error message');
    }
    
    res.json(data);
  } catch (error) {
    console.error('Error fetching Directions:', error);
    res.status(500).json({ error: 'Failed to fetch directions' });
  }
});

module.exports = router;
