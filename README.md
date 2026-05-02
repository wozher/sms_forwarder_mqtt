# SMS Forwarder MQTT

基于 ESP32、MQTT 和 Node.js 的短信转发系统，包含设备固件、集中式服务端和 Web 管理后台。

## 当前状态

- 服务端入口为 `server/backend.js`，当前版本号为 `2.0.0`
- Web 后台、消息中心、设备工具箱、定时任务、推送配置、诊断面板均已接入主服务
- OTA 相关预留路由已从当前主线移除，仓库当前不提供 OTA 服务端能力

## 主要功能

- ESP32 设备通过 MQTT 上报心跳、短信、状态信息并接收控制命令
- Web 后台支持 Basic Auth 登录，默认账号 `admin`，默认密码 `admin123`
- 消息中心支持实时刷新、分页、关键词筛选、手机号筛选、方向筛选、推送状态筛选
- 入站短信支持离线缓存后补发，消息详情可查看是否为补发以及入队时间
- 支持 Telegram、钉钉、PushPlus、Server 酱、飞书、Bark、Gotify、POST JSON、自定义模板推送
- 支持设备备注和设备手机号覆盖
- 支持发送短信、查询设备信息、Ping、飞行模式、AT 指令
- 支持定时短信任务和定时流量消耗任务
- 支持诊断快照、诊断历史和异常设备汇总展示

## 项目结构

```text
sms_forwarder_mqtt/
|-- ESP32_Firmware/
|   |-- ESP32_MQTT_Firmware/
|   |   |-- ESP32_MQTT_Firmware.ino
|   |   `-- partitions.csv
|   `-- wifi_config.h.example
|-- docs/
|   `-- 操作手册.md
|-- firmware/
|-- server/
|   |-- backend.js
|   |-- database.js
|   |-- Dockerfile
|   |-- middleware/
|   |   `-- auth.js
|   |-- public/
|   |   |-- dist/
|   |   |-- src/
|   |   `-- index.html
|   |-- routes/
|   `-- scripts/
|       `-- build-web.mjs
|-- docker-compose.yml
`-- CHANGELOG.md
```

## 快速开始

### 1. 启动服务端

```bash
cd server
npm install
npm start
```

默认启动信息：

- HTTP: `http://127.0.0.1:3000`
- WebSocket: `ws://127.0.0.1:3000/ws`
- 默认 MQTT Broker: `mqtt://192.168.31.197:1883`

如果使用根目录里的 Docker Compose，则默认映射端口为 `34567`。

### 2. Docker 部署

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

当前 `docker-compose.yml` 默认配置：

- 端口映射：`34567:34567`
- 数据卷：`./data:/app/data`
- 服务端口环境变量：`PORT=34567`
- 数据目录环境变量：`DATA_DIR=/app/data`

### 3. 访问后台

- Compose 部署：`http://localhost:34567`
- 直接运行 `npm start`：`http://localhost:3000`
- 默认账号：`admin`
- 默认密码：`admin123`

## ESP32 固件配置

1. 复制 `ESP32_Firmware/wifi_config.h.example` 为 `ESP32_Firmware/ESP32_MQTT_Firmware/wifi_config.h`
2. 修改 WiFi 信息
3. 根据实际环境修改 `ESP32_MQTT_Firmware.ino` 中的 MQTT 服务地址

示例：

```cpp
#define WIFI_SSID "Your_WiFi_SSID"
#define WIFI_PASS "Your_WiFi_Password"
```

## 设备命令

服务端通过 `POST /api/cmd/:mac` 下发命令，固件当前支持的 `action` 包括：

| Action | 参数 | 说明 |
| --- | --- | --- |
| `send_sms` | `{ phone, content }` | 发送短信 |
| `query` | `{ type }` | 查询设备信息 |
| `ping` | `{}` | 执行网络测试 |
| `flight_mode` | `{ status }` | 开启、关闭或查询飞行模式 |
| `at` | `{ cmd }` | 发送 AT 指令 |
| `consume_traffic` | `{ targetKb }` | 执行流量消耗任务 |
| `reset` | `{}` | 固件中支持的重启命令 |
| `query_sim` | `{}` | 固件中支持的 SIM 查询命令 |

`query.type` 当前前端实际使用的值为：

- `ati`
- `signal`
- `siminfo`
- `network`
- `wifi`

## Web 后台能力

### 消息中心

- 初始通过 WebSocket 下发最近 50 条消息
- HTTP 列表接口支持分页查询
- 当前 UI 支持的筛选条件：
  - `search`
  - `phone`
  - `direction`
  - `status`，这里表示推送状态，不是短信投递状态
