const axios = require('axios');
const fs = require('fs');
const zlib = require('zlib');
const tar = require('tar');
const path = require('path');
const Logger = require('../utils/logger');

const MAXMIND_LICENSE_KEY = process.env.MAXMIND_LICENSE_KEY;
const DB_DESTINATION = path.join(__dirname, '../data/GeoLite2-City.mmdb');

async function downloadGeoDb() {
  if (!MAXMIND_LICENSE_KEY) {
    Logger.error("MAXMIND_LICENSE_KEY is missing. Skipping update.");
    return;
  }

  // MaxMind Download URL for the City Database
  const url = `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz`;

  Logger.info("Updating GeoIP Database...");

  try {
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
    });

    // MaxMind packages files inside a folder in the tarball
    // This pipeline extracts the .mmdb file specifically
    response.data
      .pipe(zlib.createGunzip())
      .pipe(tar.t())
      .on('entry', (entry) => {
        if (entry.path.endsWith('.mmdb')) {
          entry.pipe(fs.createWriteStream(DB_DESTINATION));
          Logger.info("GeoIP Database updated successfully.");
        }
      });
  } catch (error) {
    Logger.error("Failed to update GeoIP Database", { error: error.message });
  }
}

module.exports = downloadGeoDb;