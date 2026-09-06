const crypto = require("crypto");
const { sendEmailOtp } = require("./mailer");

// OTP expires in 5 minutes
const OTP_EXPIRY_MS = 5 * 60 * 1000;

// OTP store
// Keyed by a string so multiple contexts (e.g., login, profile update) can have active OTPs at once.
// Each entry: { code, expiresAt, attempts, payload }
const otpStore = new Map();

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

// Converts number to E164 format, used for OTP
function toE164(mobileNumber) {
  return '+63' + mobileNumber.slice(1);
}

async function sendSmsOtp(key, mobileNumber, payload = {}) {
  const code = generateOtp();
  const expiresAt = Date.now() + OTP_EXPIRY_MS;
  
  // SMS Gateway for Android prefers E.164 format (+639XXXXXXXXX)
  let formattedNumber = mobileNumber;
  if (formattedNumber.startsWith('09')) {
    formattedNumber = '+63' + formattedNumber.slice(1);
  } else if (!formattedNumber.startsWith('+')) {
    formattedNumber = '+' + formattedNumber;
  }

  const smsgateUrl = process.env.SMSGATE_API_URL;
  const smsgateToken = process.env.SMSGATE_API_TOKEN;
  const smsgateUsername = process.env.SMSGATE_USERNAME;
  const smsgatePassword = process.env.SMSGATE_PASSWORD;

  if (smsgateUrl) {
    try {
      const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json"
      };

      if (smsgateToken) {
        headers["Authorization"] = "Bearer " + smsgateToken;
      } else if (smsgateUsername && smsgatePassword) {
        headers["Authorization"] = "Basic " + Buffer.from(smsgateUsername + ":" + smsgatePassword).toString("base64");
      }

      // Endpoint is usually /message or /api/message, we'll append /message to the base URL
      const response = await fetch(`${smsgateUrl.replace(/\/$/, '')}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          phoneNumbers: [formattedNumber],
          message: `Your Finder OTP is ${code}. Do not share this with anyone.`
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to send OTP via SMS Gateway. Status: ${response.status} - ${errorText}`);
      }
    } catch (err) {
      console.error("SMS Gateway Error:", err);
      throw err;
    }
  } else {
    console.log("[MOCK SMS] Would have sent code " + code + " to " + formattedNumber);
  }

  otpStore.set(String(key), { code, expiresAt, attempts: 0, payload });
}

async function createAndSendEmailOtp(key, emailAddress, payload = {}) {
  const code = generateOtp();
  const expiresAt = Date.now() + OTP_EXPIRY_MS;

  await sendEmailOtp(emailAddress, code);

  otpStore.set(String(key), { code, expiresAt, attempts: 0, payload });
}

function verifyOtp(key, submittedCode) {
  const storeKey = String(key);
  const entry = otpStore.get(storeKey);

  if (!entry) return { valid: false, message: "OTP not found or expired." };
  if (Date.now() > entry.expiresAt) { 
    otpStore.delete(storeKey); 
    return { valid: false, message: "OTP expired." }; 
  }

  if (submittedCode !== entry.code) {
    entry.attempts += 1;
    if (entry.attempts >= 3) otpStore.delete(storeKey); // burn after 3 wrong attempts
    return { valid: false, message: "Invalid OTP." };
  }

  const payload = entry.payload;
  otpStore.delete(storeKey); // correct — consume it
  return { valid: true, payload };
}

module.exports = {
  sendSmsOtp,
  createAndSendEmailOtp,
  verifyOtp,
};
