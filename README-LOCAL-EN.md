# NodeWarden Local (English)

NodeWarden is a **Bitwarden-compatible password vault** that runs as a standalone,
single-file executable. It embeds the Node v22 runtime, needs no Cloudflare account,
no Docker, and no database server — just one binary, one SQLite data directory, and
the Web Vault assets.

This document covers the **Linux / macOS / Windows** standalone build: quick start,
**one-command system service registration** (`--install-service`, systemd / OpenRC),
and the **one-click update** from GitHub Releases.

> The Web Vault UI itself is fully localized (10 languages). CLI messages and server
> errors are in Chinese; the key commands are shown in English below.

---

## 1. Quick Start

### One-liner (Linux x64, download & run)

```bash
curl -sL -o nodewarden.zip https://github.com/guimoyun/nodewarden-WL/releases/latest/download/nodewarden-linux-x64.zip \
  && unzip -o nodewarden.zip \
  && export JWT_SECRET="$(openssl rand -hex 24)" \
  && ./nodewarden-linux-x64
# open http://<server-ip>:8787 — the first registered account becomes the admin
```

Other platforms: swap the file name for your platform
(`nodewarden-linux-arm64.zip`, `nodewarden-win-x64.zip`, `nodewarden-macos-arm64.zip`, …;
full matrix in BUILD-RELEASES.md). On macOS re-sign first: `codesign --force --sign - ./nodewarden-macos-*`.

### One-command service registration (Debian / Ubuntu / Alpine, boot autostart)

```bash
# Run as root after placing the binary on the server (auto-detects systemd / OpenRC)
sudo ./nodewarden-linux-x64 --install-service
#    Automatically:
#      generates a JWT_SECRET and stores it in /etc/nodewarden.env (0600, not shown by `systemctl cat`)
#      Debian/Ubuntu → writes /etc/systemd/system/nodewarden.service, enable + restart
#      Alpine       → writes /etc/init.d/nodewarden, rc-update add default + start

sudo ./nodewarden-linux-x64 --uninstall-service   # remove the service (keeps /etc/nodewarden.env)
./nodewarden-linux-x64 --help                      # list all commands and environment variables
```

> Once registered as a service, **Web Vault → Settings → One-click Update** can check
> and apply new GitHub Releases versions; the service restarts itself after the update.

### Run from source (Node ≥ 22)

```bash
git clone https://github.com/guimoyun/nodewarden-WL.git && cd nodewarden-WL \
  && npm install && npm run build \
  && export JWT_SECRET="$(openssl rand -hex 24)" && npx tsx local/index.ts
```

### Manual run (binary)

```bash
export JWT_SECRET="$(openssl rand -hex 24)"
./nodewarden-linux-x64          # listens on 0.0.0.0:8787, data in ./nw-data
```

Stop: `Ctrl+C` (SIGINT/SIGTERM shut down gracefully and flush data).

---

## 2. Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `JWT_SECRET` | **required** | JWT signing secret, ≥32 random chars. `NODEWARDEN_ALLOW_INSECURE_JWT=1` allows an in-memory random secret (all sessions reset on restart; local debugging only) |
| `NODEWARDEN_DATA_DIR` | `./nw-data` | Data directory (SQLite database, attachments, KV cache) |
| `NODEWARDEN_DIST_DIR` | `./dist` | Web Vault static assets directory |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `8787` | Listen port |
| `WEBAUTHN_RP_ID` | auto | Passkey (WebAuthn) relying party ID — usually your public domain/IP |
| `WEBAUTHN_RP_NAME` | `NodeWarden` | Passkey display name |
| `WEBAUTHN_ALLOWED_ORIGINS` | auto | Allowed WebAuthn origins (comma-separated) |
| `HIDE_WEB_VAULT` | unset | `1` hides the Web Vault page (API / client only) |
| `NODEWARDEN_UPDATE_TOKEN` | unset | GitHub token for one-click update (optional): raises API rate limit (unauthenticated: 60 req/h/IP) |
| `NODEWARDEN_UPDATE_MIRROR` | unset | Download mirror prefix for one-click update (optional, mainland-China speed-up), e.g. `https://ghproxy.com/` |

---

## 3. System Service Registration

**Prefer `--install-service`** — it generates the secret, writes the unit file,
enables autostart and starts the service for you. The equivalent manual setup:

### systemd (Debian / Ubuntu / CentOS)

`/etc/systemd/system/nodewarden.service`:

