# SMS Forwarder MQTT

基于 ESP32 和 MQTT 的短信转发器系统，采用"瘦客户端 + 集中服务端"架构。

## 功能特性

- **MQTT 通信**：ESP32 作为 MQTT 瘦客户端，与集中服务端通信
- **离线队列**：MQTT 断开时自动缓存短信，重连后补发
- **OTA 无线升级**：支持远程无线更新 ESP32 固件
- **集中管理**：Node.js 服务端统一管理所有设备
- **Web 后台**：现代化 Web 界面，实时监控设备状态
- **实时消息中心**：支持分页、搜索、筛选功能
- **多种推送**：支持 Telegram、钉钉、PushPlus、Server酱、飞书、Bark、Gotify 等推送通道
- **定时任务**：支持一次性任务和周期任务
- **SQLite 持久化**：短信历史、推送记录、任务记录持久化存储
- **HTTP Basic Auth**：Web 后台访问认证

## 项目结构

```
sms_forwarder_mqtt/
├── ESP32_Firmware/           # ESP32 固件
│   ├── ESP32_MQTT_Firmware.ino
│   ├── partitions.csv        # OTA 分区表
│   ├── firmware_v1.0.0.bin   # 示例固件
│   └── wifi_config.h.example # WiFi 配置模板
├── server/                   # Node.js 服务端
│   ├── backend.js            # 主服务
│   ├── database.js           # SQLite 数据库模块
│   ├── middleware/auth.js    # Basic Auth 中间件
│   ├── routes/ota.js         # OTA 路由
│   ├── package.json
│   ├── Dockerfile
│   └── public/
│       └── index.html        # Web 后台（单文件应用）
├── data/                     # 数据目录（自动创建）
│   └── sms_forwarder.db      # SQLite 数据库
├── firmware/                 # 固件目录（自动创建）
├── docker-compose.yml        # Docker 部署配置
└── docs/
    └── README_OTA.md         # OTA 升级详细说明
```

## 快速开始

### 1. 部署 Node.js 服务器

```bash
cd sms_forwarder_mqtt/server

# 安装依赖
npm install

# 启动服务
npm start
```


### 2. Docker 部署

```bash
cd sms_forwarder_mqtt

# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止
docker-compose down
```

### 3. 访问 Web 后台

```
http://localhost:34567
账号: admin
密码: admin123
```

### 4. 配置 MQTT 环境变量（可选）

```bash
# 使用自定义 MQTT Broker
export MQTT_HOST=192.168.31.197
export MQTT_PORT=1883
export MQTT_USER=your_user
export MQTT_PASS=your_password

npm start
```

## 功能模块

### 1. 系统概览

- 实时显示在线/离线设备数量
- 短信总数统计
- 服务器运行时间
- 在线设备列表（点击选中设备）

### 2. 实时消息中心

- **实时接收**：WebSocket 推送，支持实时显示新短信
- **分页显示**：每页10条，支持跳转任意页面
- **搜索功能**：支持按短信内容、发送者、接收号码搜索
- **设备筛选**：按设备 MAC 地址筛选
- **状态筛选**：按推送状态筛选（成功/失败/待推送）
- **重新推送**：失败的消息支持一键重推

### 3. 设备工具箱

| 功能 | 说明 |
|------|------|
| 推送配置 | 配置 Telegram、钉钉、PushPlus、Server酱、飞书、Bark、Gotify、POST JSON、自定义模板 |
| 发送短信 | 向选中设备发送短信 |
| 信息查询 | 查询设备 ATI、信号、SIM卡、网络、WiFi 状态 |
| 网络测试 | Ping 测试 |
| 飞行模式 | 开启/关闭飞行模式 |
| AT终端 | 直接发送 AT 指令 |
| OTA升级 | 检查并升级固件 |
| 定时任务 | 创建、暂停、删除定时短信任务 |

### 4. 定时任务

- **一次性任务**：指定时间发送一次短信
- **周期任务**：按天间隔循环发送
- **执行历史**：记录每次执行的开始时间、状态、响应

