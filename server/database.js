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
      phone TEXT DEFAULT '',
      phone_override TEXT DEFAULT '',
      rssi INTEGER DEFAULT 0,
      uptime INTEGER DEFAULT 0,
      version TEXT DEFAULT '',
      status_json TEXT DEFAULT '{}',
      last_seen INTEGER DEFAULT 0,
      online INTEGER DEFAULT 0,
      remark TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS sms_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mac TEXT NOT NULL,
      sms_id TEXT DEFAULT '',
      sender TEXT,
      text TEXT,
      phone TEXT,
      device_phone TEXT DEFAULT '',
      timestamp TEXT,
      received_at TEXT DEFAULT (datetime('now', 'localtime')),
      queued INTEGER DEFAULT 0,
      queued_at TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      direction TEXT DEFAULT 'inbound',
      source TEXT DEFAULT 'device',
      error_message TEXT DEFAULT '',
      request_id TEXT DEFAULT '',
      task_id INTEGER DEFAULT NULL
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

    CREATE INDEX IF NOT EXISTS idx_sms_mac ON sms_messages(mac);
    CREATE INDEX IF NOT EXISTS idx_sms_received ON sms_messages(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_devices_online ON devices(online);

    CREATE TABLE IF NOT EXISTS scheduled_sms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mac TEXT NOT NULL,
      bind_mode TEXT DEFAULT 'mac',
      bind_phone TEXT DEFAULT '',
      task_type TEXT DEFAULT 'sms',
      phone TEXT NOT NULL,
      content TEXT NOT NULL,
      traffic_kb INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS device_diag_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mac TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER DEFAULT 0,
      free_heap INTEGER DEFAULT 0,
      min_free_heap INTEGER DEFAULT 0,
      pending_urc INTEGER DEFAULT 0,
      offline_sms INTEGER DEFAULT 0,
      urc_waiting_pdu INTEGER DEFAULT 0,
      pending_deferred_pdu INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_push_history_sms_channel_status ON push_history(sms_id, channel, status);
    CREATE INDEX IF NOT EXISTS idx_device_diag_mac_created_at ON device_diag_history(mac, created_at DESC);

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
    getDatabase().exec("ALTER TABLE scheduled_sms ADD COLUMN bind_mode TEXT DEFAULT 'mac'");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE scheduled_sms ADD COLUMN bind_phone TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE scheduled_sms ADD COLUMN task_type TEXT DEFAULT 'sms'");
  } catch (e) {}
  try {
    getDatabase().exec('ALTER TABLE scheduled_sms ADD COLUMN traffic_kb INTEGER DEFAULT 0');
  } catch (e) {}
  try {
    getDatabase().exec('ALTER TABLE sms_messages ADD COLUMN status TEXT DEFAULT "pending"');
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE sms_messages ADD COLUMN device_phone TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE sms_messages ADD COLUMN direction TEXT DEFAULT 'inbound'");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE sms_messages ADD COLUMN source TEXT DEFAULT 'device'");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE sms_messages ADD COLUMN error_message TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE sms_messages ADD COLUMN request_id TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDatabase().exec('ALTER TABLE sms_messages ADD COLUMN task_id INTEGER DEFAULT NULL');
  } catch (e) {}
  try {
    getDatabase().exec('ALTER TABLE sms_messages ADD COLUMN queued INTEGER DEFAULT 0');
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE sms_messages ADD COLUMN queued_at TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE sms_messages ADD COLUMN sms_id TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE devices ADD COLUMN remark TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE devices ADD COLUMN phone TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE devices ADD COLUMN phone_override TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE devices ADD COLUMN version TEXT DEFAULT ''");
  } catch (e) {}
  try {
    getDatabase().exec("ALTER TABLE devices ADD COLUMN status_json TEXT DEFAULT '{}'");
  } catch (e) {}

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sms_direction_received ON sms_messages(direction, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sms_mac_direction ON sms_messages(mac, direction);
    CREATE INDEX IF NOT EXISTS idx_sms_status ON sms_messages(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_mac_smsid ON sms_messages(mac, sms_id) WHERE sms_id <> '';
  `);

  // Indexes that depend on newly added columns must be created after migrations.
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_schedule_bind_phone ON scheduled_sms(bind_phone)");
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
  const statusJson = data.statusJson === undefined
    ? null
    : (typeof data.statusJson === 'string' ? data.statusJson : JSON.stringify(data.statusJson || {}));
  const stmt = getDatabase().prepare(`
    INSERT INTO devices (mac, ip, phone, rssi, uptime, version, status_json, last_seen, online)
    VALUES (@mac, @ip, @phone, @rssi, @uptime, @version, @status_json, @last_seen, 1)
    ON CONFLICT(mac) DO UPDATE SET
      ip = @ip,
      phone = COALESCE(@phone, phone),
      rssi = @rssi,
      uptime = @uptime,
      version = COALESCE(@version, version),
      status_json = COALESCE(@status_json, status_json),
      last_seen = @last_seen,
      online = 1
  `);
  stmt.run({
    mac,
    ip: data.ip || '',
    phone: data.phone ? String(data.phone).trim() : null,
    rssi: data.rssi || 0,
    uptime: data.uptime || 0,
    version: data.version ? String(data.version).trim() : null,
    status_json: statusJson,
    last_seen: Number(data.last_seen) || Date.now()
  });
}

function parseJsonSafe(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getDeviceList() {
  const now = Date.now();
  const devices = getDatabase().prepare('SELECT * FROM devices ORDER BY last_seen DESC').all();
  return devices.map(d => ({
    mac: d.mac,
    ip: d.ip,
    phone: d.phone_override || d.phone || '',
    phoneOverride: d.phone_override || '',
    rssi: d.rssi,
    uptime: d.uptime,
    version: d.version || '',
    status: parseJsonSafe(d.status_json, {}),
    lastSeen: d.last_seen,
    online: (now - d.last_seen) < 120000,
    remark: d.remark || ''
  }));
}

function getDeviceByMac(mac) {
  const d = getDatabase().prepare('SELECT * FROM devices WHERE mac = ?').get(mac);
  if (!d) return null;
  const now = Date.now();
  return {
    mac: d.mac,
    ip: d.ip,
    phone: d.phone_override || d.phone || '',
    phoneOverride: d.phone_override || '',
    rssi: d.rssi,
    uptime: d.uptime,
    version: d.version || '',
    status: parseJsonSafe(d.status_json, {}),
    lastSeen: d.last_seen,
    online: (now - d.last_seen) < 120000,
    remark: d.remark || ''
  };
}

function updateDeviceOffline() {
  const threshold = Date.now() - 120000;
  getDatabase().prepare(`
    UPDATE devices SET online = 0 WHERE online = 1 AND last_seen < ?
  `).run(threshold);
}

function updateDeviceRemark(mac, remark) {
  getDatabase().prepare('UPDATE devices SET remark = ? WHERE mac = ?').run(remark, mac);
}

function updateDevicePhoneOverride(mac, phoneOverride) {
  const value = phoneOverride == null ? '' : String(phoneOverride).trim();
  getDatabase().prepare('UPDATE devices SET phone_override = ? WHERE mac = ?').run(value, mac);
}

function insertSms(msg) {
  const stmt = getDatabase().prepare(`
    INSERT INTO sms_messages (mac, sms_id, sender, text, phone, device_phone, timestamp, received_at, queued, queued_at, status, direction, source, error_message, request_id, task_id)
    VALUES (@mac, @sms_id, @sender, @text, @phone, @device_phone, @timestamp, @received_at, @queued, @queued_at, @status, @direction, @source, @error_message, @request_id, @task_id)
  `);
  const result = stmt.run({
    mac: msg.mac,
    sms_id: msg.smsId || '',
    sender: msg.sender || '',
    text: msg.text || '',
    phone: msg.phone || '',
    device_phone: msg.devicePhone || '',
    timestamp: msg.timestamp || new Date().toISOString(),
    received_at: msg.receivedAt || new Date().toISOString(),
    queued: msg.queued ? 1 : 0,
    queued_at: msg.queuedAt ? String(msg.queuedAt) : '',
    status: msg.status || 'pending',
    direction: msg.direction || 'inbound',
    source: msg.source || 'device',
    error_message: msg.errorMessage || '',
    request_id: msg.requestId || '',
    task_id: msg.taskId ?? null
  });
  return result.lastInsertRowid;
}

function updateSmsStatus(id, status, errorMessage = '') {
  getDatabase().prepare('UPDATE sms_messages SET status = ?, error_message = ? WHERE id = ?').run(status, errorMessage, id);
}

function getSmsById(id) {
  return getDatabase().prepare(`
    SELECT m.*, d.ip as device_ip
    FROM sms_messages m
    LEFT JOIN devices d ON m.mac = d.mac
    WHERE m.id = ?
  `).get(id);
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
  if (filters.smsStatus) {
    conditions.push('m.status = ?');
    params.push(filters.smsStatus);
  }
  if (filters.direction) {
    conditions.push('m.direction = ?');
    params.push(filters.direction);
  }
  if (filters.source) {
    conditions.push('m.source = ?');
    params.push(filters.source);
  }
  if (filters.phone) {
    conditions.push('(m.phone = ? OR m.sender = ?)');
    params.push(filters.phone, filters.phone);
  }

  // Push status filter (based on push_history), so pagination matches UI.
  // pending: no enabled channel has success/failed record (missing history treated as pending)
  const pushStatus = filters.pushStatus;
  const enabledChannels = Array.isArray(filters.enabledPushChannels) ? filters.enabledPushChannels.filter(Boolean) : [];
  if (pushStatus) {
    if (enabledChannels.length === 0) {
      // No enabled channels: push status filters don't make sense.
      conditions.push('1 = 0');
    } else if (pushStatus === 'success' || pushStatus === 'failed') {
      const placeholders = enabledChannels.map(() => '?').join(',');
      conditions.push(`EXISTS (
        SELECT 1 FROM push_history ph
        WHERE ph.sms_id = m.id
          AND ph.channel IN (${placeholders})
          AND ph.status = ?
      )`);
      params.push(...enabledChannels, pushStatus);
    } else if (pushStatus === 'pending') {
      const placeholders = enabledChannels.map(() => '?').join(',');
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM push_history ph
        WHERE ph.sms_id = m.id
          AND ph.channel IN (${placeholders})
          AND (ph.status = 'success' OR ph.status = 'failed')
      )`);
      params.push(...enabledChannels);
    }
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
  if (filters.smsStatus) {
    conditions.push('m.status = ?');
    params.push(filters.smsStatus);
  }
  if (filters.direction) {
    conditions.push('m.direction = ?');
    params.push(filters.direction);
  }
  if (filters.source) {
    conditions.push('m.source = ?');
    params.push(filters.source);
  }
  if (filters.phone) {
    conditions.push('(m.phone = ? OR m.sender = ?)');
    params.push(filters.phone, filters.phone);
  }

  const pushStatus = filters.pushStatus;
  const enabledChannels = Array.isArray(filters.enabledPushChannels) ? filters.enabledPushChannels.filter(Boolean) : [];
  if (pushStatus) {
    if (enabledChannels.length === 0) {
      conditions.push('1 = 0');
    } else if (pushStatus === 'success' || pushStatus === 'failed') {
      const placeholders = enabledChannels.map(() => '?').join(',');
      conditions.push(`EXISTS (
        SELECT 1 FROM push_history ph
        WHERE ph.sms_id = m.id
          AND ph.channel IN (${placeholders})
          AND ph.status = ?
      )`);
      params.push(...enabledChannels, pushStatus);
    } else if (pushStatus === 'pending') {
      const placeholders = enabledChannels.map(() => '?').join(',');
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM push_history ph
        WHERE ph.sms_id = m.id
          AND ph.channel IN (${placeholders})
          AND (ph.status = 'success' OR ph.status = 'failed')
      )`);
      params.push(...enabledChannels);
    }
  }
  
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  
  return getDatabase().prepare(sql).get(...params).count;
}

function deleteSmsById(id) {
  const smsId = Number(id);
  if (!Number.isInteger(smsId) || smsId <= 0) {
    return { deleted: false, changes: 0 };
  }

  const transaction = getDatabase().transaction((targetId) => {
    getDatabase().prepare('DELETE FROM push_history WHERE sms_id = ?').run(targetId);
    const result = getDatabase().prepare('DELETE FROM sms_messages WHERE id = ?').run(targetId);
    return { deleted: result.changes > 0, changes: result.changes };
  });

  return transaction(smsId);
}

function deleteSmsByIds(ids = []) {
  const smsIds = [...new Set((Array.isArray(ids) ? ids : [])
    .map(id => Number(id))
    .filter(id => Number.isInteger(id) && id > 0))];

  if (smsIds.length === 0) {
    return { deleted: false, deletedCount: 0 };
  }

  const placeholders = smsIds.map(() => '?').join(',');
  const transaction = getDatabase().transaction((targetIds) => {
    getDatabase().prepare(`DELETE FROM push_history WHERE sms_id IN (${placeholders})`).run(...targetIds);
    const result = getDatabase().prepare(`DELETE FROM sms_messages WHERE id IN (${placeholders})`).run(...targetIds);
    return { deleted: result.changes > 0, deletedCount: result.changes };
  });

  return transaction(smsIds);
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

function insertDeviceDiagHistory(data) {
  const stmt = getDatabase().prepare(`
    INSERT INTO device_diag_history (
      mac,
      created_at,
      last_seen,
      free_heap,
      min_free_heap,
      pending_urc,
      offline_sms,
      urc_waiting_pdu,
      pending_deferred_pdu
    )
    VALUES (
      @mac,
      @created_at,
      @last_seen,
      @free_heap,
      @min_free_heap,
      @pending_urc,
      @offline_sms,
      @urc_waiting_pdu,
      @pending_deferred_pdu
    )
  `);
  const result = stmt.run({
    mac: String(data.mac || '').trim(),
    created_at: Number(data.created_at) || Date.now(),
    last_seen: Number(data.last_seen) || 0,
    free_heap: Number(data.free_heap) || 0,
    min_free_heap: Number(data.min_free_heap) || 0,
    pending_urc: Number(data.pending_urc) || 0,
    offline_sms: Number(data.offline_sms) || 0,
    urc_waiting_pdu: data.urc_waiting_pdu ? 1 : 0,
    pending_deferred_pdu: data.pending_deferred_pdu ? 1 : 0
  });
  return result.lastInsertRowid;
}

function getLatestDeviceDiagHistory(mac) {
  return getDatabase().prepare(`
    SELECT *
    FROM device_diag_history
    WHERE mac = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(mac);
}

