// services/geoip/maxMindReader.js
const maxmind = require("maxmind");
const fs = require("fs");
const path = require("path");
const InternalServerError = require("../errors/internal-server-error");

const GEOIP_DB_PATH = process.env.GEOIP_DB_PATH || path.join(__dirname, "..", "data", "GeoLite2-City.mmdb");

let reader = null;

function initializeReader() {
  if (reader) return;
  if (!fs.existsSync(GEOIP_DB_PATH)) {
    console.error(`[GeoIP] CRITICAL: DB missing at ${GEOIP_DB_PATH}`);
    throw new InternalServerError("GeoIP DB missing");
  }
  reader = maxmind.openSync(GEOIP_DB_PATH);
  console.log(`[GeoIP] MaxMind DB loaded: ${GEOIP_DB_PATH}`);
}

// Initialize immediately to fail-fast in boot
initializeReader();

function lookupSync(ip) {
  if (!reader) throw new InternalServerError("GeoIP Reader not initialized");
  // maxmind returns undefined for local/private addresses
  const raw = reader.get(ip);
  if (!raw) return null;
  const location = raw.location || {};
  const city = raw.city || {};
  const country = raw.country || {};
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    city_name: city.names ? city.names.en : undefined,
    country_name: country.names ? country.names.en : undefined,
    country_iso: country.iso_code || undefined,
    time_zone: location.time_zone,
  };
}

module.exports = {
  initializeReader,
  lookupSync,
};
