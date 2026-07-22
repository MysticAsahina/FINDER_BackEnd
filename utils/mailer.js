const nodemailer = require("nodemailer");

// Expects these in .env:
// EMAIL_USER (e.g., your gmail address)
// EMAIL_PASS (App Password from Google)

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendEmailOtp(toEmail, code) {
  const mailOptions = {
    from: `"Finder Support" <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: "Your Finder Verification Code",
    text: `Your verification code is ${code}. It expires in 5 minutes. Do not share this with anyone.`,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent: " + info.response);
    return info;
  } catch (error) {
    console.error("Error sending email:", error);
    throw new Error("Failed to send email OTP.");
  }
}

module.exports = {
  sendEmailOtp,
};
