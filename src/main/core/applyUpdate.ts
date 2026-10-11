import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  atomicUpdateJson,
  buildUpdaterScript,
  readUpdateTransaction,
  updateMarker,
  validateUpdatePayload,
  type UpdateTransaction,
  type UpdaterScriptSpec,
} from './updateTransaction';
export { buildUpdaterScript } from './updateTransaction';
import { app } from 'electron';
import type { LocalUpdateCheck, ProgressEvent, ProxyTestResult, ReleaseInfo, Settings, UpdateStateInfo } from '../../shared/types';
import { IPC_EVENT } from '../../shared/types';
import { compareSemver } from '../../shared/semver';
import { downloadAll } from './download';
import { finishTask, registerTask } from './tasks';
import { currentVersion, fetchSha256Sums, makeGhFetch, sha256File } from './selfUpdate';
import { logScope } from './launcherLog';
import { translate as t } from '../../shared/i18n';
import { isolatedUpdateTest, trustedUpdateRelease, updateAssetName } from './updateTrust';
import {
  macAppTarget,
  macUpdateSupported,
  macUpdateDir,
  readMacUpdate,
  clearMacUpdate,
  stageMacUpdate,
  blockedMacVersion,
  applyMacUpdateOnStartup,
  acknowledgeMacUpdate,
  stageMacBackup,
} from './macUpdate';
import {
  linuxAppTarget,
  linuxUpdateSupported,
  linuxUpdateDir,
  readLinuxUpdate,
  clearLinuxUpdate,
  stageLinuxUpdate,
  blockedLinuxVersion,
  applyLinuxUpdateOnStartup,
  acknowledgeLinuxUpdate,
  stageLinuxBackup,
  validateLinuxPendingUpdate,
} from './linuxUpdate';
import { httpFetch } from './httpClient';

const updateLog = logScope('self-update');

/** 低速阈值：连续 30 秒低于 100KB/s 提示一次内测群备用下载 */
const SLOW_SPEED_BPS = 100 * 1024;
const SLOW_HINT_AFTER_MS = 30_000;

// ---------------- 事件桥（ipc.ts 注册时注入，避免反向依赖） ----------------
type Emitter = (channel: string, payload: unknown) => void;
let emit: Emitter = () => {};
export function setUpdateEmitter(fn: Emitter): void {
  emit = fn;
}

// ---------------- 路径 ----------------

/**
 * 当前运行的便携 exe（外层启动器）路径。
 * 便携包运行时进程在 FAIONYX-runtime 内，外层 exe 由 electron-builder 注入 PORTABLE_EXECUTABLE_FILE；
 * 测试可用 FAIONYX_UPDATE_TARGET_EXE 指向沙盒副本走全链路。
 */
export function currentPortableExe(): string | null {
  if (process.platform === 'darwin') return macAppTarget();
  if (process.platform === 'linux') return linuxAppTarget();
  if (process.platform !== 'win32') return null;
  return (isolatedUpdateTest() && process.env.FAIONYX_UPDATE_TARGET_EXE) || process.env.PORTABLE_EXECUTABLE_FILE || null;
}

/** 是否支持自更新（仅便携包运行或测试注入目标时） */
export function updateSupported(): boolean {
  if (process.platform === 'darwin') return macUpdateSupported();
  if (process.platform === 'linux') return linuxUpdateSupported();
  return !!currentPortableExe();
}
type UpdateSettings = Pick<Settings, 'updateSource' | 'updateMirrorUrl' | 'updateUseProxy' | 'updateProxyUrl'>;

/**
 * 解析更新下载用的显式代理地址。
 * 仅在 updateUseProxy 为 true 且 updateProxyUrl 是合法的 http/https URL 时返回非空字符串；
 * 其余情况返回 undefined，让下载/校验回退到原有直连或系统代理逻辑。
 */
function resolveUpdateProxyUrl(settings: UpdateSettings): string | undefined {
  if (!settings.updateUseProxy) return undefined;
  const raw = settings.updateProxyUrl?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return raw;
  } catch {
    /* 非法 URL 视为未配置 */
  }
  return undefined;
}
function updateDirOf(exe: string): string {
  if (process.platform === 'darwin') return macUpdateDir();
  if (process.platform === 'linux') return linuxUpdateDir();
  return path.join(path.dirname(exe), 'FAIONYX-update');
}
function backupDirOf(exe: string): string {
  return path.join(path.dirname(exe), 'FAIONYX-backup');
}

