// NodeWarden Local — one-click self-update.
//
// Update source: GitHub Releases of the official distribution repository
// (https://github.com/guimoyun/nodewarden-WL/releases). The published zip for
// the current platform contains the new binary + Web Vault dist.
//
// Flow:  GET /api/admin/update/check  → compare current version with latest
//        POST /api/admin/update/apply → download zip, stage files, run a
//               detached switcher script that swaps the binary + dist and
//               restarts the service (Windows .bat / Unix .sh).

import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';

// Injected at build time by esbuild --define. Fallbacks for dev/tsx runs.
declare const __APP_VERSION__: string;
const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'v1.9.1-local';
const REPO = 'guimoyun/nodewarden-WL';
// Optional GITHUB_TOKEN (NODEWARDEN_UPDATE_TOKEN) raises the API rate limit.
const GH_TOKEN = process.env.NODEWARDEN_UPDATE_TOKEN || '';
const API_HEADERS: Record<string, string> = {
  'User-Agent': 'NodeWarden-Local-Updater',
  Accept: 'application/vnd.github+json',
  ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
};
// Optional download mirror prefix (e.g. NODEWARDEN_UPDATE_MIRROR=https://ghproxy.com/)
// to improve asset download speed from mainland China.
const MIRROR = process.env.NODEWARDEN_UPDATE_MIRROR || '';

export interface UpdateCheckResult {
  ok: boolean;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  assetUrl: string | null;
  assetName: string | null;
  assetSize: number | null;
  publishedAt: string | null;
  releaseNotes: string | null;
  platform: string;
  error: string | null;
}

export function currentVersion(): string {
  return APP_VERSION;
}

export function platformAssetName(): string | null {
  const p = process.platform;
  const a = process.arch;
  if (p === 'linux' && a === 'x64') return 'nodewarden-linux-x64.zip';
  if (p === 'linux' && a === 'arm64') return 'nodewarden-linux-arm64.zip';
  if (p === 'linux' && a === 'arm') {
    // armv7l / armv6l are both process.arch 'arm'; prefer armv7l, fall back armv6l.
    return 'nodewarden-linux-armv7l.zip';
  }
  if (p === 'linux' && a === 'mips') return 'nodewarden-linux-mips.zip';
  if (p === 'linux' && a === 'mipsel') return 'nodewarden-linux-mipsel.zip';
  if (p === 'win32' && a === 'x64') return 'nodewarden-win-x64.zip';
  if (p === 'win32' && a === 'arm64') return 'nodewarden-win-arm64.zip';
  if (p === 'win32' && a === 'ia32') return 'nodewarden-win-x86.zip';
  if (p === 'darwin' && a === 'x64') return 'nodewarden-macos-x64.zip';
  if (p === 'darwin' && a === 'arm64') return 'nodewarden-macos-arm64.zip';
  return null;
}

/** True for source-compat packages (mips/mipsel) that contain no SEA binary. */
export function isSourceCompatPlatform(): boolean {
  return process.platform === 'linux' && (process.arch === 'mips' || process.arch === 'mipsel');
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    String(v || '')
      .replace(/^v/i, '')
      .split('.')
      .map((part) => parseInt(part.replace(/\D.*$/, ''), 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const platform = platformAssetName();
  const base: UpdateCheckResult = {
    ok: false,
    currentVersion: APP_VERSION,
    latestVersion: null,
    hasUpdate: false,
    assetUrl: null,
    assetName: null,
    assetSize: null,
    publishedAt: null,
    releaseNotes: null,
    platform: String(platform || `${process.platform}-${process.arch}`),
    error: null,
  };
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: API_HEADERS });
    if (!resp.ok) {
      const detail =
        resp.status === 403 || resp.status === 429
          ? 'GitHub API 限流（未认证 60 次/小时/IP）。可设置 NODEWARDEN_UPDATE_TOKEN 环境变量提供 GitHub Token 提升限额。'
          : `HTTP ${resp.status}`;
      return { ...base, error: `无法连接 GitHub Releases（${detail}）。请检查服务器能否访问 api.github.com` };
    }
    const release = (await resp.json()) as {
      tag_name?: string;
      published_at?: string;
      body?: string;
      assets?: { name?: string; browser_download_url?: string; size?: number }[];
    };
    const latestVersion = String(release.tag_name || '');
    const assets = release.assets ?? [];
    let asset: { name?: string; browser_download_url?: string; size?: number } | undefined;
    if (platform) {
      asset = assets.find((a) => a.name === platform) ?? assets.find((a) => a.name?.endsWith('.zip'));
    } else {
      asset = assets[0];
    }
    return {
      ...base,
      ok: true,
      latestVersion,
      hasUpdate: compareVersions(latestVersion, APP_VERSION) > 0,
      assetUrl: asset?.browser_download_url ? withMirror(asset.browser_download_url) : null,
      assetName: asset?.name ?? null,
      assetSize: asset?.size ?? null,
      publishedAt: release.published_at ?? null,
      releaseNotes: (release.body ?? '').slice(0, 4000) || null,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ...base, error: `检查更新失败：${msg}` };
  }
}

function withMirror(url: string): string {
  if (!MIRROR) return url;
  return `${MIRROR.replace(/\/$/, '')}/${url}`;
}

