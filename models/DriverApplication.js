const mongoose = require("mongoose");

// ---------------------------------------------------------------------------
// DriverApplication schema
// Holds submitted driver registration data pending admin review.
// On approval, the backend creates a User document from this and deletes it.
// All image fields store Cloudinary public URLs.
// ---------------------------------------------------------------------------
const driverApplicationSchema = new mongoose.Schema(
  {
    // --- Personal info ---
    firstName:    { type: String, required: true, trim: true },
    lastName:     { type: String, required: true, trim: true },
    mobileNumber: { type: String, required: true },

    // --- Driving license ---
    licenseImgFront: { type: String, required: true },
    licenseImgBack:  { type: String, required: true },
    licenseNumber:   { type: String, required: true },
    licenseExpDate:  { type: Date,   required: true },

    // --- Face verification ---
    faceImg: { type: String, required: true },
    idImg:   { type: String, required: true },

    // --- Vehicle registration ---
    tricycleOR:  { type: String, required: true },
    regCert:     { type: String, required: true },

    // --- Tricycle details ---
    tricycleImgFront: { type: String, required: true },
    tricycleImgBack:  { type: String, required: true },
    motorcycleBrand:  { type: String, required: true },
    plateNumber:      { type: String, required: true },

    // --- Credentials ---
    // Password is hashed before storage (see pre-save hook below)
    password: { type: String, required: true },
    // mpin is optional — hashed before storage if provided
    mpin:     { type: String, default: null },

    // --- Application status ---
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },

    // Optional rejection reason set by admin
    rejectionReason: { type: String, default: null },

    // Cloudinary public IDs for all uploaded images.
    // Stored so we can delete them from Cloudinary if the application
    // is rejected or cleaned up.
    cloudinaryPublicIds: {
      licenseImgFront:  { type: String, default: null },
      licenseImgBack:   { type: String, default: null },
      faceImg:          { type: String, default: null },
      idImg:            { type: String, default: null },
      tricycleOR:       { type: String, default: null },
      regCert:          { type: String, default: null },
      tricycleImgFront: { type: String, default: null },
      tricycleImgBack:  { type: String, default: null },
    },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------
driverApplicationSchema.index({ mobileNumber: 1 });
driverApplicationSchema.index({ status: 1 });
driverApplicationSchema.index({ "licenseNumber": 1 }, { sparse: true });

// ---------------------------------------------------------------------------
// Pre-save: hash password
// ---------------------------------------------------------------------------
const bcrypt = require("bcrypt");
const SALT_ROUNDS = 12;

driverApplicationSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
});

// ---------------------------------------------------------------------------
// Pre-save: hash mpin if provided
// ---------------------------------------------------------------------------
driverApplicationSchema.pre("save", async function () {
  if (!this.mpin) return;
  if (!this.isModified("mpin")) return;
  this.mpin = await bcrypt.hash(this.mpin, SALT_ROUNDS);
});

module.exports = mongoose.model("DriverApplication", driverApplicationSchema);