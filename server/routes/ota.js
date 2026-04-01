const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../database');

const router = express.Router();

const FIRMWARE_DIR = process.env.FIRMWARE_DIR || path.join(__dirname, '..', 'firmware');
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
}

function compareSemver(versionA, versionB) {
  const partsA = versionA.split('.').map(Number);
  const partsB = versionB.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

router.get('/version/:platform', (req, res) => {
  try {
    const { platform } = req.params;
    const firmware = db.getLatestFirmware(platform);

    if (!firmware) {
      return res.status(404).json({
        success: false,
        message: `未找到平台 ${platform} 对应的固件`
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
      message: '服务器内部错误'
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
        message: '固件不存在'
      });
    }

    const firmwarePath = path.join(FIRMWARE_DIR, firmware.filename);

    if (!fs.existsSync(firmwarePath)) {
      console.error('[OTA] Firmware file not found:', firmwarePath);
      return res.status(404).json({
        success: false,
        message: '固件文件不存在'
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
        res.status(500).json({ success: false, message: '文件流读取失败' });
      }
    });
  } catch (error) {
    console.error('[OTA] Error serving firmware:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  }
});

router.post('/upload', (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({
        success: false,
        message: '未上传文件'
      });
    }

    const { file } = req.files;
    const version = String(req.body.version || '').trim();
    const platform = String(req.body.platform || '').trim();

    if (!version || !platform) {
      return res.status(400).json({
        success: false,
        message: '缺少版本号或平台参数'
      });
    }

    if (!VERSION_PATTERN.test(version)) {
      return res.status(400).json({
        success: false,
        message: '版本号格式不正确，请使用 major.minor.patch 格式'
      });
    }

    if (!file.name || !file.name.toLowerCase().endsWith('.bin')) {
      return res.status(400).json({
        success: false,
        message: '仅支持上传 .bin 固件文件'
      });
    }

    const existingFirmware = db.getLatestFirmware(platform);
    if (existingFirmware && compareSemver(version, existingFirmware.version) <= 0) {
        return res.status(400).json({
          success: false,
          message: `版本号 ${version} 必须大于当前版本 ${existingFirmware.version}`
        });
    }

    const filename = `firmware_${platform}_v${version}.bin`;
    const filePath = path.join(FIRMWARE_DIR, filename);

    file.mv(filePath, (err) => {
      if (err) {
        console.error('[OTA] File save error:', err);
        return res.status(500).json({
          success: false,
          message: '保存固件文件失败'
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
        message: '固件上传成功',
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
      message: '服务器内部错误'
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
      message: '服务器内部错误'
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
        message: '固件不存在'
      });
    }

    const filePath = path.join(FIRMWARE_DIR, firmware.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    db.deleteFirmware(version, platform || 'esp32c3');

    res.json({
      success: true,
      message: '固件删除成功'
    });
  } catch (error) {
    console.error('[OTA] Delete error:', error);
    res.status(500).json({
      success: false,
      message: '服务器内部错误'
    });
  }
});

module.exports = router;