function unzipTo(zipPath: string, destDir: string): void {
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`,
    ]);
    return;
  }
  try {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir]);
  } catch {
    execFileSync('busybox', ['unzip', '-o', '-q', zipPath, '-d', destDir]);
  }
}

function runDetached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function exeNameOf(assetName: string): string {
  // nodewarden-win-x64.zip → nodewarden-win-x64.exe ; others → nodewarden-linux-x64 …
  if (assetName.startsWith('nodewarden-win-')) {
    return assetName.replace(/\.zip$/i, '.exe');
  }
  return assetName.replace(/\.zip$/i, '');
}

export async function applyUpdate(update: UpdateCheckResult): Promise<{ ok: boolean; message: string }> {
  if (!update.assetUrl || !update.assetName) {
    return { ok: false, message: '没有可用的更新包（资产缺失）' };
  }
  const stageDir = mkdtempSync(path.join(tmpdir(), 'nw-update-'));
  try {
    const zipPath = path.join(stageDir, update.assetName);
    const resp = await fetch(update.assetUrl, { headers: API_HEADERS });
    if (!resp.ok || !resp.body) {
      return { ok: false, message: `下载更新包失败（HTTP ${resp.status}）` };
    }
    const bytes = Buffer.from(await resp.arrayBuffer());
    writeFileSync(zipPath, bytes);
    const extractDir = path.join(stageDir, 'pkg');
    unzipTo(zipPath, extractDir);

    const exeName = exeNameOf(update.assetName);
    const newExe = path.join(extractDir, exeName);
    const distDir = process.env.NODEWARDEN_DIST_DIR
      ? path.resolve(process.env.NODEWARDEN_DIST_DIR)
      : path.resolve(process.cwd(), 'dist');
    const newDist = path.join(extractDir, 'dist');

    // Source-compat package (mips/mipsel): no SEA binary, only nodewarden.js + dist.
    if (!existsSync(newExe)) {
      if (isSourceCompatPlatform() && existsSync(newDist) && existsSync(path.join(extractDir, 'nodewarden.js'))) {
        const sh = path.join(stageDir, 'apply-update.sh');
        const script = [
          '#!/bin/sh',
          'sleep 2',
          `mkdir -p "${distDir}"`,
          `cp -r "${newDist}/." "${distDir}/"`,
          `cp "${path.join(extractDir, 'nodewarden.js')}" "${path.join(distDir, '..', 'nodewarden.js')}"`,
          'if command -v systemctl >/dev/null 2>&1 && systemctl is-active nodewarden.service >/dev/null 2>&1; then',
          '  systemctl restart nodewarden.service',
          'elif [ -n "$(command -v rc-service)" ] && rc-service nodewarden status >/dev/null 2>&1; then',
          '  rc-service nodewarden restart',
          'fi',
          `rm -rf "${stageDir}"`,
          'rm -f "$0"',
        ].join('\n');
        writeFileSync(sh, script);
        runDetached('/bin/sh', [sh]);
        return { ok: true, message: '已下载源码兼容包，程序文件与前端资源将在数秒内替换；mips/mipsel 平台请确认服务已重启' };
      }
      return { ok: false, message: `更新包中未找到可执行文件 ${exeName}` };
    }
    const curExe = process.execPath;

    if (process.platform === 'win32') {
      const bat = path.join(stageDir, 'apply-update.bat');
      const script = [
        '@echo off',
        'timeout /t 2 /nobreak >nul',
        `taskkill /f /im ${exeName} >nul 2>&1`,
        newDist && existsSync(newDist) ? `if exist "${newDist}\\*" xcopy /y /e /i "${newDist}\\*" "${distDir}\\" >nul 2>&1` : 'rem no dist in package',
        `copy /y "${newExe}" "${curExe}" >nul`,
        `del /q "${newExe}" >nul 2>&1`,
        `start "" "${curExe}"`,
        'del "%~f0"',
      ].join('\r\n');
      writeFileSync(bat, script);
      runDetached('cmd.exe', ['/c', bat]);
      return { ok: true, message: `更新包已下载并准备就绪，程序将在数秒后自动替换并重启（Windows）` };
    }

    // Unix: detached shell swaps binary + dist, then restarts service or relaunches.
    const sh = path.join(stageDir, 'apply-update.sh');
    const script = [
      '#!/bin/sh',
      'sleep 2',
      `cp "${newExe}" "${curExe}.new"`,
      `chmod +x "${curExe}.new"`,
      newDist && existsSync(newDist) ? `cp -r "${newDist}/." "${distDir}/"` : 'true',
      `mv "${curExe}.new" "${curExe}"`,
      'if command -v systemctl >/dev/null 2>&1 && systemctl is-active nodewarden.service >/dev/null 2>&1; then',
      '  systemctl restart nodewarden.service',
      'else',
      `  nohup "${curExe}" >/dev/null 2>&1 &`,
      'fi',
      `rm -rf "${stageDir}"`,
      'rm -f "$0"',
    ].join('\n');
    writeFileSync(sh, script);
    runDetached('/bin/sh', [sh]);
    return { ok: true, message: `更新包已下载并准备就绪，程序将在数秒后自动替换并重启（${process.platform === 'darwin' ? 'macOS，如遇“无法验证开发者”请右键→打开' : 'Linux' }）` };
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `应用更新失败：${msg}` };
  }
}

export { APP_VERSION };
