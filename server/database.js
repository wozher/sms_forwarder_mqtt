const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'sms_forwarder.db');

let db = null;

function initDatabase() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      mac TEXT PRIMARY KEY,
      ip TEXT,
      rssi INTEGER DEFAULT 0,
      uptime INTEGER DEFAULT 0,
      last_seen INTEGER DEFAULT 0,
      online INTEGER DEFAULT 0,
      remark TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS sms_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mac TEXT NOT NULL,
      sender TEXT,
      text TEXT,
      phone TEXT,
      timestamp TEXT,
      received_at TEXT DEFAULT (datetime('now', 'localtime')),
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS push_configs (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS ota_firmware (
      version TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      checksum TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sms_mac ON sms_messages(mac);
    CREATE INDEX IF NOT EXISTS idx_sms_received ON sms_messages(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_devices_online ON devices(online);

    CREATE TABLE IF NOT EXISTS scheduled_sms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mac TEXT NOT NULL,
      phone TEXT NOT NULL,
      content TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      scheduled_time INTEGER NOT NULL,
      interval_days INTEGER DEFAULT 0,
      interval_hours INTEGER DEFAULT 0,
      interval_minutes INTEGER DEFAULT 0,
      next_run_time INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS schedule_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      run_time INTEGER NOT NULL,
      status TEXT NOT NULL,
      response TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_sms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS push_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sms_id INTEGER,
      channel TEXT NOT NULL,
      sender TEXT,
      phone TEXT,
      text TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      retry_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_next_run ON scheduled_sms(next_run_time);
    CREATE INDEX IF NOT EXISTS idx_schedule_mac ON scheduled_sms(mac);
    CREATE INDEX IF NOT EXISTS idx_history_task ON schedule_history(task_id);
  `);

  try {
    getDatabase().exec('ALTER TABLE scheduled_sms ADD COLUMN interval_hours INTEGER DEFAULT 0');
  } catch (e) {}
  try {
    getDatabase().exec('ALTER TABLE scheduled_sms ADD COLUMN interval_minutes INTEGER DEFAULT 0');
  } catch (e) {}
  try {
    getDatabase().exec('ALTER TABLE sms_messages ADD COLUMN status TEXT DEFAULT "pending"');
  } catch (e) {}

  const adminExists = db.prepare('SELECT COUNT(*) as count FROM users WHERE username = ?').get('admin');
  if (adminExists.count === 0) {
    const defaultPassHash = crypto.createHash('sha256').update('admin123').digest('hex');
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', defaultPassHash);
    console.log('[DB] Default admin user created: admin/admin123');
  }

  const defaultPushConfig = {
    telegram: { enabled: false, botToken: '', chatId: '' },
    dingtalk: { enabled: false, webhookUrl: '', secret: '' },
    pushplus: { enabled: false, token: '', channel: 'wechat' },
    serverchan: { enabled: false, sendKey: '' },
    feishu: { enabled: false, webhookUrl: '', secret: '' },
    bark: { enabled: false, barkUrl: '' },
    gotify: { enabled: false, gotifyUrl: '', token: '' },
    postJson: { enabled: false, url: '' },
    customTemplate: { enabled: false, url: '', body: '' }
  };

  const pushConfigExists = db.prepare('SELECT COUNT(*) as count FROM push_configs WHERE id = 1').get();
  if (pushConfigExists.count === 0) {
    db.prepare('INSERT INTO push_configs (id, config_json) VALUES (1, ?)').run(JSON.stringify(defaultPushConfig));
  }

  console.log(`[DB] Database initialized at ${DB_PATH}`);
  return db;
}

function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

function upsertDevice(mac, data) {
  const stmt = getDatabase().prepare(`
    INSERT INTO devices (mac, ip, rssi, uptime, last_seen, online)
    VALUES (@mac, @ip, @rssi, @uptime, @last_seen, 1)
    ON CONFLICT(mac) DO UPDATE SET
      ip = @ip,
      rssi = @rssi,
      uptime = @uptime,
      last_seen = @last_seen,
      online = 1
  `);
  stmt.run({
    mac,
    ip: data.ip || '',
    rssi: data.rssi || 0,
    uptime: data.uptime || 0,
    last_seen: Date.now()
  });
}

function getDeviceList() {
  const now = Date.now();
  const devices = getDatabase().prepare('SELECT * FROM devices ORDER BY last_seen DESC').all();
  return devices.map(d => ({
    mac: d.mac,
    ip: d.ip,
    rssi: d.rssi,
    uptime: d.uptime,
    lastSeen: d.last_seen,
    online: (now - d.last_seen) < 120000,
    remark: d.remark || ''
  }));
}

function updateDeviceOffline() {
  const threshold = Date.now() - 120000;
  getDatabase().prepare(`
    UPDATE devices SET online = 0 WHERE online = 1 AND last_seen < ?
  `).run(threshold);
}

function insertSms(msg) {
  const stmt = getDatabase().prepare(`
    INSERT INTO sms_messages (mac, sender, text, phone, timestamp, received_at, status)
    VALUES (@mac, @sender, @text, @phone, @timestamp, @received_at, 'pending')
  `);
  const result = stmt.run({
    mac: msg.mac,
    sender: msg.sender || '',
    text: msg.text || '',
    phone: msg.phone || '',
    timestamp: msg.timestamp || new Date().toISOString(),
    received_at: new Date().toISOString()
  });
  return result.lastInsertRowid;
}

function updateSmsStatus(id, status) {
  getDatabase().prepare('UPDATE sms_messages SET status = ? WHERE id = ?').run(status, id);
}

function getSmsList(limit = 100, offset = 0, filters = {}) {
  let sql = `
    SELECT m.*, d.ip as device_ip
    FROM sms_messages m
    LEFT JOIN devices d ON m.mac = d.mac
  `;
  const params = [];
  const conditions = [];
  
  if (filters.search) {
    conditions.push('(m.text LIKE ? OR m.sender LIKE ? OR m.phone LIKE ?)');
    const searchTerm = `%${filters.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }
  if (filters.device) {
    conditions.push('m.mac = ?');
    params.push(filters.device);
  }
  if (filters.status) {
    conditions.push('m.status = ?');
    params.push(filters.status);
  }
  
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  
  sql += ' ORDER BY m.received_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  
  return getDatabase().prepare(sql).all(...params);
}

function getSmsCount(filters = {}) {
  let sql = 'SELECT COUNT(*) as count FROM sms_messages m';
  const params = [];
  const conditions = [];
  
  if (filters.search) {
    conditions.push('(m.text LIKE ? OR m.sender LIKE ? OR m.phone LIKE ?)');
    const searchTerm = `%${filters.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }
  if (filters.device) {
    conditions.push('m.mac = ?');
    params.push(filters.device);
  }
  if (filters.status) {
    conditions.push('m.status = ?');
    params.push(filters.status);
  }
  
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  
  return getDatabase().prepare(sql).get(...params).count;
}

function getPushConfig() {
  const row = getDatabase().prepare('SELECT config_json FROM push_configs WHERE id = 1').get();
  return row ? JSON.parse(row.config_json) : null;
}

function savePushConfig(config) {
  const stmt = getDatabase().prepare('UPDATE push_configs SET config_json = ? WHERE id = 1');
  stmt.run(JSON.stringify(config));
  return true;
}

function validateUser(username, password) {
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  const user = getDatabase().prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?').get(username, passwordHash);
  return user !== undefined;
}

function changePassword(username, oldPassword, newPassword) {
  const oldHash = crypto.createHash('sha256').update(oldPassword).digest('hex');
  const user = getDatabase().prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?').get(username, oldHash);
  if (!user) return false;
  const newHash = crypto.createHash('sha256').update(newPassword).digest('hex');
  getDatabase().prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(newHash, username);
  return true;
}

function getLatestFirmware(platform) {
  return getDatabase().prepare(`
    SELECT * FROM ota_firmware
    WHERE platform = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(platform);
}

function insertFirmware(info) {
  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO ota_firmware (version, platform, filename, size, checksum, created_at)
    VALUES (@version, @platform, @filename, @size, @checksum, @created_at)
  `);
  stmt.run({
    version: info.version,
    platform: info.platform,
    filename: info.filename,
    size: info.size || 0,
    checksum: info.checksum || '',
    created_at: Date.now()
  });
  return true;
}

function getFirmwareList() {
  return getDatabase().prepare(`
    SELECT * FROM ota_firmware ORDER BY created_at DESC
  `).all();
}

function deleteFirmware(version, platform) {
  const result = getDatabase().prepare(`
    DELETE FROM ota_firmware WHERE version = ? AND platform = ?
  `).run(version, platform);
  return result.changes > 0;
}

function getStats() {
  const smsCount = getSmsCount();
  const deviceList = getDeviceList();
  const onlineCount = deviceList.filter(d => d.online).length;
  return {
    totalSms: smsCount,
    totalDevices: deviceList.length,
    onlineDevices: onlineCount,
    offlineDevices: deviceList.length - onlineCount
  };
}

function insertScheduledSms(data) {
  const stmt = getDatabase().prepare(`
    INSERT INTO scheduled_sms 
    (mac, phone, content, schedule_type, scheduled_time, interval_days, interval_hours, interval_minutes, next_run_time)
    VALUES (@mac, @phone, @content, @schedule_type, @scheduled_time, @interval_days, @interval_hours, @interval_minutes, @next_run_time)
  `);
  const result = stmt.run({
    mac: data.mac,
    phone: data.phone,
    content: data.content,
    schedule_type: data.schedule_type,
    scheduled_time: data.scheduled_time,
    interval_days: data.interval_days || 0,
    interval_hours: data.interval_hours || 0,
    interval_minutes: data.interval_minutes || 0,
    next_run_time: data.next_run_time
  });
  return result.lastInsertRowid;
}

function getScheduledSmsList(mac = null) {
  let sql = "SELECT * FROM scheduled_sms";
  if (mac) sql += ' WHERE mac = ?';
  sql += ' ORDER BY next_run_time ASC';
  
  if (mac) {
    return getDatabase().prepare(sql).all(mac);
  }
  return getDatabase().prepare(sql).all();
}

function getScheduledSms(id) {
  return getDatabase().prepare('SELECT * FROM scheduled_sms WHERE id = ?').get(id);
}

function getPendingSchedules() {
  const now = Date.now();
  return getDatabase().prepare(`
    SELECT * FROM scheduled_sms 
    WHERE status = 'active' AND next_run_time <= ?
    ORDER BY next_run_time ASC
  `).all(now);
}

function updateScheduledSmsStatus(id, status) {
  getDatabase().prepare('UPDATE scheduled_sms SET status = ? WHERE id = ?').run(status, id);
}

function updateScheduledSmsNextRun(id, nextRunTime, intervalDays, intervalHours = 0, intervalMinutes = 0) {
  const stmt = getDatabase().prepare(`
    UPDATE scheduled_sms 
    SET next_run_time = ?, interval_days = ?, interval_hours = ?, interval_minutes = ?, status = 'active'
    WHERE id = ?
  `);
  stmt.run(nextRunTime, intervalDays, intervalHours, intervalMinutes, id);
}

function updateScheduledSms(id, data) {
  const stmt = getDatabase().prepare(`
    UPDATE scheduled_sms 
    SET phone = COALESCE(?, phone), 
        content = COALESCE(?, content)
    WHERE id = ?
  `);
  stmt.run(data.phone || null, data.content || null, id);
}

function deleteScheduledSms(id) {
  getDatabase().prepare('DELETE FROM scheduled_sms WHERE id = ?').run(id);
}

function getScheduleHistory(taskId, limit = 50) {
  return getDatabase().prepare(`
    SELECT * FROM schedule_history 
    WHERE task_id = ?
    ORDER BY run_time DESC
    LIMIT ?
  `).all(taskId, limit);
}

function insertScheduleHistory(data) {
  const stmt = getDatabase().prepare(`
    INSERT INTO schedule_history (task_id, run_time, status, response)
    VALUES (@task_id, @run_time, @status, @response)
  `);
  stmt.run({
    task_id: data.task_id,
    run_time: data.run_time,
    status: data.status,
    response: data.response || ''
  });
}

function insertPushHistory(data) {
  const stmt = getDatabase().prepare(`
    INSERT INTO push_history (sms_id, channel, sender, phone, text, status)
    VALUES (@sms_id, @channel, @sender, @phone, @text, @status)
  `);
  const result = stmt.run({
    sms_id: data.sms_id || '',
    channel: data.channel,
    sender: data.sender || '',
    phone: data.phone || '',
    text: data.text || '',
    status: data.status || 'pending'
  });
  return result.lastInsertRowid;
}

function getPushHistory(limit = 50) {
  return getDatabase().prepare(`
    SELECT * FROM push_history 
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

function updatePushHistoryStatus(id, status, errorMessage = '') {
  getDatabase().prepare(`
    UPDATE push_history SET status = ?, error_message = ?, retry_count = retry_count + 1
    WHERE id = ?
  `).run(status, errorMessage, id);
}

function getPushHistoryById(id) {
  return getDatabase().prepare('SELECT * FROM push_history WHERE id = ?').get(id);
}

function getPushHistoryBySmsId(smsId) {
  return getDatabase().prepare('SELECT * FROM push_history WHERE sms_id = ? ORDER BY created_at DESC').all(smsId);
}

module.exports = {
  initDatabase,
  getDatabase,
  upsertDevice,
  getDeviceList,
  updateDeviceOffline,
  insertSms,
  updateSmsStatus,
  getSmsList,
  getSmsCount,
  getPushConfig,
  savePushConfig,
  validateUser,
  changePassword,
  getLatestFirmware,
  insertFirmware,
  getFirmwareList,
  deleteFirmware,
  getStats,
  insertScheduledSms,
  getScheduledSmsList,
  getScheduledSms,
  getPendingSchedules,
  updateScheduledSmsStatus,
  updateScheduledSmsNextRun,
  updateScheduledSms,
  deleteScheduledSms,
  getScheduleHistory,
  insertScheduleHistory,
  insertPushHistory,
  getPushHistory,
  updatePushHistoryStatus,
  getPushHistoryById,
  getPushHistoryBySmsId
};