function userDataDir(): string {
  return isolatedUpdateTest() ? process.env.FAIONYX_USERDATA_DIR! : app.getPath('userData');
}
function stateFile(): string {
  return path.join(userDataDir(), 'update-state.json');
}
function failedFlagFile(): string {
  return path.join(userDataDir(), 'update-failed.flag');
}

export function getUpdateState(): UpdateStateInfo | null {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
    if (j && typeof j === 'object' && j.backupPath && fs.existsSync(j.backupPath)) return j as UpdateStateInfo;
  } catch {
    /* 无记录 */
  }
  return null;
}

/** 启动时检查「更新失败已回滚」标记（脚本回滚时写入）；读取后即删除 */
export function consumeUpdateFailedFlag(): boolean {
  try {
    if (fs.existsSync(failedFlagFile())) {
      fs.rmSync(failedFlagFile(), { force: true });
      return true;
    }
  } catch {
    /* 忽略 */
  }
  return false;
}

// Download completion only stages an update. Closing the launcher never installs it.
export interface PendingUpdate {
  release: ReleaseInfo;
  file: string;
}
function pendingFile(): string {
  return path.join(userDataDir(), 'pending-update.json');
}
export function getPendingUpdate(): PendingUpdate | null {
  if (process.platform === 'darwin') return readMacUpdate();
  if (process.platform === 'linux') return readLinuxUpdate();
  const exe = currentPortableExe();
  if (exe) {
    const txn = readUpdateTransaction(updateMarker(exe), exe);
    if (txn && fs.existsSync(txn.file)) return txn;
  }
  try {
    const j = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
    if (
      trustedUpdateRelease(j?.release) &&
      typeof j.file === 'string' &&
      path.basename(j.file) === j.release.assetName &&
      fs.existsSync(j.file)
    )
      return j;
    fs.renameSync(pendingFile(), pendingFile() + `.rejected-${Date.now()}`);
  } catch {
    /* no legacy update */
  }
  return null;
}
export function clearPendingUpdate(): void {
  if (process.platform === 'darwin') {
    clearMacUpdate();
    return;
  }
  if (process.platform === 'linux') {
    clearLinuxUpdate();
    return;
  }
  const exe = currentPortableExe();
  if (exe && readUpdateTransaction(updateMarker(exe), exe)) fs.rmSync(updateMarker(exe), { force: true });
  fs.rmSync(pendingFile(), { force: true });
}
async function writePendingUpdate(release: ReleaseInfo, file: string, sha256: string, mode: UpdateTransaction['mode']): Promise<void> {
  if (process.platform === 'darwin') return stageMacUpdate(release, file, sha256, mode);
  if (process.platform === 'linux') return stageLinuxUpdate(release, file, sha256, mode);
  const exe = currentPortableExe()!;
  const marker = updateMarker(exe);
  if (fs.existsSync(marker) && !readUpdateTransaction(marker, exe)) throw new Error(t('applyupdate.error.other_launcher_record'));
  const txn: UpdateTransaction = {
    schema: 1,
    id: randomUUID(),
    target: path.resolve(exe),
    file: path.resolve(file),
    sha256,
    size: fs.statSync(file).size,
    from: currentVersion(),
    release,
    mode,
  };
  await validateUpdatePayload(txn);
  atomicUpdateJson(marker, txn);
  fs.rmSync(pendingFile(), { force: true });
}
/** Suppress retrying a failed/unfinished transaction until the user explicitly downloads again. */
export function blockedUpdateVersion(): string | undefined {
  if (process.platform === 'darwin') return blockedMacVersion();
  if (process.platform === 'linux') return blockedLinuxVersion();
  const exe = currentPortableExe();
  if (!exe) return;
  for (const suffix of ['.applying', '.applying.failed']) {
    const txn = readUpdateTransaction(updateMarker(exe) + suffix, exe);
    if (txn) return txn.release.version;
  }
}
let verifiedStartupTransaction: UpdateTransaction | undefined;
/** Only called before creating any UI, on a subsequent user startup. */
export async function applyUpdateOnStartup(): Promise<boolean> {
  if (process.platform === 'darwin') return applyMacUpdateOnStartup();
  if (process.platform === 'linux') return applyLinuxUpdateOnStartup();
  const exe = currentPortableExe();
  if (!exe) return false;
  const marker = updateMarker(exe),
    claim = marker + '.applying';
  if (fs.existsSync(claim)) {
    const previous = readUpdateTransaction(claim, exe);
    if (previous?.release.version === currentVersion()) {
      try {
        if ((await sha256File(exe)) === previous.sha256) {
          verifiedStartupTransaction = previous;
          return false;
        }
      } catch {
        /* still allow opening the current launcher */
      }
    }
    let alive = true;
    if (previous?.helperPid) {
      try {
        process.kill(previous.helperPid, 0);
      } catch {
        alive = false;
      }
    } else {
      try {
        alive = Date.now() - fs.statSync(claim).mtimeMs < 180_000;
      } catch {
        /* leave unowned records alone */
      }
    }
    if (alive) return false;
    // Interrupted helpers are quarantined, not restarted. A new explicit download may proceed.
    try {
      fs.renameSync(claim, claim + '.failed');
    } catch {
      return false;
    }
  }
  let txn = readUpdateTransaction(marker, exe);
  try {
    // Old pending files are upgraded only after obtaining and verifying the published checksum.
    if (!txn) {
      const legacy = getPendingUpdate();
      if (!legacy) return false;
      if (compareSemver(legacy.release.version, currentVersion()) <= 0) {
        clearPendingUpdate();
        return false;
      }
      const hash = (await fetchSha256Sums(legacy.release.assetUrl))?.get(legacy.release.assetName);
      if (!hash) throw new Error(t('applyupdate.error.legacy_no_checksum'));
      const dest = path.join(updateDirOf(exe), randomUUID(), legacy.release.assetName);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(legacy.file, dest);
      await writePendingUpdate(legacy.release, dest, hash, 'upgrade');
      txn = readUpdateTransaction(marker, exe)!;
    }
    if (txn.mode === 'upgrade' && compareSemver(txn.release.version, currentVersion()) <= 0) {
      clearPendingUpdate();
      return false;
    }
    await validateUpdatePayload(txn);
    const oldSha256 = await sha256File(exe);
    // Atomic claim means repeated launches cannot submit the same job twice.
    fs.renameSync(marker, claim);
    const helperPid = await spawnUpdater({
      oldExe: exe,
      newExe: txn.file,
      backupDir: backupDirOf(exe),
      mainPid: process.pid,
      wrapperPid: process.ppid,
      stateDir: userDataDir(),
      transaction: txn,
      oldSha256,
    });
    try {
      atomicUpdateJson(claim, { ...txn, helperPid });
    } catch (error) {
      updateLog.warn(t('applyupdate.log.helper_pid_record_failed'), error);
    }
    app.exit(0);
    return true;
  } catch (error) {
    updateLog.error(t('applyupdate.log.startup_incomplete'), error);
    try {
      if (txn) {
        atomicUpdateJson(claim + '.failed', txn);
        fs.rmSync(marker, { force: true });
        fs.rmSync(claim, { force: true });
      }
      if (fs.existsSync(pendingFile())) fs.renameSync(pendingFile(), pendingFile() + `.rejected-${Date.now()}`);
      fs.mkdirSync(userDataDir(), { recursive: true });
      fs.writeFileSync(failedFlagFile(), String(error));
    } catch (recordError) {
      updateLog.warn(t('applyupdate.log.failed_record_save_failed'), recordError);
    }
    return false;
  }
}
/** Renderer readiness, not portable-wrapper lifetime, acknowledges a successful update. */
export async function acknowledgeUpdateStartup(): Promise<void> {
  if (process.platform === 'darwin') return acknowledgeMacUpdate();
  if (process.platform === 'linux') return acknowledgeLinuxUpdate();
  const exe = currentPortableExe();
  if (!exe) return;
  const claim = updateMarker(exe) + '.applying';
  const txn = verifiedStartupTransaction;
  if (!txn || currentVersion() !== txn.release.version) return;
  const state = getUpdateState();
  if (state?.to === txn.release.version) atomicUpdateJson(stateFile(), { ...state, result: 'ok' });
  atomicUpdateJson(claim + '.receipt.json', { id: txn.id, version: currentVersion() });
}

