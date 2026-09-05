const jwt = require("jsonwebtoken");
const User = require("../models/User");

/**
 * Verifies the Bearer token in the Authorization header.
 * Attaches the decoded payload to req.user.
 * Rejects pending tokens (those issued before OTP verification).
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }

  try {
    const decoded = jwt.verify(
      authHeader.split(" ")[1],
      process.env.ACCESS_SECRET
    );

    if (decoded.pending) {
      return res.status(401).json({ message: "Token is not yet fully authenticated." });
    }

    const user = await User.findById(decoded.id).select("tokenVersion");
    if (!user) {
      return res.status(401).json({ message: "User no longer exists." });
    }

    const tokenV = decoded.tokenVersion || 0;
    if (user.tokenVersion !== tokenV) {
      return res.status(401).json({ message: "Session expired due to login on another device." });
    }

    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Invalid or expired token." });
    }
    next(err);
  }
}

/**
 * Role guard — use after authenticate().
 * Usage: router.get('/route', authenticate, requireRole('admin'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ message: "Access denied." });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };