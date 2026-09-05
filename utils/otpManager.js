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
  
  // PhilSMS requires 639XXXXXXXXX format
  let philsmsNumber = mobileNumber;
  if (philsmsNumber.startsWith('+63')) {
    philsmsNumber = philsmsNumber.slice(1);
  } else if (philsmsNumber.startsWith('09')) {
    philsmsNumber = '63' + philsmsNumber.slice(1);
  }

  const apiToken = process.env.PHILSMS_API_TOKEN;

  if (apiToken) {
    try {
      const response = await fetch("https://dashboard.philsms.com/api/v3/sms/send", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + apiToken,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          recipient: philsmsNumber,
          sender_id: "FINDER",
          type: "plain",
          message: `Your Finder OTP is ${code}. Do not share this with anyone.`
        }),
      });

      const data = await response.json();
      if (data.status !== "success") {
        throw new Error(data.message || "Failed to send OTP via PhilSMS");
      }
    } catch (err) {
      console.error("PhilSMS Error:", err);
      throw err;
    }
  } else {
    console.log("[MOCK SMS] Would have sent code " + code + " to " + philsmsNumber);
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
