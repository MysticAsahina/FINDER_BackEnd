const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const SALT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// driverDetails sub-schema
// All image fields store Cloudinary URLs as strings.
// ---------------------------------------------------------------------------
const driverDetailsSchema = new mongoose.Schema(
  {
    licenseImgFront:  { type: String, required: true },
    licenseImgBack:   { type: String, required: true },
    licenseNumber:    { type: String, required: true },
    licenseExpDate:   { type: Date,   required: true },
    faceImg:          { type: String, required: true },
    idImg:            { type: String, required: true },
    tricycleOR:       { type: String, required: true },
    regCert:          { type: String, required: true },
    tricycleImgFront: { type: String, required: true },
    tricycleImgBack:  { type: String, required: true },
    motorcycleBrand:  { type: String, required: true },
    plateNumber:      { type: String, required: true },
    mpin:             { type: String, default: null }, // optional; hashed on save
    ratingSum:        { type: Number, default: 0 },
    totalReviews:     { type: Number, default: 0 },
    averageRating:    { type: Number, default: 5.0 },
  },
  { _id: false } // no separate _id for the subdocument
);

// ---------------------------------------------------------------------------
// Main User schema
// ---------------------------------------------------------------------------
const userSchema = new mongoose.Schema(
  {
    // --- Common fields (all roles) ---
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      // Required only for admin — enforced in the pre-save hook below.
      // Intentionally no default — field must be absent (not null) on
      // passenger/driver documents so the sparse unique index skips them.
    },
    mobileNumber: {
      type: String,
      required: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ["admin", "passenger", "driver"],
      required: true,
    },

    // --- Driver-only fields ---
    // Null/absent for admin and passenger; enforced by pre-save hook.
    driverDetails: {
      type: driverDetailsSchema,
      default: null,
    },
    
    // --- Passenger-only fields ---
    isDiscountVerified: {
      type: Boolean,
      default: false,
    },
    discountType: {
      type: String,
      default: null,
    },
    discountIdNumber: {
      type: String,
      default: null,
    },
    discountExpiration: {
      type: String,
      default: null,
    },

    pushTokens: {
      type: [String],
      default: [],
    },

    refreshToken: {
      type: String,
      default: null,
    },
    
    tokenVersion: {
      type: Number,
      default: 0,
    },

    // --- Emergency Contact (optional for all users) ---
    emergencyContact: {
      type: {
        firstName: { type: String, required: true },
        lastName: { type: String, required: true },
        mobileNumber: { type: String, required: true },
      },
      default: null,
    },
    
    // --- Flagging / Restriction fields ---
    isFlagged: {
      type: Boolean,
      default: false,
    },
    flagReason: {
      type: String,
      default: null,
    },
    flaggedAt: {
      type: Date,
      default: null,
    },
    warningCount: {
      type: Number,
      default: 0,
    },
    restrictionEndDate: {
      type: Date,
      default: null,
    },
    strikes: [{
      type: { type: String, enum: ['frequent_cancellation', 'unresponsive_passenger', 'unresponsive_driver'] },
      rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride' },
      createdAt: { type: Date, default: Date.now }
    }],
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------
userSchema.index({ email: 1 },                              { unique: true, sparse: true });
userSchema.index({ mobileNumber: 1 },                       { unique: true });
userSchema.index({ "driverDetails.licenseNumber": 1 },      { unique: true, sparse: true });
userSchema.index({ "driverDetails.plateNumber": 1 },        { unique: true, sparse: true });

// ---------------------------------------------------------------------------
// Pre-save: role-based field validation
// ---------------------------------------------------------------------------
userSchema.pre("save", async function () {
  // Admin must have an email
  if (this.role === "admin" && !this.email) {
    throw new Error("Admin accounts require an email address.");
  }

  // Driver must supply driverDetails
  if (this.role === "driver" && !this.driverDetails) {
    throw new Error("Driver accounts require driverDetails.");
  }

  // Non-drivers cannot carry driverDetails
  if (this.role !== "driver" && this.driverDetails) {
    this.driverDetails = null;
  }

  // Non-passengers cannot carry discount verification
  if (this.role !== "passenger") {
    this.isDiscountVerified = false;
    this.discountType = null;
    this.discountIdNumber = null;
    this.discountExpiration = null;
  }
});

// ---------------------------------------------------------------------------
// Pre-save: hash password
// ---------------------------------------------------------------------------
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
});

// ---------------------------------------------------------------------------
// Pre-save: hash mpin (driver only, optional)
// ---------------------------------------------------------------------------
userSchema.pre("save", async function () {
  if (!this.driverDetails?.mpin) return;
  if (!this.isModified("driverDetails.mpin")) return;
  this.driverDetails.mpin = await bcrypt.hash(this.driverDetails.mpin, SALT_ROUNDS);
});

// ---------------------------------------------------------------------------
// Instance methods
// ---------------------------------------------------------------------------

// Compare a plaintext password against the stored hash
userSchema.methods.comparePassword = function (plaintext) {
  return bcrypt.compare(plaintext, this.password);
};

// Compare a plaintext mpin against the stored hash (drivers only)
userSchema.methods.compareMpin = function (plaintext) {
  if (!this.driverDetails?.mpin) return Promise.resolve(false);
  return bcrypt.compare(plaintext, this.driverDetails.mpin);
};

// ---------------------------------------------------------------------------
// toJSON: strip sensitive fields before sending to client
// ---------------------------------------------------------------------------
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  if (obj.driverDetails?.mpin) {
    delete obj.driverDetails.mpin;
  }
  return obj;
};

module.exports = mongoose.model("User", userSchema);