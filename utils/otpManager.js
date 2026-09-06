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

  // Save the OTP to memory BEFORE attempting to send it.
  // If the SMS Gateway takes too long to respond and our 10-second timeout triggers,
  // the SMS might still eventually reach the user's phone. By saving it first, 
  // they can still successfully verify it!
  otpStore.set(String(key), { code, expiresAt, attempts: 0, payload });

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

      let endpoint = smsgateUrl.replace(/\/$/, '');
      
      // Auto-append the correct path if the user just provided the base URL
      if (!endpoint.endsWith('/message') && !endpoint.endsWith('/messages')) {
        if (endpoint.includes('api.sms-gate.app') || endpoint.includes('3rdparty')) {
          endpoint += '/messages';
        } else {
          endpoint += '/message';
        }
      }

      // The Public Cloud API uses a different JSON structure than the Local API
      const isCloud = endpoint.endsWith('/messages');
      const payloadBody = isCloud
        ? {
            textMessage: { text: `Your Finder OTP is ${code}. Do not share this with anyone.` },
            phoneNumbers: [formattedNumber]
          }
        : {
            message: `Your Finder OTP is ${code}. Do not share this with anyone.`,
            phoneNumbers: [formattedNumber]
          };

      let response;
      let retries = 3;
      let lastError = null;

      while (retries > 0) {
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payloadBody),
            signal: AbortSignal.timeout(10000)
          });
          
          if (response.ok) break; // Success!
          
          if (response.status >= 500) {
             throw new Error(`Server returned ${response.status}`);
          } else {
             break; // 4xx errors shouldn't be retried
          }
        } catch (err) {
          lastError = err;
          retries--;
          if (retries > 0) {
             console.log(`[SMS Gateway] Request failed (${err.message}). Retrying in 2 seconds...`);
             await new Promise(res => setTimeout(res, 2000));
          }
        }
      }

      if (!response || !response.ok) {
        const errorText = response ? await response.text() : lastError.message;
        const status = response ? response.status : 'Network/Timeout';
        throw new Error(`Failed to send OTP via SMS Gateway. Status: ${status} - ${errorText}`);
      }
    } catch (err) {
      console.error("SMS Gateway Error:", err);
      throw err;
    }
  } else {
    console.log("[MOCK SMS] Would have sent code " + code + " to " + formattedNumber);
  }
}

async function createAndSendEmailOtp(key, emailAddress, payload = {}) {
  const code = generateOtp();
  const expiresAt = Date.now() + OTP_EXPIRY_MS;

  otpStore.set(String(key), { code, expiresAt, attempts: 0, payload });

  await sendEmailOtp(emailAddress, code);
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