```ini
[Unit]
Description=NodeWarden Local (Bitwarden-compatible password server)
After=network.target

[Service]
Type=simple
User=nodewarden
WorkingDirectory=/opt/nodewarden
EnvironmentFile=/etc/nodewarden.env
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
journalctl -u nodewarden -f   # logs
```

### OpenRC (Alpine Linux)

The generated script at `/etc/init.d/nodewarden` sources `/etc/nodewarden.env`,
exports `JWT_SECRET` / data dirs and starts the binary in the background;
manage with `rc-service nodewarden start|stop|status`.

---

## 4. One-Click Update (Settings → One-click Update)

The **Settings → One-click Update** page (admin only) checks and applies new versions
from GitHub Releases:

1. Click **Check for updates** → shows current / latest version, platform package name
   and release notes.
2. If an update is available, click **Update now** → the backend downloads the zip for
   your platform and, in the background:
   - replaces the executable (Linux/macOS: `cp+mv` atomic replace; Windows:
     `taskkill → xcopy → copy`),
   - overwrites the `dist/` Web Vault assets,
   - restarts the service via `systemctl restart nodewarden` if a systemd service is
     registered, otherwise relaunches itself in the background.
3. A **manual download** link to the release asset is also provided.

- Update source is fixed to `https://github.com/guimoyun/nodewarden-WL/releases`.
- A release tag (e.g. `v1.1.0`) must be **higher than the baked-in binary version**
  to be offered. The version is injected at build time (`--define:__APP_VERSION__`);
  fallback is `v1.8.0-local`.
- GitHub API rate limits can be raised with `NODEWARDEN_UPDATE_TOKEN`; asset downloads
  can be sped up with `NODEWARDEN_UPDATE_MIRROR` (e.g. ghproxy) for mainland networks.

### Windows specifics

Same page in Web Vault: it downloads `nodewarden-win-x64.zip` (or arm64/x86), runs
`taskkill` on the old process, overwrites `dist\`, replaces `nodewarden.exe` and
restarts it. The page shows "Downloading and applying update…" until the program
restarts; reopen the page to see the new version.

---

## 5. Data & Backup

- All data lives under `NODEWARDEN_DATA_DIR` (SQLite `nodewarden.db` + attachments).
- Built-in backup: see the admin **Backup** page (manual run / scheduled, automatic
  pruning) — docs in README-LOCAL.md (Chinese).
- Multi-vault sync: Settings → Remote Sync (add another NodeWarden vault by URL +
  email + master password, scheduled sync; multi-master mesh supported).

---

## 6. Localization Notes (vs. the Cloudflare edition)

| Cloudflare component | Local replacement | Location |
| --- | --- | --- |
| D1 (SQLite) | SQLite file | `NODEWARDEN_DATA_DIR` |
| KV / Cache | local cache in data dir | `local/cache.ts` |
| R2 (attachments) | local disk | `NODEWARDEN_DATA_DIR` |
| Queues / Cron | in-process timers | `local/index.ts` |
| Workers runtime | embedded Node v22 (SEA) | single binary |

---

## 7. Build the Executable from Source

```bash
# 1. Install deps & build the Web Vault frontend
npm install && npm run build          # produces dist/

# 2. Bundle the backend into a single CJS file (once; blob is platform-independent)
npx esbuild local/index.ts --bundle --platform=node --format=cjs --target=node22 \
  --outfile=dist-local/nodewarden.cjs --external:bufferutil --external:utf-8-validate \
  --define:__APP_VERSION__='"v1.8.0-local"'   # version baked in for one-click update

# 3. Generate the SEA blob (once)
cat > dist-local/sea-config.json <<'EOF'
{ "main": "dist-local/nodewarden.cjs", "output": "dist-local/nodewarden-sea.blob", "disableExperimentalSEAWarning": true }
EOF
node --experimental-sea-config dist-local/sea-config.json

# 4. Inject into the platform Node binary (repeat per platform)
cp <node-binary-for-platform> dist-local/nodewarden-<platform>
npx postject dist-local/nodewarden-<platform> NODE_SEA_BLOB dist-local/nodewarden-sea.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

Full platform matrix, runtime download list and CI instructions: BUILD-RELEASES.md.
**Do not strip the SEA binary.**

---

## 8. Requirements

- Linux x64/arm64/armv7l/armv6l, Windows x64/arm64/x86, macOS x64/arm64
- `--install-service` requires **root** (systemd or OpenRC host)
- One-click update requires outbound access to `api.github.com` + the asset download
  domain (or configure `NODEWARDEN_UPDATE_MIRROR`)
- Source build requires Node ≥ 22
- No Docker, no external database, no cloud account
