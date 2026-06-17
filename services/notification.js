const { Expo } = require("expo-server-sdk");
const User = require("../models/User");

const expo = new Expo();

/**
 * Send a push notification to a specific user's devices.
 *
 * @param {string} userId     - The recipient's User _id
 * @param {string} title      - Notification title (e.g. "Support Update 💬")
 * @param {string} body       - Notification body (the message text)
 * @param {object} data       - Extra payload for deeplinking (e.g. { ticketId, type: "support_chat" })
 */
async function sendPushToUser(userId, title, body, data = {}) {
  const user = await User.findById(userId).select("pushTokens");
  if (!user || !user.pushTokens.length) return;

  // Build one message per valid token
  const messages = [];
  for (const token of user.pushTokens) {
    if (!Expo.isExpoPushToken(token)) {
      console.warn(`Invalid Expo push token: ${token}`);
      continue;
    }
    messages.push({
      to: token,
      sound: "default",
      title,
      body,
      data,
    });
  }

  if (messages.length === 0) return;

  try {
    await expo.sendPushNotificationsAsync(messages);
  } catch (error) {
    console.error("Push notification delivery failed:", error);
  }
}

module.exports = { sendPushToUser };