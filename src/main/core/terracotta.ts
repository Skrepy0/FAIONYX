import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
/**
 * terracotta.ts — 陶瓦联机（Terracotta）官方工具集成（FAIONYX）
 *
 * 移植自 VoxLink MOD 的集成方式（fabric/26.2/.../terracotta/*）：
 *  - 官方渠道下载 terracotta-<ver>-windows-<arch>-pkg.tar.gz（多镜像回退）→ SHA-256 校验 → 解出 exe
 *  - `terracotta.exe --hmcl <portFile>` 启动 → 轮询 portFile 得 {"port": N} → HTTP 127.0.0.1:N
 *  - 房主：GET /state/scanning?player=NAME        → 轮询 /state 直到 state=host_ok，room=U/XXXX-XXXX-XXXX-XXXX
 *  - 加入：GET /state/guesting?room=CODE&player=NAME → 轮询 /state 直到给出 url
 *  - 复位：GET /state/ide（官方拼写即 ide）；停止：GET /panic?peaceful=true + 杀进程树
 *
 * IPC：invoke 'tc:start'|'tc:stop'|'tc:status'；push 'tc:event' {type:'log'|'ready'|'error'|'stopped', data}
 */
import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { app, BrowserWindow, type IpcMain } from 'electron';
import { translate as t } from '../../shared/i18n';

const TC_VERSION = '0.4.2';
// 与 VoxLink MOD TerracottaBinary.java 一致的平台资产与 SHA-256
const ASSETS: Record<string, { pkg: string; sha256: string; packageSha256: string; exe: string }> = {
  'linux-x64': {
    pkg: `terracotta-${TC_VERSION}-linux-x86_64-pkg.tar.gz`,
    packageSha256: '675c4fd6c74d49ed8165151ba2be5b6582e0af20fb6d912074543c2484b1e10a',
    sha256: 'dc8eed0338a1888743ab38468d88b9dd8a60d60c29df072adba7c8d2edaf7937',
    exe: `terracotta-${TC_VERSION}-linux-x86_64`,
  },
  'linux-arm64': {
    pkg: `terracotta-${TC_VERSION}-linux-arm64-pkg.tar.gz`,
    packageSha256: '845285ff264ac5fbc16db1a1605ad190e7fa64196516068cc309de5a1d2bf66d',
    sha256: '1cc03ed2ccaab8a7b64e8eb375ccfb8c1d4cd28f4c1a242fe3b492522f9f4aad',
    exe: `terracotta-${TC_VERSION}-linux-arm64`,
  },
  'win32-x64': {
    pkg: `terracotta-${TC_VERSION}-windows-x86_64-pkg.tar.gz`,
    packageSha256: '07ebe139e3ca5f74576e58b1a96efe59abdfbe148d3f1a49bfdca8b6f70745f0',
    sha256: '74c10568a7fea9c1d38cf8d2d4ca90baf1517f8e5a26c63d3349db70bc449796',
    exe: `terracotta-${TC_VERSION}-windows-x86_64.exe`,
  },
  'win32-arm64': {
    pkg: `terracotta-${TC_VERSION}-windows-arm64-pkg.tar.gz`,
    packageSha256: 'acfab0a87a02dedc6dab7c05303186c8907f56f815548b693fb3324358da7d14',
    sha256: '782c2fa911488d487447694acca6b17fa68304c87023fb6814b83a167fc2845f',
    exe: `terracotta-${TC_VERSION}-windows-arm64.exe`,
  },
  'darwin-arm64': {
    pkg: `terracotta-${TC_VERSION}-macos-arm64-pkg.tar.gz`,
    packageSha256: '13de7f9ce8733971b23493fabbe7e16d480f1e0d16a6265b4861f5a01bbecb60',
    sha256: '14a6cfa98e841c33b552f2291b0637461f37813c0bb3d29c6b56a59cb5e6714a',
    exe: `terracotta-${TC_VERSION}-macos-arm64`,
  },
  'darwin-x64': {
    pkg: `terracotta-${TC_VERSION}-macos-x86_64-pkg.tar.gz`,
    packageSha256: '16306157d89423ce79fa901cdb75a6386ec1a9b1bd43a5d47c2c47cf01a16b86',
    sha256: '07899429515f7646fd6c271acb39a2d3a34d330547b1d2682c2e3311db07aa0a',
    exe: `terracotta-${TC_VERSION}-macos-x86_64`,
  },
};
const DOWNLOAD_BASES = [
  `https://github.com/burningtnt/Terracotta/releases/download/v${TC_VERSION}`,
  `https://gitee.com/burningtnt/Terracotta/releases/download/v${TC_VERSION}`,
  `https://cnb.cool/HMCL-Terracotta/Terracotta/-/releases/download/v${TC_VERSION}`,
  `https://mirror.ghproxy.com/https://github.com/burningtnt/Terracotta/releases/download/v${TC_VERSION}`,
];
const START_TOTAL_TIMEOUT_MS = 120_000;
const PORT_POLL_MS = 500;
const STATE_POLL_MS = 500;
const HTTP_TIMEOUT_MS = 8_000;