## 配置说明

### ESP32 WiFi 配置

编辑 `ESP32_Firmware/wifi_config.h.example`，复制为 `wifi_config.h`:

```cpp
#define WIFI_SSID "Your_WiFi_SSID"
#define WIFI_PASS "Your_WiFi_Password"
```

固件中 MQTT 服务器配置（`ESP32_MQTT_Firmware.ino`）:

```cpp
#define MQTT_SERVER "192.168.31.197"  // 服务器地址
#define MQTT_PORT 1883
#define OTA_SERVER "http://192.168.31.197:34567"
```

### MQTT 命令协议

| Action | 参数 | 说明 |
|--------|-------|------|
| `send_sms` | `{phone, content}` | 发送短信 |
| `ping` | `{}` | Ping 测试 |
| `query` | `{type}` | 信息查询 |
| `flight_mode` | `{status}` | 飞行模式 |
| `at` | `{cmd}` | AT 指令 |
| `ota_check` | `{}` | 检查固件更新 |
| `ota_start` | `{version, url, checksum}` | 开始升级 |
| `reset` | `{}` | 重启设备 |

### Query 类型

| Type | 说明 |
|------|------|
| `ati` | 固件信息 |
| `signal` | 信号质量 |
| `siminfo` | SIM 卡信息 |
| `network` | 网络状态 |
| `wifi` | WiFi 状态 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 34567 | HTTP 服务端口 |
| `MQTT_HOST` | 192.168.31.197 | MQTT Broker 地址 |
| `MQTT_PORT` | 1883 | MQTT Broker 端口 |
| `MQTT_USER` | - | MQTT 用户名（可选） |
| `MQTT_PASS` | - | MQTT 密码（可选） |
| `DATA_DIR` | ./data | 数据目录 |
| `FIRMWARE_DIR` | ./firmware | 固件目录 |
| `OTA_BASE_URL` | - | OTA 下载基础 URL（可选） |
| `TZ` | Asia/Shanghai | 时区 |

## API 接口

所有接口需要 HTTP Basic Auth 认证（默认 admin/admin123）。

### 认证接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/login` | GET | 登录验证 |
| `/api/password` | POST | 修改密码 |

### 设备接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/devices` | GET | 设备列表 |
| `/api/cmd/:mac` | POST | 发送命令 |

### 消息接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/messages` | GET | 短信历史（支持分页、筛选） |
| `/api/stats` | GET | 统计数据 |

### 推送接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/push-config` | GET | 获取推送配置 |
| `/api/push-config` | POST | 保存推送配置 |
| `/api/push-history` | GET | 推送历史记录 |
| `/api/push-history/sms/:smsId` | GET | 特定短信的推送记录 |
| `/api/push-history/:id/retry` | POST | 重试推送 |

### 定时任务接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/schedule` | GET | 定时任务列表 |
| `/api/schedule` | POST | 创建定时任务 |
| `/api/schedule/:id` | GET | 任务详情和执行历史 |
| `/api/schedule/:id` | PUT | 更新任务 |
| `/api/schedule/:id` | DELETE | 删除任务 |

### OTA 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/ota/version/:platform` | GET | 固件版本信息 |
| `/api/ota/firmware/:version` | GET | 下载固件文件 |
| `/api/ota/upload` | POST | 上传固件 |
| `/api/ota/list` | GET | 固件列表 |
| `/api/ota/:version` | DELETE | 删除固件 |

### API 消息接口参数

#### GET /api/messages

**查询参数：**
- `page`: 页码（默认 1）
- `pageSize`: 每页数量（默认 10，最大 100）
- `search`: 搜索关键词（可选）
- `device`: 设备 MAC 地址（可选）
- `status`: 推送状态（可选：success/failed/pending）

