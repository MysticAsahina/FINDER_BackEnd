const { google } = require('googleapis');

// Expects these in .env:
// EMAIL_USER (e.g., your gmail address)
// GOOGLE_CLIENT_ID
// GOOGLE_CLIENT_SECRET
// GOOGLE_REFRESH_TOKEN

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground' // Redirect URI used during setup
);

oAuth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

async function sendEmailOtp(toEmail, code) {
  const subject = "Your Finder Verification Code";
  
  // RFC 1342 format for subject encoding (handles special characters nicely)
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  
  const messageParts = [
    `From: Finder Support <${process.env.EMAIL_USER}>`,
    `To: ${toEmail}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${utf8Subject}`,
    '',
    `Your verification code is ${code}. It expires in 5 minutes. Do not share this with anyone.`
  ];
  
  const message = messageParts.join('\n');
  
  // The Gmail API requires a base64url encoded string
  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });
    console.log("Email sent successfully, ID: " + res.data.id);
    return res.data;
  } catch (error) {
    console.error("Error sending email via Gmail API:", error);
    throw new Error("Failed to send email OTP.");
  }
}

module.exports = {
  sendEmailOtp,
};
