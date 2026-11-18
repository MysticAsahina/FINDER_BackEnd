const ActiveDriver = require("../models/ActiveDriver");
const Ride = require("../models/Ride");
const { sendToUser } = require("./socket");

const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

async function checkIdleDrivers() {
  try {
    const thresholdDate = new Date(Date.now() - IDLE_TIMEOUT_MS);
    
    // Find drivers who are online but haven't updated location/status in 2 hours
    const idleDrivers = await ActiveDriver.find({
      isOnline: true,
      lastUpdated: { $lt: thresholdDate }
    });

    for (const driver of idleDrivers) {
      // Check if driver is in an active ride
      const activeRide = await Ride.findOne({
        driverId: driver.driverId,
        status: { $in: ['pending', 'driver_assigned', 'arrived_pickup', 'trip_started'] }
      });

      if (!activeRide) {
        // Driver is genuinely idle and not in a ride. Mark offline.
        driver.isOnline = false;
        driver.terminalId = null;
        driver.enteredTerminalAt = null;
        driver.leftTerminalAt = null;
        await driver.save();

        // Emit socket event so their app updates UI and stops background tracking
        sendToUser(driver.driverId, "force_offline", {
          reason: "You have been marked offline due to prolonged inactivity."
        });
        
        console.log(`[idleMonitor] Driver ${driver.driverId} marked offline due to 2-hour inactivity.`);
      }
    }
  } catch (error) {
    console.error("[idleMonitor] Error checking idle drivers:", error);
  }
}

const RIDE_STUCK_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours

async function checkStuckRides() {
  try {
    const thresholdDate = new Date(Date.now() - RIDE_STUCK_TIMEOUT_MS);
    
    // Find rides that have been stuck in an active state with no updates for 3 hours
    const stuckRides = await Ride.find({
      status: { $in: ['driver_assigned', 'arrived_pickup', 'trip_started'] },
      updatedAt: { $lt: thresholdDate }
    });

    for (const ride of stuckRides) {
      if (!ride.cancellationData) ride.cancellationData = {};
      ride.cancellationData.cancelledBy = "system";
      ride.cancellationData.reason = "Ride was automatically cancelled due to prolonged inactivity (abandoned ride).";
      ride.status = "cancelled";
      await ride.save();

      // Free up driver
      if (ride.driverId) {
        await ActiveDriver.findOneAndUpdate({ driverId: ride.driverId }, { isBusy: false });
        sendToUser(ride.driverId, "ride_cancelled", { reason: "Ride was automatically cancelled due to prolonged inactivity (abandoned ride)." });
      }

      // Notify passenger
      sendToUser(ride.passengerId, "ride_cancelled", { reason: "Ride was automatically cancelled due to prolonged inactivity (abandoned ride)." });
      
      console.log(`[idleMonitor] Ride ${ride._id} automatically cancelled (stuck for > 3 hours).`);
    }
  } catch (error) {
    console.error("[idleMonitor] Error checking stuck rides:", error);
  }
}

const SupportTicket = require("../models/SupportTicket");
const ChatMessage = require("../models/ChatMessage");
const { broadcastToTicket, broadcastTicketResolved, broadcastToAdmins } = require("./socket");

const TICKET_WARNING_MS = 48 * 60 * 60 * 1000; // 48 hours
const TICKET_CLOSE_MS = 24 * 60 * 60 * 1000; // 24 hours
const WARNING_TEXT = "We haven't heard from you in a while. We will close this ticket in 24 hours if we don't receive a response.";
const CLOSE_TEXT = "This ticket has been automatically resolved due to inactivity. If you still need help, please open a new ticket.";

async function checkStaleSupportTickets() {
  try {
    const openTickets = await SupportTicket.find({ status: "open" });
    const now = Date.now();

    for (const ticket of openTickets) {
      // Find the last message
      const lastMessage = await ChatMessage.findOne({ ticketId: ticket._id }).sort({ createdAt: -1 });
      if (!lastMessage) continue; // Should not happen, but safe to skip

      const timeSinceLastMessage = now - lastMessage.createdAt.getTime();

      // If the last message was NOT from an admin, it means the admin hasn't responded yet.
      if (lastMessage.senderRole !== "admin") {
        // If 7 days have passed and admin still hasn't responded, auto-close with apology to free user's queue
        if (timeSinceLastMessage >= 7 * 24 * 60 * 60 * 1000) {
          const apologyMsg = await ChatMessage.create({
            ticketId: ticket._id,
            senderId: lastMessage.senderId, // User's ID is fine here since it's a system action
            senderRole: "admin", // Sent as admin for authority
            body: "We apologize for the delayed response. Due to high support volume, this ticket has been automatically closed to free up your queue. If your issue persists, please open a new ticket."
          });

          ticket.status = "resolved";
          ticket.updatedAt = new Date();
          await ticket.save();

          broadcastToTicket(ticket._id.toString(), apologyMsg);
          broadcastTicketResolved(ticket._id.toString());
          broadcastToAdmins("ticket_updated", {
            ticketId: ticket._id.toString(),
            updatedAt: ticket.updatedAt,
            status: ticket.status
          });
          console.log(`[idleMonitor] Ticket ${ticket._id} auto-resolved after 7 days of admin inactivity.`);
        }
        continue;
      }

      if (lastMessage.body === WARNING_TEXT) {
        // We already sent the warning. Has it been 24 hours since the warning?
        if (timeSinceLastMessage >= TICKET_CLOSE_MS) {
          // Close ticket
          const closeMsg = await ChatMessage.create({
            ticketId: ticket._id,
            senderId: lastMessage.senderId, // Use the same admin who sent the warning
            senderRole: "admin",
            body: CLOSE_TEXT
          });

          ticket.status = "resolved";
          ticket.updatedAt = new Date();
          await ticket.save();

          broadcastToTicket(ticket._id.toString(), closeMsg);
          broadcastTicketResolved(ticket._id.toString());
          broadcastToAdmins("ticket_updated", {
            ticketId: ticket._id.toString(),
            updatedAt: ticket.updatedAt,
            status: ticket.status
          });
          console.log(`[idleMonitor] Ticket ${ticket._id} auto-resolved due to inactivity.`);
        }
      } else {
        // Last message was a regular admin reply. Has it been 48 hours?
        if (timeSinceLastMessage >= TICKET_WARNING_MS) {
          // Send warning
          const warningMsg = await ChatMessage.create({
            ticketId: ticket._id,
            senderId: lastMessage.senderId, // Use the same admin who replied last
            senderRole: "admin",
            body: WARNING_TEXT
          });

          ticket.updatedAt = new Date();
          await ticket.save();

          broadcastToTicket(ticket._id.toString(), warningMsg);
          broadcastToAdmins("ticket_updated", {
            ticketId: ticket._id.toString(),
            updatedAt: ticket.updatedAt,
            status: ticket.status
          });
          console.log(`[idleMonitor] Ticket ${ticket._id} sent 48h inactivity warning.`);
        }
      }
    }
  } catch (error) {
    console.error("[idleMonitor] Error checking stale tickets:", error);
  }
}

function startIdleMonitor() {
  // Run every 15 minutes
  setInterval(() => {
    checkIdleDrivers();
    checkStuckRides();
    checkStaleSupportTickets();
  }, 15 * 60 * 1000);
  console.log("[idleMonitor] Started idle driver, stuck ride, and stale ticket monitor.");
}

module.exports = { startIdleMonitor };
