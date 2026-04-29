# OTA 无线升级说明

## 1. 概述

本文档说明 SMS 转发器系统的 OTA（Over-The-Air）无线升级功能。该功能允许在不通过 USB 连接的情况下，通过网络更新 ESP32 设备的固件。

### 架构

```
┌─────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   ESP32     │ MQTT │   Node.js       │ HTTP │   固件文件      │
│  设备       │◀────▶│   服务器        │◀────▶│   /firmware/   │
│             │      │                 │      │                 │
│             │      │  /api/ota/*    │      │  firmware.bin   │
└─────────────┘      └─────────────────┘      └─────────────────┘
```

---

## 2. ESP32 分区配置

### 分区表文件

在 Arduino sketch 目录创建 `partitions.csv`：

```csv
# Name,   Type, SubType, Offset,  Size, Flags
nvs,      data, nvs,     0x9000,  0x5000,
otadata,  data, ota,     0xe000,  0x2000,
app0,     app,  ota_0,  0x10000, 0x180000,
app1,     app,  ota_1,  0x190000,0x180000,
spiffs,   data, spiffs, 0x310000,0xF0000,
```

### 分区说明（ESP32-C3 4MB Flash）

| 分区名   | 大小   | 用途              |
|---------|--------|------------------|
| nvs     | 20KB   | 非易失性存储      |
| otadata | 8KB    | OTA启动数据      |
| app0    | 1536KB | 应用程序分区A    |
| app1    | 1536KB | 应用程序分区B    |
| spiffs  | 960KB  | 文件系统         |

### Arduino IDE 配置

在 Arduino IDE 中：
1. 工具 → 分区方案 → 选择 "No OTA (2MB APP)" → 然后手动编辑
2. 或者使用 platform.txt 覆盖

推荐方法：在 sketch 目录放置 `partitions.csv`，Arduino IDE 会自动识别。

---

## 3. 固件版本管理

### 固件版本号规则

版本号格式：`major.minor.patch`（如 `1.0.0`、`1.0.1`、`2.0.0`）

### 上传新固件

#### 方法一：Web界面上传（推荐）

1. 访问 `http://your-server:34567`
2. 登录后台
3. 选择设备 → 工具箱 → OTA升级
4. 点击"检查更新"查看当前版本

#### 方法二：API上传

```bash
curl -X POST http://localhost:34567/api/ota/upload \
  -u admin:admin123 \
  -F "file=@firmware.bin" \
  -F "version=1.0.1" \
  -F "platform=esp32c3"
```

响应示例：
```json
{
  "success": true,
  "message": "固件上传成功",
  "data": {
    "version": "1.0.1",
    "platform": "esp32c3",
    "filename": "firmware_esp32c3_v1.0.1.bin",
    "size": 1024000,
    "checksum": "d41d8cd98f00b204e9800998ecf8427e"
  }
}
```

#### 方法三：直接放置文件

将固件文件放入服务器的 `firmware/` 目录：

```bash
cp your_firmware.bin /path/to/project/firmware/firmware_esp32c3_v1.0.1.bin
```

然后通过 API 注册：

```bash
curl -X POST http://localhost:34567/api/ota/upload \
  -u admin:admin123 \
  -F "file=@/path/to/firmware.bin" \
  -F "version=1.0.1" \
  -F "platform=esp32c3"
```

---

## 4. 设备端OTA流程

### 流程图

```
┌──────────────┐
│   设备启动    │
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌────────────────┐
│  定时检查     │────▶│ 发送 ota_check │
│  (可选)      │     │  MQTT 消息     │
└──────────────┘     └───────┬────────┘
                             │
                             ▼
                    ┌────────────────┐
                    │  收到响应      │
                    │  version/url   │
                    └───────┬────────┘
                             │
                             ▼
                    ┌────────────────┐
                    │  需要更新?     │
                    └───────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │ Yes                           │ No
              ▼                               ▼
     ┌────────────────┐               ┌────────────────┐
     │ 发送 ota_start │               │   继续运行     │
     │  MQTT 消息    │               │   原固件       │
     └───────┬────────┘               └────────────────┘
             │
             ▼
     ┌────────────────┐
     │  HTTP 下载     │
     │  固件文件      │
     └───────┬────────┘
             │
             ▼
     ┌────────────────┐
     │  写入备用分区   │
     │  (app1)        │
     └───────┬────────┘
             │
             ▼
     ┌────────────────┐
     │  验证 checksum  │
     └───────┬────────┘
             │
      ┌──────┴──────┐
      │ Success     │ Fail
      ▼             ▼
┌────────────┐ ┌────────────┐
│ 设置下次   │ │ OTA失败    │
│ 启动分区   │ │ 继续原固件  │
│ 为 app1   │ │           │
└─────┬──────┘ └────────────┘
      │
      ▼
┌────────────┐
│  ESP重启   │
└─────┬──────┘
      │
      ▼
┌────────────┐
│  新固件启动 │
└────────────┘
```

### MQTT 消息格式

#### ota_check（检查更新）