export interface TerracottaState {
  phase: 'idle' | 'downloading' | 'starting' | 'hosting' | 'joining' | 'ready';
  room?: string;
  url?: string;
  stateRaw?: string;
  error?: string;
  downloaded?: number;
  total?: number;
}

let proc: ChildProcess | null = null;
let httpPort = 0;
let portFile = '';
type UnixSession = { directory: string; child: ChildProcess; closed: Promise<void>; cleanup?: Promise<void>; mac?: boolean };
let unixSession: UnixSession | null = null;
let state: TerracottaState = { phase: 'idle' };
let stateTimer: ReturnType<typeof setInterval> | undefined;
let disposedByUser = false;
/** tc:start 进行中标记：防止并发 start 覆盖 proc 引用导致第一个进程泄漏。 */
let starting = false;
let operation = 0;
let installController: AbortController | null = null;

function emit(type: 'log' | 'ready' | 'error' | 'stopped' | 'status', data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('tc:event', { type, data });
  }
}

function setState(patch: Partial<TerracottaState>): void {
  state = { ...state, ...patch };
  emit('status', { ...state });
}

function tcDir(): string {
  return path.join(app.getPath('userData'), 'terracotta');
}

function assetKey(): string {
  return `${process.platform}-${os.arch()}`;
}

function binaryPath(): string {
  const asset = ASSETS[assetKey()];
  if (!asset) throw new Error(t('terracotta.error.platform_unsupported', { platform: assetKey() }));
  return path.join(tcDir(), asset.exe);
}

/** 下载（带镜像回退与重试）→ SHA-256 校验 → 解 tar.gz 提取 exe。返回进度日志。 */
async function ensureBinary(signal: AbortSignal): Promise<string> {
  const asset = ASSETS[assetKey()];
  if (!asset) throw new Error(t('terracotta.error.platform_unsupported', { platform: assetKey() }));
  const exe = binaryPath();
  fs.mkdirSync(tcDir(), { recursive: true });
  if (fs.existsSync(exe)) {
    if (await verifySha256(exe, asset.sha256)) {
      if (process.platform !== 'win32') await fs.promises.chmod(exe, 0o755);
      return exe;
    }
    emit('log', { level: 'warn', msg: t('terracotta.log.local_binary_verify_failed') });
    fs.rmSync(exe, { force: true });
  }
  const pkgPath = path.join(tcDir(), asset.pkg);
  let lastErr: unknown = null;
  for (const base of DOWNLOAD_BASES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        setState({ phase: 'downloading' });
        emit('log', { level: 'info', msg: t('terracotta.log.download_binary', { host: new URL(base + '/' + asset.pkg).host }) });
        signal.throwIfAborted();
        await download(base + '/' + asset.pkg, pkgPath, signal);
        if (!(await verifySha256(pkgPath, asset.packageSha256))) throw new Error(t('terracotta.error.package_sha_failed'));
        signal.throwIfAborted();
        await extractTarGz(pkgPath, tcDir());
        if (!fs.existsSync(exe)) throw new Error(t('terracotta.error.exe_missing_in_archive', { name: asset.exe }));
        if (!(await verifySha256(exe, asset.sha256))) {
          await fs.promises.rm(exe, { force: true });
          throw new Error(t('terracotta.error.exe_verify_failed'));
        }
        fs.rmSync(pkgPath, { force: true });
        if (process.platform !== 'win32') await fs.promises.chmod(exe, 0o755);
        emit('log', { level: 'info', msg: t('terracotta.log.binary_ready') });
        return exe;
      } catch (e) {
        lastErr = e;
        await fs.promises.rm(pkgPath, { force: true }).catch(() => {});
        if (signal.aborted) throw new Error(t('terracotta.error.download_cancelled'));
        emit('log', { level: 'warn', msg: t('terracotta.log.source_failed', { error: (e as Error).message }) });
      }
    }
  }
  throw new Error(
    t('terracotta.error.download_failed', {
      error: (lastErr as Error)?.message ?? t('terracotta.error.all_mirrors_unavailable'),
      dir: tcDir(),
    })
  );
}

