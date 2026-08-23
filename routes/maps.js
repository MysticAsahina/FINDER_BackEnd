const express = require('express');
const rateLimit = require("express-rate-limit");
const router = express.Router();

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Rate Limiter for Maps API requests
const mapsLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || rateLimit.ipKeyGenerator(req, res),
  message: { error: 'Too many requests to Maps API. Please try again later.' }
});

router.use(mapsLimiter);

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
    
    res.json(data);
  } catch (error) {
    console.error('Error fetching Directions:', error);
    res.status(500).json({ error: 'Failed to fetch directions' });
  }
});

module.exports = router;
