const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../database');

const router = express.Router();

const FIRMWARE_DIR = process.env.FIRMWARE_DIR || path.join(__dirname, '..', 'firmware');

if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
}

router.get('/version/:platform', (req, res) => {
  try {
    const { platform } = req.params;
    const firmware = db.getLatestFirmware(platform);

    if (!firmware) {
      return res.status(404).json({
        success: false,
        message: `No firmware found for platform: ${platform}`
      });
    }

    const baseUrl = process.env.OTA_BASE_URL || `http://${req.headers.host}`;
    res.json({
      success: true,
      version: firmware.version,
      url: `${baseUrl}/api/ota/firmware/${firmware.version}?platform=${platform}`,
      checksum: firmware.checksum,
      size: firmware.size,
      platform: firmware.platform
    });
  } catch (error) {
    console.error('[OTA] Error getting version:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

router.get('/firmware/:version', (req, res) => {
  try {
    const { version } = req.params;
    const { platform } = req.query;

    const firmware = db.getLatestFirmware(platform || 'esp32c3');

    if (!firmware || firmware.version !== version) {
      return res.status(404).json({
        success: false,
        message: 'Firmware not found'
      });
    }

    const firmwarePath = path.join(FIRMWARE_DIR, firmware.filename);

    if (!fs.existsSync(firmwarePath)) {
      console.error('[OTA] Firmware file not found:', firmwarePath);
      return res.status(404).json({
        success: false,
        message: 'Firmware file not found'
      });
    }

    const stat = fs.statSync(firmwarePath);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${firmware.filename}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('x-firmware-version', firmware.version);
    res.setHeader('x-firmware-checksum', firmware.checksum);

    const fileStream = fs.createReadStream(firmwarePath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('[OTA] Stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Stream error' });
      }
    });
  } catch (error) {
    console.error('[OTA] Error serving firmware:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }
});

router.post('/upload', (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const { file } = req.files;
    const { version, platform } = req.body;

    if (!version || !platform) {
      return res.status(400).json({
        success: false,
        message: 'Missing version or platform parameter'
      });
    }

    const existingFirmware = db.getLatestFirmware(platform);
    if (existingFirmware) {
      const existingVersion = existingFirmware.version.split('.').map(Number);
      const newVersion = version.split('.').map(Number);

      let shouldReject = false;
      for (let i = 0; i < 3; i++) {
        if (newVersion[i] < existingVersion[i]) {
          shouldReject = true;
          break;
        }
        if (newVersion[i] > existingVersion[i]) {
          shouldReject = false;
          break;
        }
        shouldReject = (i === 2);
      }

      if (shouldReject) {
        return res.status(400).json({
          success: false,
          message: `Version ${version} must be greater than current version ${existingFirmware.version}`
        });
      }
    }

    const filename = `firmware_${platform}_v${version}.bin`;
    const filePath = path.join(FIRMWARE_DIR, filename);

    file.mv(filePath, (err) => {
      if (err) {
        console.error('[OTA] File save error:', err);
        return res.status(500).json({
          success: false,
          message: 'Failed to save firmware file'
        });
      }

      const checksum = crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');

      db.insertFirmware({
        version,
        platform,
        filename,
        size: file.size,
        checksum
      });

      console.log(`[OTA] Firmware uploaded: ${filename} (${file.size} bytes, MD5: ${checksum})`);

      res.json({
        success: true,
        message: 'Firmware uploaded successfully',
        data: {
          version,
          platform,
          filename,
          size: file.size,
          checksum
        }
      });
    });
  } catch (error) {
    console.error('[OTA] Upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

router.get('/list', (req, res) => {
  try {
    const firmwareList = db.getFirmwareList();
    res.json({
      success: true,
      data: firmwareList
    });
  } catch (error) {
    console.error('[OTA] List error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

router.delete('/:version', (req, res) => {
  try {
    const { version } = req.params;
    const { platform } = req.query;

    const firmware = db.getLatestFirmware(platform || 'esp32c3');
    if (!firmware || firmware.version !== version) {
      return res.status(404).json({
        success: false,
        message: 'Firmware not found'
      });
    }

    const filePath = path.join(FIRMWARE_DIR, firmware.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    db.deleteFirmware(version, platform || 'esp32c3');

    res.json({
      success: true,
      message: 'Firmware deleted successfully'
    });
  } catch (error) {
    console.error('[OTA] Delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

module.exports = router;
