const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const SALT_ROUNDS = 12;

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
      default: null,
      // Required only for admin — enforced in the pre-save hook below.
      // sparse: true on the index allows multiple null values.
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
userSchema.pre("save", function (next) {
  // Admin must have an email
  if (this.role === "admin" && !this.email) {
    return next(new Error("Admin accounts require an email address."));
  }

  // Driver must supply driverDetails
  if (this.role === "driver" && !this.driverDetails) {
    return next(new Error("Driver accounts require driverDetails."));
  }

  // Non-drivers cannot carry driverDetails
  if (this.role !== "driver" && this.driverDetails) {
    this.driverDetails = null;
  }

  next();
});

// ---------------------------------------------------------------------------
// Pre-save: hash password
// ---------------------------------------------------------------------------
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
  next();
});

// ---------------------------------------------------------------------------
// Pre-save: hash mpin (driver only, optional)
// ---------------------------------------------------------------------------
userSchema.pre("save", async function (next) {
  if (!this.driverDetails?.mpin) return next();
  if (!this.isModified("driverDetails.mpin")) return next();
  this.driverDetails.mpin = await bcrypt.hash(this.driverDetails.mpin, SALT_ROUNDS);
  next();
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