**响应示例：**
```json
{
  "success": true,
  "messages": [
    {
      "id": "xxx",
      "mac": "a4cf12d3e1b4",
      "sender": "10086",
      "text": "您的余额...",
      "phone": "13800138000",
      "timestamp": "2026-03-21T15:30:00.000Z",
      "receivedAt": "2026-03-21T15:30:01.234Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 156,
    "totalPages": 16,
    "hasMore": true
  },
  "filters": {
    "search": "",
    "device": "",
    "status": ""
  }
}
```

## WebSocket

**地址：** `ws://host/ws`

### 消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| `init` | 服务器→客户端 | 初始化（设备列表 + 短信列表） |
| `devices` | 服务器→客户端 | 设备列表更新 |
| `sms` | 服务器→客户端 | 新短信推送 |
| `resp` | 服务器→客户端 | 命令响应 |
| `schedule` | 服务器→客户端 | 定时任务事件 |

### 推送状态事件

```json
{
  "type": "schedule",
  "event": "executed",
  "data": {
    "taskId": 1,
    "status": "success",
    "response": "OK"
  },
  "timestamp": 1711012200000
}
```

## 数据库

### 表结构

| 表名 | 用途 | 主要字段 |
|------|------|----------|
| `devices` | 设备管理 | mac(PK), ip, rssi, uptime, last_seen, online, remark |
| `sms_messages` | 短信记录 | id, mac, sender, text, phone, timestamp, received_at |
| `push_configs` | 推送配置 | id(PK=1), config_json |
| `users` | 用户管理 | username(PK), password_hash, created_at |
| `ota_firmware` | 固件版本 | version(PK), platform, filename, size, checksum |
| `scheduled_sms` | 定时任务 | id, mac, phone, content, schedule_type, next_run_time, status |
| `schedule_history` | 任务执行记录 | id, task_id, run_time, status, response |
| `push_history` | 推送历史 | id, sms_id, channel, status, error_message |

### 数据库位置

SQLite 数据库文件位于 `data/sms_forwarder.db`

## Docker 部署

### docker-compose.yml

```yaml
version: '3.8'
services:
  sms-forwarder:
    build: ./server
    ports:
      - "34567:34567"
    environment:
      - PORT=34567
      - MQTT_HOST=192.168.31.197
      - MQTT_PORT=1883
      - TZ=Asia/Shanghai
    volumes:
      - ./data:/app/data
      - ./firmware:/app/firmware
    restart: unless-stopped
```

### 常用命令

```bash
# 构建并启动
docker-compose up -d --build

# 查看日志
docker-compose logs -f

# 停止
docker-compose down

# 查看运行状态
docker-compose ps
```

## 故障排查

### 服务无法启动

1. 检查端口是否被占用：`lsof -i :34567`
2. 检查 Node.js 版本：`node --version`（需要 >= 18.0.0）
3. 检查依赖安装：`npm install`

### 设备不在线

1. 检查 MQTT Broker 是否运行
2. 检查设备配置的服务器地址是否正确
3. 检查防火墙设置（1883 端口）

### 推送失败

1. 检查推送配置是否正确
2. 查看推送历史记录中的错误信息
3. 测试推送渠道是否可用

### 短信时间显示异常

如果历史短信时间显示为 `-`，可能需要执行数据迁移：

```sql
-- 登录 SQLite 数据库
sqlite3 data/sms_forwarder.db

-- 迁移毫秒级时间戳为 ISO 格式
UPDATE sms_messages 
SET received_at = datetime(received_at / 1000, 'unixepoch', 'localtime')
WHERE typeof(received_at) = 'integer' AND received_at > 9999999999;

-- 退出
.quit
```

## 技术栈

| 组件 | 技术 | 版本 |
|------|------|------|
| 后端框架 | Express | 4.18.2 |
| MQTT 客户端 | mqtt.js | 5.3.0 |
| WebSocket | ws | 8.14.2 |
| 数据库 | better-sqlite3 | 9.2.2 |
| 时间处理 | dayjs | 1.11.10 |
| 前端样式 | TailwindCSS (CDN) | - |
| 运行时 | Node.js | >= 18.0.0 |

## 许可证

MIT License
