#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <pdulib.h>
#include "wifi_config.h"

#define TXD 3
#define RXD 4
#define MODEM_EN_PIN 5

#ifndef LED_BUILTIN
#define LED_BUILTIN 8
#endif

#define SERIAL_BUFFER_SIZE 500
#define MAX_PDU_LENGTH 300
#define MAX_CONCAT_PARTS 20
#define CONCAT_TIMEOUT_MS 30000
#define MAX_CONCAT_MESSAGES 5
#define RECENT_CONCAT_CACHE_SIZE 5
#define RECENT_CONCAT_IGNORE_MS 120000

#define MQTT_SERVER "192.168.31.197"
#define MQTT_PORT 1883
#define MQTT_RECONNECT_INTERVAL 5000
#define HEARTBEAT_INTERVAL 60000
#define CURRENT_FIRMWARE_VERSION "1.0.1"

PDU pdu = PDU(4096);
WiFiClient espClient;
PubSubClient mqttClient(espClient);

String phoneNumber = "";
unsigned long lastHeartbeat = 0;
unsigned long lastMqttReconnect = 0;
String deviceMAC = "";
String currentRequestId = "";
unsigned long lastPhoneRefreshAt = 0;
unsigned long lastQueueFlushAttempt = 0;

#define OFFLINE_QUEUE_SIZE 10
#define MQTT_BUFFER_SIZE 4096
#define PHONE_REFRESH_INTERVAL 1800000UL
#define QUEUE_FLUSH_INTERVAL 300UL
#define ASYNC_CMD_BUFFER_SIZE 768
#define TRAFFIC_BATCH_KB 8
#define TRAFFIC_SAFE_LIMIT_KB 1024
#define SIGNAL_CACHE_TTL 5000UL
#define NETWORK_CACHE_TTL 5000UL
#define SIMINFO_CACHE_TTL 600000UL

// Roaming networks can have higher latency; keep SMS send timeout longer.
#define SEND_SMS_TOTAL_TIMEOUT_MS 50000UL

enum AsyncTaskType {
  ASYNC_TASK_NONE = 0,
  ASYNC_TASK_PING,
  ASYNC_TASK_TRAFFIC
};

enum AsyncTaskStep {
  ASYNC_STEP_IDLE = 0,
  ASYNC_STEP_ACTIVATE_WAIT,
  ASYNC_STEP_MPING_WAIT,
  ASYNC_STEP_DEACTIVATE_WAIT
};

struct AsyncTaskState {
  AsyncTaskType type;
  AsyncTaskStep step;
  bool active;
  unsigned long stepStartedAt;
  unsigned long totalBytes;
  int targetKb;
  int currentMpingBytes;
  bool pingResultSuccess;
  String requestId;
  String responseBuffer;
  String resultMessage;
};

AsyncTaskState asyncTask = { ASYNC_TASK_NONE, ASYNC_STEP_IDLE, false, 0, 0, 0, 0, false, "", "", "" };
bool urcWaitingPdu = false;

struct RequestIdScope {
  String previous;
  bool active;
};

struct QueryCacheEntry {
  String message;
  unsigned long updatedAt;
  bool valid;
};

QueryCacheEntry signalCache = { "", 0, false };
QueryCacheEntry networkCache = { "", 0, false };
QueryCacheEntry simInfoCache = { "", 0, false };

struct PendingSms {
  String sender;
  String text;
  String timestamp;
  String phone;
};

PendingSms offlineQueue[OFFLINE_QUEUE_SIZE];
uint8_t queueHead = 0;
uint8_t queueTail = 0;
uint8_t queueCount = 0;
bool queueValid[OFFLINE_QUEUE_SIZE] = {0};

struct SmsPart {
  bool valid;
  String text;
};

struct ConcatSms {
  bool inUse;
  int refNumber;
  String sender;
  String timestamp;
  int totalParts;
  int receivedParts;
  unsigned long firstPartTime;
  SmsPart parts[MAX_CONCAT_PARTS];
};

struct RecentConcatMessage {
  bool valid;
  int refNumber;
  String sender;
  String timestamp;
  unsigned long completedAt;
};

ConcatSms concatBuffer[MAX_CONCAT_MESSAGES];
RecentConcatMessage recentConcatMessages[RECENT_CONCAT_CACHE_SIZE];

void blink_short(unsigned long gap_time = 500) {
  digitalWrite(LED_BUILTIN, LOW);
  delay(50);
  digitalWrite(LED_BUILTIN, HIGH);
  delay(gap_time);
}

bool sendATandWaitOK(const char* cmd, unsigned long timeout) {
  while (Serial1.available()) Serial1.read();
  Serial1.println(cmd);
  unsigned long start = millis();
  String resp = "";
  while (millis() - start < timeout) {
    while (Serial1.available()) {
      char c = Serial1.read();
      resp += c;
      if (resp.indexOf("OK") >= 0) return true;
      if (resp.indexOf("ERROR") >= 0) return false;
    }
  }
  return false;
}

String sendATCommand(const char* cmd, unsigned long timeout) {
  while (Serial1.available()) Serial1.read();
  Serial1.println(cmd);
  unsigned long start = millis();
  String resp = "";
  resp.reserve(ASYNC_CMD_BUFFER_SIZE);
  while (millis() - start < timeout) {
    while (Serial1.available()) {
      char c = Serial1.read();
      resp += c;
      if (resp.indexOf("OK") >= 0 || resp.indexOf("ERROR") >= 0) {
        delay(50);
        while (Serial1.available()) resp += (char)Serial1.read();
        return resp;
      }
    }
    delay(1);
  }
  Serial.println(String("[AT] Timeout: ") + cmd + ", elapsed=" + String(millis() - start) + "ms");
  return resp;
}

void modemPowerCycle() {
  pinMode(MODEM_EN_PIN, OUTPUT);
  digitalWrite(MODEM_EN_PIN, LOW);
  delay(1200);
  digitalWrite(MODEM_EN_PIN, HIGH);
  delay(6000);
}

void resetModule() {
  Serial.println("硬重启模组...");
  modemPowerCycle();
  while (Serial1.available()) Serial1.read();
  bool ok = false;
  for (int i = 0; i < 10; i++) {
    if (sendATandWaitOK("AT", 1000)) { ok = true; break; }
    Serial.println("等待模组启动...");
  }
  Serial.println(ok ? "模组AT恢复正常" : "模组AT仍未响应");
}

bool sendSMS(const char* phoneNum, const char* message, String& outMessage) {
  Serial.println("发送短信...");
  Serial.print("目标号码: "); Serial.println(phoneNum);
  Serial.print("内容: "); Serial.println(message);

  const unsigned long SMS_TOTAL_TIMEOUT_MS = SEND_SMS_TOTAL_TIMEOUT_MS;
  const unsigned long startAll = millis();

  pdu.setSCAnumber();
  int pduLen = pdu.encodePDU(phoneNum, message);
  if (pduLen < 0) {
    Serial.print("PDU编码失败: "); Serial.println(pduLen);
    outMessage = "PDU编码失败";
    return false;
  }

  String cmgsCmd = "AT+CMGS=";
  cmgsCmd += pduLen;
  while (Serial1.available()) Serial1.read();
  Serial1.println(cmgsCmd);

  bool gotPrompt = false;
  while (millis() - startAll < SMS_TOTAL_TIMEOUT_MS) {
    // Keep MQTT connection alive while waiting on modem
    if (mqttClient.connected()) mqttClient.loop();
    if (Serial1.available()) {
      char c = Serial1.read();
      Serial.print(c);
      if (c == '>') { gotPrompt = true; break; }
    }
    delay(1);
  }
  if (!gotPrompt) {
    Serial.println("未收到>提示符");
    outMessage = "未收到发送提示符";
    return false;
  }

  Serial1.print(pdu.getSMS());
  Serial1.write(0x1A);

  String resp = "";
  while (millis() - startAll < SMS_TOTAL_TIMEOUT_MS) {
    // Keep MQTT connection alive while waiting on modem
    if (mqttClient.connected()) mqttClient.loop();
    while (Serial1.available()) {
      char c = Serial1.read();
      resp += c;
      Serial.print(c);
      if (resp.indexOf("OK") >= 0) {
        Serial.println("短信发送成功");
        outMessage = "短信发送成功";
        return true;
      }
      if (resp.indexOf("ERROR") >= 0) {
        Serial.println("短信发送失败");
        outMessage = "短信发送失败";
        return false;
      }
    }
    delay(1);
  }
  Serial.println("短信发送超时");
  outMessage = "短信发送超时";
  return false;
}

