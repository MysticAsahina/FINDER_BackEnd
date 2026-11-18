// ---------------------------------------------------------------------------
// Common User Fields
// ---------------------------------------------------------------------------

function validateName(value, field) {
  if (!value || !value.trim()) return `${field} is required.`;
  if (value.trim().length > 50) return `${field} is too long.`;
  if (!/^[A-Za-z\s'-]+$/.test(value)) return `${field} can only contain letters, spaces, hyphens, and apostrophes.`;
  return null;
}

function validateMobileFormat(mobileNumber) {
  // PH mobile format: 09XXXXXXXXX (11 digits starting with 09)
  const mobileRegex = /^09\d{9}$/;
  if (!mobileRegex.test(mobileNumber)) return "Invalid mobile number format.";
  return null;
}

function validateEmailFormat(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return "Invalid email format.";
  return null;
}

function validateEmailLength(email) {
  if (email.length > 254) return "Email is too long.";
  return null;
}

function validatePasswordLength(password) {
  // Upper cap prevents bcrypt DoS via oversized inputs
  if (password.length > 128) return "Password is too long.";
  return null;
}

function validatePasswordPolicy(password) {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password is too long.";
  if (!/(?=.*[a-z])/.test(password)) return "Password must contain at least one lowercase letter.";
  if (!/(?=.*[A-Z])/.test(password)) return "Password must contain at least one uppercase letter.";
  if (!/(?=.*\d)/.test(password)) return "Password must contain at least one number.";
  if (!/(?=.*[^A-Za-z0-9])/.test(password)) return "Password must contain at least one special character.";
  return null;
}

// ---------------------------------------------------------------------------
// Driver & Vehicle Specific Fields
// ---------------------------------------------------------------------------

function validateMpinFormat(mpin) {
  if (!/^\d{4}$/.test(mpin)) return "MPIN must be exactly 4 digits.";
  return null;
}

function validateUrl(value, field) {
  if (!value || typeof value !== "string" || !value.startsWith("https://")) {
    return `${field} must be a valid Cloudinary URL.`;
  }
  return null;
}

function validateLicenseNumber(value) {
  if (!value || !value.trim()) return "License number is required.";
  if (value.trim().length > 20) return "License number is too long.";
  return null;
}

function validatePlateNumber(value) {
  if (!value || !value.trim()) return "Plate number is required.";
  if (value.trim().length > 10) return "Plate number is too long.";
  return null;
}

function validateMotorcycleBrand(value) {
  if (!value || !value.trim()) return "Motorcycle brand is required.";
  if (value.trim().length > 50) return "Motorcycle brand is too long.";
  return null;
}

function validateLicenseExpDate(value) {
  const date = new Date(value);
  if (isNaN(date.getTime())) return "Invalid license expiration date.";
  if (date < new Date()) return "License expiration date must be in the future.";
  return null;
}

// ---------------------------------------------------------------------------
// Admin & Settings Fields
// ---------------------------------------------------------------------------

function validateFareValue(value, fieldName) {
  if (value === undefined || value === null) return `${fieldName} is required.`;
  const num = Number(value);
  if (isNaN(num) || num < 0) return `${fieldName} must be a positive number.`;
  return null;
}

module.exports = {
  validateName,
  validateMobileFormat,
  validateEmailFormat,
  validateEmailLength,
  validatePasswordLength,
  validatePasswordPolicy,
  validateMpinFormat,
  validateUrl,
  validateLicenseNumber,
  validatePlateNumber,
  validateMotorcycleBrand,
  validateLicenseExpDate,
  validateFareValue
};
