/**
 * model/userModel.js
 * ZENITH APEX - Extreme-Reliability Identity Schema
 * Sync: isActive, isDeleted, securityVersion, and WebAuthn.
 */

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// ---------------------------------------------------------------------
// --- 1. SPECIAL PASSWORD HASHING UTILITY (PBKDF2) ---
// ---------------------------------------------------------------------

function deriveSpecialPasswordHash(password, salt) {
  const iterations = 310000;
  const keylen = 64;
  const digest = "sha512";
  return crypto
    .pbkdf2Sync(password, salt, iterations, keylen, digest)
    .toString("hex");
}

function generateSpecialPasswordSalt() {
  return crypto.randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------
// --- 2. SUB-SCHEMAS ---
// ---------------------------------------------------------------------

/**
 * 🛡️ SECURITY AUDIT SCHEMA
 */
const SecurityAuditSchema = new mongoose.Schema(
  {
    event: { type: String, required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reason: { type: String },
    ts: { type: Date, default: Date.now },
    ip: { type: String },
  },
  { _id: false }
);

/**
 * 🔑 WEBAUTHN CREDENTIAL SCHEMA
 */
const WebAuthnCredentialSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    publicKey: { type: Buffer, required: true },
    counter: { type: Number, default: 0 },
    transports: [{ type: String }],
    deviceName: { type: String, default: "Security Key" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * 💸 PAYOUT INFO SCHEMA
 */
const PayoutInfoSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ["Stripe", "Paystack", "Flutterwave", "Manual", null],
      default: null,
    },
    recipientId: {
      type: String,
      default: null,
      index: { unique: true, sparse: true },
    },
    bankName: { type: String, trim: true },
    accountRefId: { type: String, default: null },
    accountNumber: {
      type: String,
      select: false,
      default: null,
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      match: /^[A-Z]{3}$/,
      default: "USD",
    },
    lastUpdated: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ---------------------------------------------------------------------
// --- 3. MAIN USER SCHEMA ---
// ---------------------------------------------------------------------

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 50 },
    middleName: { type: String, trim: true, default: "", maxlength: 50 },
    lastName: { type: String, required: true, trim: true, maxlength: 50 },

    username: {
      type: String,
      required: [true, "Username is required"],
      unique: true,
      minlength: 3,
      maxlength: 30,
      lowercase: true,
      trim: true,
      index: true,
      match: [
        /^[a-zA-Z0-9_]+$/,
        "Username can only contain letters, numbers, and underscores",
      ],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: [/.+@.+\..+/, "Invalid email address"],
    },

    phone: {
      type: String,
      required: [true, "Phone number is required"],
      unique: true,
      match: [/^\+?\d{7,15}$/, "Phone number must be 7-15 digits"],
      trim: true,
    },

    profilePic: { type: String, default: "" },

    // --- Authentication & Security (Main) ---
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [12, "Password must be at least 12 characters long"],
      select: false,
      validate: {
        validator: (value) =>
          /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&.,])[A-Za-z\d@$!%*?&.,]{12,}$/.test(
            value
          ),
        message: "Password too weak.",
      },
    },

    // --- 🛡️ ZENITH GLOBAL PANIC PROTECTION (Synchronized) ---
    securityVersion: {
      type: Number,
      default: 0,
      select: false,
    },
    passwordChangedAt: { type: Date },
    securityAudit: [SecurityAuditSchema],

    // ⭐ Master Booleans for Admin Orchestration
    isActive: { type: Boolean, default: true, index: true },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date },

    // --- 🛡️ ZENITH WEBAUTHN STORAGE ---
    webAuthnEnabled: { type: Boolean, default: false, index: true },
    credentials: [WebAuthnCredentialSchema],
    lastWebAuthnVerification: { type: Number, default: 0 },

    // --- Step-Up Security ---
    specialPasswordHash: { type: String, select: false, default: null },
    specialPasswordSalt: { type: String, select: false, default: null },

    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },

    otp: { type: String, select: false },
    otpExpiry: { type: Date, select: false },

    twoFactor: {
      enabled: { type: Boolean, default: false },
      secret: { type: String, select: false },
    },

    isVerified: { type: Boolean, default: false, index: true },

    // --- Financial & Wallet ---
    walletBalance: { type: Number, default: 0.0, min: 0, required: true },
    lifetimeRevenue: { type: Number, default: 0.0, min: 0, required: true },

    payoutInfo: {
      type: PayoutInfoSchema,
      default: () => ({}),
    },

    dob: { type: Date, required: [true, "Date of Birth is required"] },
    age: { type: Number, required: true, min: 13, max: 120 },
    address: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    country: { type: String, required: true, trim: true },

    lastIp: { type: String, default: null },
    lastUserAgent: { type: String, default: null },

    role: {
      type: String,
      enum: ["user", "admin", "moderator", "support", "auditor"],
      default: "user",
      index: true,
    },
    referralCode: { type: String, index: true },
  },
  {
    timestamps: true,
    strict: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.password;
        delete ret.specialPasswordHash;
        delete ret.specialPasswordSalt;
        delete ret.securityVersion;
        delete ret.otp;
        delete ret.twoFactor?.secret;
        if (ret.credentials) ret.credentials.forEach((c) => delete c.publicKey);
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------
// --- 4. INDEXING FOR HYPERSCALE ---
// ---------------------------------------------------------------------

// ⭐ COMPOSITE SECURITY INDEX
// Allows Middleware to verify user availability in one O(1) index scan.
userSchema.index({ _id: 1, securityVersion: 1, isActive: 1, isDeleted: 1 });

// ---------------------------------------------------------------------
// --- 5. MIDDLEWARE & METHODS ---
// ---------------------------------------------------------------------

userSchema.pre("save", async function (next) {
  if (this.isModified("password")) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    this.passwordChangedAt = Date.now() - 1000;
  }
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  const userWithPassword = await this.model("User")
    .findById(this._id)
    .select("+password");
  return userWithPassword
    ? bcrypt.compare(candidatePassword, userWithPassword.password)
    : false;
};

userSchema.methods.verifySpecialPassword = function (plaintextPassword) {
  if (!this.specialPasswordHash || !this.specialPasswordSalt) return false;
  const submittedHash = deriveSpecialPasswordHash(
    plaintextPassword,
    this.specialPasswordSalt
  );
  return crypto.timingSafeEqual(
    Buffer.from(this.specialPasswordHash, "hex"),
    Buffer.from(submittedHash, "hex")
  );
};
userSchema.statics.findByRawToken = function(rawToken) {
  const hashedToken = hashToken(rawToken);
  return this.findOne({ verificationToken: hashedToken });
};

userSchema.methods.setSpecialPassword = function (plaintextPassword) {
  this.specialPasswordSalt = generateSpecialPasswordSalt();
  this.specialPasswordHash = deriveSpecialPasswordHash(
    plaintextPassword,
    this.specialPasswordSalt
  );
};

module.exports = mongoose.model("User", userSchema);