void initConcatBuffer() {
  for (int i = 0; i < MAX_CONCAT_MESSAGES; i++) {
    concatBuffer[i].inUse = false;
    concatBuffer[i].receivedParts = 0;
    for (int j = 0; j < MAX_CONCAT_PARTS; j++) {
      concatBuffer[i].parts[j].valid = false;
      concatBuffer[i].parts[j].text = "";
    }
  }

  for (int i = 0; i < RECENT_CONCAT_CACHE_SIZE; i++) {
    recentConcatMessages[i].valid = false;
    recentConcatMessages[i].refNumber = 0;
    recentConcatMessages[i].sender = "";
    recentConcatMessages[i].timestamp = "";
    recentConcatMessages[i].completedAt = 0;
  }
}

bool isRecentlyCompletedConcat(int refNumber, const char* sender, const char* timestamp) {
  unsigned long now = millis();
  for (int i = 0; i < RECENT_CONCAT_CACHE_SIZE; i++) {
    if (!recentConcatMessages[i].valid) continue;
    if (now - recentConcatMessages[i].completedAt > RECENT_CONCAT_IGNORE_MS) {
      recentConcatMessages[i].valid = false;
      continue;
    }
    if (recentConcatMessages[i].refNumber == refNumber &&
        recentConcatMessages[i].sender.equals(sender) &&
        recentConcatMessages[i].timestamp.equals(timestamp)) {
      return true;
    }
  }
  return false;
}

void rememberCompletedConcat(int refNumber, const char* sender, const char* timestamp) {
  int slot = -1;
  unsigned long oldestTime = millis();

  for (int i = 0; i < RECENT_CONCAT_CACHE_SIZE; i++) {
    if (!recentConcatMessages[i].valid) {
      slot = i;
      break;
    }
    if (recentConcatMessages[i].completedAt <= oldestTime) {
      oldestTime = recentConcatMessages[i].completedAt;
      slot = i;
    }
  }

  if (slot >= 0) {
    recentConcatMessages[slot].valid = true;
    recentConcatMessages[slot].refNumber = refNumber;
    recentConcatMessages[slot].sender = String(sender);
    recentConcatMessages[slot].timestamp = String(timestamp);
    recentConcatMessages[slot].completedAt = millis();
  }
}

int findOrCreateConcatSlot(int refNumber, const char* sender, const char* timestamp, int totalParts) {
  for (int i = 0; i < MAX_CONCAT_MESSAGES; i++) {
    if (concatBuffer[i].inUse &&
        concatBuffer[i].refNumber == refNumber &&
        concatBuffer[i].sender.equals(sender) &&
        concatBuffer[i].timestamp.equals(timestamp) &&
        concatBuffer[i].totalParts == totalParts) {
      return i;
    }
  }
  for (int i = 0; i < MAX_CONCAT_MESSAGES; i++) {
    if (!concatBuffer[i].inUse) {
      concatBuffer[i].inUse = true;
      concatBuffer[i].refNumber = refNumber;
      concatBuffer[i].sender = String(sender);
      concatBuffer[i].timestamp = String(timestamp);
      concatBuffer[i].totalParts = totalParts;
      concatBuffer[i].receivedParts = 0;
      concatBuffer[i].firstPartTime = millis();
      for (int j = 0; j < MAX_CONCAT_PARTS; j++) {
        concatBuffer[i].parts[j].valid = false;
        concatBuffer[i].parts[j].text = "";
      }
      return i;
    }
  }
  int oldestSlot = 0;
  unsigned long oldestTime = concatBuffer[0].firstPartTime;
  for (int i = 1; i < MAX_CONCAT_MESSAGES; i++) {
    if (concatBuffer[i].firstPartTime < oldestTime) {
      oldestTime = concatBuffer[i].firstPartTime;
      oldestSlot = i;
    }
  }
  Serial.printf("长短信缓存已满，覆盖最早分段缓存: sender=%s ref=%d\n", concatBuffer[oldestSlot].sender.c_str(), concatBuffer[oldestSlot].refNumber);
  concatBuffer[oldestSlot].inUse = true;
  concatBuffer[oldestSlot].refNumber = refNumber;
  concatBuffer[oldestSlot].sender = String(sender);
  concatBuffer[oldestSlot].timestamp = String(timestamp);
  concatBuffer[oldestSlot].totalParts = totalParts;
  concatBuffer[oldestSlot].receivedParts = 0;
  concatBuffer[oldestSlot].firstPartTime = millis();
  for (int j = 0; j < MAX_CONCAT_PARTS; j++) {
    concatBuffer[oldestSlot].parts[j].valid = false;
    concatBuffer[oldestSlot].parts[j].text = "";
  }
  return oldestSlot;
}

String assembleConcatSms(int slot) {
  String result = "";
  for (int i = 0; i < concatBuffer[slot].totalParts; i++) {
    if (concatBuffer[slot].parts[i].valid) result += concatBuffer[slot].parts[i].text;
    else result += "[缺失分段" + String(i + 1) + "]";
  }
  return result;
}

void clearConcatSlot(int slot) {
  concatBuffer[slot].inUse = false;
  concatBuffer[slot].receivedParts = 0;
  concatBuffer[slot].firstPartTime = 0;
  concatBuffer[slot].sender = "";
  concatBuffer[slot].timestamp = "";
  for (int j = 0; j < MAX_CONCAT_PARTS; j++) {
    concatBuffer[slot].parts[j].valid = false;
    concatBuffer[slot].parts[j].text = "";
  }
}