/** 当前是否有更新包在下载中（防重复触发自动下载） */
let autoDownloadingVersion: string | null = null;
export function isUpdateDownloading(): boolean {
  return !!autoDownloadingVersion || !!activeDownload;
}

/**
 * 自动安装模式入口：静默后台下载；完成后写待安装状态并发 updateReady，
 * 下次用户启动时应用，本次退出不执行替换或重启。
 */
export function startAutoUpdate(release: ReleaseInfo, settings: UpdateSettings): void {
  if (!updateSupported()) return;
  if (autoDownloadingVersion) return;
  autoDownloadingVersion = release.version;
  try {
    const handle = startUpdateDownload(release, settings, 'upgrade');
    handle.done
      .then(() => {
        updateLog.info(t('applyupdate.log.auto_ready', { version: release.version }));
        emit(IPC_EVENT.updateReady, { version: release.version });
      })
      .catch(() => {
        /* 失败/取消：静默，下次启动再试 */
      })
      .finally(() => {
        autoDownloadingVersion = null;
      });
  } catch {
    autoDownloadingVersion = null;
  }
}

/** Settings action validates readiness without closing or restarting. */
export async function applyPendingIfAny(): Promise<boolean> {
  const p = getPendingUpdate();
  if (!p) return false;
  await applyDownloadedUpdate(p.release);
  return true;
}