**发送主题：** `sms_forwarder/cmd/<MAC>`
```json
{
  "action": "ota_check"
}
```

**响应主题：** `sms_forwarder/resp/<MAC>`
```json
{
  "action": "ota_check",
  "success": true,
  "version": "1.0.1",
  "url": "http://192.168.31.197:34567/api/ota/firmware/1.0.1?platform=esp32c3",
  "checksum": "d41d8cd98f00b204e9800998ecf8427e",
  "current_version": "1.0.0",
  "needs_update": true
}
```

#### ota_start（开始升级）

**发送主题：** `sms_forwarder/cmd/<MAC>`
```json
{
  "action": "ota_start",
  "version": "1.0.1",
  "url": "http://192.168.31.197:34567/api/ota/firmware/1.0.1?platform=esp32c3",
  "checksum": "d41d8cd98f00b204e9800998ecf8427e"
}
```

**OTA状态主题：** `sms_forwarder/ota/<MAC>`
```json
{"status": "downloading", "message": "下载中: 25%"}
{"status": "downloading", "message": "下载中: 50%"}
{"status": "downloading", "message": "下载中: 75%"}
{"status": "verifying", "message": "验证固件..."}
{"status": "completed", "message": "升级成功，设备即将重启"}
```

---

## 5. API 参考

### 获取固件版本

```
GET /api/ota/version/:platform
```

**参数：**
- `platform`: 平台标识（如 `esp32c3`）

**响应：**
```json
{
  "success": true,
  "version": "1.0.1",
  "url": "http://192.168.31.197:34567/api/ota/firmware/1.0.1?platform=esp32c3",
  "checksum": "d41d8cd98f00b204e9800998ecf8427e",
  "size": 1024000,
  "platform": "esp32c3"
}
```

### 下载固件

```
GET /api/ota/firmware/:version?platform=esp32c3
```

**响应：** 二进制文件流

**响应头：**
- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="firmware_esp32c3_v1.0.1.bin"`
- `Content-Length: 1024000`
- `x-firmware-version: 1.0.1`
- `x-firmware-checksum: d41d8cd98f00b204e9800998ecf8427e`

### 上传固件

```
POST /api/ota/upload
Content-Type: multipart/form-data
```

**参数：**
- `file`: 固件二进制文件
- `version`: 版本号（如 `1.0.1`）
- `platform`: 平台标识（如 `esp32c3`）

### 固件列表

```
GET /api/ota/list
```

**响应：**
```json
{
  "success": true,
  "data": [
    {
      "version": "1.0.1",
      "platform": "esp32c3",
      "filename": "firmware_esp32c3_v1.0.1.bin",
      "size": 1024000,
      "checksum": "d41d8cd98f00b204e9800998ecf8427e",
      "created_at": 1699000000
    }
  ]
}
```

**注意：** 固件版本必须大于当前已上传的最新版本才能上传成功。

### 删除固件

```
DELETE /api/ota/:version?platform=esp32c3
```

---

## 6. 注意事项

### 安全建议

1. **内网访问**：OTA服务应在内网使用，不要暴露到公网
2. **固件签名**：生产环境建议添加固件签名验证
3. **版本控制**：不要删除正在使用中的旧版本固件

### 故障排查

#### 固件下载失败

1. 检查服务器是否运行：`curl http://localhost:34567/api/ota/version/esp32c3`
2. 检查固件文件是否存在：`ls -la firmware/`
3. 检查防火墙设置

#### 固件写入失败

1. 确保分区表正确配置
2. 检查固件大小是否超过分区容量（1536KB）
3. 检查 ESP32 Flash 是否损坏

#### 设备重启后仍然运行旧固件

1. 检查 otadata 分区是否正确写入
2. 可能是 OTA 升级过程中断，需要重新升级

---

## 7. 编译固件

### Arduino IDE

1. 打开 `ESP32_MQTT_Firmware.ino`
2. 选择正确的开发板：`ESP32C3 Dev Module`
3. 选择分区方案：`No OTA (2MB APP)` 或自定义分区表
4. 编译并上传首次固件
5. 后续通过 OTA 升级

### PlatformIO

在 `platformio.ini` 中添加：

```ini
[env:esp32-c3]
platform = espressif32
board = esp32-c3-devkitm-1
framework = arduino
board_build.partitions = partitions.csv
```

---

## 8. 快速开始

### 1. 部署服务器

```bash
cd sms_forwarding-master
docker compose up -d
```

### 2. 首次烧录固件

使用 USB 线连接 ESP32C3，通过 Arduino IDE 烧录 `ESP32_MQTT_Firmware.ino`

### 3. 上传新固件

```bash
# 编译后上传
curl -X POST http://localhost:34567/api/ota/upload \
  -u admin:admin123 \
  -F "file=@.pio/build/esp32-c3/firmware.bin" \
  -F "version=1.0.1" \
  -F "platform=esp32c3"
```

### 4. 设备自动升级

设备开机后会自动检查更新，或在后台手动触发升级。

---

## 9. 联系与支持

如有问题，请提交 Issue。
