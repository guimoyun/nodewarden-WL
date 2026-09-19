# NodeWarden Local — 跨平台构建与发布

NodeWarden 本地化版可编译为 **10 个平台/架构**的单文件可执行程序。所有平台的业务代码完全同源
（单个平台无关的 SEA blob），差异仅在注入载体（对应平台的 Node v22.23.2 运行时）。

## 一、平台矩阵

| 平台 | 架构 | 产物文件 | 载体来源 | 说明 |
| --- | --- | --- | --- | --- |
| Linux | x64 | `nodewarden-linux-x64` | 官方 linux-x64 | 服务器首选 |
| Linux | arm64 | `nodewarden-linux-arm64` | 官方 linux-arm64 | 树莓派 4/5 64 位系统、飞腾/鲲鹏 |
| Linux | armv7l | `nodewarden-linux-armv7l` | 官方 linux-armv7l | 树莓派 2/3 32 位系统（armhf） |
| Linux | armv6l | `nodewarden-linux-armv6l` | unofficial-builds | 树莓派 1 / Zero（ARMv6） |
| Windows | x64 | `nodewarden-win-x64.exe` | 官方 win-x64 | 主流 Windows |
| Windows | arm64 | `nodewarden-win-arm64.exe` | 官方 win-arm64 | Windows on ARM 设备 |
| Windows | x86 | `nodewarden-win-x86.exe` | 官方 win-x86 | 32 位 Windows |
| macOS | x64 | `nodewarden-macos-x64` | 官方 darwin-x64 | Intel Mac |
| macOS | arm64 | `nodewarden-macos-arm64` | 官方 darwin-arm64 | Apple Silicon（M 系列） |

> **ARMv6 说明**：Node.js 官方自 v19 起不再发布 linux-armv6l 构建，本地化版依赖 Node 22 内置的
> `node:sqlite`，因此使用 **unofficial-builds** 提供的 v22.23.2 armv6l 构建作为载体。
> 树莓派 1/Zero 若运行不畅（内存 512MB），建议改用 armv7l 设备或调小 SQLite 缓存。

## 二、单次构建流程（以 linux-arm64 为例）

```bash
# 1. 构建前端（一次即可，全平台共用）
npm install && npm run build          # 产出 dist/

# 2. 打包后端为单文件 CJS（一次即可，blob 平台无关）
npx esbuild local/index.ts --bundle --platform=node --format=cjs --target=node22 \
  --outfile=dist-local/nodewarden.cjs --external:bufferutil --external:utf-8-validate

# 3. 生成 SEA blob（一次即可）
cat > dist-local/sea-config.json <<'EOF'
{ "main": "dist-local/nodewarden.cjs", "output": "dist-local/nodewarden-sea.blob", "disableExperimentalSEAWarning": true }
EOF
node --experimental-sea-config dist-local/sea-config.json

# 4. 下载目标平台 Node 运行时（见下载清单）
curl -L -O https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.xz
tar xf node-v22.23.2-linux-arm64.tar.xz

# 5. 注入生成可执行文件
cp node-v22.23.2-linux-arm64/bin/node dist-local/nodewarden-linux-arm64
npx postject dist-local/nodewarden-linux-arm64 NODE_SEA_BLOB dist-local/nodewarden-sea.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 6. 打包发布
cd dist-local && zip nodewarden-linux-arm64.zip nodewarden-linux-arm64
```

## 三、运行时下载清单

| 平台 | URL |
| --- | --- |
| linux-x64 | `https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz` |
| linux-arm64 | `https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.xz` |
| linux-armv7l | `https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-armv7l.tar.xz` |
| linux-armv6l | `https://unofficial-builds.nodejs.org/download/release/v22.23.2/node-v22.23.2-linux-armv6l.tar.gz` |
| win-x64 | `https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip` |
| win-arm64 | `https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-arm64.zip` |
| win-x86 | `https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x86.zip` |
| darwin-x64 | `https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-x64.tar.xz` |
| darwin-arm64 | `https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.xz` |

## 四、平台特有注意事项

### macOS（重要）

1. SEA 注入会破坏原有代码签名，**必须重新签名**才能在 macOS 上运行：

   ```bash
   codesign --force --sign - nodewarden-macos-arm64
   ```

   构建机为 macOS 时可在本地完成；跨平台构建（Linux 上产出）后，用户拿到文件需自行执行上面
   一行命令（或用 `xattr -dr com.apple.quarantine nodewarden` 清除隔离属性后右键打开）。

2. 若提示"无法验证开发者"，在 **系统设置 → 隐私与安全性** 中点"仍要打开"。

### Windows

- SmartScreen 提示"未知发布者"为 SEA 注入导致签名失效的正常现象，点"更多信息 → 仍要运行"。
- 首次启动 Windows 防火墙弹窗请允许"专用网络"访问。

### Linux

- 依赖 glibc ≥ 2.28（Ubuntu 20.04+ / Debian 11+ / CentOS 8+），armv6l 设备的 libc 若过旧
  可能无法运行，建议 Debian 10+ / Raspberry Pi OS（Bookworm/Bullseye）。

## 五、发布建议（GitHub Releases）

```bash
# 单文件可执行直接挂 Releases（GitHub Releases 单附件上限 2GB，比仓库直推更省空间）
git tag v1.0.0-local
git push origin main --tags
```

然后在 GitHub 网页 Releases 页面上传各平台 zip 产物，随标签发布。

## 六、环境变量（全平台一致）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | 必填 | JWT 签名密钥（≥32 字符），设置 `NODEWARDEN_ALLOW_INSECURE_JWT=1` 可临时用内存密钥 |
| `NODEWARDEN_DATA_DIR` | `./nw-data` | 数据目录（SQLite + 附件 + KV） |
| `NODEWARDEN_DIST_DIR` | `./dist` | Web Vault 前端资源目录 |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | 监听地址与端口 |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ALLOWED_ORIGINS` | 自动 | Passkey（WebAuthn）配置 |
| `HIDE_WEB_VAULT` | 未设置 | `1` 时隐藏 Web Vault 页面 |
