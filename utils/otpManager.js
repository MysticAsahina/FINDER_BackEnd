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

// Converts number to E164 format, used for OTP, use if SMS API requires E164 format (+639XXXXXXXXX)
function toE164(mobileNumber) {
  if (mobileNumber.startsWith('09')) {
    return '+63' + mobileNumber.slice(1);
  } else if (!mobileNumber.startsWith('+')) {
    return '+' + mobileNumber;
  }
  return mobileNumber;
}

async function sendSmsOtp(key, mobileNumber, payload = {}) {
  const code = generateOtp();
  const expiresAt = Date.now() + OTP_EXPIRY_MS;

  // Save the OTP to memory BEFORE attempting to send it.
  // If the SMS Gateway takes too long to respond and our 10-second timeout triggers,
  // the SMS might still eventually reach the user's phone. By saving it first, 
  // they can still successfully verify it!
  otpStore.set(String(key), { code, expiresAt, attempts: 0, payload });

  const iProgSmsToken = process.env.IPROGSMS_API_TOKEN;
  const iProgSmsUrl = process.env.IPROGSMS_API_URL;

  if (iProgSmsUrl) {
    try {
      console.log(`[IProgSMS] Preparing to send OTP to: ${mobileNumber}`);
      
      const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json"
      };

      let endpoint = iProgSmsUrl.replace(/\/$/, '');
      const payloadBody = {
        api_token: iProgSmsToken,
        phone_number: mobileNumber,
        message: `Finder app code: ${code}`,
        sms_provider: 1 // Trying alternative routing since 0 is failing silently at the telco
      };

      console.log(`[IProgSMS] Sending request to ${endpoint}`);
      // Do not log the raw token in production, but for debugging we log the keys
      console.log(`[IProgSMS] Payload keys: ${Object.keys(payloadBody).join(', ')}`);

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payloadBody),
        signal: AbortSignal.timeout(5000)
      });
      
      const responseText = await response.text();
      console.log(`[IProgSMS] Received response status: ${response.status} ${response.statusText}`);
      console.log(`[IProgSMS] Response body: ${responseText}`);

      if (!response.ok) {
        throw new Error(`Failed to send OTP via IProgSMS. Status: ${response.status} - ${responseText}`);
      }
      
      // Some APIs return 200 OK but include an error message in the body
      try {
        const jsonResponse = JSON.parse(responseText);
        if (jsonResponse.status === 'error' || jsonResponse.status === false || jsonResponse.success === false) {
           console.warn(`[IProgSMS] API returned 200 OK but indicates failure in body:`, jsonResponse);
        }
      } catch (e) {
        // Not JSON, ignore
      }

    } catch (err) {
      console.error("[IProgSMS] SMS Gateway Error:", err.message || err);
      // Don't throw if we want them to still be able to use the mock OTP or if we don't want to crash the login flow, 
      // but throwing is better so the frontend knows it failed.
      throw err;
    }
  } else {
    // FALLBACK: If there's no API URL in the .env, print the OTP to the console for testing purposes.
    console.log(`[MOCK SMS] Would have sent code ${code} to ${mobileNumber}`);
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
