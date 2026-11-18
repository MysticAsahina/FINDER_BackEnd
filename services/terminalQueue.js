const Terminal = require("../models/Terminal");
const ActiveDriver = require("../models/ActiveDriver");

const GRACE_PERIOD_MS = 3 * 60 * 1000; // 3 minutes grace period for GPS drift
const DISCONNECT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes without update = reset queue position

// Default MVGFCI coordinates: [longitude, latitude]
const DEFAULT_MVGFCI_COORDS = [120.958028, 15.478000];
const DEFAULT_TERMINAL_RADIUS = 60; // meters
const DEFAULT_CATCHMENT_RADIUS = 400; // meters

/**
 * Calculates geodesic distance between two points [lng, lat] in meters using Haversine formula
 */
function calculateDistanceMeters(coord1, coord2) {
  if (!coord1 || !coord2 || coord1.length < 2 || coord2.length < 2) return Infinity;
  const [lng1, lat1] = coord1;
  const [lng2, lat2] = coord2;

  const R = 6371000; // Radius of Earth in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Retrieves the active MVGFCI terminal settings (from DB with memory fallback)
 */
let cachedTerminal = null;
let lastTerminalFetch = 0;

async function getMvgfciTerminal() {
  const now = Date.now();
  if (cachedTerminal && now - lastTerminalFetch < 60000) {
    return cachedTerminal;
  }
  try {
    let terminal = await Terminal.findOne({ code: "MVGFCI", isActive: true });
    if (!terminal) {
      terminal = await Terminal.getMvgfciTerminal();
    }
    cachedTerminal = terminal;
    lastTerminalFetch = now;
    return terminal;
  } catch (err) {
    console.error("[terminalQueue] Error fetching MVGFCI terminal:", err);
    return {
      code: "MVGFCI",
      name: "MVGFCI Main Gate TODA Terminal",
      location: { coordinates: DEFAULT_MVGFCI_COORDS },
      terminalRadiusMeters: DEFAULT_TERMINAL_RADIUS,
      catchmentRadiusMeters: DEFAULT_CATCHMENT_RADIUS,
    };
  }
}

/**
 * Processes a driver's location update and manages terminal queue & grace period state
 * @param {Object} activeDriver - Mongoose ActiveDriver document
 * @param {Array<Number>} coordinates - [longitude, latitude]
 * @param {Boolean} isOnline - Driver's online status
 */
async function processDriverLocation(activeDriver, coordinates, isOnline) {
  if (!activeDriver) return;

  // 1. If driver goes offline, immediately evict from queue
  if (isOnline === false) {
    activeDriver.terminalId = null;
    activeDriver.enteredTerminalAt = null;
    activeDriver.leftTerminalAt = null;
    return;
  }

  const now = new Date();

  // 2. If driver was disconnected/silent for > 3 minutes before this update, reset queue position
  if (activeDriver.lastUpdated && activeDriver.enteredTerminalAt) {
    const elapsedSinceLastUpdate = now.getTime() - new Date(activeDriver.lastUpdated).getTime();
    if (elapsedSinceLastUpdate > DISCONNECT_TIMEOUT_MS) {
      console.log(`[terminalQueue] Driver ${activeDriver.driverId} was disconnected for > 3m (${Math.round(elapsedSinceLastUpdate / 1000)}s). Resetting queue position.`);
      activeDriver.enteredTerminalAt = null;
      activeDriver.leftTerminalAt = null;
      activeDriver.terminalId = null;
    }
  }

  if (!coordinates || coordinates.length < 2) return;

  const terminal = await getMvgfciTerminal();
  const terminalCoords = terminal.location?.coordinates || DEFAULT_MVGFCI_COORDS;
  const terminalRadius = terminal.terminalRadiusMeters || DEFAULT_TERMINAL_RADIUS;

  const distToTerminal = calculateDistanceMeters(coordinates, terminalCoords);

  // 3. Driver is within terminal geofence (60m)
  if (distToTerminal <= terminalRadius) {
    activeDriver.terminalId = terminal.code;

    if (!activeDriver.enteredTerminalAt) {
      // Fresh arrival into the terminal
      activeDriver.enteredTerminalAt = now;
      activeDriver.leftTerminalAt = null;
      console.log(`[terminalQueue] Driver ${activeDriver.driverId} joined ${terminal.code} queue at ${now.toISOString()}`);
    } else {
      // Driver was already in the queue
      if (activeDriver.leftTerminalAt) {
        const timeOutsideMs = now.getTime() - new Date(activeDriver.leftTerminalAt).getTime();
        if (timeOutsideMs <= GRACE_PERIOD_MS) {
          // Returned within grace period: keep original queue position!
          console.log(`[terminalQueue] Driver ${activeDriver.driverId} returned to queue within grace period (${Math.round(timeOutsideMs / 1000)}s). Preserving position.`);
          activeDriver.leftTerminalAt = null;
        } else {
          // Stayed outside longer than grace period: reset position to back of queue
          console.log(`[terminalQueue] Driver ${activeDriver.driverId} grace period expired (${Math.round(timeOutsideMs / 1000)}s). Moved to back of queue.`);
          activeDriver.enteredTerminalAt = now;
          activeDriver.leftTerminalAt = null;
        }
      }
    }
  } else {
    // 4. Driver is outside the terminal geofence (> 60m)
    if (activeDriver.enteredTerminalAt) {
      if (!activeDriver.leftTerminalAt) {
        // Just drifted out: start grace period
        activeDriver.leftTerminalAt = now;
        console.log(`[terminalQueue] Driver ${activeDriver.driverId} drifted outside ${terminal.code} (${Math.round(distToTerminal)}m). Grace period started.`);
      } else {
        // Already drifting: check if grace period exceeded
        const timeOutsideMs = now.getTime() - new Date(activeDriver.leftTerminalAt).getTime();
        if (timeOutsideMs > GRACE_PERIOD_MS) {
          // Grace period expired: evict from queue
          console.log(`[terminalQueue] Driver ${activeDriver.driverId} evicted from ${terminal.code} queue after > 3m outside.`);
          activeDriver.enteredTerminalAt = null;
          activeDriver.leftTerminalAt = null;
          activeDriver.terminalId = null;
        }
      }
    }
  }
}

/**
 * Returns current queue information for a specific driver
 * @param {String|ObjectId} driverId
 */
async function getDriverQueueInfo(driverId) {
  try {
    const activeDriver = await ActiveDriver.findOne({ driverId });
    if (!activeDriver || !activeDriver.isOnline || !activeDriver.enteredTerminalAt) {
      return {
        inQueue: false,
        position: null,
        totalInQueue: 0,
        isDrifting: false,
        driftSecondsLeft: null,
        terminalName: null,
      };
    }

    const now = Date.now();

    // Check if grace period expired while waiting
    if (activeDriver.leftTerminalAt) {
      const timeOutsideMs = now - new Date(activeDriver.leftTerminalAt).getTime();
      if (timeOutsideMs > GRACE_PERIOD_MS) {
        activeDriver.enteredTerminalAt = null;
        activeDriver.leftTerminalAt = null;
        activeDriver.terminalId = null;
        await activeDriver.save();
        return {
          inQueue: false,
          position: null,
          totalInQueue: 0,
          isDrifting: false,
          driftSecondsLeft: null,
          terminalName: null,
        };
      }
    }

    const isDrifting = !!activeDriver.leftTerminalAt;
    const driftSecondsLeft = isDrifting
      ? Math.max(0, Math.round((GRACE_PERIOD_MS - (now - new Date(activeDriver.leftTerminalAt).getTime())) / 1000))
      : null;

    // Count how many drivers entered the queue before this driver
    const earlierDriversCount = await ActiveDriver.countDocuments({
      terminalId: activeDriver.terminalId,
      isOnline: true,
      isBusy: false,
      enteredTerminalAt: { $lt: activeDriver.enteredTerminalAt },
    });

    const totalInQueue = await ActiveDriver.countDocuments({
      terminalId: activeDriver.terminalId,
      isOnline: true,
      isBusy: false,
      enteredTerminalAt: { $ne: null },
    });

    return {
      inQueue: true,
      position: earlierDriversCount + 1,
      totalInQueue,
      isDrifting,
      driftSecondsLeft,
      terminalName: "MVGFCI Pila",
    };
  } catch (err) {
    console.error("[terminalQueue] Error getting driver queue info:", err);
    return {
      inQueue: false,
      position: null,
      totalInQueue: 0,
      isDrifting: false,
      driftSecondsLeft: null,
      terminalName: null,
    };
  }
}

/**
 * Applies penalty to a driver who declines or times out (moves to back of queue)
 * @param {String|ObjectId} driverId
 */
async function applyQueuePenalty(driverId) {
  try {
    const activeDriver = await ActiveDriver.findOne({ driverId });
    if (activeDriver && activeDriver.enteredTerminalAt) {
      const now = new Date();
      activeDriver.enteredTerminalAt = now;
      activeDriver.leftTerminalAt = null;
      await activeDriver.save();
      console.log(`[terminalQueue] Applied queue penalty to Driver ${driverId}. Reset to back of line.`);

      const { sendToUser } = require("./socket");
      const updatedInfo = await getDriverQueueInfo(driverId);
      sendToUser(driverId, "queue_status", updatedInfo);
      return true;
    }
  } catch (err) {
    console.error("[terminalQueue] Error applying queue penalty:", err);
  }
  return false;
}

module.exports = {
  calculateDistanceMeters,
  getMvgfciTerminal,
  processDriverLocation,
  getDriverQueueInfo,
  applyQueuePenalty,
  GRACE_PERIOD_MS,
  DEFAULT_MVGFCI_COORDS,
  DEFAULT_TERMINAL_RADIUS,
  DEFAULT_CATCHMENT_RADIUS,
};
