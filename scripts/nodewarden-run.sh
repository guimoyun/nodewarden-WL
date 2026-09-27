#!/usr/bin/env bash
# NodeWarden Local — manual run script (/opt/nodewarden layout)
# 手动前台运行（调试用）；生产环境请用系统服务（--install-service）
set -euo pipefail

INSTALL_DIR="/opt/nodewarden"
DATA_DIR="${INSTALL_DIR}/nw-data"
DIST_DIR="${INSTALL_DIR}/dist"

if [ ! -d "${INSTALL_DIR}" ]; then
  echo "[nodewarden] 未找到 ${INSTALL_DIR}，请先执行 nodewarden-install.sh 安装" >&2
  exit 1
fi

# 自动探测二进制
BIN="$(ls "${INSTALL_DIR}"/nodewarden-linux-* 2>/dev/null | head -1)"
[ -n "${BIN}" ] || { echo "[nodewarden] 未找到可执行程序（${INSTALL_DIR}/nodewarden-linux-*）" >&2; exit 1; }

# 读取密钥
if [ -z "${JWT_SECRET:-}" ] && [ -f "${INSTALL_DIR}/.env" ]; then
  set -a; source "${INSTALL_DIR}/.env"; set +a
fi
if [ -z "${JWT_SECRET:-}" ]; then
  echo "[nodewarden] 警告：未设置 JWT_SECRET，将使用内存随机密钥（重启后会话失效）" >&2
  export NODEWARDEN_ALLOW_INSECURE_JWT=1
fi

cd "${INSTALL_DIR}"
export NODEWARDEN_DATA_DIR="${DATA_DIR}" NODEWARDEN_DIST_DIR="${DIST_DIR}"
echo "[nodewarden] 启动中 ... 浏览器访问 http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT:-8787}"
exec "${BIN}"
