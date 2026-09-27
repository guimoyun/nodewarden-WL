#!/usr/bin/env bash
# NodeWarden Local — one-command install to /opt/nodewarden
# 一键安装：下载最新版本 → 部署到 /opt/nodewarden → 生成密钥 → 注册系统服务
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/guimoyun/nodewarden-WL/main/scripts/nodewarden-install.sh | sudo bash
#   # 或下载后执行：
#   sudo bash nodewarden-install.sh
#
# 目录布局（程序目录与密码库目录统一在 /opt/nodewarden）:
#   /opt/nodewarden/
#   ├── nodewarden-linux-*     ← 可执行程序（单文件二进制）
#   ├── dist/                  ← Web Vault 前端资源
#   ├── nw-data/               ← 密码库数据（SQLite 数据库、附件）
#   ├── .env                   ← JWT_SECRET（0600 权限）
#   └── start.sh / run.sh      ← 手动运行脚本
set -euo pipefail

REPO="guimoyun/nodewarden-WL"
INSTALL_DIR="/opt/nodewarden"
DATA_DIR="${INSTALL_DIR}/nw-data"
DIST_DIR="${INSTALL_DIR}/dist"

log()  { echo -e "\033[1;32m[nodewarden]\033[0m $*"; }
warn() { echo -e "\033[1;33m[nodewarden]\033[0m $*"; }
die()  { echo -e "\033[1;31m[nodewarden]\033[0m $*" >&2; exit 1; }

# ---------- 1. root 检查 ----------
if [ "$(id -u)" -ne 0 ]; then
  die "需要 root 权限，请用 sudo 执行：sudo bash $0"
fi

# ---------- 2. 架构检测 ----------
detect_platform() {
  case "$(uname -m)" in
    x86_64|amd64)      echo "linux-x64" ;;
    aarch64|arm64)     echo "linux-arm64" ;;
    armv7l|armhf)      echo "linux-armv7l" ;;
    armv6l)            echo "linux-armv6l" ;;
    *) die "不支持的架构: $(uname -m)（仅支持 x64 / arm64 / armv7l / armv6l）" ;;
  esac
}
PLAT="$(detect_platform)"
BIN_NAME="nodewarden-${PLAT}"
ZIP_NAME="${BIN_NAME}.zip"
DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ZIP_NAME}"

# ---------- 3. 下载最新版本 ----------
log "下载 ${ZIP_NAME} ..."
log "  ${DOWNLOAD_URL}"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 -o "${TMPDIR}/${ZIP_NAME}" "${DOWNLOAD_URL}"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "${TMPDIR}/${ZIP_NAME}" "${DOWNLOAD_URL}"
else
  die "需要 curl 或 wget"
fi

# ---------- 4. 部署到 /opt/nodewarden ----------
mkdir -p "${INSTALL_DIR}"
log "解压到 ${INSTALL_DIR} ..."
if command -v unzip >/dev/null 2>&1; then
  unzip -qo "${TMPDIR}/${ZIP_NAME}" -d "${INSTALL_DIR}"
elif command -v busybox >/dev/null 2>&1; then
  busybox unzip -qo "${TMPDIR}/${ZIP_NAME}" -d "${INSTALL_DIR}"
else
  die "需要 unzip（Debian/Ubuntu: apt install unzip；Alpine: apk add unzip）"
fi

[ -x "${INSTALL_DIR}/${BIN_NAME}" ] || die "解压后未找到可执行文件 ${BIN_NAME}"
chmod +x "${INSTALL_DIR}/${BIN_NAME}"
mkdir -p "${DATA_DIR}"

# ---------- 5. 生成/复用 JWT_SECRET ----------
ENV_FILE="${INSTALL_DIR}/.env"
umask 077
if [ ! -s "${ENV_FILE}" ]; then
  if [ -n "${JWT_SECRET:-}" ]; then
    printf 'JWT_SECRET=%s\n' "${JWT_SECRET}" > "${ENV_FILE}"
  else
    printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 24)" > "${ENV_FILE}"
  fi
  log "已生成 JWT_SECRET 并保存到 ${ENV_FILE}（请妥善保管，换密钥 = 全部会话失效）"
else
  log "复用已有 ${ENV_FILE}"
fi
chmod 600 "${ENV_FILE}"
set -a; source "${ENV_FILE}"; set +a

# ---------- 6. 注册系统服务（systemd / OpenRC） ----------
cd "${INSTALL_DIR}"
log "注册系统服务（--install-service）..."
# shellcheck disable=SC1090
export JWT_SECRET NODEWARDEN_DATA_DIR="${DATA_DIR}" NODEWARDEN_DIST_DIR="${DIST_DIR}"
if NODEWARDEN_DATA_DIR="${DATA_DIR}" NODEWARDEN_DIST_DIR="${DIST_DIR}" \
   "${INSTALL_DIR}/${BIN_NAME}" --install-service; then
  log "服务已注册并启动：systemctl status nodewarden  /  journalctl -u nodewarden -f"
else
  warn "--install-service 注册失败（可能 init 系统不受支持），将改为直接后台运行"
  nohup "${INSTALL_DIR}/${BIN_NAME}" >/dev/null 2>&1 &
fi

# ---------- 7. 完成 ----------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

============================================================
  NodeWarden 已安装完成

  访问地址:  http://${IP:-<服务器IP>}:8787
  首次注册的账号自动成为管理员（后续注册需管理员邀请码）

  程序目录:  ${INSTALL_DIR}        （二进制 + dist 前端）
  密码库目录: ${DATA_DIR}          （SQLite 数据库 + 附件）
  密钥文件:  ${ENV_FILE}           （0600，勿外泄）

  常用命令:
    systemctl status nodewarden    查看服务状态
    journalctl -u nodewarden -f    实时日志
    ${INSTALL_DIR}/${BIN_NAME} --uninstall-service   卸载服务
    ${INSTALL_DIR}/${BIN_NAME} --help                全部命令与变量
    ${INSTALL_DIR}/start.sh        手动前台运行（调试用）

  一键更新: 登录 Web Vault → 程序设置 → 一键更新
============================================================
EOF
