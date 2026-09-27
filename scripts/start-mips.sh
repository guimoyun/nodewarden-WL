#!/usr/bin/env bash
# NodeWarden Local — mips / mipsel source-compat launcher
# 说明：Node.js 官方不再发布 mips/mipsel 单文件载体，此平台以"源码兼容包"提供：
#   用设备上的 Node.js ≥ 22 直接运行 nodewarden.js（无需编译，业务代码同源）。
# 前置：设备已安装 Node.js ≥ 22（OpenWrt：opkg install node；其他发行版：包管理器安装 nodejs）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null 2>&1 || { echo "[nodewarden] 未找到 node，请先安装 Node.js ≥ 22" >&2; exit 1; }

if [ -z "${JWT_SECRET:-}" ]; then
  if [ -f .env ]; then
    set -a; source .env; set +a
  fi
fi
if [ -z "${JWT_SECRET:-}" ]; then
  echo "[nodewarden] JWT_SECRET 未设置，正在生成一个随机密钥并写入 .env ..."
  umask 077
  echo "JWT_SECRET=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" > .env
  set -a; source .env; set +a
fi

export NODEWARDEN_DATA_DIR="${SCRIPT_DIR}/nw-data"
export NODEWARDEN_DIST_DIR="${SCRIPT_DIR}/dist"

echo "[nodewarden] 启动中（node $(node -v)）... 浏览器访问 http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT:-8787}"
exec node "${SCRIPT_DIR}/nodewarden.js"
