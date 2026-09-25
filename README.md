<p align="center">
  <img src="./NodeWarden.svg" alt="NodeWarden Logo" width="180" />
</p>

<p align="center">
  <strong>NodeWarden Local — Bitwarden 兼容密码库 · 本地化独立可执行版</strong>
</p>

<p align="center">
  脱离 Cloudflare 生态 · 单文件运行 · 数据全部本地化（SQLite） · 9 平台可执行文件
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-LGPL--3.0-2ea44f" alt="License: LGPL-3.0" /></a>
  <img src="https://img.shields.io/badge/platform-Linux%20x64%2Farm64%2Farmv7l%2Farmv6l%20%7C%20Windows%20x64%2Farm64%2Fx86%20%7C%20macOS%20x64%2Farm64-blue" alt="Platforms" />
  <img src="https://img.shields.io/badge/Node-v22.23.2-informational" alt="Node v22.23.2" />
</p>

> **这是什么**：NodeWarden（[shuaiplus/NodeWarden](https://github.com/shuaiplus/NodeWarden)，Cloudflare Workers
> 上的 Bitwarden 兼容服务器）的**本地化适配发行版**——把绑定 Cloudflare 的实现重写为可在你自己的
> 服务器/电脑上直接运行的独立程序：数据库用本地 SQLite，附件存本地目录，实时通知走本地 WebSocket，
> 定时备份由进程内调度，**无需任何云服务账号**。

---

## ✨ 功能特性

- **Bitwarden 客户端完全兼容**：桌面 / 移动端 / 浏览器扩展直接对接（自托管环境填服务器地址即可）
- **单文件可执行**：内置 Node v22.23.2 运行时，无需安装 Node、无需依赖
- **数据全部本地化**：SQLite 数据库 + 本地附件目录 + 本地 KV，停止服务后复制目录即备份
- **实时推送同步**：本地 WebSocket（SignalR 协议），多设备改动即时同步
- **密码管理全家桶**：登录项 / TOTP（含 Steam）/ Secure Notes / 附件 / Send / Passkey 登录
- **安全**：2FA（TOTP / YubiKey / Passkey）、登录审批、设备管理、多用户邀请码
- **云备份仍可用**：WebDAV / S3 定时备份
- **9 平台开箱即用**：见下方矩阵，GitHub Actions 一键编译发布到 Releases

## 🖥️ 平台矩阵

| 平台 | 架构 | 产物 |
| --- | --- | --- |
| Linux | x64 / arm64 / armv7l / armv6l | `nodewarden-linux-<arch>` |
| Windows | x64 / arm64 / x86 | `nodewarden-win-<arch>.exe` |
| macOS | x64（Intel）/ arm64（Apple Silicon） | `nodewarden-macos-<arch>` |

> 所有产物在 [Releases](https://github.com/guimoyun/nodewarden-WL/releases) 下载，
> 或点仓库 **Actions → Build & Release → Run workflow** 手动触发重新编译发布。

## 🚀 快速开始

```bash
# Linux / macOS（macOS 需先执行 codesign --force --sign - 重新签名，见 README-MACOS.md）
export JWT_SECRET="$(openssl rand -hex 24)"
./nodewarden-linux-x64          # 默认监听 0.0.0.0:8787，数据存 ./nw-data
```

Windows 双击 `start.bat` 即可（自动生成并保存 JWT 密钥）。

浏览器打开 `http://<服务器IP>:8787`，**首次注册的账号自动成为管理员**。
Bitwarden 客户端对接：设置 → 自托管环境 → 服务器地址填 `http://<服务器IP>:8787`。

## 📚 文档

| 文档 | 内容 |
| --- | --- |
| [README-LOCAL.md](README-LOCAL.md) | 主使用说明：环境变量、systemd 部署、备份、本地化改造细节、从源码构建 |
| [README-WINDOWS.md](README-WINDOWS.md) | Windows 版：快速开始、防火墙、SmartScreen 说明 |
| [README-MACOS.md](README-MACOS.md) | macOS 版：重新签名、Gatekeeper 处理 |
| [BUILD-RELEASES.md](BUILD-RELEASES.md) | 跨平台构建与发布：平台矩阵、构建流程、运行时清单、CI 说明 |

## 🔧 本地化改造说明（相对 Cloudflare 版）

| Cloudflare 组件 | 本地替代 | 位置 |
| --- | --- | --- |
| D1 数据库 | 本地 SQLite（`node:sqlite`） | `local/d1.ts` |
| R2 附件 / KV | 本地目录 | `local/r2.ts` / `local/kv.ts` |
| Durable Objects 通知中心 | 进程内模拟 + `ws` WebSocket（SignalR 兼容） | `local/durable.ts` / `local/server.ts` |
| Workers 静态资源 | 本地 dist 目录 + SPA fallback | `local/assets.ts` |
| `caches` / 限流 | 内存缓存 | `local/cache.ts` |
| Cron 定时备份 | 进程内 5 分钟调度 | `local/index.ts` |

源码仅改动一处：`src/durable/notifications-hub.ts` 的 Cloudflare 导入替换为本地模拟
（保留 Cloudflare 部署兼容，详见 [README-LOCAL.md](README-LOCAL.md) 第六节）。

## 🤖 自动编译与发布

`.github/workflows/build-release.yml`：手动触发（workflow_dispatch），自动完成
**编译 9 平台 → SEA 注入（macOS 自动 ad-hoc 签名）→ 打包 → 发布到 Releases**。

## 🛠️ 开发

```bash
npm install && npm run build      # 构建 Web Vault 前端（dist/）
npx tsx local/index.ts            # 本地直接运行（tsx 开发模式）
# 打包单文件可执行（SEA）见 BUILD-RELEASES.md 第二节
```

## 📄 与上游项目的关系

本仓库是 [shuaiplus/NodeWarden](https://github.com/shuaiplus/NodeWarden)（v1.8.0，LGPL-3.0）的
**本地化适配发行版**：保留其全部功能与协议实现，新增 `local/` 适配层使其脱离 Cloudflare 以本地
可执行文件运行。上游 Cloudflare Workers 部署方式请参见上游仓库。

## ⚖️ License

[LGPL-3.0](./LICENSE)，与上游一致。本项目与 Bitwarden 官方无任何关联，使用前请自行备份数据。
