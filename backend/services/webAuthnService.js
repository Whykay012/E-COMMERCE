/**
 * @file WebAuthnSecurityService.js
 * @description Zenith Enterprise - Unified FIDO2/WebAuthn HA Identity Service
 * @version 4.0.0 (High-Assurance & Atomic)
 */

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

const { getRedisClient } = require("../event/lib/redisCacheClient");
const User = require("../models/user.model");
const Logger = require("../utils/logger");
const Tracing = require("../utils/tracingClient");
const {
  BadRequestError,
  UnauthorizedError,
} = require("../errors/customErrors");

// Configuration: Domain & Security Hardware Policy
const RP_ID = process.env.WEBAUTHN_RP_ID || "auth.enterprise.com";
const RP_NAME = "Zenith Enterprise Identity";
const ORIGINS = (
  process.env.WEBAUTHN_ORIGINS || "https://auth.enterprise.com"
).split(",");
const CHALLENGE_TTL = 300; // 5-minute security window for hardware response

class WebAuthnSecurityService {
  /**
   * Internal helper for Redis key isolation in a Shared Cluster
   */
  #getChallengeKey(userId) {
    return `auth:webauthn:challenge:${userId}`;
  }

  /* ───────────────────────────────────────────────────────────
     1. REGISTRATION: PROVISIONING NEW HARDWARE KEYS
  ───────────────────────────────────────────────────────────── */

  /**
   * @desc Prepares the challenge for a new Passkey or Security Key.
   */
  async getRegistrationOptions(userId, userName, existingCredentials = []) {
    return Tracing.withSpan("WebAuthn.getRegistrationOptions", async (span) => {
      span.setAttributes({ userId, action: "PROVISION_KEY", rpId: RP_ID });

      const options = await generateRegistrationOptions({
        rpID: RP_ID,
        rpName: RP_NAME,
        userID: userId,
        userName: userName,
        attestationType: "none",
        authenticatorSelection: {
          residentKeyRequirement: "preferred", // Superior: Enables Passkey/Usernameless login
          userVerification: "required", // Superior: Forces Biometric/PIN check
          authenticatorAttachment: "platform", // Optimized for TouchID/FaceID/Windows Hello
        },
        excludeCredentials: existingCredentials.map((c) => ({
          id: Buffer.from(c.id, "base64"),
          type: "public-key",
        })),
      });

      // Atomic storage in Redis (supports HA clusters)
      await getRedisClient().set(
        this.#getChallengeKey(userId),
        options.challenge,
        "EX",
        CHALLENGE_TTL
      );

      return options;
    });
  }

  /**
   * @desc Validates the new public key and saves it to the user profile.
   */
  async finalizeRegistration(userId, response) {
    return Tracing.withSpan("WebAuthn.finalizeRegistration", async (span) => {
      const redis = getRedisClient();
      const expectedChallenge = await redis.get(this.#getChallengeKey(userId));

      if (!expectedChallenge)
        throw new BadRequestError("Registration challenge expired.");

      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: ORIGINS,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      });

      if (!verification.verified) {
        Logger.security("REGISTRATION_FAILURE", {
          userId,
          reason: "Cryptographic Mismatch",
        });
        throw new UnauthorizedError("Hardware attestation failed.");
      }

      // Replay Protection: Wipe challenge immediately after use
      await redis.del(this.#getChallengeKey(userId));

      const { registrationInfo } = verification;
      return {
        id: Buffer.from(registrationInfo.credentialID).toString("base64"),
        publicKey: Buffer.from(registrationInfo.credentialPublicKey).toString(
          "base64"
        ),
        counter: registrationInfo.counter,
        transports: response.response.transports || [],
        deviceType: registrationInfo.credentialDeviceType,
        fmt: registrationInfo.fmt,
      };
    });
  }

  /* ───────────────────────────────────────────────────────────
     2. AUTHENTICATION: STEP-UP & LOGIN VERIFICATION
  ───────────────────────────────────────────────────────────── */

  /**
   * @desc Generates an assertion challenge for an existing registered key.
   */
  async getAssertionOptions(userId, userCredentials = []) {
    return Tracing.withSpan("WebAuthn.getAssertionOptions", async (span) => {
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials: userCredentials.map((cred) => ({
          id: Buffer.from(cred.id, "base64"),
          type: "public-key",
          transports: cred.transports,
        })),
        // 🛡️ CRITICAL: Change from 'preferred' to 'required'
        // This forces the browser to prompt for Biometrics/PIN.
        userVerification: "required",
      });

      await getRedisClient().set(
        this.#getChallengeKey(userId),
        options.challenge,
        "EX",
        CHALLENGE_TTL
      );
      return options;
    });
  }

  /**
   * @desc The Superior "Step-Up" Verifier.
   * Performs signature check, atomic counter increment, and session device binding.
   */
  async verifyStepUpAssertion(req, userId, assertionResponse) {
    return Tracing.withSpan("WebAuthn.verifyStepUpAssertion", async (span) => {
      // 1. Zero-Trust Projection: Fetch ONLY the matching credential from DB
      const user = await User.findOne(
        { _id: userId, "credentials.id": assertionResponse.id },
        { "credentials.$": 1 }
      ).lean();

      if (!user) throw new UnauthorizedError("Security key not recognized.");
      const dbCredential = user.credentials[0];

      // 2. Cryptographic Signature Validation
      const redis = getRedisClient();
      const expectedChallenge = await redis.get(this.#getChallengeKey(userId));

      if (!expectedChallenge)
        throw new BadRequestError("Step-up session expired.");

      const verification = await verifyAuthenticationResponse({
        response: assertionResponse,
        expectedChallenge,
        expectedOrigin: ORIGINS,
        expectedRPID: RP_ID,
        credentialPublicKey: Buffer.from(dbCredential.publicKey, "base64"),
        credentialID: Buffer.from(dbCredential.id, "base64"),
        prevCounter: dbCredential.counter,
      });

      if (!verification.verified) {
        Logger.security("MFA_VIOLATION", {
          userId,
          reason: "Invalid Signature",
        });
        throw new UnauthorizedError("Biometric signature mismatch.");
      }

      // 3. SUPERIOR ATOMICITY: Guard against Cloned Keys & Race Conditions
      // We only update if the new counter is higher than the existing one.
      const update = await User.updateOne(
        {
          _id: userId,
          "credentials.id": assertionResponse.id,
          "credentials.counter": {
            $lt: verification.authenticationInfo.newCounter,
          },
        },
        {
          $set: {
            "credentials.$.counter": verification.authenticationInfo.newCounter,
          },
          $push: {
            securityAudit: {
              event: "STEP_UP_VERIFIED",
              ts: new Date(),
              ip: req.ip,
              ua: req.headers["user-agent"],
            },
          },
        }
      );

      if (update.modifiedCount === 0) {
        Logger.critical("CLONE_DETECTED", {
          userId,
          credentialId: assertionResponse.id,
        });
        throw new UnauthorizedError(
          "Security alert: Potential hardware key duplication detected."
        );
      }

      // 4. Session Context Sealing (Superior Binding)
      await redis.del(this.#getChallengeKey(userId));

      req.session.lastWebAuthnVerification = Date.now();
      req.session.mfaContext = {
        ip: req.ip,
        ua: req.headers["user-agent"],
      };

      span.setAttribute("auth.stepup.success", true);
      return { success: true };
    });
  }
}

module.exports = new WebAuthnSecurityService();
