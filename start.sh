#!/usr/bin/env bash
# NodeWarden Local — quick start script (run inside the extracted zip folder)
# 一键运行：把本文件与二进制、dist 文件夹放在同一目录后执行 ./start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 自动探测同目录二进制（nodewarden-linux-x64 / nodewarden-win-x64.exe 等）
BIN="$(ls ./nodewarden-* 2>/dev/null | grep -v '\.zip$' | head -1 || true)"
[ -n "${BIN}" ] || { echo "[nodewarden] 未找到可执行程序（nodewarden-*），请确认与二进制放在同一目录" >&2; exit 1; }
chmod +x "${BIN}" 2>/dev/null || true

if [ -z "${JWT_SECRET:-}" ]; then
  if [ -f .env ]; then
    set -a; source .env; set +a
  fi
fi
if [ -z "${JWT_SECRET:-}" ]; then
  echo "[nodewarden] JWT_SECRET 未设置，正在生成一个随机密钥并写入 .env ..."
  umask 077
  echo "JWT_SECRET=$(openssl rand -hex 24)" > .env
  echo "JWT_SECRET 已保存到 ./.env（首次运行后请妥善保管）"
  set -a; source .env; set +a
fi

# 数据目录与前端目录默认跟随本目录（与 /opt/nodewarden 一键安装布局一致）
export NODEWARDEN_DATA_DIR="${SCRIPT_DIR}/nw-data"
export NODEWARDEN_DIST_DIR="${SCRIPT_DIR}/dist"

echo "[nodewarden] 启动中 ... 浏览器访问 http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT:-8787}"
echo "[nodewarden] 数据目录: ${NODEWARDEN_DATA_DIR}"
exec "./${BIN}"
