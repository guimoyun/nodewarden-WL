# NodeWarden Local — Windows 版

Windows x64 单文件可执行程序（内置 Node v22.23.2 运行时，无需安装 Node，无需任何云服务账号）。

## 快速开始

1. 把以下三个文件/文件夹放到**同一个目录**（例如 `D:\nodewarden\`）：

   ```
   D:\nodewarden\
   ├── nodewarden.exe      ← 可执行程序
   ├── dist\               ← Web Vault 前端资源（整个文件夹）
   └── start.bat           ← 一键启动脚本
   ```

2. 双击 **start.bat**（首次运行会：生成 JWT_SECRET 存到 .env、提示防火墙授权——**请允许"专用网络"访问**）。

3. 浏览器打开 `http://127.0.0.1:8787`，首次注册的账号自动成为管理员。

## 手动启动（不用 start.bat）

```bat
set JWT_SECRET=你的32位以上随机密钥
D:\nodewarden\nodewarden.exe
```

## 环境变量（Windows 下用 `set 变量=值` 或写进 .env）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | 必填（start.bat 自动生成） | JWT 签名密钥，≥32 字符 |
| `NODEWARDEN_DATA_DIR` | `.\nw-data` | 数据目录（数据库、附件都在这） |
| `NODEWARDEN_DIST_DIR` | `.\dist` | 前端资源目录 |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（局域网其他设备也能连） |

示例（手动设置数据目录到别的盘）：

```bat
set NODEWARDEN_DATA_DIR=D:\nodewarden-data
set PORT=9000
nodewarden.exe
```

## 局域网 / 公网访问

- 局域网：`http://<本机IP>:8787`（Windows 防火墙需放行 8787 端口；可在 控制面板→防火墙→高级设置 或首次运行弹窗中放行）。
- 公网：建议不要直接暴露 8787，用 Nginx/Caddy 反代 + HTTPS，或用 Tailscale/FRP 内网穿透。
- 对接 Bitwarden 官方客户端：设置 → 自托管环境 → 服务器地址填 `http://<服务器IP>:8787`。

## 数据与备份

所有数据在 `NODEWARDEN_DATA_DIR`（默认 `nw-data\`）下：`nodewarden.db`（SQLite 数据库）、
`attachments\`（附件）。**备份 = 停止服务后复制整个数据目录**；也可在 Web Vault 里配置
WebDAV/S3 云备份。

## 已知说明

- 首次运行 Windows SmartScreen 可能提示"未知发布者"——这是 SEA 注入导致签名失效的正常现象，
  点"更多信息 → 仍要运行"即可（程序是自建的，可自行校验哈希）。
- `node:sqlite` 为 Node 实验性模块，启动时可能出现一行 ExperimentalWarning，不影响使用。
- 本版本在 Linux 端完成注入与静态验证（SEA 哨兵完整、无平台专属代码）；由于当前构建环境
  无 Windows 系统，**未在真实 Windows 上实机运行**，如有异常请告知具体报错，我会针对性修复。
