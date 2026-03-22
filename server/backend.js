const express = require('express');
const http = require('http');
const mqtt = require('mqtt');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const crypto2 = require('crypto');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const db = require('./database');
const { basicAuth } = require('./middleware/auth');
const otaRouter = require('./routes/ota');

const TZ = 'Asia/Shanghai';
const PORT = parseInt(process.env.PORT || '3000');
const MQTT_HOST = process.env.MQTT_HOST || '192.168.31.197';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883');
const WS_PATH = '/ws';

function calculateNextRunTime(hour, minute, intervalDays = 0) {
  const nowInTZ = dayjs().tz(TZ);
  let target = nowInTZ.hour(hour).minute(minute).second(0).millisecond(0);
  if (target.valueOf() <= nowInTZ.valueOf()) {
    target = target.add(intervalDays > 0 ? intervalDays : 1, 'day');
  }
  return target.valueOf();
}

function calculateNextRunTimeFromRunTime(runTime, hour, minute, intervalDays = 1) {
  const nowInTZ = dayjs(runTime).tz(TZ);
  let target = nowInTZ.hour(hour).minute(minute).second(0).millisecond(0);
  let nextRun = target.valueOf();
  if (nextRun <= runTime) {
    nextRun = target.add(intervalDays, 'day').valueOf();
  }
  return nextRun;
}

const mqttUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
const mqttOptions = {
  clientId: `NodeServer_${crypto.randomBytes(6).toString('hex')}`,
  reconnectPeriod: 5000,
  connectTimeout: 10000
};

if (process.env.MQTT_USER) {
  mqttOptions.username = process.env.MQTT_USER;
  mqttOptions.password = process.env.MQTT_PASS;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: WS_PATH });

const wsClients = new Set();
const pendingCmds = new Map();

let mqttClient = null;

db.initDatabase();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  if (req.files) {
    for (const key in req.files) {
      req.files[key].name = Buffer.from(req.files[key].name, 'latin1').toString('utf8');
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/ota', otaRouter);

app.post('/api/login', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
    const [username, password] = credentials.split(':');

    if (db.validateUser(username, password)) {
      return res.json({ success: true, username, message: 'Login successful' });
    }

    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Authentication error' });
  }
});

