// services/maxMindClient.js (ENTERPRISE-GRADE GEOIP SERVICE CLIENT)

// 💡 Dependency: Assumed MaxMind GeoIP reader library or an HTTP client for a GeoIP API
const geoIpReader = require('./maxMindReader'); 
// Using the robust cache utility that exports the get/set functions
const cached = require('./cacheWrapper'); 
const InternalServerError = require('../errors/internal-server-error');

// 🚀 TELEMETRY UTILITIES INTEGRATION
// We assume this file exports the tracing utility and its constants
const Tracing = require('../utils/tracingClient'); 
const Metrics = require('../utils/metricsClient'); // StatsD Client
const Logger = require('../utils/logger'); // Pino Logger

// --- Configuration ---
// Cache Time-To-Live for successful lookups (24 hours)
const GEOIP_CACHE_TTL_SECONDS = 24 * 60 * 60; 
// Cache Time-To-Live for failed/null lookups (to prevent Cache Penetration)
const GEOIP_MISS_TTL_SECONDS = 600; // 10 minutes

/**
* @typedef {object} GeoIPResult
* @property {number} lat - Latitude.
* @property {number} lon - Longitude.
* @property {string} city - City name.
* @property {string} country - Country name.
* @property {string} timezone - Timezone string.
*/

// -----------------------------------------------------------
// 🔍 Core Lookup Function
// -----------------------------------------------------------

/**
* @desc Looks up the geographical location details for a given IP address.
* Uses a Redis cache layer for performance and to reduce external API/DB calls.
* @param {string} ip - The client IP address.
* @returns {Promise<GeoIPResult | null>} Location data or null on failure/miss.
*/
const lookup = async (ip) => {
  // Use Tracing.withSpan to wrap the entire function and capture context 
  return Tracing.withSpan("MaxMindClient:lookup", async (span) => {
    span.setAttribute('network.client.ip', ip);
    
    if (!ip || ip === '::1' || ip === '127.0.0.1') {
      Logger.info('GEOIP_SKIP_INTERNAL', { ip });
      Metrics.increment('geoip.lookup_skip', 1, { reason: 'internal_ip' }); // 💡 UPGRADE: Track internal skips
      return null; // Skip non-routable/internal IPs
    }

    const cacheKey = `geoip:${ip}`;
    
    try {
      const timer = new Date();
      
      // 1. Check Cache
      const cachedResultString = await cached.get(cacheKey);
      
      if (cachedResultString) {
        // 💡 UPGRADE: Explicitly handle the cached 'null' value for misses
        if (cachedResultString === 'null') {
          Metrics.cacheHit('geoip', { type: 'miss' }); // 💡 UPGRADE: Tag cache hit type
          span.setAttribute('cache.hit', 'miss_cached');
          Metrics.timing('geoip.lookup_duration', new Date() - timer, { type: 'cache_miss' });
          return null;
        }

        // If we reach here, it's a successful cached result
        Metrics.cacheHit('geoip', { type: 'success' });
        span.setAttribute('cache.hit', 'success');
        
        // The result is stored as a JSON string
        const result = JSON.parse(cachedResultString);
        
        // Add city/country to the span for context enrichment
        span.setAttributes({
          'geo.city': result?.city,
          'geo.country': result?.country,
        });
        
        Metrics.timing('geoip.lookup_duration', new Date() - timer, { type: 'cache_success' });
        
        return result; 
      }

      // --- Cache Miss: Proceed to Compute ---

      Metrics.cacheMiss('geoip');
      span.setAttribute('cache.hit', 'false');
      
      // 2. Perform External/Database Lookup (Expected to be async)
      const rawResult = await geoIpReader.lookup(ip);

      if (!rawResult || !Number.isFinite(rawResult.latitude) || !Number.isFinite(rawResult.longitude)) {
        // Handle GeoIP Lookup Miss or Invalid Data
        Logger.warn(`GEOIP_LOOKUP_MISS`, { ip, reason: 'No data or invalid coordinates' });
        
        // Cache the null result briefly to prevent repeated re-computation (Cache Penetration)
        // Store as the string 'null'
        await cached.set(cacheKey, 'null', GEOIP_MISS_TTL_SECONDS); 
        Metrics.increment('geoip.lookup_miss', 1, { reason: 'data_fail' });
        
        Metrics.timing('geoip.lookup_duration', new Date() - timer, { type: 'miss_fail' });
        return null; 
      }

      // 3. Normalize Result
      const result = {
        lat: rawResult.latitude,
        lon: rawResult.longitude,
        city: rawResult.city_name || 'Unknown City',
        country: rawResult.country_name || 'Unknown Country',
        timezone: rawResult.time_zone || 'UTC',
      };

      // Add geo context to the span
      span.setAttributes({
        'geo.city': result.city,
        'geo.country': result.country,
        'geo.lat': result.lat,
        'geo.lon': result.lon,
      });

      // 4. Store in Cache (as JSON string)
      await cached.set(cacheKey, JSON.stringify(result), GEOIP_CACHE_TTL_SECONDS);
      Metrics.increment('geoip.lookup_success');
      Metrics.timing('geoip.lookup_duration', new Date() - timer, { type: 'success' });

      return result;

    } catch (error) {
      // Log a non-critical error about the GeoIP service failure
      Logger.error(`GEOIP_CLIENT_FAIL`, { ip, error: error.message, err: error });
      span.recordException(error);
      // 💡 UPGRADE: Use the SpanStatusCode constant from the imported Tracing client
      span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: error.message });
      Metrics.increment('geoip.client_error');
      
      // IMPORTANT: Fail open and return null to avoid blocking the primary flow
      return null; 
    }
  });
};

module.exports = {
  lookup,
};