# Changelog

## 2026-05-02

### Summary

本次更新主要补齐了 4 月底到 5 月初已经落地到代码中的后台能力说明，并重写了项目文档，使 README、操作手册与当前实现保持一致。

### Backend

- 增加设备备注与设备手机号覆盖接口：
  - `PUT /api/devices/:mac/remark`
  - `PUT /api/devices/:mac/phone`
- 增加设备诊断历史接口：
  - `GET /api/devices/:mac/diag-history`
- 消息列表支持按推送状态筛选，并保持分页统计与 UI 一致
- 增加单条与批量删除消息接口
- 定时任务支持两类任务：
  - 定时短信
  - 定时流量消耗
- 定时任务支持状态切换、内容更新、周期更新与执行历史查询
- 服务端对流量消耗型操作增加漫游拦截逻辑

### Database

- `devices` 表增加以下能力字段：
  - `remark`
  - `phone_override`
  - `version`
  - `status_json`
- `sms_messages` 表增加以下业务字段：
  - `sms_id`
  - `device_phone`
  - `queued`
  - `queued_at`
  - `status`
  - `direction`
  - `source`
  - `error_message`
  - `request_id`
  - `task_id`
- 新增 `device_diag_history` 表
- `scheduled_sms` 表补充以下字段：
  - `bind_mode`
  - `bind_phone`
  - `task_type`
  - `traffic_kb`
  - `interval_hours`
  - `interval_minutes`

### Frontend

- 设备卡片支持编辑备注
- 设备工具箱新增诊断面板
- 消息详情新增推送状态、补发状态、请求 ID、入队时间展示
- 定时任务 UI 支持短信任务与流量任务切换
- 优化多处提示文案与异常提示

### Firmware

- 固件状态心跳当前已包含更完整的 `status` 结构，供服务端落库和诊断面板使用
- 心跳与短信链路已支持补发状态、请求 ID、离线短信计数等字段

### Docs

- 重写 `README.md`
- 重写 `docs/操作手册.md`
- 重写 `docs/README_OTA.md`
- 将 OTA 预留路由从当前主线移除，并把文档同步为“未提供 OTA 能力”

### Commits

- `9756bc5` `Refine diagnostic dashboard and deployment flow`
- `8db0301` `Refine diagnostic panel typography`
- `3cee1a5` `Refine message layout and diagnostics`

## 2026-04-12

### Summary

本次更新主要围绕 Web 后台消息中心与首页布局做收口与可用性增强，并修复 Docker 前端构建因脚本语法错误导致失败的问题。

### Backend

- 为短信列表接口恢复 `phone` 筛选参数，用于按手机号过滤（发送方 / 接收方）
- 保留批量删除短信历史接口

### Frontend

- 消息中心筛选项改为“全部手机号”，同时包含发送方与接收方
- 消息中心列表移除“推送状态”列，仅在详情中展示
- 新增“刷新”按钮，重置筛选并回到第一页
- 修复推送配置启用状态文案在页面初始加载时不同步的问题
- 修复手机号筛选选项生成处多余 `}` 导致前端打包失败的问题
- 优化 PC / 移动端筛选栏布局与首页设备区块比例

## 2026-04-06

### Summary

本次更新主要修复了短信实时展示重复、固件网络状态误判，以及串口与 URC 并发导致的若干稳定性问题，整体提升了短信收发、消息中心实时更新和设备状态上报的可靠性。

### Firmware

- 优化短信发送判定逻辑，按 `+CMGS`、`OK`、`+CMS ERROR`、`+CME ERROR` 更准确判断
- 增加短信发送参考号 `ref` 返回
- 优化长短信乱序分段拼接与转发
- 修复接收短信过程中临时查询本机号导致的串口竞争问题
- 优化 `network`、`siminfo` 查询逻辑
- 修复心跳 `network` 字段缺失、注册状态误判、运营商解析异常等问题
- 统一 MQTT 心跳、响应、原始短信、离线补发的发布逻辑
- 改进启动阶段与运行阶段的 URC 处理

### Backend

- 接收短信入库时增加设备号码兜底逻辑
- 修复发送记录成功后仍显示失败原因的问题
- 保持发送与接收短信广播和数据库记录一致

### Frontend

- 修复消息中心与发送记录在 WebSocket 刷新时重复展示同一短信的问题
- 实时更新改为按短信 `id` 更新或插入
- 优化短信发送成功提示与参考号展示
- 修复接收短信收件号码优先展示异常
- 修复按手机号筛选时发送与接收短信显示不全、分页统计异常的问题
