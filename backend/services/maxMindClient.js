const geoIpReader = require('./maxMindReader'); // Path updated
const cached = require('./cacheWrapper'); 
const InternalServerError = require('../errors/internal-server-error');
const Tracing = require('../utils/tracingClient'); 
const Metrics = require('../utils/metricsClient');
const Logger = require('../utils/logger');

const GEOIP_CACHE_TTL_SECONDS = 24 * 60 * 60; 
const GEOIP_MISS_TTL_SECONDS = 600; 

/**
 * @desc Looks up the geographical location details for a given IP address.
 */
const lookup = async (ip) => {
  return await Tracing.withSpan("MaxMindClient:lookup", async (span) => {
    span.setAttribute('network.client.ip', ip);
    
    // 1. Filter internal/local traffic
    if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.')) {
      Metrics.increment('geoip.lookup_skip', 1, { reason: 'internal_ip' });
      return null;
    }

    const cacheKey = `geoip:${ip}`;
    const timer = Date.now();
    
    try {
      // 2. Cache Layer
      const cachedResultString = await cached.get(cacheKey);
      
      if (cachedResultString) {
        if (cachedResultString === 'null') {
          Metrics.cacheHit('geoip', { type: 'miss' });
          return null;
        }

        Metrics.cacheHit('geoip', { type: 'success' });
        const result = JSON.parse(cachedResultString);
        
        span.setAttributes({
          'geo.city': result?.city,
          'geo.country': result?.country,
          'cache.hit': true
        });
        
        Metrics.timing('geoip.lookup_duration', Date.now() - timer, { type: 'cache_success' });
        return result; 
      }

      // 3. Reader Layer (Now properly awaited and async)
      span.setAttribute('cache.hit', false);
      const rawResult = await geoIpReader.lookup(ip);

      if (!rawResult || !rawResult.latitude) {
        Logger.debug(`GEOIP_LOOKUP_MISS`, { ip });
        await cached.set(cacheKey, 'null', GEOIP_MISS_TTL_SECONDS); 
        Metrics.increment('geoip.lookup_miss', 1, { reason: 'not_found' });
        return null; 
      }

      // 4. Data Normalization
      const result = {
        lat: rawResult.latitude,
        lon: rawResult.longitude,
        city: rawResult.city_name || 'Unknown City',
        country: rawResult.country_name || 'Unknown Country',
        timezone: rawResult.time_zone || 'UTC',
      };

      span.setAttributes({
        'geo.city': result.city,
        'geo.country': result.country,
        'geo.lat': result.lat,
        'geo.lon': result.lon,
      });

      // 5. Persist and Report
      await cached.set(cacheKey, JSON.stringify(result), GEOIP_CACHE_TTL_SECONDS);
      Metrics.increment('geoip.lookup_success');
      Metrics.timing('geoip.lookup_duration', Date.now() - timer, { type: 'db_success' });

      return result;

    } catch (error) {
      Logger.error(`GEOIP_CLIENT_FAIL`, { ip, error: error.message });
      span.recordException(error);
      span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: error.message });
      Metrics.increment('geoip.client_error');
      
      // Fail open: Identity and Payments shouldn't break because of a GeoIP miss
      return null; 
    }
  });
};

module.exports = { lookup };