async function download(url: string, file: string, signal: AbortSignal, redirects = 0): Promise<void> {
  signal.throwIfAborted();
  if (redirects > 5) throw new Error(t('terracotta.error.redirect_too_many'));
  await new Promise<void>((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).get(url, { signal, timeout: 20_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(new URL(res.headers.location, url).href, file, signal, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(t('terracotta.error.http_status', { status: String(res.statusCode) })));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let downloaded = 0,
        lastUpdate = 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (Date.now() - lastUpdate > 200) {
          lastUpdate = Date.now();
          setState({ downloaded, total });
        }
      });
      pipeline(res, fs.createWriteStream(file), { signal }).then(() => {
        setState({ downloaded, total });
        resolve();
      }, reject);
    });
    req.on('timeout', () => req.destroy(new Error(t('terracotta.error.download_timeout'))));
    req.on('error', reject);
  });
}

async function extractTarGz(tarGz: string, destDir: string): Promise<void> {
  const raw = await promisify(zlib.gunzip)(await fs.promises.readFile(tarGz), { maxOutputLength: 256 * 1024 * 1024 });
  let off = 0;
  while (off + 512 <= raw.length) {
    const header = raw.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const typeFlag = String.fromCharCode(header[156] ?? 48);
    off += 512;
    if (!Number.isSafeInteger(size) || size < 0 || off + size > raw.length) throw new Error(t('terracotta.error.archive_incomplete'));
    if (!name) break;
    const data = raw.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (typeFlag === '0' || typeFlag === '\0') {
      const base = path.basename(name.replace(/\\/g, '/'));
      if (base && base !== '..' && base !== '.') await fs.promises.writeFile(path.join(destDir, base), data);
    }
  }
}

async function verifySha256(file: string, expected: string): Promise<boolean> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === expected;
}