bool isHexString(const String& str) {
  if (str.length() == 0) return false;
  for (unsigned int i = 0; i < str.length(); i++) {
    char c = str.charAt(i);
    if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

String readSerialLine(HardwareSerial& port) {
  static char lineBuf[SERIAL_BUFFER_SIZE];
  static int linePos = 0;
  while (port.available()) {
    char c = port.read();
    if (c == '\n') {
      lineBuf[linePos] = 0;
      String res = String(lineBuf);
      linePos = 0;
      return res;
    } else if (c != '\r') {
      if (linePos < SERIAL_BUFFER_SIZE - 1) lineBuf[linePos++] = c;
      else linePos = 0;
    }
  }
  return "";
}

void resetAsyncTaskState() {
  asyncTask.type = ASYNC_TASK_NONE;
  asyncTask.step = ASYNC_STEP_IDLE;
  asyncTask.active = false;
  asyncTask.stepStartedAt = 0;
  asyncTask.totalBytes = 0;
  asyncTask.targetKb = 0;
  asyncTask.currentMpingBytes = 0;
  asyncTask.pingResultSuccess = false;
  asyncTask.requestId = "";
  asyncTask.responseBuffer = "";
  asyncTask.resultMessage = "";
}

bool isAsyncTaskBusy() {
  return asyncTask.active;
}

bool isAtSensitiveAction(const char* action) {
  return strcmp(action, "ping") == 0 ||
         strcmp(action, "consume_traffic") == 0 ||
         strcmp(action, "flight_mode") == 0 ||
         strcmp(action, "at") == 0 ||
         strcmp(action, "query") == 0 ||
         strcmp(action, "query_sim") == 0 ||
         strcmp(action, "send_sms") == 0;
}

String getBusyActionName() {
  if (asyncTask.type == ASYNC_TASK_PING) return "ping";
  if (asyncTask.type == ASYNC_TASK_TRAFFIC) return "consume_traffic";
  return "task";
}

bool shouldRefreshPhoneNumber() {
  if (phoneNumber.length() == 0 || phoneNumber == "未知") return true;
  return millis() - lastPhoneRefreshAt >= PHONE_REFRESH_INTERVAL;
}

void refreshPhoneNumberIfNeeded(bool force = false) {
  if (isAsyncTaskBusy()) return;
  if (!force && !shouldRefreshPhoneNumber()) return;
  phoneNumber = "";
  getPhoneNumber();
  lastPhoneRefreshAt = millis();
}

void beginAsyncTask(AsyncTaskType type, const String& requestId) {
  resetAsyncTaskState();
  asyncTask.type = type;
  asyncTask.active = true;
  asyncTask.requestId = requestId;
  asyncTask.stepStartedAt = millis();
  asyncTask.responseBuffer.reserve(ASYNC_CMD_BUFFER_SIZE);
  asyncTask.resultMessage.reserve(160);
}

RequestIdScope pushRequestIdScope(const String& requestId) {
  RequestIdScope scope = { currentRequestId, false };
  if (requestId.length() > 0) {
    currentRequestId = requestId;
    scope.active = true;
  }
  return scope;
}

void popRequestIdScope(const RequestIdScope& scope) {
  if (scope.active) {
    currentRequestId = scope.previous;
  }
}

void invalidateQueryCaches() {
  signalCache.valid = false;
  networkCache.valid = false;
  simInfoCache.valid = false;
}

bool isQueryCacheValid(const QueryCacheEntry& entry, unsigned long ttlMs) {
  if (!entry.valid) return false;
  return millis() - entry.updatedAt <= ttlMs;
}

void updateQueryCache(QueryCacheEntry& entry, const String& message) {
  entry.message = message;
  entry.updatedAt = millis();
  entry.valid = true;
}

String extractQuotedValue(const String& text, int startSearch = 0) {
  int firstQuote = text.indexOf('"', startSearch);
  if (firstQuote < 0) return "";
  int secondQuote = text.indexOf('"', firstQuote + 1);
  if (secondQuote <= firstQuote) return "";
  return text.substring(firstQuote + 1, secondQuote);
}

String extractLineAfterPrefix(const String& resp, const char* prefix) {
  int idx = resp.indexOf(prefix);
  if (idx < 0) return "";
  String tmp = resp.substring(idx + strlen(prefix));
  int endIdx = tmp.indexOf('\r');
  if (endIdx < 0) endIdx = tmp.indexOf('\n');
  if (endIdx > 0) tmp = tmp.substring(0, endIdx);
  tmp.trim();
  return tmp;
}

String extractNextResponseLine(const String& resp) {
  int start = resp.indexOf('\n');
  if (start < 0) return "";
  int end = resp.indexOf('\n', start + 1);
  if (end < 0) end = resp.indexOf('\r', start + 1);
  if (end <= start) return "";
  String value = resp.substring(start + 1, end);
  value.trim();
  return value;
}

bool withCachedQuery(QueryCacheEntry& cache, unsigned long ttlMs, String& msg, bool& success, bool (*builder)(String&)) {
  if (isQueryCacheValid(cache, ttlMs)) {
    success = true;
    msg = cache.message;
    return true;
  }
  if (isAsyncTaskBusy()) {
    success = false;
    msg = "设备忙碌，正在执行 " + getBusyActionName();
    return true;
  }
  success = builder(msg);
  if (success) {
    updateQueryCache(cache, msg);
  }
  return true;
}

void finishAsyncTask(bool success, const String& message) {
  String action = asyncTask.type == ASYNC_TASK_TRAFFIC ? "consume_traffic" : "ping";
  RequestIdScope scope = pushRequestIdScope(asyncTask.requestId);
  publishResp(action.c_str(), success, message);
  popRequestIdScope(scope);
  resetAsyncTaskState();
}

String getPhoneNumber() {
  if (phoneNumber.length() > 0) return phoneNumber;
  String resp = sendATCommand("AT+CNUM", 2000);
  if (resp.indexOf("+CNUM:") >= 0) {
    phoneNumber = extractQuotedValue(resp, resp.indexOf(",\""));
  }
  if (phoneNumber.length() == 0) phoneNumber = "未知";
  return phoneNumber;
}

String jsonEscape(const String& str) {
  String result = "";
  for (unsigned int i = 0; i < str.length(); i++) {
    char c = str.charAt(i);
    if (c == '"') result += "\\\"";
    else if (c == '\\') result += "\\\\";
    else if (c == '\n') result += "\\n";
    else if (c == '\r') result += "\\r";
    else if (c == '\t') result += "\\t";
    else result += c;
  }
  return result;
}

String formatPDUTime(const char* ts) {
  int len = strlen(ts);
  if (len < 12) return "";
  
  int year, month, day, hour, minute, second;
  year = (ts[0] - '0') * 10 + (ts[1] - '0');
  month = (ts[2] - '0') * 10 + (ts[3] - '0');
  day = (ts[4] - '0') * 10 + (ts[5] - '0');
  hour = (ts[6] - '0') * 10 + (ts[7] - '0');
  minute = (ts[8] - '0') * 10 + (ts[9] - '0');
  second = (ts[10] - '0') * 10 + (ts[11] - '0');
  
  year += (year < 80) ? 2000 : 1900;
  
  if (year < 2000 || year > 2099) year += 100;
  if (month < 1 || month > 12) return "";
  if (day < 1 || day > 31) return "";
  if (hour > 23 || minute > 59 || second > 59) return "";
  
  char buf[32];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02d %02d:%02d:%02d", year, month, day, hour, minute, second);
  return String(buf);
}

String formatTime(const char* timestamp) {
  if (timestamp == nullptr || strlen(timestamp) == 0) {
    return "";
  }
  
  int len = strlen(timestamp);
  
  if (len >= 12 && len <= 20 && timestamp[2] == '/' && timestamp[5] == ',') {
    int year, month, day, hour, minute, second;
    if (sscanf(timestamp, "%d/%d/%d,%d:%d:%d", &year, &month, &day, &hour, &minute, &second) == 6) {
      year += (year < 80) ? 2000 : 1900;
      if (year >= 2000 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        char buf[32];
        snprintf(buf, sizeof(buf), "%04d-%02d-%02d %02d:%02d:%02d", year, month, day, hour, minute, second);
        return String(buf);
      }
    }
  }
  
  if (len >= 12 && len <= 16) {
    String pduResult = formatPDUTime(timestamp);
    if (pduResult.length() > 0) {
      return pduResult;
    }
  }
  
  time_t ts = atoi(timestamp);
  if (ts > 0 && ts <= 2147483647) {
    struct tm *tm_info = localtime(&ts);
    if (tm_info && tm_info->tm_year >= 0) {
      if (tm_info->tm_year < 70 || tm_info->tm_year > 137) {
        return "";
      }
      char buf[32];
      strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", tm_info);
      return String(buf);
    }
  }
  
  return "";
}

String getLocalTimeStr() {
  time_t now = time(nullptr);
  struct tm *tm_info = localtime(&now);
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", tm_info);
  return String(buf);
}

String buildSmsPayload(const char* sender, const char* text, const char* timestamp) {
  String formattedTime = formatTime(timestamp);
  if (formattedTime.length() == 0) {
    formattedTime = getLocalTimeStr();
  }

  String phone = getPhoneNumber();
  size_t capacity = JSON_OBJECT_SIZE(4) + formattedTime.length() + phone.length() + strlen(sender) + strlen(text) + 256;
  DynamicJsonDocument doc(capacity);
  doc["sender"] = sender;
  doc["text"] = text;
  doc["timestamp"] = formattedTime;
  doc["phone"] = phone;

  String payload;
  payload.reserve(capacity);
  serializeJson(doc, payload);
  return payload;
}

bool enqueueOfflineSMS(const char* sender, const char* text, const char* timestamp) {
  if (queueCount >= OFFLINE_QUEUE_SIZE) {
    uint8_t oldHead = queueHead;
    queueHead = (queueHead + 1) % OFFLINE_QUEUE_SIZE;
    queueCount--;
    queueValid[oldHead] = false;
  }
  
  String ts = formatTime(timestamp);
  offlineQueue[queueTail].sender = String(sender);
  offlineQueue[queueTail].text = String(text);
  offlineQueue[queueTail].timestamp = ts.length() > 0 ? ts : getLocalTimeStr();
  offlineQueue[queueTail].phone = getPhoneNumber();
  queueValid[queueTail] = true;
  
  queueTail = (queueTail + 1) % OFFLINE_QUEUE_SIZE;
  queueCount++;
  
  Serial.println("[Queue] SMS queued, count: " + String(queueCount));
  return true;
}

bool flushOfflineQueue(uint8_t maxMessages = 1) {
  if (queueCount == 0) return true;
  if (!mqttClient.connected()) return false;

  uint8_t flushed = 0;
  while (queueCount > 0 && flushed < maxMessages) {
    if (!queueValid[queueHead]) {
      queueHead = (queueHead + 1) % OFFLINE_QUEUE_SIZE;
      queueCount--;
      continue;
    }

    String payload;
    {
      size_t capacity = JSON_OBJECT_SIZE(4) + offlineQueue[queueHead].sender.length() + offlineQueue[queueHead].text.length() + offlineQueue[queueHead].timestamp.length() + offlineQueue[queueHead].phone.length() + 256;
      DynamicJsonDocument doc(capacity);
      doc["sender"] = offlineQueue[queueHead].sender;
      doc["text"] = offlineQueue[queueHead].text;
      doc["timestamp"] = offlineQueue[queueHead].timestamp;
      doc["phone"] = offlineQueue[queueHead].phone;
      payload.reserve(capacity);
      serializeJson(doc, payload);
    }

    String topic = "sms_forwarder/raw_sms/" + deviceMAC;
    bool ok = mqttClient.publish(topic.c_str(), payload.c_str());
    if (!ok) {
      Serial.println("[Queue] Flush publish failed, keeping queued SMS");
      return false;
    }

    queueValid[queueHead] = false;
    offlineQueue[queueHead].sender = "";
    offlineQueue[queueHead].text = "";
    offlineQueue[queueHead].timestamp = "";
    offlineQueue[queueHead].phone = "";
    queueHead = (queueHead + 1) % OFFLINE_QUEUE_SIZE;
    queueCount--;
    flushed++;
  }

  if (flushed > 0) {
    Serial.println("[Queue] Flushed messages: " + String(flushed) + ", remaining=" + String(queueCount));
  }
  return queueCount == 0;
}

void publishHeartbeat() {
  StaticJsonDocument<384> doc;
  doc["ip"] = WiFi.localIP().toString();
  doc["phone"] = phoneNumber.length() > 0 ? phoneNumber : "未知";
  doc["rssi"] = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;
  doc["version"] = CURRENT_FIRMWARE_VERSION;
  JsonObject wifi = doc.createNestedObject("wifi");
  wifi["connected"] = WiFi.isConnected();
  wifi["ssid"] = WiFi.SSID();
  JsonObject sim = doc.createNestedObject("sim");
  sim["ready"] = (phoneNumber.length() > 0 && phoneNumber != "未知");
  JsonObject queue = doc.createNestedObject("queue");
  queue["offlineSms"] = queueCount;
  String topic = "sms_forwarder/heartbeat/" + deviceMAC;
  char buf[384];
  serializeJson(doc, buf);
  mqttClient.publish(topic.c_str(), buf);
  Serial.println("[MQTT] Heartbeat sent: " + String(buf));
}

bool publishRawSMS(const char* sender, const char* text, const char* timestamp) {
  Serial.println("[SMS] 准备发送短信到服务器...");
  Serial.println("[SMS] sender=" + String(sender) + ", text=" + String(text));
  Serial.println("[SMS] 原始时间戳: " + String(timestamp ? timestamp : "(null)"));

  String payload = buildSmsPayload(sender, text, timestamp);
  String topic = "sms_forwarder/raw_sms/" + deviceMAC;
  Serial.println("[SMS] Topic: " + topic);
  Serial.println("[SMS] Payload length: " + String(payload.length()));
  if (payload.length() >= MQTT_BUFFER_SIZE) {
    Serial.println("[SMS] Payload exceeds MQTT buffer, storing in offline queue");
    return enqueueOfflineSMS(sender, text, timestamp);
  }
  
  if (mqttClient.connected()) {
    Serial.println("[SMS] MQTT已连接，准备发送...");
    if (!flushOfflineQueue(1)) {
      Serial.println("[SMS] 离线队列刷新失败，当前短信改为入队");
      return enqueueOfflineSMS(sender, text, timestamp);
    }
    mqttClient.loop();
    delay(10);
    boolean result = mqttClient.publish(topic.c_str(), payload.c_str());
    Serial.println("[SMS] MQTT发送结果: " + String(result ? "成功" : "失败"));
    if (result) {
      Serial.println("[MQTT] SMS published");
      return true;
    }
    Serial.println("[SMS] MQTT发送失败，转入离线队列");
    return enqueueOfflineSMS(sender, text, timestamp);
  } else {
    Serial.println("[SMS] MQTT未连接，存入离线队列");
    return enqueueOfflineSMS(sender, text, timestamp);
  }
}

void publishRespDoc(DynamicJsonDocument& doc) {
  if (currentRequestId.length() > 0 && !doc.containsKey("requestId")) {
    doc["requestId"] = currentRequestId;
  }
  String payload;
  payload.reserve(512);
  serializeJson(doc, payload);
  String topic = "sms_forwarder/resp/" + deviceMAC;

  // Ensure response is sent promptly, even after a long modem operation.
  // Try to reconnect and retry publish a few times to avoid the server waiting.
  if (!mqttClient.connected()) {
    unsigned long start = millis();
    while (!mqttClient.connected() && millis() - start < 3000) {
      mqttReconnect();
      mqttClient.loop();
      delay(120);
    }
  }

  bool published = false;
  for (int i = 0; i < 3; i++) {
    if (!mqttClient.connected()) {
      mqttReconnect();
      mqttClient.loop();
      delay(120);
      continue;
    }
    published = mqttClient.publish(topic.c_str(), payload.c_str());
    mqttClient.loop();
    if (published) break;
    delay(60);
  }

  Serial.println(String("[MQTT] Resp ") + (published ? "sent" : "send_failed") + ": " + payload);
}

void publishResp(const char* action, bool success, const String& message) {
  DynamicJsonDocument doc(1024);
  doc["action"] = action;
  doc["success"] = success;
  doc["message"] = message;
  publishRespDoc(doc);
}

String parseMpingResultMessage(const String& mpingLine, bool& success) {
  success = false;
  int colonIdx = mpingLine.indexOf(':');
  if (colonIdx < 0) return "Ping结果解析失败";
  String params = mpingLine.substring(colonIdx + 1);
  params.trim();
  int commaIdx = params.indexOf(',');
  String resultStr = commaIdx >= 0 ? params.substring(0, commaIdx) : params;
  resultStr.trim();
  int result = resultStr.toInt();
  success = (result == 0 || result == 1);
  if (!success) return "Ping超时或目标不可达 (错误码: " + String(result) + ")";
  if (commaIdx < 0) return "Ping成功";
  String rest = params.substring(commaIdx + 1);
  String ip;
  int idx2;
  if (rest.startsWith("\"")) {
    int quoteEnd = rest.indexOf('"', 1);
    if (quoteEnd >= 0) {
      ip = rest.substring(1, quoteEnd);
      idx2 = rest.indexOf(',', quoteEnd);
    } else {
      idx2 = rest.indexOf(',');
      ip = rest.substring(0, idx2);
    }
  } else {
    idx2 = rest.indexOf(',');
    ip = rest.substring(0, idx2);
  }
  if (idx2 < 0) return "Ping成功";
  rest = rest.substring(idx2 + 1);
  int idx3 = rest.indexOf(',');
  if (idx3 < 0) return "Ping成功";
  rest = rest.substring(idx3 + 1);
  int idx4 = rest.indexOf(',');
  String timeStr = idx4 >= 0 ? rest.substring(0, idx4) : rest;
  String ttlStr = idx4 >= 0 ? rest.substring(idx4 + 1) : "N/A";
  timeStr.trim();
  ttlStr.trim();
  return "目标: " + ip + ", 延迟: " + timeStr + "ms, TTL: " + ttlStr;
}

bool isExactOkLine(const String& line) {
  return line == "OK";
}

bool isErrorLine(const String& line) {
  return line.indexOf("+CME ERROR") >= 0 || line == "ERROR";
}

bool isCgactQueryLine(const String& line) {
  return line.indexOf("+CGACT:") >= 0;
}

bool isMpingLine(const String& line) {
  return line.indexOf("+MPING:") >= 0;
}

void finishTrafficTaskWithProgress(bool success, const String& reason) {
  String message = "目标=" + String(asyncTask.targetKb) + "KB|实际=" + String(asyncTask.totalBytes / 1024) + "KB|bytes=" + String(asyncTask.totalBytes);
  if (reason.length() > 0) {
    message += "|原因=" + reason;
  }
  finishAsyncTask(success, message);
}

void startPingTask() {
  beginAsyncTask(ASYNC_TASK_PING, currentRequestId);
  asyncTask.step = ASYNC_STEP_ACTIVATE_WAIT;
  asyncTask.stepStartedAt = millis();
  while (Serial1.available()) Serial1.read();
  Serial1.println("AT+CGACT=1,1");
  Serial.println("[ASYNC] Ping task started");
}

void startConsumeTrafficTask(int targetKb) {
  if (targetKb < 1) {
    publishResp("consume_traffic", false, "参数错误: targetKb 必须 >= 1");
    return;
  }
  if (targetKb > TRAFFIC_SAFE_LIMIT_KB) {
    publishResp("consume_traffic", false, "参数错误: targetKb 不能超过 1024KB");
    return;
  }
  beginAsyncTask(ASYNC_TASK_TRAFFIC, currentRequestId);
  asyncTask.step = ASYNC_STEP_ACTIVATE_WAIT;
  asyncTask.stepStartedAt = millis();
  asyncTask.targetKb = targetKb;
  while (Serial1.available()) Serial1.read();
  Serial1.println("AT+CGACT=1,1");
  Serial.println("[ASYNC] Traffic task started, targetKb=" + String(targetKb));
}

void issueAsyncMpingCommand() {
  while (Serial1.available()) Serial1.read();
  asyncTask.responseBuffer = "";
  asyncTask.responseBuffer.reserve(ASYNC_CMD_BUFFER_SIZE);
  asyncTask.step = ASYNC_STEP_MPING_WAIT;
  asyncTask.stepStartedAt = millis();
  if (asyncTask.type == ASYNC_TASK_PING) {
    Serial1.println("AT+MPING=\"8.8.8.8\",30,1");
  } else {
    asyncTask.currentMpingBytes = min(asyncTask.targetKb - (int)(asyncTask.totalBytes / 1024), TRAFFIC_BATCH_KB) * 1024;
    if (asyncTask.currentMpingBytes <= 0) {
      asyncTask.currentMpingBytes = 1024;
    }
    Serial1.println("AT+MPING=\"8.8.8.8\",16,1");
  }
}

void issueAsyncDeactivateCommand() {
  while (Serial1.available()) Serial1.read();
  asyncTask.responseBuffer = "";
  asyncTask.responseBuffer.reserve(ASYNC_CMD_BUFFER_SIZE);
  asyncTask.step = ASYNC_STEP_DEACTIVATE_WAIT;
  asyncTask.stepStartedAt = millis();
  Serial1.println("AT+CGACT=0,1");
}

void processAsyncTaskResponse(const String& line) {
  if (!asyncTask.active) return;
  if (line.length() == 0) return;

  if (line.startsWith("+CMT:")) {
    return;
  }

  if (asyncTask.responseBuffer.length() < ASYNC_CMD_BUFFER_SIZE) {
    asyncTask.responseBuffer += line;
    asyncTask.responseBuffer += '\n';
  }

  if (asyncTask.step == ASYNC_STEP_ACTIVATE_WAIT) {
    if (isErrorLine(line)) {
      finishAsyncTask(false, "数据连接激活失败");
      return;
    }
    if (isCgactQueryLine(line)) {
      return;
    }
    if (isExactOkLine(line)) {
      asyncTask.step = ASYNC_STEP_MPING_WAIT;
      issueAsyncMpingCommand();
      return;
    }
  }

  if (asyncTask.step == ASYNC_STEP_MPING_WAIT) {
    if (isMpingLine(line)) {
      bool success = false;
      String message = parseMpingResultMessage(line, success);
      if (asyncTask.type == ASYNC_TASK_PING) {
        asyncTask.pingResultSuccess = success;
        asyncTask.resultMessage = message;
        issueAsyncDeactivateCommand();
      } else {
        if (success) {
          asyncTask.totalBytes += asyncTask.currentMpingBytes;
        }
        if (!success) {
          finishTrafficTaskWithProgress(asyncTask.totalBytes > 0, message);
          return;
        }
        if ((int)(asyncTask.totalBytes / 1024) >= asyncTask.targetKb) {
          asyncTask.resultMessage = "目标=" + String(asyncTask.targetKb) + "KB|实际=" + String(asyncTask.totalBytes / 1024) + "KB|bytes=" + String(asyncTask.totalBytes);
          issueAsyncDeactivateCommand();
        } else {
          issueAsyncMpingCommand();
        }
      }
      return;
    }
    if (isErrorLine(line)) {
      asyncTask.resultMessage = asyncTask.type == ASYNC_TASK_PING ? "模组返回错误" : "流量消耗过程中模组返回错误";
      issueAsyncDeactivateCommand();
      return;
    }
  }

  if (asyncTask.step == ASYNC_STEP_DEACTIVATE_WAIT) {
    if (isCgactQueryLine(line)) {
      return;
    }
    if (isExactOkLine(line) || isErrorLine(line)) {
      bool success = false;
      String message = asyncTask.resultMessage;
      if (asyncTask.type == ASYNC_TASK_PING) {
        success = asyncTask.pingResultSuccess;
        if (message.length() == 0) {
          message = success ? "Ping成功" : "操作超时，未收到Ping结果";
        }
      } else {
        success = asyncTask.totalBytes > 0;
        if (message.length() == 0) {
          message = success
            ? "目标=" + String(asyncTask.targetKb) + "KB|实际=" + String(asyncTask.totalBytes / 1024) + "KB|bytes=" + String(asyncTask.totalBytes)
            : "流量消耗失败，未成功建立数据流量";
        }
      }
      finishAsyncTask(success, message);
      return;
    }
  }
}

void tickAsyncTask() {
  if (!asyncTask.active) return;

  const unsigned long now = millis();
  if (asyncTask.step == ASYNC_STEP_ACTIVATE_WAIT && now - asyncTask.stepStartedAt > 12000) {
    if (asyncTask.type == ASYNC_TASK_TRAFFIC) {
      finishTrafficTaskWithProgress(false, "数据连接激活超时");
    } else {
      finishAsyncTask(false, "数据连接激活超时");
    }
    return;
  }
  if (asyncTask.step == ASYNC_STEP_MPING_WAIT && now - asyncTask.stepStartedAt > 35000) {
    if (asyncTask.type == ASYNC_TASK_PING) {
      asyncTask.resultMessage = "操作超时，未收到Ping结果";
      issueAsyncDeactivateCommand();
    } else {
      finishTrafficTaskWithProgress(asyncTask.totalBytes > 0, "流量消耗超时");
    }
    return;
  }
  if (asyncTask.step == ASYNC_STEP_DEACTIVATE_WAIT && now - asyncTask.stepStartedAt > 6000) {
    bool success = asyncTask.type == ASYNC_TASK_PING ? asyncTask.pingResultSuccess : asyncTask.totalBytes > 0;
    String message = asyncTask.resultMessage;
    if (message.length() == 0) {
      if (asyncTask.type == ASYNC_TASK_TRAFFIC) {
        message = "目标=" + String(asyncTask.targetKb) + "KB|实际=" + String(asyncTask.totalBytes / 1024) + "KB|bytes=" + String(asyncTask.totalBytes) + "|原因=关闭数据连接超时";
      } else {
        message = success ? "任务完成" : "关闭数据连接超时";
      }
    }
    finishAsyncTask(success, message);
  }
}

void handleFlightModeMQTT(int status) {
  Serial.println("[MQTT] 飞行模式操作, status=" + String(status));
  String resp;
  bool success = false;
  String msg;

  if (status == -1) {
    resp = sendATCommand("AT+CFUN?", 2000);
    Serial.println("CFUN查询响应: " + resp);
    if (resp.indexOf("+CFUN:") >= 0) {
      success = true;
      int idx = resp.indexOf("+CFUN:");
      int mode = resp.substring(idx + 6).toInt();
      String modeStr, statusIcon;
      if (mode == 0) { modeStr = "最小功能模式（关机）"; statusIcon = "OFF"; }
      else if (mode == 1) { modeStr = "全功能模式（正常）"; statusIcon = "ON"; }
      else if (mode == 4) { modeStr = "飞行模式（射频关闭）"; statusIcon = "FLIGHT"; }
      else { modeStr = "未知模式 (" + String(mode) + ")"; statusIcon = "UNKNOWN"; }
      msg = statusIcon + "|" + modeStr + "|CFUN=" + String(mode);
    } else {
      msg = "查询失败";
    }
  } else if (status == 1) {
    resp = sendATCommand("AT+CFUN=4", 5000);
    success = (resp.indexOf("OK") >= 0);
    msg = success ? "飞行模式已开启" : "开启失败: " + resp;
    if (success) invalidateQueryCaches();
  } else if (status == 0) {
    resp = sendATCommand("AT+CFUN=1", 5000);
    success = (resp.indexOf("OK") >= 0);
    msg = success ? "飞行模式已关闭" : "关闭失败: " + resp;
    if (success) invalidateQueryCaches();
  } else {
    resp = sendATCommand("AT+CFUN?", 2000);
    if (resp.indexOf("+CFUN:") >= 0) {
      int idx = resp.indexOf("+CFUN:");
      int currentMode = resp.substring(idx + 6).toInt();
      int newMode = (currentMode == 1) ? 4 : 1;
      String cmd = "AT+CFUN=" + String(newMode);
      Serial.println("切换飞行模式: " + cmd);
      resp = sendATCommand(cmd.c_str(), 5000);
      success = (resp.indexOf("OK") >= 0);
      msg = success ? (newMode == 4 ? "飞行模式已开启" : "飞行模式已关闭") : "切换失败: " + resp;
      if (success) invalidateQueryCaches();
    } else {
      msg = "无法获取当前状态";
    }
  }
  publishResp("flight_mode", success, msg);
}

void handleAtCmdMQTT(const String& cmd) {
  Serial.println("[MQTT] AT指令: " + cmd);
  String resp = sendATCommand(cmd.c_str(), 5000);
  Serial.println("响应: " + resp);
  publishResp("at", resp.length() > 0, resp);
}

bool buildSimInfoQueryMessage(String& msg) {
  String resp = sendATCommand("AT+CIMI", 2000);
  String imsi = "未知";
  if (resp.indexOf("OK") >= 0) {
    imsi = extractNextResponseLine(resp);
    if (imsi == "OK" || imsi.length() < 10) imsi = "未知";
  }

  resp = sendATCommand("AT+ICCID", 2000);
  String iccid = "未知";
  if (resp.indexOf("+ICCID:") >= 0) {
    iccid = extractLineAfterPrefix(resp, "+ICCID:");
  }

  resp = sendATCommand("AT+CNUM", 2000);
  String phoneNum = "未存储或不支持";
  if (resp.indexOf("+CNUM:") >= 0) {
    String extracted = extractQuotedValue(resp, resp.indexOf(",\""));
    if (extracted.length() > 0) phoneNum = extracted;
  }

  msg = "IMSI=" + imsi + "|ICCID=" + iccid + "|PHONE=" + phoneNum;
  return true;
}

bool buildSignalQueryMessage(String& msg) {
  String resp = sendATCommand("AT+CESQ", 2000);
  if (resp.indexOf("+CESQ:") < 0) {
    msg = "查询失败";
    return false;
  }

  String params = extractLineAfterPrefix(resp, "+CESQ:");

  String values[6];
  int valIdx = 0;
  int startPos = 0;
  for (int i = 0; i <= params.length() && valIdx < 6; i++) {
    if (i == params.length() || params.charAt(i) == ',') {
      values[valIdx] = params.substring(startPos, i);
      values[valIdx].trim();
      valIdx++;
      startPos = i + 1;
    }
  }

  int rsrp = values[5].toInt();
  String rsrpStr;
  if (rsrp == 99 || rsrp == 255) rsrpStr = "未知";
  else rsrpStr = String(-140 + rsrp) + " dBm";

  int rsrq = values[4].toInt();
  String rsrqStr;
  if (rsrq == 99 || rsrq == 255) rsrqStr = "未知";
  else rsrqStr = String(-19.5 + rsrq * 0.5, 1) + " dB";

  msg = "RSRP=" + rsrpStr + "|RSRQ=" + rsrqStr + "|RAW=" + params;
  return true;
}

bool buildNetworkQueryMessage(String& msg) {
  String resp = sendATCommand("AT+CEREG?", 2000);
  String regStatus = "未知";
  if (resp.indexOf("+CEREG:") >= 0) {
    String tmp = extractLineAfterPrefix(resp, "+CEREG:");
    int commaIdx = tmp.indexOf(',');
    if (commaIdx >= 0) {
      String stat = tmp.substring(commaIdx + 1, commaIdx + 2);
      int s = stat.toInt();
      if (s == 0) regStatus = "未注册";
      else if (s == 1) regStatus = "已注册本地";
      else if (s == 2) regStatus = "搜索中";
      else if (s == 3) regStatus = "注册被拒绝";
      else if (s == 4) regStatus = "未知";
      else if (s == 5) regStatus = "已注册漫游";
      else regStatus = "状态码:" + stat;
    }
  }

  resp = sendATCommand("AT+COPS?", 2000);
  String oper = "未知";
  if (resp.indexOf("+COPS:") >= 0) {
    String extracted = extractQuotedValue(resp, resp.indexOf(",\""));
    if (extracted.length() > 0) oper = extracted;
  }

  resp = sendATCommand("AT+CGACT?", 2000);
  String pdpStatus = resp.indexOf("+CGACT: 1,1") >= 0 ? "已激活" : "未激活";

  msg = "注册=" + regStatus + "|运营商=" + oper + "|数据=" + pdpStatus;
  return true;
}

String buildWifiQueryMessage() {
  String wifiStatus = WiFi.isConnected() ? "已连接" : "未连接";
  return "状态=" + wifiStatus + "|SSID=" + WiFi.SSID() + "|RSSI=" + String(WiFi.RSSI()) + "|IP=" + WiFi.localIP().toString();
}

void handleQuerySimMQTT() {
  Serial.println("[MQTT] 查询SIM卡信息");
  String msg;
  bool success = false;
  withCachedQuery(simInfoCache, SIMINFO_CACHE_TTL, msg, success, buildSimInfoQueryMessage);
  publishResp("query_sim", success, msg);
}

void handleQueryMQTT(const String& type) {
  Serial.println("[MQTT] 查询类型: " + type);
  String resp;
  bool success = false;
  String msg;

  if (type == "ati") {
    resp = sendATCommand("ATI", 2000);
    if (resp.indexOf("OK") >= 0) {
      success = true;
      String manufacturer = "未知", model = "未知", version = "未知";
      int lineStart = 0, lineNum = 0;
      for (int i = 0; i < resp.length(); i++) {
        if (resp.charAt(i) == '\n' || i == resp.length() - 1) {
          String line = resp.substring(lineStart, i);
          line.trim();
          if (line.length() > 0 && line != "ATI" && line != "OK") {
            lineNum++;
            if (lineNum == 1) manufacturer = line;
            else if (lineNum == 2) model = line;
            else if (lineNum == 3) version = line;
          }
          lineStart = i + 1;
        }
      }
      msg = "厂商=" + manufacturer + "|型号=" + model + "|版本=" + version;
    } else msg = "查询失败";
  }
  else if (type == "signal") {
    withCachedQuery(signalCache, SIGNAL_CACHE_TTL, msg, success, buildSignalQueryMessage);
  }
  else if (type == "siminfo") {
    withCachedQuery(simInfoCache, SIMINFO_CACHE_TTL, msg, success, buildSimInfoQueryMessage);
  }
  else if (type == "network") {
    withCachedQuery(networkCache, NETWORK_CACHE_TTL, msg, success, buildNetworkQueryMessage);
  }
  else if (type == "wifi") {
    success = true;
    msg = buildWifiQueryMessage();
  }
  else {
    msg = "未知查询类型: " + type;
  }

  publishResp("query", success, msg);
}

void handleSendSmsMQTT(const String& phone, const String& content) {
  Serial.println("[MQTT] 发送短信: " + phone + " -> " + content);
  String resultMsg;
  resultMsg.reserve(64);
  bool ok = sendSMS(phone.c_str(), content.c_str(), resultMsg);
  // Always send a response (with original requestId) right after the action ends.
  // This prevents the backend from waiting its full timeout when modem/network is slow.
  if (resultMsg.length() == 0) {
    resultMsg = ok ? "短信发送成功" : "短信发送失败";
  }
  publishResp("send_sms", ok, resultMsg);
}


void handleCmdMessage(char* topic, uint8_t* payload, unsigned int length) {
  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    Serial.println("[MQTT] JSON解析失败: " + String(error.c_str()));
    return;
  }

  const char* action = doc["action"] | "";
  const char* requestId = doc["requestId"] | "";
  RequestIdScope scope = pushRequestIdScope(String(requestId));
  Serial.println("[MQTT] 收到指令 action=" + String(action));

  if (isAsyncTaskBusy() && isAtSensitiveAction(action)) {
    publishResp(action, false, String("设备忙碌，正在执行 ") + getBusyActionName());
    popRequestIdScope(scope);
    return;
  }

  if (strcmp(action, "ping") == 0) {
    startPingTask();
  }
  else if (strcmp(action, "flight_mode") == 0) {
    int status = doc["status"] | -2;
    handleFlightModeMQTT(status);
  }
  else if (strcmp(action, "at") == 0) {
    const char* cmd = doc["cmd"] | "";
    handleAtCmdMQTT(String(cmd));
  }
  else if (strcmp(action, "query_sim") == 0) {
    handleQuerySimMQTT();
  }
  else if (strcmp(action, "query") == 0) {
    const char* type = doc["type"] | "ati";
    handleQueryMQTT(String(type));
  }
  else if (strcmp(action, "send_sms") == 0) {
    const char* phone = doc["phone"] | "";
    const char* content = doc["content"] | "";
    handleSendSmsMQTT(String(phone), String(content));
  }
  else if (strcmp(action, "consume_traffic") == 0) {
    int targetKb = doc["targetKb"] | 0;
    startConsumeTrafficTask(targetKb);
  }
  else if (strcmp(action, "reset") == 0) {
    publishResp("reset", true, "设备即将重启");
    delay(500);
    ESP.restart();
  }
  else {
    publishResp(action, false, "未知动作: " + String(action));
  }

  popRequestIdScope(scope);
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String t = String(topic);
  String macTopic = "sms_forwarder/cmd/" + deviceMAC;
  if (t == macTopic) {
    handleCmdMessage(topic, payload, length);
  }
}

bool mqttReconnect() {
  String clientId = "ESP32SMS_" + deviceMAC;
  if (mqttClient.connect(clientId.c_str())) {
    Serial.println("[MQTT] Connected to broker");
    String topic = "sms_forwarder/cmd/" + deviceMAC;
    mqttClient.subscribe(topic.c_str());
    Serial.println("[MQTT] Subscribed to: " + topic);
    flushOfflineQueue(1);
    publishHeartbeat();
  }
  return mqttClient.connected();
}

void checkSerial1URC() {
  String line = readSerialLine(Serial1);
  if (line.length() == 0) return;
  Serial.println("Debug> " + line);

  if (asyncTask.active) {
    processAsyncTaskResponse(line);
    if (!asyncTask.active) return;
  }

  if (!urcWaitingPdu) {
    if (line.startsWith("+CMT:")) {
      Serial.println("检测到+CMT，等待PDU...");
      urcWaitingPdu = true;
    }
  } else {
    if (line.length() == 0) return;
    if (isHexString(line)) {
      Serial.println("收到PDU数据: " + line);
      if (!pdu.decodePDU(line.c_str())) {
        Serial.println("PDU解析失败");
      } else {
        Serial.println("PDU解析成功");
        Serial.println("发送者: " + String(pdu.getSender()));
        Serial.println("时间戳: " + String(pdu.getTimeStamp()));
        Serial.println("内容: " + String(pdu.getText()));

        int* concatInfo = pdu.getConcatInfo();
        int refNumber = concatInfo[0];
        int partNumber = concatInfo[1];
        int totalParts = concatInfo[2];

        if (totalParts > 1 && partNumber > 0) {
          if (isRecentlyCompletedConcat(refNumber, pdu.getSender(), pdu.getTimeStamp())) {
            Serial.printf("忽略已完成长短信的重复分段 %d/%d\n", partNumber, totalParts);
            urcWaitingPdu = false;
            return;
          }

          if (totalParts > MAX_CONCAT_PARTS) {
            Serial.printf("长短信分段数超出支持范围: %d/%d，已丢弃\n", partNumber, totalParts);
            urcWaitingPdu = false;
            return;
          }

          Serial.printf("长短信分段 %d/%d\n", partNumber, totalParts);
          int slot = findOrCreateConcatSlot(refNumber, pdu.getSender(), pdu.getTimeStamp(), totalParts);
          int partIndex = partNumber - 1;
          if (partIndex >= 0 && partIndex < MAX_CONCAT_PARTS) {
            if (!concatBuffer[slot].parts[partIndex].valid) {
              concatBuffer[slot].parts[partIndex].valid = true;
              concatBuffer[slot].parts[partIndex].text = String(pdu.getText());
              concatBuffer[slot].receivedParts++;
              if (concatBuffer[slot].receivedParts == 1) {
                concatBuffer[slot].firstPartTime = millis();
                concatBuffer[slot].sender = String(pdu.getSender());
                concatBuffer[slot].totalParts = totalParts;
                concatBuffer[slot].timestamp = String(pdu.getTimeStamp());
              }
              Serial.printf("已缓存分段 %d, 已收到 %d/%d\n", partNumber, concatBuffer[slot].receivedParts, totalParts);
            }
          }
          if (concatBuffer[slot].receivedParts >= totalParts) {
            Serial.println("长短信已收齐，合并转发");
            String fullText = assembleConcatSms(slot);
            bool published = publishRawSMS(concatBuffer[slot].sender.c_str(), fullText.c_str(), concatBuffer[slot].timestamp.c_str());
            if (published) {
              rememberCompletedConcat(concatBuffer[slot].refNumber, concatBuffer[slot].sender.c_str(), concatBuffer[slot].timestamp.c_str());
            } else {
              Serial.println("长短信发布失败，未写入去重缓存");
            }
            clearConcatSlot(slot);
          }
        } else {
          publishRawSMS(pdu.getSender(), pdu.getText(), pdu.getTimeStamp());
        }
      }
      urcWaitingPdu = false;
    } else {
      urcWaitingPdu = false;
    }
  }
}

void checkConcatTimeout() {
  unsigned long now = millis();
  for (int i = 0; i < MAX_CONCAT_MESSAGES; i++) {
    if (concatBuffer[i].inUse) {
      if (now - concatBuffer[i].firstPartTime >= CONCAT_TIMEOUT_MS) {
        Serial.printf("长短信超时，丢弃不完整分段 (%d/%d)\n", concatBuffer[i].receivedParts, concatBuffer[i].totalParts);
        clearConcatSlot(i);
      }
    }
  }
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);

  Serial.begin(115200);
  delay(1500);

  Serial1.begin(115200, SERIAL_8N1, RXD, TXD);
  Serial1.setRxBufferSize(SERIAL_BUFFER_SIZE);

  while (Serial1.available()) Serial1.read();
  modemPowerCycle();
  while (Serial1.available()) Serial1.read();
  invalidateQueryCaches();

  initConcatBuffer();

  deviceMAC = WiFi.macAddress();
  deviceMAC.replace(":", "");
  deviceMAC.toLowerCase();
  
  if (deviceMAC == "000000000000" || deviceMAC.length() != 12) {
    uint64_t chipid = ESP.getEfuseMac();
    deviceMAC = String(chipid, HEX);
    deviceMAC.toLowerCase();
  }
  
  Serial.println("设备MAC: " + deviceMAC);

  while (!sendATandWaitOK("AT", 1000)) {
    Serial.println("AT未响应，重试...");
    blink_short();
  }
  Serial.println("模组AT响应正常");

  {
    String cgactResp = sendATCommand("AT+CGACT?", 2000);
    Serial.println("CGACT查询: " + cgactResp);
    bool disabled = false;
    for (int i = 0; i < 3; i++) {
      if (sendATandWaitOK("AT+CGACT=0,1", 5000)) { disabled = true; break; }
      blink_short();
    }
    if (disabled) Serial.println("已禁用数据连接");
    else Serial.println("禁用数据连接失败");
  }

  while (!sendATandWaitOK("AT+CNMI=2,2,0,0,0", 1000)) {
    Serial.println("设置CNMI失败，重试...");
    blink_short();
  }
  Serial.println("CNMI参数设置完成");

  while (!sendATandWaitOK("AT+CMGF=0", 1000)) {
    Serial.println("设置PDU模式失败，重试...");
    blink_short();
  }
  Serial.println("PDU模式设置完成");
  refreshPhoneNumberIfNeeded(true);

  Serial1.println("AT+CEREG?");
  unsigned long startReg = millis();
  bool registered = false;
  while (millis() - startReg < 60000) {
    String line = readSerialLine(Serial1);
    if (line.length() > 0) {
      Serial.println("Debug> " + line);
      if (line.indexOf("+CEREG:") >= 0) {
        if (line.indexOf(",1") >= 0 || line.indexOf(",5") >= 0) { registered = true; break; }
        if (line.indexOf(",2") >= 0 || line.indexOf(",0") >= 0) {
          delay(2000);
          Serial1.println("AT+CEREG?");
        }
      }
    }
    delay(10);
  }
  if (registered) Serial.println("网络已注册");
  else Serial.println("网络注册超时");

  WiFi.begin(WIFI_SSID, WIFI_PASS, 0, nullptr, true);
  Serial.println("连接WiFi: " + String(WIFI_SSID));
  while (WiFi.status() != WL_CONNECTED) blink_short();
  Serial.print("WiFi已连接, IP: ");
  Serial.println(WiFi.localIP());

  Serial.println("同步NTP时间...");
  configTime(8 * 3600, 0, "ntp.ntsc.ac.cn", "ntp.aliyun.com", "pool.ntp.org");
  int ntpRetry = 0;
  while (time(nullptr) < 100000 && ntpRetry < 100) { delay(100); ntpRetry++; }
  if (time(nullptr) >= 100000) { Serial.println("NTP时间同步成功"); }
  else Serial.println("NTP时间同步失败");

  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setBufferSize(MQTT_BUFFER_SIZE);
  mqttClient.setCallback(mqttCallback);
  mqttReconnect();

  digitalWrite(LED_BUILTIN, LOW);
  lastHeartbeat = millis();
  Serial.println("=== 设备启动完成 ===");
  Serial.println("MQTT Server: " + String(MQTT_SERVER) + ":" + String(MQTT_PORT));
}

void loop() {
  if (!mqttClient.connected()) {
    if (millis() - lastMqttReconnect >= MQTT_RECONNECT_INTERVAL) {
      lastMqttReconnect = millis();
      Serial.println("[MQTT] 尝试重连...");
      mqttReconnect();
    }
  } else {
    mqttClient.loop();
  }

  if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL) {
    lastHeartbeat = millis();
    publishHeartbeat();
  }

  if (mqttClient.connected() && queueCount > 0 && millis() - lastQueueFlushAttempt >= QUEUE_FLUSH_INTERVAL && !isAsyncTaskBusy()) {
    lastQueueFlushAttempt = millis();
    flushOfflineQueue(1);
  }

  if (shouldRefreshPhoneNumber()) {
    refreshPhoneNumberIfNeeded();
  }

  checkSerial1URC();
  checkConcatTimeout();
  tickAsyncTask();

  if (Serial.available()) Serial1.write(Serial.read());
}