- 支持单条删除和批量删除
- 消息详情展示推送状态、错误信息、请求 ID、补发状态、入队时间等字段

### 设备管理

- 显示在线 / 离线状态
- 支持编辑设备备注
- 支持覆盖显示设备手机号
- 设备在线判定规则为最近 120 秒内有心跳

### 设备工具箱

- 发送短信
- 固件信息 / 信号质量 / SIM 卡信息 / 网络状态 / WiFi 状态查询
- Ping 网络测试
- 飞行模式控制
- AT 终端
- 定时任务
- 诊断面板

### 定时任务

- 支持两类任务：`sms`、`traffic`
- 支持两种执行方式：`once`、`interval`
- 周期任务按“每 N 天固定时刻执行”计算下次时间
- 支持暂停、恢复、删除
- 任务详情支持查看执行历史

### 诊断面板

当前诊断数据来自固件心跳中的状态字段与服务端落库历史，主要包含：

- `freeHeap`
- `minFreeHeap`
- `pendingUrc`
- `offlineSms`
- `urcWaitingPdu`
- `pendingDeferredPdu`

历史接口支持 `1h`、`24h`、`7d` 三种范围。

## API 概览

所有 `/api/*` 接口默认使用 HTTP Basic Auth，只有 `/api/login` 为公开登录校验接口。

### 认证

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/login` | `POST` | 校验账号密码 |
| `/api/password` | `POST` | 修改当前用户密码 |

### 设备

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/devices` | `GET` | 获取设备列表 |
| `/api/devices/:mac/diag-history` | `GET` | 获取设备诊断历史 |
| `/api/devices/:mac/remark` | `PUT` | 更新设备备注 |
| `/api/devices/:mac/phone` | `PUT` | 更新设备手机号覆盖值 |
| `/api/cmd/:mac` | `POST` | 向设备发送命令 |

### 消息

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/messages` | `GET` | 分页获取消息列表 |
| `/api/messages/:id` | `DELETE` | 删除单条消息 |
| `/api/messages/batch-delete` | `POST` | 批量删除消息 |
| `/api/stats` | `GET` | 获取总数统计 |

### 推送

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/push-config` | `GET` | 获取推送配置 |
| `/api/push-config` | `POST` | 保存推送配置 |
| `/api/push-history` | `GET` | 获取推送历史 |
| `/api/push-history/sms/:smsId` | `GET` | 获取某条短信的推送记录 |
| `/api/push-history/:id/retry` | `POST` | 重试某条推送记录 |

### 定时任务

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/schedule` | `GET` | 获取任务列表 |
| `/api/schedule` | `POST` | 创建任务 |
| `/api/schedule/:id` | `GET` | 获取任务详情和历史 |
| `/api/schedule/:id` | `PUT` | 更新任务状态或内容 |
| `/api/schedule/:id` | `DELETE` | 删除任务 |

## WebSocket

- 地址：`ws://host/ws?auth=<BasicAuthBase64>`
- 当前服务端会广播以下类型：
  - `init`
  - `devices`
  - `sms`
  - `resp`
  - `schedule`

## 数据存储

SQLite 默认路径：

```text
data/sms_forwarder.db
```

当前主要表：

- `devices`
- `sms_messages`
- `push_configs`
- `users`
- `scheduled_sms`
- `schedule_history`
- `push_history`
- `device_diag_history`

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端监听端口 |
| `MQTT_HOST` | `192.168.31.197` | MQTT Broker 地址 |
| `MQTT_PORT` | `1883` | MQTT Broker 端口 |
| `MQTT_USER` | 空 | MQTT 用户名 |
| `MQTT_PASS` | 空 | MQTT 密码 |
| `DATA_DIR` | `../data` | SQLite 数据目录 |
| `DIAG_HISTORY_INTERVAL_MS` | `300000` | 诊断历史落库间隔 |

Docker 运行时额外使用：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TZ` | `Asia/Shanghai` | 容器时区；代码内部当前固定按 Asia/Shanghai 处理 |

## 当前已知限制

- 当前主线不包含 OTA 服务端实现；若后续恢复，需要重新补齐路由、上传中间件和固件元数据存储
- 根文档旧版本曾混用 `3000` 与 `34567` 端口；当前实际端口取决于是否通过 Compose 部署
- 消息列表中的 `status` 筛选代表推送状态，而非短信本身的发送状态

## 相关文档

- `CHANGELOG.md`
- `docs/操作手册.md`

## 许可证

MIT
