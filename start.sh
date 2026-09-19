#!/usr/bin/env bash
# NodeWarden Local — quick start script
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -z "${JWT_SECRET:-}" ]; then
  echo "[nodewarden] JWT_SECRET 未设置，正在生成一个随机密钥并写入 .env ..."
  umask 077
  echo "JWT_SECRET=$(openssl rand -hex 24)" > .env
  echo "JWT_SECRET 已保存到 ./.env（首次运行后请妥善保管）"
fi

# shellcheck disable=SC1091
[ -f .env ] && set -a && source .env && set +a

echo "[nodewarden] 启动中 ... 浏览器访问 http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT:-8787}"
exec ./dist-local/nodewarden
