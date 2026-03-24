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

#define OFFLINE_QUEUE_SIZE 10
#define MQTT_BUFFER_SIZE 4096

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
  }
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

bool sendSMS(const char* phoneNum, const char* message) {
  Serial.println("发送短信...");
  Serial.print("目标号码: "); Serial.println(phoneNum);
  Serial.print("内容: "); Serial.println(message);

  pdu.setSCAnumber();
  int pduLen = pdu.encodePDU(phoneNum, message);
  if (pduLen < 0) {
    Serial.print("PDU编码失败: "); Serial.println(pduLen);
    return false;
  }

  String cmgsCmd = "AT+CMGS=";
  cmgsCmd += pduLen;
  while (Serial1.available()) Serial1.read();
  Serial1.println(cmgsCmd);

  unsigned long start = millis();
  bool gotPrompt = false;
  while (millis() - start < 5000) {
    if (Serial1.available()) {
      char c = Serial1.read();
      Serial.print(c);
      if (c == '>') { gotPrompt = true; break; }
    }
  }
  if (!gotPrompt) { Serial.println("未收到>提示符"); return false; }

  Serial1.print(pdu.getSMS());
  Serial1.write(0x1A);

  start = millis();
  String resp = "";
  while (millis() - start < 30000) {
    while (Serial1.available()) {
      char c = Serial1.read();
      resp += c;
      Serial.print(c);
      if (resp.indexOf("OK") >= 0) { Serial.println("短信发送成功"); return true; }
      if (resp.indexOf("ERROR") >= 0) { Serial.println("短信发送失败"); return false; }
    }
  }
  Serial.println("短信发送超时");
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

String getPhoneNumber() {
  if (phoneNumber.length() > 0) return phoneNumber;
  String resp = sendATCommand("AT+CNUM", 2000);
  if (resp.indexOf("+CNUM:") >= 0) {
    int idx = resp.indexOf(",\"");
    if (idx >= 0) {
      int endIdx = resp.indexOf("\"", idx + 2);
      if (endIdx > idx) phoneNumber = resp.substring(idx + 2, endIdx);
    }
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

bool flushOfflineQueue() {
  if (queueCount == 0) return true;
  
  Serial.println("[Queue] Flushing " + String(queueCount) + " queued messages...");
  
  while (queueCount > 0) {
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
      serializeJson(doc, payload);
    }

    String topic = "sms_forwarder/raw_sms/" + deviceMAC;
    bool ok = mqttClient.publish(topic.c_str(), payload.c_str());
    if (!ok) {
      Serial.println("[Queue] Flush publish failed, keeping queued SMS");
      return false;
    }
    Serial.println("[Queue] Flushed: " + payload);
    
    queueValid[queueHead] = false;
    offlineQueue[queueHead].sender = "";
    offlineQueue[queueHead].text = "";
    offlineQueue[queueHead].timestamp = "";
    offlineQueue[queueHead].phone = "";
    queueHead = (queueHead + 1) % OFFLINE_QUEUE_SIZE;
    queueCount--;
    delay(50);
  }
  
  Serial.println("[Queue] All queued messages flushed");
  return true;
}

void publishHeartbeat() {
  StaticJsonDocument<256> doc;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;
  doc["version"] = CURRENT_FIRMWARE_VERSION;
  String topic = "sms_forwarder/heartbeat/" + deviceMAC;
  char buf[256];
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
    if (!flushOfflineQueue()) {
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

void publishResp(const char* action, bool success, const String& message) {
  StaticJsonDocument<512> doc;
  doc["action"] = action;
  doc["success"] = success;
  doc["message"] = message;
  String topic = "sms_forwarder/resp/" + deviceMAC;
  char buf[512];
  serializeJson(doc, buf);
  mqttClient.publish(topic.c_str(), buf);
  Serial.println("[MQTT] Resp sent: " + String(buf));
}

void handlePingMQTT() {
  Serial.println("[MQTT] 执行 Ping 测试...");
  while (Serial1.available()) Serial1.read();

  Serial.println("激活数据连接(CGACT)...");
  String activateResp = sendATCommand("AT+CGACT=1,1", 10000);
  Serial.println("CGACT响应: " + activateResp);
  bool networkActivated = (activateResp.indexOf("OK") >= 0);
  if (!networkActivated) Serial.println("数据连接激活失败，尝试继续...");

  while (Serial1.available()) Serial1.read();
  delay(500);
  Serial1.println("AT+MPING=\"8.8.8.8\",30,1");

  unsigned long start = millis();
  String resp = "";
  bool gotOK = false;
  bool gotError = false;
  bool gotPingResult = false;
  String pingResultMsg = "";

  while (millis() - start < 35000) {
    while (Serial1.available()) {
      char c = Serial1.read();
      resp += c;
      Serial.print(c);
      if (resp.indexOf("OK") >= 0 && !gotOK) gotOK = true;
      if (resp.indexOf("+CME ERROR") >= 0 || resp.indexOf("ERROR") >= 0) {
        gotError = true;
        pingResultMsg = "模组返回错误";
        break;
      }
      int mpingIdx = resp.indexOf("+MPING:");
      if (mpingIdx >= 0) {
        int lineEnd = resp.indexOf('\n', mpingIdx);
        if (lineEnd >= 0) {
          String mpingLine = resp.substring(mpingIdx, lineEnd);
          mpingLine.trim();
          Serial.println("收到MPING结果: " + mpingLine);
          int colonIdx = mpingLine.indexOf(':');
          if (colonIdx >= 0) {
            String params = mpingLine.substring(colonIdx + 1);
            params.trim();
            int commaIdx = params.indexOf(',');
            String resultStr = commaIdx >= 0 ? params.substring(0, commaIdx) : params;
            resultStr.trim();
            int result = resultStr.toInt();
            gotPingResult = true;
            bool pingSuccess = (result == 0 || result == 1);
            if (pingSuccess) {
              int idx1 = params.indexOf(',');
              if (idx1 >= 0) {
                String rest = params.substring(idx1 + 1);
                String ip;
                int idx2;
                if (rest.startsWith("\"")) {
                  int quoteEnd = rest.indexOf('\"', 1);
                  if (quoteEnd >= 0) {
                    ip = rest.substring(1, quoteEnd);
                    idx2 = rest.indexOf(',', quoteEnd);
                  } else { idx2 = rest.indexOf(','); ip = rest.substring(0, idx2); }
                } else { idx2 = rest.indexOf(','); ip = rest.substring(0, idx2); }
                if (idx2 >= 0) {
                  rest = rest.substring(idx2 + 1);
                  int idx3 = rest.indexOf(',');
                  if (idx3 >= 0) {
                    rest = rest.substring(idx3 + 1);
                    int idx4 = rest.indexOf(',');
                    String timeStr, ttlStr;
                    if (idx4 >= 0) { timeStr = rest.substring(0, idx4); ttlStr = rest.substring(idx4 + 1); }
                    else { timeStr = rest; ttlStr = "N/A"; }
                    timeStr.trim(); ttlStr.trim();
                    pingResultMsg = "目标: " + ip + ", 延迟: " + timeStr + "ms, TTL: " + ttlStr;
                  }
                }
              }
              if (pingResultMsg.length() == 0) pingResultMsg = "Ping成功";
            } else {
              pingResultMsg = "Ping超时或目标不可达 (错误码: " + String(result) + ")";
            }
            break;
          }
        }
      }
    }
    if (gotError || gotPingResult) break;
    delay(10);
  }

  Serial.println("\nPing操作完成，关闭PDP上下文...");
  String deactivateResp = sendATCommand("AT+CGACT=0,1", 5000);
  Serial.println("CGACT关闭响应: " + deactivateResp);

  if (gotPingResult && pingResultMsg.indexOf("延迟") >= 0) {
    publishResp("ping", true, pingResultMsg);
  } else if (gotError) {
    publishResp("ping", false, pingResultMsg);
  } else if (gotPingResult) {
    publishResp("ping", false, pingResultMsg);
  } else {
    publishResp("ping", false, "操作超时，未收到Ping结果");
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
  } else if (status == 0) {
    resp = sendATCommand("AT+CFUN=1", 5000);
    success = (resp.indexOf("OK") >= 0);
    msg = success ? "飞行模式已关闭" : "关闭失败: " + resp;
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

void handleQuerySimMQTT() {
  Serial.println("[MQTT] 查询SIM卡信息");
  bool success = true;
  String msg;

  String resp = sendATCommand("AT+CIMI", 2000);
  String imsi = "未知";
  if (resp.indexOf("OK") >= 0) {
    int start = resp.indexOf('\n');
    if (start >= 0) {
      int end = resp.indexOf('\n', start + 1);
      if (end < 0) end = resp.indexOf('\r', start + 1);
      if (end > start) {
        imsi = resp.substring(start + 1, end);
        imsi.trim();
        if (imsi == "OK" || imsi.length() < 10) imsi = "未知";
      }
    }
  }

  resp = sendATCommand("AT+ICCID", 2000);
  String iccid = "未知";
  if (resp.indexOf("+ICCID:") >= 0) {
    int idx = resp.indexOf("+ICCID:");
    String tmp = resp.substring(idx + 7);
    int endIdx = tmp.indexOf('\r');
    if (endIdx < 0) endIdx = tmp.indexOf('\n');
    if (endIdx > 0) { iccid = tmp.substring(0, endIdx); iccid.trim(); }
  }

  resp = sendATCommand("AT+CNUM", 2000);
  String phoneNum = "未存储或不支持";
  if (resp.indexOf("+CNUM:") >= 0) {
    int idx = resp.indexOf(",\"");
    if (idx >= 0) {
      int endIdx = resp.indexOf("\"", idx + 2);
      if (endIdx > idx) phoneNum = resp.substring(idx + 2, endIdx);
    }
  }

  msg = "IMSI=" + imsi + "|ICCID=" + iccid + "|PHONE=" + phoneNum;
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
    resp = sendATCommand("AT+CESQ", 2000);
    if (resp.indexOf("+CESQ:") >= 0) {
      success = true;
      int idx = resp.indexOf("+CESQ:");
      String params = resp.substring(idx + 6);
      int endIdx = params.indexOf('\r');
      if (endIdx < 0) endIdx = params.indexOf('\n');
      if (endIdx > 0) params = params.substring(0, endIdx);
      params.trim();
      String values[6]; int valIdx = 0; int startPos = 0;
      for (int i = 0; i <= params.length() && valIdx < 6; i++) {
        if (i == params.length() || params.charAt(i) == ',') {
          values[valIdx] = params.substring(startPos, i); values[valIdx].trim(); valIdx++; startPos = i + 1;
        }
      }
      int rsrp = values[5].toInt();
      String rsrpStr;
      if (rsrp == 99 || rsrp == 255) rsrpStr = "未知";
      else { int rsrpDbm = -140 + rsrp; rsrpStr = String(rsrpDbm) + " dBm"; }
      int rsrq = values[4].toInt();
      String rsrqStr;
      if (rsrq == 99 || rsrq == 255) rsrqStr = "未知";
      else { float rsrqDb = -19.5 + rsrq * 0.5; rsrqStr = String(rsrqDb, 1) + " dB"; }
      msg = "RSRP=" + rsrpStr + "|RSRQ=" + rsrqStr + "|RAW=" + params;
    } else msg = "查询失败";
  }
  else if (type == "siminfo") {
    handleQuerySimMQTT();
    return;
  }
  else if (type == "network") {
    success = true;
    resp = sendATCommand("AT+CEREG?", 2000);
    String regStatus = "未知";
    if (resp.indexOf("+CEREG:") >= 0) {
      int idx = resp.indexOf("+CEREG:");
      String tmp = resp.substring(idx + 7);
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
      int idx = resp.indexOf(",\"");
      if (idx >= 0) {
        int endIdx = resp.indexOf("\"", idx + 2);
        if (endIdx > idx) oper = resp.substring(idx + 2, endIdx);
      }
    }
    resp = sendATCommand("AT+CGACT?", 2000);
    String pdpStatus = "未激活";
    if (resp.indexOf("+CGACT: 1,1") >= 0) pdpStatus = "已激活";
    msg = "注册=" + regStatus + "|运营商=" + oper + "|数据=" + pdpStatus;
  }
  else if (type == "wifi") {
    success = true;
    String wifiStatus = WiFi.isConnected() ? "已连接" : "未连接";
    msg = "状态=" + wifiStatus + "|SSID=" + WiFi.SSID() + "|RSSI=" + String(WiFi.RSSI()) + "|IP=" + WiFi.localIP().toString();
  }
  else {
    msg = "未知查询类型: " + type;
  }

  publishResp("query", success, msg);
}

void handleSendSmsMQTT(const String& phone, const String& content) {
  Serial.println("[MQTT] 发送短信: " + phone + " -> " + content);
  bool ok = sendSMS(phone.c_str(), content.c_str());
  publishResp("send_sms", ok, ok ? "短信发送成功" : "短信发送失败");
}


void handleCmdMessage(char* topic, uint8_t* payload, unsigned int length) {
  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    Serial.println("[MQTT] JSON解析失败: " + String(error.c_str()));
    return;
  }

  const char* action = doc["action"] | "";
  Serial.println("[MQTT] 收到指令 action=" + String(action));

  if (strcmp(action, "ping") == 0) {
    handlePingMQTT();
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
  else if (strcmp(action, "reset") == 0) {
    publishResp("reset", true, "设备即将重启");
    delay(500);
    ESP.restart();
  }
  else {
    publishResp(action, false, "未知动作: " + String(action));
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String t = String(topic);
  String macTopic = "sms_forwarder/cmd/" + deviceMAC;
  if (t == macTopic) {
    char* payloadCopy = new char[length + 1];
    memcpy(payloadCopy, payload, length);
    payloadCopy[length] = '\0';
    handleCmdMessage(topic, (uint8_t*)payloadCopy, length);
    delete[] payloadCopy;
  }
}

bool mqttReconnect() {
  String clientId = "ESP32SMS_" + deviceMAC;
  if (mqttClient.connect(clientId.c_str())) {
    Serial.println("[MQTT] Connected to broker");
    String topic = "sms_forwarder/cmd/" + deviceMAC;
    mqttClient.subscribe(topic.c_str());
    Serial.println("[MQTT] Subscribed to: " + topic);
    flushOfflineQueue();
    publishHeartbeat();
  }
  return mqttClient.connected();
}

void checkSerial1URC() {
  static enum { IDLE, WAIT_PDU } state = IDLE;
  String line = readSerialLine(Serial1);
  if (line.length() == 0) return;
  Serial.println("Debug> " + line);

  if (state == IDLE) {
    if (line.startsWith("+CMT:")) {
      Serial.println("检测到+CMT，等待PDU...");
      state = WAIT_PDU;
    }
  } else if (state == WAIT_PDU) {
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
            state = IDLE;
            return;
          }

          if (totalParts > MAX_CONCAT_PARTS) {
            Serial.printf("长短信分段数超出支持范围: %d/%d，已丢弃\n", partNumber, totalParts);
            state = IDLE;
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
      state = IDLE;
    } else {
      state = IDLE;
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

  checkSerial1URC();
  checkConcatTimeout();

  if (Serial.available()) Serial1.write(Serial.read());
}
