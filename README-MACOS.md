# NodeWarden Local — macOS 版

macOS（Intel x64 或 Apple Silicon arm64）单文件可执行程序，内置 Node v22.23.2 运行时，
无需安装 Node，无需任何云服务账号。

## 快速开始

1. 把 `nodewarden-macos-*` 和 `dist` 文件夹放到同一目录（如 `~/nodewarden/`）：

   ```
   ~/nodewarden/
   ├── nodewarden-macos-arm64   ← 可执行程序（M 系列选 arm64，Intel 选 x64）
   ├── dist/                    ← Web Vault 前端资源（整个文件夹）
   └── start.sh                 ← 一键启动脚本
   ```

2. **首次运行必须先重新签名**（SEA 注入会破坏原签名，这是 macOS 系统要求）：

   ```bash
   cd ~/nodewarden
   chmod +x nodewarden-macos-arm64
   codesign --force --sign - nodewarden-macos-arm64
   ```

3. 启动并访问：

   ```bash
   ./start.sh          # 或 JWT_SECRET=你的密钥 ./nodewarden-macos-arm64
   # 浏览器打开 http://127.0.0.1:8787 ，首次注册账号即管理员
   ```

若提示"无法验证开发者"：**系统设置 → 隐私与安全性 → 仍要打开**；
或执行 `xattr -dr com.apple.quarantine nodewarden-macos-arm64` 清除隔离标记。

## 环境变量

与全平台一致：`JWT_SECRET`（必填）、`NODEWARDEN_DATA_DIR`（默认 `./nw-data`）、
`NODEWARDEN_DIST_DIR`（默认 `./dist`）、`HOST`/`PORT`、`WEBAUTHN_RP_ID` 等，详见 `README-LOCAL.md`。

## 数据与备份

数据在 `nw-data/` 下（`nodewarden.db` SQLite + `attachments/`）。备份 = 停止服务后复制整个
数据目录；也可在 Web Vault 里配置 WebDAV/S3 云备份。
