#!/bin/bash
# 修复 SMS Forwarder 数据库问题

echo "=== 停止容器 ==="
docker rm -f sms-forwarder

echo "=== 删除旧数据库 ==="
rm -f data/sms_forwarder.db

echo "=== 重启容器 ==="
docker compose up -d

echo "=== 查看日志 ==="
docker compose logs -f
