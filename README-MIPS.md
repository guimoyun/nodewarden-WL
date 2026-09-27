# NodeWarden Local — mips / mipsel 源码兼容包

> **适用版本：v1.9.1-local**

## 为什么是"兼容包"而不是单文件

Node.js 官方从 v5 起停止发布 **mips / mipsel** 二进制载体，因此无法像 x64/arm 那样把
Node 运行时打进单文件（SEA）。mips/mipsel 设备（OpenWrt 路由器、国产机顶盒、老 NAS 等）
改用**源码兼容包**：业务代码完全同源（同一份 esbuild 产物 + 同一套 Web Vault 前端），
用设备上自带的 Node.js 运行，零编译。

## 安装

```bash
# 1. 确保设备有 Node.js ≥ 22
#    OpenWrt:  opkg update && opkg install node
#    Debian/Ubuntu (mips 移植):  apt install nodejs
# 2. 下载对应平台的兼容包
curl -sL -o nw.zip https://github.com/guimoyun/nodewarden-WL/releases/latest/download/nodewarden-linux-mips.zip
#    （mipsel 设备换 nodewarden-linux-mipsel.zip）
# 3. 解压并启动
unzip -o nw.zip && ./start-mips.sh
```

目录结构（与 x64 版一致，仅二进制换为 `nodewarden.js`）：

```
./nodewarden.js   ← 业务代码（esbuild 单文件 CJS，由 node 运行）
./dist/           ← Web Vault 前端资源
./start-mips.sh   ← 启动脚本（自动生成 JWT_SECRET 到 .env）
./nw-data/        ← 密码库数据（首次启动自动创建）
```

## 说明

- 服务化（可选）：Debian/Ubuntu 用 systemd；OpenWrt 用 procd 或 rc.local 自启，
  命令行为 `node /路径/nodewarden.js`；
- 「一键更新」对该平台同样可用（检查 + 下载 + 替换 `nodewarden.js` 与 `dist/` 后提示重启）；
- 其余功能（远程库同步、多主互同步、备份、Bitwarden 客户端对接）与单文件版完全一致。