// ---------------- 下载源 ----------------

/** 按设置构造下载候选 URL 列表（auto=直连优先镜像兜底；direct=仅直连；mirror=仅镜像） */
export function updateDownloadCandidates(assetUrl: string, settings: UpdateSettings): string[] {
  const mirrorPrefix = (settings.updateMirrorUrl || 'https://ghproxy.net/').trim();
  const mirrored = mirrorPrefix ? mirrorPrefix + assetUrl : '';
  const source = settings.updateSource ?? 'auto';
  if (source === 'direct') return [assetUrl];
  if (source === 'mirror') return mirrored ? [mirrored] : [assetUrl];
  return mirrored ? [assetUrl, mirrored] : [assetUrl];
}

// ---------------- 下载（接入下载中心） ----------------

export interface UpdateDownloadHandle {
  taskId: string;
  file: string;
  done: Promise<void>;
}
let activeDownload: { version: string; handle: UpdateDownloadHandle } | null = null;

/**
 * 后台下载更新包：注册下载中心任务（分阶段进度/可取消/断点续传/多源换源），
 * 完成后强制 SHA256 校验。低速 30s 通过 emit 发一次内测群提示。
 */
export function startUpdateDownload(release: ReleaseInfo, settings: UpdateSettings, mode: 'upgrade' | 'rollback'): UpdateDownloadHandle {
  if (process.platform === 'darwin' && !macUpdateSupported()) throw new Error(t('macupdate.error.app_dir_not_writable'));
  if (!trustedUpdateRelease(release)) throw new Error(t('applyupdate.error.untrusted_source'));
  if (activeDownload) {
    if (activeDownload.version === release.version) return activeDownload.handle;
    throw new Error(t('applyupdate.error.download_in_progress'));
  }
  const exe = currentPortableExe();
  if (!exe) throw new Error(t('applyupdate.error.portable_only'));
  if (!release.assetUrl) throw new Error(t('applyupdate.error.no_asset'));

  // 解析显式代理：仅在启用且 URL 合法时生效。
  const proxyUrl = resolveUpdateProxyUrl(settings);
  // 构造带代理的 fetcher；未启用代理时用 fetchSha256Sums 的默认 ghFetch。
  const proxiedFetcher = proxyUrl ? makeGhFetch(proxyUrl) : undefined;
  // Keep the previous ready update until its replacement has been fully verified.
  const updateDir = path.join(updateDirOf(exe), release.version);
  fs.mkdirSync(updateDir, { recursive: true });
  const dest = path.join(updateDir, release.assetName || `FAIONYX-${release.version}.exe`);

  const task = registerTask(
    t('applyupdate.label.task_title', {
      action: t(mode === 'rollback' ? 'applyupdate.label.rollback' : 'applyupdate.label.download'),
      version: release.version,
    }),
    'download'
  );
  const [url, ...alternates] = updateDownloadCandidates(release.assetUrl, settings);
  let slowSince: number | null = null;
  let slowHintSent = false;

  const done = (async () => {
    try {
      // 先取校验值（安全优先：取不到不开始下载）。
      // 校验和请求同样走用户配置的显式代理，避免开启代理后卡在校验和获取。
      const sums = await fetchSha256Sums(release.assetUrl, proxiedFetcher);
      const expected = sums?.get(release.assetName) ?? sums?.get(path.basename(dest)) ?? null;
      if (!expected) throw new Error(t('applyupdate.error.no_checksum'));
      await downloadAll(
        [
          {
            url,
            urls: alternates,
            dest,
            sha256: expected,
            size: release.assetSize || undefined,
            proxyUrl,
          },
        ],
        (_done, _total, bps, detail) => {
          const received = detail.bytesDone,
            total = detail.bytesTotal ?? 0;
          const now = Date.now();
          emit(IPC_EVENT.progress, {
            stage: 'launcher-update',
            progress: total > 0 ? received / total : 0,
            text: t('applyupdate.label.progress_text', {
              action: t(mode === 'rollback' ? 'applyupdate.label.rollback' : 'applyupdate.label.update'),
              version: release.version,
            }),
            speed: bps,
            etaSeconds: detail.etaSeconds ?? undefined,
            bytesDone: received,
            bytesTotal: total > 0 ? total : undefined,
            indeterminate: total <= 0,
            taskId: task.id,
          } satisfies ProgressEvent);
          if (bps > 0 && bps < SLOW_SPEED_BPS) {
            if (slowSince == null) slowSince = now;
            if (!slowHintSent && now - slowSince >= SLOW_HINT_AFTER_MS) {
              slowHintSent = true;
              emit(IPC_EVENT.updateSlowHint, { taskId: task.id });
            }
          } else if (bps >= SLOW_SPEED_BPS) {
            slowSince = null;
          }
        },
        8,
        'official',
        task.controller.signal
      );
      const actual = await sha256File(dest);
      if (actual !== expected) {
        fs.rmSync(dest, { force: true });
        throw new Error(t('applyupdate.error.hash_mismatch', { expected: expected.slice(0, 12), actual: actual.slice(0, 12) }));
      }
      updateLog.info(t('applyupdate.log.download_verified', { dest }));
      await writePendingUpdate(release, dest, expected, mode);
      emit(IPC_EVENT.taskDone, { taskId: task.id, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit(IPC_EVENT.taskDone, { taskId: task.id, ok: false, error: msg, cancelled: msg === '已取消' });
      throw e;
    } finally {
      finishTask(task.id);
      activeDownload = null;
    }
  })();
  const handle = { taskId: task.id, file: dest, done };
  activeDownload = { version: release.version, handle };
  return handle;
}

/** Compatibility for existing verification harness; each download owns its estimator. */
export function resetSpeedSamplerForTest(): void {}

// The detached helper must exist before the bootstrap process exits.
async function spawnUpdater(spec: UpdaterScriptSpec): Promise<number> {
  const { spawnDetachedProcess, windowsQuote } = await import('./gracefulClose');
  spec.launchArguments = process.argv.slice(1).map(windowsQuote).join(' ');
  const scriptFile = path.join(os.tmpdir(), `faionyx-updater-${spec.transaction.id}.ps1`);
  fs.writeFileSync(scriptFile, '\uFEFF' + buildUpdaterScript(spec), 'utf8');
  const pid = await spawnDetachedProcess(
    'powershell.exe',
    ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
    { cwd: os.tmpdir() }
  );
  if (!pid) throw new Error(t('applyupdate.error.helper_spawn_failed'));
  return pid;
}

export async function applyDownloadedUpdate(release: ReleaseInfo): Promise<void> {
  const exe = currentPortableExe();
  const txn =
    process.platform === 'darwin'
      ? readMacUpdate()
      : process.platform === 'linux'
        ? readLinuxUpdate()
        : exe && readUpdateTransaction(updateMarker(exe), exe);
  if (!txn || txn.release.version !== release.version) throw new Error(t('applyupdate.error.not_ready'));
  if (process.platform === 'linux') await validateLinuxPendingUpdate(txn);
  else await validateUpdatePayload(txn);
}

/** Manual rollback is staged for next startup too, and never consumes the only backup. */
export async function restoreBackupAndRestart(): Promise<void> {
  const state = getUpdateState(),
    exe = currentPortableExe();
  if (!state || !exe) throw new Error(t('applyupdate.error.no_backup'));
  if (process.platform === 'darwin') return stageMacBackup(state.backupPath, state.backupVersion);
  if (process.platform === 'linux') return stageLinuxBackup(state.backupPath, state.backupVersion);
  const dest = path.join(updateDirOf(exe), randomUUID(), `FAIONYX-${state.backupVersion}.exe`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(state.backupPath, dest);
  await writePendingUpdate(
    {
      version: state.backupVersion,
      publishedAt: '',
      body: '',
      assetUrl: '',
      assetSize: fs.statSync(dest).size,
      assetName: path.basename(dest),
    },
    dest,
    await sha256File(dest),
    'rollback'
  );
}

/** 校验本地安装包：版本号（文件名解析）与 SHA256（联网比对 Release，离线则 unknown 由用户自担确认） */
const EXE_VERSION_RE = /^FAIONYX-(\d+\.\d+\.\d+(?:\.\d+)?)/i;
export async function checkLocalUpdateFile(filePath: string, proxyUrl?: string): Promise<LocalUpdateCheck> {
  const fileName = path.basename(filePath);
  const st = fs.statSync(filePath);
  const m = EXE_VERSION_RE.exec(fileName);
  const version = m?.[1] ?? '';
  if (process.platform === 'darwin' && (!version || fileName !== updateAssetName(version)))
    throw new Error(t('applyupdate.error.pick_mac_arch', { arch: process.arch }));
  if (process.platform === 'linux' && (!version || fileName !== updateAssetName(version)))
    throw new Error(t('applyupdate.error.pick_linux_package'));
  const current = currentVersion();
  const versionOk = !!version && compareSemver(version, current) >= 0;
  let sha: LocalUpdateCheck['sha256'] = 'unknown';
  let detail = '';
  try {
    const fetcher = proxyUrl ? makeGhFetch(proxyUrl) : undefined;
    const sums = await fetchSha256Sums(undefined, fetcher);
    const expected = sums?.get(fileName) ?? null;
    if (expected) {
      const actual = await sha256File(filePath);
      sha = actual === expected ? 'match' : 'mismatch';
      if (sha === 'mismatch')
        detail = t('applyupdate.detail.hash_mismatch', { expected: expected.slice(0, 12), actual: actual.slice(0, 12) });
    }
  } catch {
    /* 离线 → unknown */
  }
  return { filePath, fileName, fileSize: st.size, version, versionOk, sha256: sha, detail };
}

/** Copy the explicitly chosen local package before staging; never move the user's file. */
export async function applyLocalUpdateFile(check: LocalUpdateCheck): Promise<void> {
  const exe = currentPortableExe();
  if (!exe) throw new Error(t('applyupdate.error.portable_only'));
  const verified = await checkLocalUpdateFile(check.filePath);
  if (!verified.version || verified.sha256 === 'mismatch') throw new Error(t('applyupdate.error.local_verify_failed'));
  const dest = path.join(updateDirOf(exe), randomUUID(), verified.fileName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(verified.filePath, dest);
  await writePendingUpdate(
    { version: verified.version, publishedAt: '', body: '', assetUrl: '', assetSize: verified.fileSize, assetName: verified.fileName },
    dest,
    await sha256File(dest),
    'local'
  );
}

/**
 * 用给定代理访问 targetUrl，仅做一次 GET，读少量 body 后立即取消。
 * proxyUrl 为空/非法时按直连测试，方便用户对比。
 */
export async function testProxyConnection(targetUrl: string, proxyUrl?: string): Promise<ProxyTestResult> {
  let url: URL;
  try {
    url = new URL(targetUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: `Unsupported protocol: ${url.protocol}` };
    }
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const started = Date.now();
  try {
    const res = await httpFetch(url.href, {
      method: 'GET',
      signal: controller.signal,
      // 代理地址由 httpFetch 内部校验：非法/空串自动回退直连
      proxyUrl: proxyUrl?.trim() || undefined,
      headers: { accept: 'text/plain, */*' },
    });
    const latencyMs = Date.now() - started;
    // 读一点就取消，避免拖大响应
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return { ok: res.ok, status: res.status, latencyMs };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}