function getDeviceDiagHistory(mac, options = {}) {
  const limit = typeof options === 'number' ? options : options.limit;
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 30, 500));
  const fromTs = Math.max(0, parseInt(options?.fromTs, 10) || 0);
  let sql = `
    SELECT *
    FROM device_diag_history
    WHERE mac = ?
  `;
  const params = [mac];
  if (fromTs > 0) {
    sql += ' AND created_at >= ?';
    params.push(fromTs);
  }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(safeLimit);
  return getDatabase().prepare(sql).all(...params).reverse();
}

function insertScheduledSms(data) {
  const stmt = getDatabase().prepare(`
    INSERT INTO scheduled_sms 
    (mac, bind_mode, bind_phone, task_type, phone, content, traffic_kb, schedule_type, scheduled_time, interval_days, interval_hours, interval_minutes, next_run_time)
    VALUES (@mac, @bind_mode, @bind_phone, @task_type, @phone, @content, @traffic_kb, @schedule_type, @scheduled_time, @interval_days, @interval_hours, @interval_minutes, @next_run_time)
  `);
  const taskType = data.task_type === 'traffic' ? 'traffic' : 'sms';
  const bindMode = data.bind_mode === 'phone' ? 'phone' : 'mac';
  const bindPhone = data.bind_phone ? String(data.bind_phone).trim() : '';
  const result = stmt.run({
    mac: data.mac,
    bind_mode: bindMode,
    bind_phone: bindPhone,
    task_type: taskType,
    phone: taskType === 'sms' ? (data.phone || '') : '-',
    content: taskType === 'sms' ? (data.content || '') : '[TRAFFIC_TASK]',
    traffic_kb: taskType === 'traffic' ? (parseInt(data.traffic_kb, 10) || 0) : 0,
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
        content = COALESCE(?, content),
        traffic_kb = COALESCE(?, traffic_kb)
    WHERE id = ?
  `);
  stmt.run(
    data.phone || null,
    data.content || null,
    data.traffic_kb !== undefined ? (parseInt(data.traffic_kb, 10) || 0) : null,
    id
  );
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

function getPushHistorySummaryBySmsIds(smsIds = []) {
  if (!Array.isArray(smsIds) || smsIds.length === 0) {
    return {};
  }

  const placeholders = smsIds.map(() => '?').join(',');
  const rows = getDatabase().prepare(`
    SELECT id, sms_id, channel, status, error_message, created_at
    FROM push_history
    WHERE sms_id IN (${placeholders})
    ORDER BY created_at DESC, id DESC
  `).all(...smsIds);

  const summary = {};
  for (const row of rows) {
    if (!summary[row.sms_id]) {
      summary[row.sms_id] = {};
    }
    if (!summary[row.sms_id][row.channel]) {
      summary[row.sms_id][row.channel] = {
        id: row.id,
        status: row.status || 'pending',
        error: row.error_message || ''
      };
    }
  }

  return summary;
}

module.exports = {
  initDatabase,
  getDatabase,
  upsertDevice,
  getDeviceList,
  getDeviceByMac,
  updateDeviceOffline,
  updateDeviceRemark,
  updateDevicePhoneOverride,
  insertSms,
  updateSmsStatus,
  getSmsById,
  getSmsList,
  getSmsCount,
  deleteSmsById,
  deleteSmsByIds,
  getPushConfig,
  savePushConfig,
  validateUser,
  changePassword,
  getStats,
  insertDeviceDiagHistory,
  getLatestDeviceDiagHistory,
  getDeviceDiagHistory,
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
  getPushHistoryBySmsId,
  getPushHistorySummaryBySmsIds
};
