const mongoose = require("mongoose");

const discountApplicationSchema = new mongoose.Schema(
  {
    passengerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    discountType: {
      type: String,
      enum: ["Student", "Senior Citizen", "PWD"],
      required: true,
    },
    fullName: {
      type: String,
      required: true,
    },
    mobileNumber: {
      type: String,
      required: true,
    },
    dob: {
      type: String,
      required: true,
    },
    idType: {
      type: String,
      required: true,
    },
    idNumber: {
      type: String,
      required: true,
    },
    expirationDate: {
      type: String,
      default: "",
    },
    imageUri: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    rejectionReason: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

discountApplicationSchema.index({ passengerId: 1 });
discountApplicationSchema.index({ status: 1 });

module.exports = mongoose.model("DiscountApplication", discountApplicationSchema);