/** 启动 terracotta --hmcl <portFile> 并轮询端口文件。 */
async function startProcess(): Promise<number> {
  const exe = binaryPath();
  const linux = process.platform === 'linux';
  const mac = process.platform === 'darwin';
  if (linux || mac) {
    fs.mkdirSync(tcDir(), { recursive: true });
    if (!fs.lstatSync(tcDir()).isDirectory() || fs.lstatSync(tcDir()).isSymbolicLink())
      throw new Error(t('terracotta.error.tool_dir_not_directory'));
  }
  // v0.4.2 uses temp_dir()/terracotta for its Unix lock, logs and service.
  // A unique TMPDIR prevents --hmcl from attaching to or replacing another
  // launcher's service, including another FAIONYX process using this profile.
  const dir = fs.mkdtempSync(
    path.join(linux || mac ? tcDir() : os.tmpdir(), linux ? 'linux-session-' : mac ? 'mac-session-' : 'faionyx-tc-')
  );
  portFile = path.join(dir, 'http');
  fs.rmSync(portFile, { force: true });
  disposedByUser = false;
  // macOS --hmcl is a short-lived client of the daemon, not the server. Own an
  // isolated daemon directly; do not install/stop the player's global HMCL service.
  if (mac) prepareMacIdentity(dir);
  const env = mac ? { ...process.env, HOME: dir } : linux ? { ...process.env, TMPDIR: dir } : process.env;
  proc = spawn(exe, mac ? ['--daemon'] : [process.platform === 'win32' ? '--hmcl2' : '--hmcl', portFile], {
    windowsHide: true,
    env,
    detached: process.platform !== 'win32',
  });
  const child = proc;
  const session: UnixSession | null =
    linux || mac ? { directory: dir, child, mac, closed: new Promise((resolve) => child.once('close', () => resolve())) } : null;
  if (session) {
    unixSession = session;
    child.once('close', () => {
      void cleanUnixSession(session).catch((error) => emit('log', { level: 'warn', msg: (error as Error).message }));
    });
  }
  child.on('error', (e) => {
    if (proc === child) {
      proc = null;
      setState({ phase: 'idle', error: e.message });
      emit('error', e.message);
    }
  });
  proc.stdout?.on('data', (d: Buffer) => emit('log', { level: 'info', msg: d.toString().trim() }));
  proc.stderr?.on('data', (d: Buffer) => emit('log', { level: 'warn', msg: d.toString().trim() }));
  proc.on('exit', (code) => {
    if ((mac || linux) && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* private daemon group already empty */
      }
    }
    emit('log', { level: 'info', msg: t('terracotta.log.process_exit', { code: code ?? t('terracotta.label.signal') }) });
    if (proc !== child) return;
    proc = null;
    if (!disposedByUser) {
      stopPolling();
      setState({ phase: 'idle', room: undefined, url: undefined });
      emit('stopped', null);
    }
  });
  const t0 = Date.now();
  while (Date.now() - t0 < START_TOTAL_TIMEOUT_MS) {
    if (!proc || proc.exitCode !== null) throw new Error(t('terracotta.error.process_exited_during_start'));
    if (mac) {
      // Official v0.4.2 publishes a two-byte big-endian port only after Rocket
      // binds. Never invoke --hmcl: it can win the startup lock and bootstrap
      // a system service. Both the lock and HTTP readiness belong to this HOME.
      const port = readMacPort(path.join(dir, 'terracotta', 'terracotta.lock'));
      if (port) {
        httpPort = port;
        try {
          const observed = JSON.parse(await tcGet('/state')) as TcStateJson;
          if (typeof observed.state === 'string' && proc === child && child.exitCode === null) {
            emit('log', { level: 'info', msg: t('terracotta.log.http_port', { port: httpPort }) });
            return httpPort;
          }
        } catch {
          /* listener not ready yet; retain the original startup deadline */
        }
      }
      await sleep(PORT_POLL_MS);
      continue;
    }
    try {
      const content = fs.readFileSync(portFile, 'utf8').trim();
      const m = /"port"\s*:\s*(\d+)/.exec(content);
      if (m) {
        httpPort = Number(m[1]);
        emit('log', { level: 'info', msg: t('terracotta.log.http_port', { port: httpPort }) });
        return httpPort;
      }
    } catch {
      /* 文件尚未生成 */
    }
    await sleep(PORT_POLL_MS);
  }
  throw new Error(t('terracotta.error.start_timeout'));
}

function prepareMacIdentity(directory: string): void {
  const persistent = path.join(tcDir(), 'terracotta');
  fs.mkdirSync(persistent, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(persistent).isDirectory() || fs.lstatSync(persistent).isSymbolicLink())
    throw new Error(t('terracotta.error.identity_dir_not_directory'));
  const identity = path.join(persistent, 'machine-id');
  try {
    fs.writeFileSync(identity, crypto.randomBytes(16), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(identity);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 16) throw new Error(t('terracotta.error.identity_corrupt'));
  const service = path.join(directory, 'terracotta');
  fs.mkdirSync(service, { mode: 0o700 });
  fs.writeFileSync(path.join(service, 'machine-id'), fs.readFileSync(identity), { flag: 'wx', mode: 0o600 });
}

function readMacPort(lock: string): number | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(t('terracotta.error.port_file_not_file'));
  if (stat.size < 2) return null;
  if (stat.size !== 2) throw new Error(t('terracotta.error.port_file_format'));
  const raw = fs.readFileSync(lock);
  if (raw.length < 2) return null;
  if (raw.length !== 2) throw new Error(t('terracotta.error.port_file_format'));
  const port = raw.readUInt16BE(0);
  if (!port) throw new Error(t('terracotta.error.port_invalid'));
  return port;
}

