const maxmind = require("maxmind");
const fs = require("fs");
const path = require("path");
const Logger = require("../utils/logger");
const { InternalServerError } = require("../errors/internalServerError");

const GEOIP_DB_PATH = process.env.GEOIP_DB_PATH || path.join(__dirname, "../../data/GeoLite2-City.mmdb");

let reader = null;

async function initializeReader() {
  try {
    if (reader) return reader;

    if (!fs.existsSync(GEOIP_DB_PATH)) {
      Logger.error(`[GeoIP] CRITICAL: DB missing at ${GEOIP_DB_PATH}`);
      throw new InternalServerError("GeoIP Database file not found");
    }

    // Load into memory and watch for binary swaps
    reader = await maxmind.open(GEOIP_DB_PATH, { watchForUpdates: true });
    
    Logger.info(`[GeoIP] MaxMind DB loaded and watching for updates: ${GEOIP_DB_PATH}`);
    return reader;
  } catch (error) {
    Logger.error(`[GeoIP] Initialization Failed`, { error: error.message });
    throw error;
  }
}

/**
 * Internal transformation logic
 */
function transform(raw) {
  if (!raw) return null;
  return {
    latitude: raw.location?.latitude,
    longitude: raw.location?.longitude,
    city_name: raw.city?.names?.en,
    country_name: raw.country?.names?.en,
    country_iso: raw.country?.iso_code,
    time_zone: raw.location?.time_zone,
  };
}

// Synchronous lookup (for high-performance loops)
function lookupSync(ip) {
  if (!reader) return null; // Or throw if you prefer strictness
  return transform(reader.get(ip));
}

// Asynchronous lookup (matches your current client usage)
async function lookup(ip) {
  if (!reader) await initializeReader();
  return transform(reader.get(ip));
}

module.exports = {
  initializeReader,
  lookup,
  lookupSync, // Now geoIpService.js will find this!
};