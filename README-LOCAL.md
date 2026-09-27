# NodeWarden Local（本地化可执行版）

NodeWarden（Bitwarden 兼容密码管理服务器）的**本地化独立可执行版**：脱离 Cloudflare 生态，
以单个可执行文件运行完整的密码库服务，数据全部保存在本机。

支持 **9 个平台/架构**（Linux x64/arm64/armv7l/armv6l、Windows x64/arm64/x86、macOS x64/arm64），
全部平台产物与构建方法见 **[BUILD-RELEASES.md](BUILD-RELEASES.md)**，各平台专属说明见
`README-WINDOWS.md` / `README-MACOS.md`。以下以 Linux x64 为例。

## 一、快速开始（3 步）

```bash
# 1. 设置密钥（32+ 随机字符，务必保存，换密钥 = 全部会话失效）
export JWT_SECRET="$(openssl rand -hex 24)"

# 2. 启动（默认 0.0.0.0:8787，数据存 ./nw-data，前端资源从 ./dist 读取）
./dist-local/nodewarden

# 3. 浏览器打开
#    http://<服务器IP>:8787
#    首次注册的账号自动成为管理员（后续注册需要管理员邀请码）
```

停止：`Ctrl+C`（SIGINT/SIGTERM 会优雅退出并落盘）。

> **重要**：`nodewarden` 二进制运行时从**当前工作目录**的相对路径读取 `dist/`（Web Vault 前端）
> 和 `nw-data/`（数据库）。推荐把二进制放在 `nodewarden/` 项目根下运行，或显式指定目录（见下）。

## 二、环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | **必填** | JWT 签名密钥，≥32 字符随机串。设置 `NODEWARDEN_ALLOW_INSECURE_JWT=1` 可在未设置时用内存随机密钥（重启后所有会话失效，仅限本地调试） |
| `NODEWARDEN_DATA_DIR` | `./nw-data` | 数据目录（SQLite 数据库、附件、KV 缓存都在这下面） |
| `NODEWARDEN_DIST_DIR` | `./dist` | Web Vault 前端静态资源目录 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `WEBAUTHN_RP_ID` | 自动 | Passkey（WebAuthn）的 Relying Party ID，一般填对外域名/IP |
| `WEBAUTHN_RP_NAME` | `NodeWarden` | Passkey 显示名 |
| `WEBAUTHN_ALLOWED_ORIGINS` | 自动 | 允许的 Passkey 来源（逗号分隔） |
| `HIDE_WEB_VAULT` | 未设置 | 设为 `1` 时隐藏 Web Vault 页面（仅用 API/客户端） |

## 三、对接 Bitwarden 官方客户端

在 Bitwarden 客户端（桌面/移动/浏览器扩展）中：

1. 右上角 **设置 → 自托管环境 / Server URL**；
2. 服务器地址填：`http://<服务器IP>:8787`（如 `http://192.168.1.10:8787`）；
3. 用你注册的邮箱 + 主密码登录即可。

支持的功能与 Cloudflare 版一致：密码/登录项/TOTP（含 Steam）、Secure Notes、附件与 Send、
Passkey 登录、2FA（TOTP/YubiKey/Passkey）、实时推送同步（WebSocket）、设备管理、登录审批、
多用户邀请码、WebDAV/S3 云备份。

## 四、systemd 常驻运行（生产推荐）

创建 `/etc/systemd/system/nodewarden.service`：

```ini
[Unit]
Description=NodeWarden Local (Bitwarden-compatible password server)
After=network.target

[Service]
Type=simple
User=nodewarden
WorkingDirectory=/opt/nodewarden
Environment=JWT_SECRET=请替换为你的长随机密钥
Environment=NODEWARDEN_DATA_DIR=/var/lib/nodewarden
Environment=NODEWARDEN_DIST_DIR=/opt/nodewarden/dist
Environment=PORT=8787
ExecStart=/opt/nodewarden/nodewarden
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nodewarden
sudo systemctl status nodewarden
journalctl -u nodewarden -f   # 看日志
```

数据目录建议放在独立磁盘分区，便于备份。

## 五、数据与备份

所有数据在 `NODEWARDEN_DATA_DIR` 下：

```
nw-data/
├── nodewarden.db          # SQLite 数据库（密码条目、用户、Send 等全部数据）
├── nodewarden.db-wal      # WAL 日志（运行中产生，正常退出后合并回主库）
├── attachments/           # 附件文件（R2 的本地替代）
└── kv/                    # KV 备用存储（一般为空）
```

**备份方式**：
- 停止服务后复制整个 `nw-data/` 目录即可（最稳妥）；
- 或在线备份：先 `sqlite3 nodewarden.db ".backup backup.db"`（WAL 安全），再复制附件目录；
- 也可以在 Web Vault 里配置 **WebDAV / S3 云备份**（定时自动备份，每 5 分钟检查一次计划）。

## 五点五、多库同步（远程密码库同步）

后台（设置 → 系统管理 → **远程库同步**，需管理员）可以添加**其他 NodeWarden 密码库**作为
同步源：填写「网址 + 邮箱 + 主密码」即可把远端库的密码条目同步到本地，支持**定时同步**。

