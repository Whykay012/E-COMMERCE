// services/geoip/policies.js
// Simple policy helpers / admin-managed list (store/serve from DB for admin UI)

const BLOCKED_COUNTRIES = (process.env.RISK_BLOCK_COUNTRIES || "KP,IR,CU")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

const CHALLENGE_COUNTRIES = (process.env.RISK_CHALLENGE_COUNTRIES || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

function countryStatus(iso) {
  if (!iso) return { status: "unknown" };
  const code = iso.toUpperCase();
  if (BLOCKED_COUNTRIES.includes(code)) return { status: "blocked", code };
  if (CHALLENGE_COUNTRIES.includes(code)) return { status: "challenge", code };
  return { status: "allowed", code };
}

module.exports = { BLOCKED_COUNTRIES, CHALLENGE_COUNTRIES, countryStatus };