app.post('/api/password', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
    const [username, oldPassword] = credentials.split(':');
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: '新密码至少6位' });
    }
    if (db.changePassword(username, oldPassword, newPassword)) {
      return res.json({ success: true, message: '密码修改成功' });
    }
    return res.status(401).json({ success: false, message: '原密码错误' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.use(basicAuth);

app.get('/api/devices', (req, res) => {
  try {
    const devices = db.getDeviceList();
    res.json({ success: true, devices });
  } catch (error) {
    console.error('[API] Error getting devices:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.get('/api/messages', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(parseInt(req.query.pageSize) || 10, 100);
    const offset = (page - 1) * pageSize;
    
    const filters = {
      search: req.query.search || '',
      device: req.query.device || '',
      status: req.query.status || ''
    };
    
    const messages = db.getSmsList(pageSize, offset, filters).map(m => ({
      id: m.id,
      mac: m.mac,
      deviceIp: m.device_ip || '',
      sender: m.sender,
      text: m.text,
      phone: m.phone,
      timestamp: m.timestamp,
      receivedAt: m.received_at
    }));
    
    const total = db.getSmsCount(filters);
    const totalPages = Math.ceil(total / pageSize) || 1;
    
    res.json({ 
      success: true, 
      messages,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasMore: page < totalPages
      },
      filters
    });
  } catch (error) {
    console.error('[API] Error getting messages:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const stats = db.getStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('[API] Error getting stats:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/cmd/:mac', async (req, res) => {
  const { mac } = req.params;
  const { action, ...params } = req.body;

  if (!action) {
    return res.status(400).json({ success: false, message: 'Missing action parameter' });
  }

  const devices = db.getDeviceList();
  const device = devices.find(d => d.mac === mac);

  if (!device) {
    return res.status(404).json({ success: false, message: 'Device not found' });
  }

  if (!device.online) {
    return res.status(400).json({ success: false, message: 'Device is offline' });
  }

  try {
    const result = await sendCmdToDevice(mac, action, params);
    res.json({ success: true, result });
  } catch (error) {
    console.error('[API] Command error:', error);
    res.status(500).json({ success: false, message: error.message || 'Command execution failed' });
  }
});

app.get('/api/push-config', (req, res) => {
  try {
    const config = db.getPushConfig();
    res.json({ success: true, config });
  } catch (error) {
    console.error('[API] Error getting push config:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/push-config', (req, res) => {
  try {
    const config = req.body;
    db.savePushConfig(config);
    res.json({ success: true, message: 'Push config saved successfully' });
  } catch (error) {
    console.error('[API] Error saving push config:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.get('/api/push-history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const history = db.getPushHistory(limit);
    res.json({ success: true, history });
  } catch (error) {
    console.error('[API] Error getting push history:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.get('/api/push-history/sms/:smsId', (req, res) => {
  try {
    const smsId = parseInt(req.params.smsId);
    const history = db.getPushHistoryBySmsId(smsId);
    res.json({ success: true, history });
  } catch (error) {
    console.error('[API] Error getting push history by smsId:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/push-history/:id/retry', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const record = db.getPushHistoryById(id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }
    const cfg = db.getPushConfig();
    if (!cfg) {
      return res.status(400).json({ success: false, message: 'Push config not found' });
    }
    (async () => {
      try {
        const timestamp = new Date().toISOString();
        if (record.channel === 'telegram' && cfg.telegram?.enabled) {
          await doTelegram(cfg.telegram.botToken, cfg.telegram.chatId, record.sender, record.text, timestamp, record.phone);
        } else if (record.channel === 'dingtalk' && cfg.dingtalk?.enabled) {
          await doDingtalk(cfg.dingtalk.webhookUrl, cfg.dingtalk.secret, record.sender, record.text, timestamp, record.phone);
        } else if (record.channel === 'pushplus' && cfg.pushplus?.enabled) {
          await doPushplus(cfg.pushplus.token, record.sender, record.text, timestamp, record.phone, cfg.pushplus.channel);
        } else if (record.channel === 'serverchan' && cfg.serverchan?.enabled) {
          await doServerChan(cfg.serverchan.sendKey, record.sender, record.text, timestamp, record.phone);
        } else if (record.channel === 'feishu' && cfg.feishu?.enabled) {
          await doFeishu(cfg.feishu.webhookUrl, cfg.feishu.secret, record.sender, record.text, timestamp, record.phone);
        } else if (record.channel === 'bark' && cfg.bark?.enabled) {
          await doBark(cfg.bark.barkUrl, record.sender, record.text, timestamp, record.phone);
        } else if (record.channel === 'gotify' && cfg.gotify?.enabled) {
          await doGotify(cfg.gotify.gotifyUrl, cfg.gotify.token, record.sender, record.text, timestamp, record.phone);
        } else if (record.channel === 'postjson' && cfg.postJson?.enabled) {
          await doPostJson(cfg.postJson.url, { sender: record.sender, message: record.text, timestamp, phone: record.phone });
        } else if (record.channel === 'custom' && cfg.customTemplate?.enabled) {
          await doCustomTemplate(cfg.customTemplate.url, cfg.customTemplate.body, { sender: record.sender, message: record.text, timestamp, phone: record.phone });
        }
        db.updatePushHistoryStatus(id, 'success', '');
        res.json({ success: true, message: 'Retry successful' });
      } catch (error) {
        db.updatePushHistoryStatus(id, 'failed', error.message);
        res.status(500).json({ success: false, message: error.message });
      }
    })();
  } catch (error) {
    console.error('[API] Error retry push:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/schedule', (req, res) => {
  try {
    const { mac, phone, content, schedule_type, scheduled_time, interval_days, interval_hours, interval_minutes } = req.body;
    
    console.log('[Schedule] Received request:', JSON.stringify(req.body));
    
    if (!mac) {
      return res.status(400).json({ success: false, message: '缺少设备MAC地址' });
    }
    if (!phone) {
      return res.status(400).json({ success: false, message: '缺少目标号码' });
    }
    if (!content) {
      return res.status(400).json({ success: false, message: '缺少短信内容' });
    }
    if (!scheduled_time) {
      return res.status(400).json({ success: false, message: '请选择发送时间' });
    }
    
    const devices = db.getDeviceList();
    const device = devices.find(d => d.mac === mac);
    
    if (!device?.online) {
      return res.status(400).json({ success: false, message: '设备不在线' });
    }
    
    const timeParts = scheduled_time.split(':');
    const hour = parseInt(timeParts[0]) || 0;
    const minute = parseInt(timeParts[1]) || 0;
    
    const intervalDays = schedule_type === 'interval' ? (parseInt(interval_days) || 1) : 0;
    const nextRunTime = calculateNextRunTime(hour, minute, intervalDays);
    
    const taskId = db.insertScheduledSms({
      mac, phone, content,
      schedule_type: schedule_type || 'once',
      scheduled_time: scheduled_time,
      interval_days: interval_days || 0,
      interval_hours: hour,
      interval_minutes: minute,
      next_run_time: nextRunTime
    });
    
    console.log(`[Schedule] Task ${taskId} created: ${schedule_type} - ${phone} at ${hour}:${minute}`);
    res.json({ success: true, id: taskId, message: '定时任务已创建' });
  } catch (error) {
    console.error('[API] Error creating schedule:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.get('/api/schedule', (req, res) => {
  try {
    const { mac } = req.query;
    const tasks = db.getScheduledSmsList(mac || null);
    res.json({ success: true, tasks });
  } catch (error) {
    console.error('[API] Error getting schedule list:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.get('/api/schedule/:id', (req, res) => {
  try {
    const { id } = req.params;
    const task = db.getScheduledSms(id);
    if (!task) {
      return res.status(404).json({ success: false, message: '任务不存在' });
    }
    const history = db.getScheduleHistory(id);
    res.json({ success: true, task, history });
  } catch (error) {
    console.error('[API] Error getting schedule:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.put('/api/schedule/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status, phone, content, interval_days } = req.body;
    
    const task = db.getScheduledSms(id);
    if (!task) {
      return res.status(404).json({ success: false, message: '任务不存在' });
    }
    
    if (status === 'paused' || status === 'active') {
      db.updateScheduledSmsStatus(id, status);
      console.log(`[Schedule] Task ${id} status: ${status}`);
    }
    
    if (phone !== undefined || content !== undefined) {
      db.updateScheduledSms(id, { phone, content });
    }
    
    if (interval_days !== undefined && task.schedule_type === 'interval') {
      const newInterval = interval_days > 0 ? interval_days : task.interval_days;
      const targetHour = task.interval_hours || 0;
      const targetMinute = task.interval_minutes || 0;
      const nextRun = calculateNextRunTime(targetHour, targetMinute, newInterval);
      db.updateScheduledSmsNextRun(id, nextRun, newInterval, targetHour, targetMinute);
    }
    
    res.json({ success: true, message: '任务已更新' });
  } catch (error) {
    console.error('[API] Error updating schedule:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.delete('/api/schedule/:id', (req, res) => {
  try {
    const { id } = req.params;
    const task = db.getScheduledSms(id);
    if (!task) {
      return res.status(404).json({ success: false, message: '任务不存在' });
    }
    db.deleteScheduledSms(id);
    console.log(`[Schedule] Task ${id} deleted`);
    res.json({ success: true, message: '任务已删除' });
  } catch (error) {
    console.error('[API] Error deleting schedule:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[App] Error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  console.log(`[WS] Client connected. Total: ${wsClients.size}`);

  const devices = db.getDeviceList();
  const messages = db.getSmsList(50).map(m => ({
    id: m.id,
    mac: m.mac,
    deviceIp: m.device_ip || '',
    sender: m.sender,
    text: m.text,
    phone: m.phone,
    timestamp: m.timestamp,
    receivedAt: m.received_at
  }));

  ws.send(JSON.stringify({ type: 'init', devices, messages }));

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${wsClients.size}`);
  });

  ws.on('error', () => wsClients.delete(ws));
});

function broadcastDeviceList() {
  const devices = db.getDeviceList();
  const payload = JSON.stringify({ type: 'devices', devices });
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

function broadcastScheduleEvent(event, data) {
  const payload = JSON.stringify({ type: 'schedule', event, data, timestamp: Date.now() });
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

function broadcastSMS(sms) {
  const payload = JSON.stringify({ type: 'sms', sms });
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

function broadcastResp(mac, data) {
  const payload = JSON.stringify({ type: 'resp', mac, data });
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

function registerRespCallback(mac, callback) {
  if (!pendingCmds.has(mac)) {
    pendingCmds.set(mac, []);
  }
  pendingCmds.get(mac).push(callback);

  setTimeout(() => {
    if (pendingCmds.has(mac)) {
      const cbs = pendingCmds.get(mac);
      const idx = cbs.indexOf(callback);
      if (idx >= 0) {
        cbs.splice(idx, 1);
        callback({ action: 'timeout', success: false, message: 'Command timeout' });
      }
    }
  }, 60000);
}

function sendCmdToDevice(mac, action, params) {
  return new Promise((resolve, reject) => {
    if (!mqttClient || !mqttClient.connected) {
      return reject(new Error('MQTT client not connected'));
    }

    const topic = `sms_forwarder/cmd/${mac}`;
    const payload = { action, ...params };
    const payloadStr = JSON.stringify(payload);

    mqttClient.publish(topic, payloadStr, { qos: 1 }, (err) => {
      if (err) {
        return reject(err);
      }

      console.log(`[CMD] ${mac} <- ${payloadStr}`);

      const timeout = action === 'ping' ? 40000 : 15000;
      const timer = setTimeout(() => {
        reject(new Error('Command timeout'));
      }, timeout);

      registerRespCallback(mac, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
    });
  });
}

async function dispatchPush(sms, smsId = null) {
  const cfg = db.getPushConfig();
  if (!cfg) return;

  const { sender, text, timestamp, phone } = sms;
  const payload = { sender, message: text, timestamp, phone };
  const tasks = [];
  const channelMap = [];

  if (cfg.telegram?.enabled && cfg.telegram.botToken && cfg.telegram.chatId) {
    const historyId = db.insertPushHistory({ sms_id: smsId, channel: 'telegram', sender, phone, text, status: 'pending' });
    tasks.push(doTelegram(cfg.telegram.botToken, cfg.telegram.chatId, sender, text, timestamp, phone).then(() => historyId).catch(e => ({ historyId, error: e.message })));
    channelMap.push('telegram');
  }

  if (cfg.dingtalk?.enabled && cfg.dingtalk.webhookUrl) {
    const historyId = db.insertPushHistory({ sms_id: smsId, channel: 'dingtalk', sender, phone, text, status: 'pending' });
    tasks.push(doDingtalk(cfg.dingtalk.webhookUrl, cfg.dingtalk.secret, sender, text, timestamp, phone).then(() => historyId).catch(e => ({ historyId, error: e.message })));
    channelMap.push('dingtalk');
  }

  if (cfg.pushplus?.enabled && cfg.pushplus.token) {
    const historyId = db.insertPushHistory({ sms_id: smsId, channel: 'pushplus', sender, phone, text, status: 'pending' });
    tasks.push(doPushplus(cfg.pushplus.token, sender, text, timestamp, phone, cfg.pushplus.channel).then(() => historyId).catch(e => ({ historyId, error: e.message })));
    channelMap.push('pushplus');
  }

  if (cfg.serverchan?.enabled && cfg.serverchan.sendKey) {
    const historyId = db.insertPushHistory({ sms_id: smsId, channel: 'serverchan', sender, phone, text, status: 'pending' });
    tasks.push(doServerChan(cfg.serverchan.sendKey, sender, text, timestamp, phone).then(() => historyId).catch(e => ({ historyId, error: e.message })));
    channelMap.push('serverchan');
  }

  if (cfg.feishu?.enabled && cfg.feishu.webhookUrl) {
    const historyId = db.insertPushHistory({ sms_id: smsId, channel: 'feishu', sender, phone, text, status: 'pending' });
    tasks.push(doFeishu(cfg.feishu.webhookUrl, cfg.feishu.secret, sender, text, timestamp, phone).then(() => historyId).catch(e => ({ historyId, error: e.message })));
    channelMap.push('feishu');
  }

  if (cfg.bark?.enabled && cfg.bark.barkUrl) {
    const historyId = db.insertPushHistory({ sms_id: smsId, channel: 'bark', sender, phone, text, status: 'pending' });
    tasks.push(doBark(cfg.bark.barkUrl, sender, text, timestamp, phone).then(() => historyId).catch(e => ({ historyId, error: e.message })));
    channelMap.push('bark');
  }

  if (cfg.gotify?.enabled && cfg.gotify.gotifyUrl && cfg.gotify.token) {
    const historyId = db.insertPushHistory({ sms_id: smsId, channel: 'gotify', sender, phone, text, status: 'pending' });
    tasks.push(doGotify(cfg.gotify.gotifyUrl, cfg.gotify.token, sender, text, timestamp, phone).then(() => historyId).catch(e => ({ historyId, error: e.message })));
    channelMap.push('gotify');
  }

  if (cfg.postJson?.enabled && cfg.postJson.url) {
    const historyId = db.insertPushHistory({ sms_id: smsId, channel: 'postjson', sender, phone, text, status: 'pending' });
    tasks.push(doPostJson(cfg.postJson.url, payload).then(() => historyId).catch(e => ({ historyId, error: e.message })));
    channelMap.push('postjson');
  }

  if (cfg.customTemplate?.enabled && cfg.customTemplate.url && cfg.customTemplate.body) {
    const historyId = db.insertPushHistory({ sms_id: smsId, channel: 'custom', sender, phone, text, status: 'pending' });
    tasks.push(doCustomTemplate(cfg.customTemplate.url, cfg.customTemplate.body, payload).then(() => historyId).catch(e => ({ historyId, error: e.message })));
    channelMap.push('custom');
  }

  if (tasks.length === 0) return;

  const results = await Promise.allSettled(tasks);
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const historyId = r.value?.historyId || r.value;
      if (historyId) {
        db.updatePushHistoryStatus(historyId, 'success', '');
        console.log(`[PUSH] ${channelMap[i]} ok`);
      }
    } else {
      const error = r.reason?.message || r.reason;
      const historyId = r.reason?.historyId;
      if (historyId) {
        db.updatePushHistoryStatus(historyId, 'failed', error);
      }
      console.error(`[PUSH] ${channelMap[i]} failed:`, error);
    }
  });
}

function formatPushMessage(sender, text, timestamp, phone) {
  let timeStr = timestamp || new Date().toISOString();
  try {
    const date = new Date(timeStr);
    if (!isNaN(date.getTime())) {
      timeStr = date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }
  } catch (e) {}

  const separator = '────────────────────────────────';
  const content = text.replace(/\n/g, '\n📝 ');

  const msgHtml = `📱 <b>短信转发提醒</b><br>${separator.replace(/─/g, '<br>')}<br>👤 <b>发件人:</b> ${sender}<br>📞 <b>手机号:</b> ${phone}<br>⏰ <b>时间:</b> ${timeStr}<br>${separator.replace(/─/g, '<br>')}<br>📝 <b>短信内容:</b><br>${text.replace(/\n/g, '<br>')}<br>${separator.replace(/─/g, '<br>')}`;

  const msgPlain = `📱 短信转发提醒\n${separator}\n👤 发件人: ${sender}\n📞 手机号: ${phone}\n⏰ 时间: ${timeStr}\n${separator}\n📝 短信内容:\n${text}\n${separator}`;

  const msgTg = `📱 短信转发提醒\n${separator}\n👤 发件人: ${sender}\n📞 手机号: ${phone}\n⏰ 时间: ${timeStr}\n${separator}\n📝 短信内容:\n${text}\n${separator}`;

  return {
    html: msgHtml,
    plain: msgPlain,
    telegram: msgTg,
    title: `📱 短信转发提醒 - ${sender}`
  };
}

async function doTelegram(botToken, chatId, sender, text, timestamp, phone) {
  const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const msgObj = formatPushMessage(sender, text, timestamp, phone);
  const resp = await fetch(tgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msgObj.telegram, parse_mode: 'HTML' })
  });
  if (!resp.ok) throw new Error(`Telegram HTTP ${resp.status}`);
}

async function doDingtalk(webhookUrl, secret, sender, text, timestamp, phone) {
  let url = webhookUrl;
  if (secret) {
    const timestamp2 = Date.now();
    const sign = crypto2.createHmac('sha256', secret).update(`${timestamp2}\n${secret}`).digest('base64');
    const encodedSign = encodeURIComponent(sign);
    url += `&timestamp=${timestamp2}&sign=${encodedSign}`;
  }
  const msgObj = formatPushMessage(sender, text, timestamp, phone);
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: msgObj.plain } })
  });
}

async function doPushplus(token, sender, text, timestamp, phone, channel) {
  const msgObj = formatPushMessage(sender, text, timestamp, phone);
  const resp = await fetch('http://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      title: msgObj.title,
      content: msgObj.html,
      channel: channel || 'wechat'
    })
  });
  if (!resp.ok) throw new Error(`PushPlus HTTP ${resp.status}`);
}

async function doServerChan(sendKey, sender, text, timestamp, phone) {
  const msgObj = formatPushMessage(sender, text, timestamp, phone);
  const scUrl = `https://sctapi.ftqq.com/${sendKey}.send`;
  const resp = await fetch(scUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `title=${encodeURIComponent(msgObj.title)}&desp=${encodeURIComponent(msgObj.plain.replace(/\*/g, ''))}`
  });
  if (!resp.ok) throw new Error(`ServerChan HTTP ${resp.status}`);
}

async function doFeishu(webhookUrl, secret, sender, text, timestamp, phone) {
  const msgObj = formatPushMessage(sender, text, timestamp, phone);
  let bodyObj = { msg_type: 'text', content: { text: msgObj.plain } };
  if (secret) {
    const timestampSec = Math.floor(Date.now() / 1000);
    const sign = crypto2.createHmac('sha256', secret).update(`${timestampSec}\n${secret}`).digest('base64');
    bodyObj = { ...bodyObj, timestamp: String(timestampSec), sign };
  }
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj)
  });
}

async function doBark(barkUrl, sender, text, timestamp, phone) {
  const msgObj = formatPushMessage(sender, text, timestamp, phone);
  const url = barkUrl.endsWith('/') ? barkUrl : barkUrl + '/';
  await fetch(`${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: msgObj.title, body: msgObj.plain })
  });
}

async function doGotify(gotifyUrl, token, sender, text, timestamp, phone) {
  const msgObj = formatPushMessage(sender, text, timestamp, phone);
  const url = gotifyUrl.endsWith('/') ? gotifyUrl : gotifyUrl + '/';
  await fetch(`${url}message?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: msgObj.title, message: msgObj.plain, priority: 5 })
  });
}

async function doPostJson(url, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) throw new Error(`POST JSON HTTP ${resp.status}`);
}

async function doCustomTemplate(url, template, payload) {
  let body = template;
  for (const [k, v] of Object.entries(payload)) {
    body = body.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
}

function connectMQTT() {
  mqttClient = mqtt.connect(mqttUrl, mqttOptions);

  mqttClient.on('connect', () => {
    console.log(`[MQTT] Connected to broker at ${mqttUrl}`);
    mqttClient.subscribe('sms_forwarder/heartbeat/+', { qos: 1 });
    mqttClient.subscribe('sms_forwarder/raw_sms/+', { qos: 1 });
    mqttClient.subscribe('sms_forwarder/resp/+', { qos: 1 });
    mqttClient.subscribe('sms_forwarder/ota/+', { qos: 1 });
    console.log('[MQTT] Subscribed to all device topics');
  });

  mqttClient.on('offline', () => {
    console.log('[MQTT] Disconnected from broker');
  });

  mqttClient.on('error', (err) => {
    console.error('[MQTT] Error:', err.message);
  });

  mqttClient.on('reconnect', () => {
    console.log('[MQTT] Reconnecting...');
  });

  mqttClient.on('message', (topic, message) => {
    try {
      const msgStr = message.toString();
      const parts = topic.split('/');

      if (parts[0] === 'sms_forwarder' && parts.length >= 3) {
        const type = parts[1];
        const mac = parts[2];

        if (type === 'heartbeat') {
          let data;
          try { data = JSON.parse(msgStr); } catch { data = {}; }

          db.upsertDevice(mac, {
            ip: data.ip || '',
            rssi: data.rssi || 0,
            uptime: data.uptime || 0
          });

          broadcastDeviceList();
        }
        else if (type === 'raw_sms') {
          console.log(`[SMS] 收到 raw_sms 消息, mac=${mac}, payload=${msgStr}`);
          let data;
          try {
            data = JSON.parse(msgStr);
          } catch (e) {
            console.log(`[SMS] JSON解析失败: ${e.message}, 原始内容: ${msgStr}`);
            data = { sender: '?', text: msgStr, timestamp: new Date().toISOString() };
          }

          const receivedAt = new Date().toISOString();
          let smsTimestamp = data.timestamp || receivedAt;
          const tsDate = new Date(smsTimestamp);
          if (isNaN(tsDate.getTime()) || tsDate.getFullYear() > 2099 || tsDate.getFullYear() < 2020) {
            console.log(`[SMS] 时间戳无效或异常: ${smsTimestamp}, 使用服务器时间`);
            smsTimestamp = receivedAt;
          }

          const smsRecord = {
            id: crypto.randomUUID(),
            mac,
            deviceIp: db.getDeviceList().find(d => d.mac === mac)?.ip || '',
            sender: data.sender || '?',
            text: data.text || '',
            timestamp: smsTimestamp,
            phone: data.phone || '?',
            receivedAt
          };

          console.log(`[SMS] 解析后的数据: sender=${smsRecord.sender}, text=${smsRecord.text.substring(0, 50)}...`);

          let smsId = null;
          try {
            smsId = db.insertSms({
              mac,
              sender: data.sender || '',
              text: data.text || '',
              phone: data.phone || '',
              timestamp: smsRecord.timestamp
            });
            console.log(`[SMS] 数据库插入成功, id=${smsId}`);
          } catch (e) {
            console.log(`[SMS] 数据库插入失败: ${e.message}`);
          }

          dispatchPush({
            sender: data.sender || '',
            text: data.text || '',
            timestamp: smsRecord.timestamp,
            phone: data.phone || ''
          }, smsId);

          if (smsId !== null) {
            smsRecord.id = smsId;
            console.log(`[SMS] ${mac} | ${data.sender} | ${data.text}`);
            broadcastSMS(smsRecord);
          }
        }
        else if (type === 'resp') {
          let data;
          try {
            data = JSON.parse(msgStr);
          } catch {
            data = { action: '?', success: false, message: msgStr };
          }

          if (pendingCmds.has(mac)) {
            const callbacks = pendingCmds.get(mac);
            callbacks.forEach(cb => {
              try { cb(data); } catch (e) { console.error('[Resp CB error]:', e); }
            });
            pendingCmds.delete(mac);
          }

          broadcastResp(mac, data);
        }
        else if (type === 'ota') {
          let data;
          try {
            data = JSON.parse(msgStr);
          } catch {
            data = { status: '?', message: msgStr };
          }
          console.log(`[OTA] ${mac} | ${data.status} | ${data.message}`);
          broadcastResp(mac, { action: 'ota', ...data });
        }
      }
    } catch (e) {
      console.error('[MQTT message error]:', e.message);
    }
  });

  return mqttClient;
}

setInterval(() => {
  broadcastDeviceList();
}, 60000);

setInterval(() => {
  const pendingTasks = db.getPendingSchedules();
  
  if (pendingTasks.length > 0) {
    console.log(`[Schedule] Processing ${pendingTasks.length} pending tasks`);
  }
  
  pendingTasks.forEach(task => {
    console.log(`[Schedule] Executing task ${task.id}: ${task.phone} -> ${task.content.substring(0, 20)}...`);
    
    sendCmdToDevice(task.mac, 'send_sms', {
      phone: task.phone,
      content: task.content
    }).then(result => {
      const runTime = Date.now();
      
      if (task.schedule_type === 'once') {
        db.insertScheduleHistory({
          task_id: task.id,
          run_time: runTime,
          status: 'success',
          response: result.message || '发送成功'
        });
        db.updateScheduledSmsStatus(task.id, 'completed');
        console.log(`[Schedule] Task ${task.id} completed`);
        
        broadcastScheduleEvent('completed', { 
          taskId: task.id, 
          runTime,
          message: '一次性任务已完成' 
        });
        
      } else if (task.schedule_type === 'interval') {
        const intervalDays = task.interval_days || 1;
        const targetHour = task.interval_hours || 0;
        const targetMinute = task.interval_minutes || 0;
        
        const nextRun = calculateNextRunTimeFromRunTime(runTime, targetHour, targetMinute, intervalDays);
        
        db.updateScheduledSmsNextRun(task.id, nextRun, intervalDays, targetHour, targetMinute);
        db.insertScheduleHistory({
          task_id: task.id,
          run_time: runTime,
          status: 'success',
          response: result.message || '发送成功'
        });
        console.log(`[Schedule] Task ${task.id} interval run, next: ${new Date(nextRun).toISOString()}`);
        
        broadcastScheduleEvent('executed', { 
          taskId: task.id, 
          runTime,
          nextRun,
          message: `发送成功，下次: ${new Date(nextRun).toLocaleString()}` 
        });
      }
      
      dispatchPush({
        sender: '系统',
        text: `【定时短信】任务执行成功\n\n目标: ${task.phone}\n内容: ${task.content}\n时间: ${new Date(runTime).toLocaleString()}`,
        timestamp: new Date(runTime).toISOString(),
        phone: task.phone
      });
      
    }).catch(err => {
      console.error(`[Schedule] Task ${task.id} failed:`, err.message);
      
      const runTime = Date.now();
      db.insertScheduleHistory({
        task_id: task.id,
        run_time: runTime,
        status: 'failed',
        response: err.message || '发送失败'
      });
      
      if (task.schedule_type === 'once') {
        db.updateScheduledSmsStatus(task.id, 'failed');
        broadcastScheduleEvent('failed', { 
          taskId: task.id, 
          runTime,
          message: `发送失败: ${err.message}，任务已停止` 
        });
      } else {
        const intervalDays = task.interval_days || 1;
        const targetHour = task.interval_hours || 0;
        const targetMinute = task.interval_minutes || 0;
        
        const nextRun = calculateNextRunTimeFromRunTime(runTime, targetHour, targetMinute, intervalDays);
        
        db.updateScheduledSmsNextRun(task.id, nextRun, intervalDays, targetHour, targetMinute);
        broadcastScheduleEvent('failed', { 
          taskId: task.id, 
          runTime,
          message: `发送失败，将在下次间隔后重试: ${err.message}` 
        });
      }
    });
  });
}, 60000);

connectMQTT();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================`);
  console.log(`  SMS Forwarder Server v2.0`);
  console.log(`====================================`);
  console.log(`  HTTP:      http://0.0.0.0:${PORT}`);
  console.log(`  WebSocket: ws://0.0.0.0:${PORT}${WS_PATH}`);
  console.log(`  MQTT:      ${mqttUrl}`);
  console.log(`====================================`);
  console.log(`  Default credentials: admin/admin123`);
  console.log(`====================================`);
});

process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down...');
  server.close(() => {
    if (mqttClient) mqttClient.end();
    db.getDatabase().close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down...');
  server.close(() => {
    if (mqttClient) mqttClient.end();
    db.getDatabase().close();
    process.exit(0);
  });
});