**适用场景**：多个 NodeWarden 节点（如 CF 线上库 + 本地库）保持同一套密码；把线上库整体迁入
本地库后，本地用相同主密码登录即可查看全部条目。

**多主互同步（多台服务器冗余）**：多台服务器可以**互相把对方添加为同步源**，形成网格冗余——
任何一台都能读写，任一台宕机其余节点仍持有全量密码。同步是"拉取式"且**幂等**的（相同时间戳
跳过、不产生环），条目冲突按 **最后写入者胜出**（比较条目 `revisionDate`）：后修改的那台服务器
的版本最终会传播到所有节点。实测验证过的拓扑：两台互指 → 条目双向到达、冲突收敛、删除传播、
重同步无重复（测试脚本：`scripts/test-remote-sync-multi-master.ts`）。

**用法**：

1. 管理员登录 Web Vault → 设置 → 系统管理 → 远程库同步；
2. 「添加远程密码库」：填写远端库网址（如 `https://pwd.177999.xyz`）、账号邮箱、主密码，
   同步间隔（分钟，默认 60）；
3. 添加即执行首次同步；之后按设置的间隔自动同步，也可手动「立即同步」。

**安全说明**：

- 主密码明文**永不落盘**；登录凭证以 `JWT_SECRET` 派生的 AES-256-GCM 加密后存储，定时同步用它
  重新登录远端库（PBKDF2 客户端协议，与 Web Vault 完全一致）；
- 密码条目全程端到端加密，服务端只搬运密文；
- **密钥约束**：只有「同一账号 + 相同主密码」的库，同步条目才能被本地客户端解密（Bitwarden
  加密语义决定）。若本地已存在同名账号但密钥不一致，会**跳过密码数据并给出警告**，不破坏本地库。
  这是把线上库迁入**新本地库**（本地无该账号）的标准用法；
- 远端库若开启两步验证，同步暂不支持（登录会报错提示）；
- 附件：条目元数据与附件文件会尽力同步，附件文件下载失败不影响密码条目同步；
- 删除同步源不会删除已同步到本地的条目。

**管理 API**（管理员）：`GET/POST /api/admin/remote-sync`、`PUT/DELETE /api/admin/remote-sync/:id`、
`POST /api/admin/remote-sync/:id/trigger`（立即同步）。

## 六、本地化改造说明（相对 Cloudflare 版）

| Cloudflare 组件 | 本地替代 | 说明 |
| --- | --- | --- |
| D1 数据库 | `node:sqlite`（SQLite） | `local/d1.ts`：D1 prepare/bind/all/first/run/batch/exec 全部实现 |
| R2 附件存储 | 本地目录 | `local/r2.ts`：put/get/head/delete/list |
| KV 备用存储 | 本地目录 | `local/kv.ts`：put/get/getWithMetadata/delete/list |
| Durable Objects 通知中心 | 进程内单例 + `ws` WebSocket | `local/durable.ts` + `local/server.ts` 桥接 SignalR 协议 |
| Workers 静态资源 | 本地目录服务 + SPA fallback | `local/assets.ts` |
| `caches.default` / rate-limit | 内存缓存 | `local/cache.ts` |
| Cron Trigger 定时备份 | `setInterval` 5 分钟检查 | `local/index.ts` |
| Bitwarden 官方推送（Push Relay） | 无需改造 | 走 Bitwarden 公开 HTTP API，直连可用 |

源码唯一改动：`src/durable/notifications-hub.ts` 的 Cloudflare 导入改为本地模拟
（另有一处 101 状态码在本地运行时的兼容处理，不影响 Cloudflare 部署）。

## 七、从源码重新构建可执行文件

```bash
# 1. 安装依赖并构建 Web Vault 前端
npm install
npm run build                    # 产出 dist/

# 2. 打包后端为单文件 CJS
npx esbuild local/index.ts --bundle --platform=node --format=cjs --target=node22 \
  --outfile=dist-local/nodewarden.cjs --external:bufferutil --external:utf-8-validate

# 3. 生成单文件可执行二进制（Node SEA，内置 Node v22 运行时）
cat > dist-local/sea-config.json <<'EOF'
{ "main": "dist-local/nodewarden.cjs", "output": "dist-local/nodewarden-sea.blob", "disableExperimentalSEAWarning": true }
EOF
node --experimental-sea-config dist-local/sea-config.json
cp "$(command -v node)" dist-local/nodewarden
npx postject dist-local/nodewarden NODE_SEA_BLOB dist-local/nodewarden-sea.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

**注意**：不要对 SEA 二进制执行 `strip`（会破坏注入段导致段错误）。`dist-local/nodewarden.cjs`
是轻量备选（约 1.9MB，需系统安装 Node.js ≥ 22 后 `node dist-local/nodewarden.cjs` 运行）。

## 八、运行要求

- 单文件二进制：Linux x64，glibc ≥ 2.28（Ubuntu 20.04+ / Debian 11+ / CentOS 8+ 均可）；
- 或用 `nodewarden.cjs`：Node.js ≥ 22（`node:sqlite` 为实验性内置模块，无需额外安装）；
- 无需任何云服务账号、无需外网（推送通知走 Bitwarden 公共服务器，可断网使用其余全部功能）。