function cleanUnixSession(session: UnixSession): Promise<void> {
  if (session.cleanup) return session.cleanup;
  session.cleanup = (async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      let alive = false;
      if (session.child.pid) {
        try {
          process.kill(-session.child.pid, 0);
          alive = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      if (!alive) break;
      if (Date.now() >= deadline) throw new Error(t('terracotta.error.session_not_exited'));
      await sleep(50);
    }
    if (session.mac) {
      // Preserve diagnostic logs and identity; move only the private session
      // after its owned child and process group are gone. No shared service is
      // stopped or deleted, and an uncertain cleanup leaves files in place.
      const history = path.join(tcDir(), 'session-history');
      await fs.promises.mkdir(history, { recursive: true, mode: 0o700 });
      const stat = await fs.promises.lstat(history);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(t('terracotta.error.history_dir_not_directory'));
      await fs.promises.rename(session.directory, path.join(history, path.basename(session.directory)));
    } else await fs.promises.rm(session.directory, { recursive: true, force: true });
    if (unixSession === session) unixSession = null;
  })();
  return session.cleanup;
}

async function finishUnixSession(session: UnixSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(t('terracotta.error.session_exit_timeout'))), 5000);
      }),
    ]);
    await cleanUnixSession(session);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tcGet(pathName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${httpPort}${pathName}`, { timeout: HTTP_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error(t('terracotta.error.http_status_body', { status: String(res.statusCode), body: body.slice(0, 200) })));
      });
    });
    req.on('timeout', () => req.destroy(new Error(t('terracotta.error.request_timeout'))));
    req.on('error', reject);
  });
}

interface TcStateJson {
  state?: string;
  room?: string;
  url?: string;
  difficulty?: string;
}

async function pollUntilReady(kind: 'host' | 'join', timeoutSec: number): Promise<TcStateJson> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (!proc) throw new Error(t('terracotta.error.process_exited'));
    try {
      const json = JSON.parse(await tcGet('/state')) as TcStateJson;
      const st = json.state ?? 'unknown';
      if (st !== state.stateRaw) {
        setState({ stateRaw: st });
        emit('log', { level: 'info', msg: t('terracotta.log.state', { state: st }) });
      }
      // 失败/异常态直接报错（与 MOD 的可恢复异常→重试一次对齐）
      if (st === 'exception' || st === 'fatal' || st === 'failed') {
        await tcGet('/state/ide').catch(() => {});
        const fatal = new Error(t('terracotta.error.state_exception', { state: st })) as Error & { tcFatalState?: true };
        fatal.tcFatalState = true;
        throw fatal;
      }
      if (kind === 'host' && st === 'host-ok' && json.room) return json;
      if (kind === 'join' && st === 'guest-ok' && json.url) return json;
    } catch (e) {
      if ((e as { tcFatalState?: true }).tcFatalState) throw e;
    }
    await sleep(STATE_POLL_MS);
  }
  throw new Error(kind === 'host' ? t('terracotta.error.host_timeout') : t('terracotta.error.join_timeout'));
}

function stopPolling(): void {
  if (stateTimer) {
    clearInterval(stateTimer);
    stateTimer = undefined;
  }
}

async function killTree(): Promise<void> {
  const p = proc;
  const session = unixSession && (unixSession.child === p || !p) ? unixSession : null;
  proc = null;
  httpPort = 0;
  stopPolling();
  if (!p || p.exitCode !== null) {
    if (session) await finishUnixSession(session);
    return;
  }
  if (process.platform === 'win32' && p.pid) {
    await new Promise<void>((resolve) => {
      execFileAsync('taskkill', ['/T', '/F', '/PID', String(p.pid)]).catch(() => {});
      setTimeout(resolve, 800);
    });
  } else if (process.platform !== 'win32' && p.pid) {
    // The Mac daemon and its EasyTier children share the private process group
    // created above. Never target a global service or the game's process group.
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {
      /* already stopped */
    }
    if (session) await finishUnixSession(session);
  } else {
    p.kill('SIGKILL');
  }
  disposedByUser = true;
}

function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = require('node:child_process') as typeof import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
  });
}

async function tcStart(payload: { mode: 'host' | 'join'; code?: string; port?: number; playerName?: string }): Promise<TerracottaState> {
  if (starting) throw new Error(t('terracotta.error.already_starting'));
  if (stopping) throw new Error(t('terracotta.error.stopping'));
  if (installController) throw new Error(t('terracotta.error.install_in_progress'));
  if (proc) throw new Error(t('terracotta.error.already_running'));
  const generation = ++operation;
  try {
    starting = true;
    const asset = ASSETS[assetKey()];
    if (!asset || !(await verifySha256(binaryPath(), asset.sha256).catch(() => false)))
      throw new Error(t('terracotta.error.tool_not_installed'));
    if (generation !== operation) return { ...state };
    setState({ phase: 'starting' });
    await startProcess();
    if (generation !== operation) return { ...state };
    const me = payload.playerName || 'FAIONYX';
    if (payload.mode === 'host') {
      setState({ phase: 'hosting', room: undefined, url: undefined, error: undefined });
      await tcGet(`/state/scanning?player=${encodeURIComponent(me)}`);
      emit('log', { level: 'info', msg: t('terracotta.log.host_request') });
      const final = await pollUntilReady('host', 30);
      if (generation !== operation) return { ...state };
      setState({ phase: 'ready', room: final.room, url: undefined });
      emit('ready', { mode: 'host', room: final.room, state: final.state });
    } else {
      const code = String(payload.code ?? '')
        .trim()
        .toUpperCase();
      // 陶瓦房间码：U/ 前缀 + 四段各 4 位（GitHub burningtnt/Terracotta 官方格式）
      if (!/^U\/[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(code)) throw new Error(t('terracotta.error.room_code_format'));
      setState({ phase: 'joining', room: code, url: undefined, error: undefined });
      await tcGet(`/state/guesting?room=${encodeURIComponent(code)}&player=${encodeURIComponent(me)}`);
      emit('log', { level: 'info', msg: t('terracotta.log.join_request') });
      const final = await pollUntilReady('join', 60);
      if (generation !== operation) return { ...state };
      setState({ phase: 'ready', room: code, url: final.url });
      emit('ready', { mode: 'join', url: final.url, state: final.state });
    }
  } catch (e) {
    if (generation !== operation) return { ...state };
    await killTree();
    setState({ phase: 'idle', error: (e as Error).message });
    emit('error', (e as Error).message);
  } finally {
    if (generation === operation) starting = false;
  }
  return { ...state };
}

let stopping = false;
async function tcStop(silent = false): Promise<TerracottaState> {
  if (stopping) return { ...state };
  stopping = true;
  try {
    operation++;
    starting = false;
    installController?.abort();
    disposedByUser = true;
    try {
      if (httpPort > 0) await tcGet('/panic?peaceful=true');
    } catch {
      /* 进程可能已退出 */
    }
    await killTree();
    state = { phase: 'idle' };
    if (!silent) emit('stopped', null);
    return { ...state };
  } finally {
    stopping = false;
  }
}

async function tcInstall(): Promise<void> {
  if (installController || starting || stopping || proc) throw new Error(t('terracotta.error.busy'));
  const controller = new AbortController();
  installController = controller;
  setState({ phase: 'downloading', error: undefined, downloaded: 0, total: 0 });
  try {
    await ensureBinary(controller.signal);
    controller.signal.throwIfAborted();
    setState({ phase: 'idle' });
    emit('ready', null);
  } catch (e) {
    setState({ phase: 'idle', error: controller.signal.aborted ? t('terracotta.error.download_cancelled') : (e as Error).message });
    throw new Error(state.error);
  } finally {
    if (installController === controller) installController = null;
  }
}
export function registerTerracottaIpc(ipcMain: IpcMain): void {
  ipcMain.handle('tc:install', () => tcInstall());
  ipcMain.handle('tc:cancel-install', () => {
    installController?.abort();
  });
  ipcMain.handle('tc:start', (_e, payload: { mode: 'host' | 'join'; code?: string; port?: number; playerName?: string }) =>
    tcStart(payload)
  );
  ipcMain.handle('tc:stop', () => tcStop());
  ipcMain.handle('tc:status', async () => ({
    ...state,
    binaryReady: !!ASSETS[assetKey()] && (await verifySha256(binaryPath(), ASSETS[assetKey()].sha256).catch(() => false)),
    running: !!proc,
    toolVersion: TC_VERSION,
    binaryPath: binaryPath(),
  }));
}

/** 应用退出时清理（gracefulClose 里调用）。 */
export async function stopTerracottaOnQuit(): Promise<void> {
  installController?.abort();
  await killTree();
}
