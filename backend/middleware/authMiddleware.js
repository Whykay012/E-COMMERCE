/**
 * middleware/authMiddleware.js
 * ZENITH APEX - High-Performance Security Enforcement Fabric
 * Logic: Redis JTI Lookup, DB Versioning, and Active/Deleted status checks.
 */

const jwt = require("jsonwebtoken");
const User = require("../model/userModel");
const UnauthenticatedError = require("../errors/unauthenication-error");
const UnauthorizedError = require("../errors/unauthorized");
const NotFoundError = require("../errors/notFoundError");
const AuditLogger = require("../services/auditLogger");

/**
 * Zenith Apex Integration:
 * Importing the high-reliability state orchestrator.
 */
const { isTokenBlacklisted } = require("../services/tokenRevocationService");

/**
 * @desc Extracts token from multiple possible sources (Header or Cookie).
 */
const getToken = (req) => {
  const authHeader = req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.replace("Bearer ", "");
  }
  if (req.cookies?.token) return req.cookies.token;
  return null;
};

/**
 * @desc ZENITH ENFORCEMENT: The core authentication and revocation logic.
 * Orchestrates JTI verification, DB versioning, and status enforcement.
 */
const authenticate = async (req, res, next) => {
  const token = getToken(req);
  if (!token) {
    throw new UnauthenticatedError(
      "Authentication token missing. Please log in."
    );
  }

  try {
    // --- 1. Verify JWT Structure and Signature ---
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const {
      userID,
      iat,
      jti,
      version: tokenVersion,
      csrf: tokenCsrf,
    } = decoded;

    /**
     * --- 2. ZENITH APEX JTI CHECK ---
     * High-speed O(1) lookup in the Redis Deny-List.
     */
    const isRevoked = await isTokenBlacklisted(jti);
    if (isRevoked) {
      await AuditLogger.log({
        level: "SECURITY",
        event: "JTI_BLACKLIST_HIT",
        userId: userID,
        details: { jti, ip: req.ip },
      });
      throw new UnauthenticatedError("Session revoked. Please log in again.");
    }

    // --- 3. CSRF Validation (Double Submit Cookie Pattern) ---
    const providedCsrf = req.header("X-CSRF-Token");
    if (tokenCsrf && providedCsrf && tokenCsrf !== providedCsrf) {
      throw new UnauthorizedError("CSRF verification failed.");
    }

    // --- 4. Optimized Fetch (Leveraging Security Compound Index) ---
    // Selects core security fields: isActive, isDeleted, and securityVersion.
    const user = await User.findOne({ _id: userID }).select(
      "+passwordChangedAt +securityVersion isActive isDeleted role email firstName lastName"
    );

    if (!user) throw new NotFoundError("User not found.");

    /**
     * ⭐ ZENITH APEX: STATUS ENFORCEMENT
     * Ensures deleted or inactive users are rejected immediately.
     */
    if (user.isDeleted) {
      throw new UnauthenticatedError("This account no longer exists.");
    }

    if (!user.isActive) {
      throw new UnauthorizedError(
        "Account has been administratively disabled or banned."
      );
    }

    /**
     * ⭐ ZENITH ENFORCEMENT: GLOBAL PANIC REVOCATION CHECK
     * Cross-references the stateless token version with the stateful DB version.
     */
    const currentVersion = user.securityVersion || 0;
    if (currentVersion > (tokenVersion || 0)) {
      await AuditLogger.log({
        level: "SECURITY",
        event: "GLOBAL_REVOCATION_ENFORCED",
        userId: userID,
        details: {
          tokenVersion,
          currentVersion,
          reason: "Security Version Mismatch (Admin Reset/Breach Handled)",
        },
      });
      throw new UnauthenticatedError(
        "Security reset triggered. For your safety, please log in again."
      );
    }

    // --- 5. Password Change Check (with 5s Grace for Clock Drift) ---
    if (user.passwordChangedAt) {
      const passwordChangedTimestamp = Math.floor(
        (user.passwordChangedAt.getTime() - 5000) / 1000
      );

      if (passwordChangedTimestamp > iat) {
        throw new UnauthenticatedError(
          "Security credentials recently updated. Please re-authenticate."
        );
      }
    }

    // --- 6. Attach Optimized User Context ---
    req.user = {
      userID: user._id,
      role: user.role,
      email: user.email,
      fullName: `${user.firstName} ${user.lastName}`,
      jti: jti,
      securityVersion: currentVersion,
    };

    next();
  } catch (error) {
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError"
    ) {
      await AuditLogger.log({
        level: "SECURITY",
        event: "AUTH_FAILED_JWT",
        details: { reason: error.name, message: error.message, ip: req.ip },
      });
      throw new UnauthenticatedError(
        "Your session has expired or is invalid. Please log in."
      );
    }
    next(error);
  }
};

/**
 * @desc Dynamic RBAC (Role Based Access Control)
 */
const authorizePermissions = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      throw new UnauthenticatedError("Authentication required.");
    }

    if (!allowedRoles.includes(req.user.role)) {
      AuditLogger.log({
        level: "RISK",
        event: "ACCESS_DENIED_ROLE",
        userId: req.user.userID,
        details: {
          userRole: req.user.role,
          required: allowedRoles,
          path: req.originalUrl,
        },
      });
      throw new UnauthorizedError(
        `Access denied. Insufficient permissions for role: ${req.user.role}`
      );
    }
    next();
  };
};

module.exports = { authenticate, authorizePermissions };
