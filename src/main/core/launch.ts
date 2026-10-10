/**
 * 游戏启动：版本链合并、classpath/natives 处理、JVM/游戏参数组装、进程管理
 */
import { ProgressDeadline, withDeadline } from '../../shared/deadline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { GameExitEvidence } from '../../shared/gameExit';
import { createCommandWorld } from './commandWorld';
import { autoMemoryMB } from '../../shared/memory';
import { requestGameWindowClose, focusGameWindow, spawnGameProcess } from './gracefulClose';
import { logScope } from './launcherLog';
import { translate as t } from '../../shared/i18n';

const launchLog = logScope('launch');
import { reuseExternalRuntimeLibraries } from './externalRuntime';
import { repairNeoRuntime } from './loaders';
import { pathIdentity } from './folderPaths';
import { GameSession } from './gameSession';
import { upgradeInstalledBridge } from './bridgeUpgrade';
import { app, BrowserWindow, screen } from 'electron';
import AdmZip from 'adm-zip';
import type { GameResolution, GameWindowMode, LaunchState, ProgressEvent } from '../../shared/types';
import { getSettings, saveSettings } from './settings';
import { getValidAccount, selectedAccount } from './accounts';
import { validateJavaRuntime } from './javaRuntimeHealth';
import {
  ensureJava,
  resolveJavaRequirement,
  javaCompatibilityError,
  scanJavaForLaunch,
  resolveJavaExecutable,
  selectHealthyJava,
  probeJavaAsync,
} from './java';
import { gameJavaArchitecture } from './javaArchitecture';
import { requireDesktopGamePlatform } from '../../shared/platform';
import { assertNativeElf, resolveNativeIntegrity } from './platformNatives';
import {
  assetsDir,
  allFolders,
  folderOfVersion,
  baseVersionJarPath,
  gameDir,
  librariesDir,
  nativesDir,
  versionJarPath,
  versionJsonPath,
} from './paths';
import { withGameFolder } from './paths';
import {
  clientJarPath,
  installClientJarOnly,
  installVanilla,
  libraryTasks,
  launchLibraryFiles,
  readVersionJson,
  setVersionResolution,
  resolveVersionChain,
  resolvedLibraries,
  rulesAllow,
  type ArgumentEntry,
  type VersionJson,
} from './versions';
import { downloadAll } from './download';
import { instanceDirectoryState } from './instances';
import { prepareLaunchAssets } from './launchAssets';
import { mapLaunchFiles, waitForPreparation } from './launchPreparation';
import { ensureLaunchArtifact, invalidLaunchArtifact } from './launchIntegrity';
import { exitHistory, rememberExit } from './exitHistory';
import { buildGameWindowArguments, resolveGameResolution } from './gameWindow';
import { rememberedWindowResolution, watchGameWindowSize } from './gameWindowSize';
import { supportsQuickPlayMultiplayer } from './serverUtils';
import * as yggdrasil from './yggdrasil';
import { prepareOfflineSkinLaunch, type OfflineSkinLaunch } from './offlineSkinLaunch';
import { serializeYggdrasilUserProperties } from './yggdrasilProvider';

export type ProgressEmit = (e: ProgressEvent) => void;
export type SendLog = (line: string) => void;
export type OnState = (s: LaunchState) => void;

const gameSession = new GameSession();
export const isBusy = () => gameSession.busy || !!restartPending;
interface LaunchOptions {
  createCommandWorld?: boolean;
  singleplayerWorld?: string;
}
interface Invocation {
  versionId: string;
  folder: string;
  emit: ProgressEmit;
  sendLog: SendLog;
  onState: OnState;
  serverAddress?: string;
  options: LaunchOptions;
}
let invocation: Invocation | undefined;
let restartPending: { invocation: Invocation; sessionToken?: symbol; forceToken?: string; waiting: boolean } | undefined;

export function cancelRestart(): void {
  if (restartPending?.waiting) throw new Error(t('launch.error.wait_exit_cancel'));
  restartPending = undefined;
}

/** Holds ownership across close -> relaunch so another click cannot race into the gap. */
export async function restartGame(
  versionId: string,
  folder: string,
  forceToken?: string
): Promise<{ requiresForce: boolean; forceToken?: string }> {
  launchLog.info(
    t('launch.log.restart_request', {
      version: versionId,
      forced: forceToken ? t('launch.log.restart_forced_suffix') : '',
    })
  );
  const targetToken = gameSession.tokenOf(versionId);
  if (forceToken) {
    if (
      !restartPending ||
      restartPending.waiting ||
      restartPending.forceToken !== forceToken ||
      restartPending.invocation.versionId !== versionId ||
      pathIdentity(restartPending.invocation.folder) !== pathIdentity(folder)
    )
      throw new Error(t('launch.error.restart_confirm_expired'));
    restartPending.waiting = true;
    try {
      if (targetToken) await gameSession.stop(8000, targetToken);
    } catch (error) {
      restartPending = undefined;
      launchLog.error(t('launch.log.restart_force_stop_failed', { version: versionId }), error);
      throw error;
    }
  } else {
    if (restartPending) throw new Error(t('launch.error.restart_pending'));
    if (!invocation || !targetToken || invocation.versionId !== versionId || pathIdentity(invocation.folder) !== pathIdentity(folder))
      throw new Error(t('launch.error.instance_not_running'));
    restartPending = { invocation, sessionToken: targetToken, waiting: true };
    try {
      await gameSession.stopGracefully(requestGameWindowClose, 30000, targetToken);
    } catch {
      launchLog.warn(t('launch.log.restart_grace_timeout', { version: versionId }));
      restartPending.waiting = false;
      restartPending.forceToken = crypto.randomUUID();
      return { requiresForce: true, forceToken: restartPending.forceToken };
    }
  }
  const previous = restartPending.invocation;
  try {
    previous.onState({ status: 'launching', text: t('launch.state.restarting') });
    const token = gameSession.reserve(previous.versionId);
    try {
      await withGameFolder(previous.folder, () =>
        launchOwned(previous.versionId, previous.emit, previous.sendLog, previous.onState, previous.serverAddress, token, {
          ...previous.options,
          createCommandWorld: false,
        })
      );
    } catch (error) {
      gameSession.release(token);
      previous.onState({ status: 'error', text: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return { requiresForce: false };
  } finally {
    restartPending = undefined;
  }
}

/** 当前正在运行的全部游戏版本 id（多开支持；改名等写操作前校验） */
export function getRunningVersionIds(): Set<string> {
  return gameSession.runningIds();
}

/** 运行中游戏的 PID（退出路径仅用于记录「游戏继续运行」日志，绝不用于终止） */
export function getRunningGamePids(): number[] {
  return gameSession.runningPids();
}

/** 最近一次会话的版本 id（兼容旧调用） */
export function getRunningVersionId(): string | null {
  return gameSession.versionId;
}

/** 最近一次启动的上下文（导出错误日志摘要用） */
export interface LastLaunchInfo {
  versionId: string;
  javaPath: string;
  startedAt: string;
  effectiveGameDir?: string;
  logDir?: string;
  commandSummary?: string;
  pid?: number;
  exitCode?: number | null;
  endedAt?: string;
  spawnError?: string;
  windowMode?: GameWindowMode;
  windowWidth?: number;
  windowHeight?: number;
}
let lastLaunch: LastLaunchInfo | null = null;
export function getLastLaunch(): LastLaunchInfo | null {
  return (
    lastLaunch ??
    (rememberExit(
      () =>
        exitHistory()
          .list()
          .find((e) => e.kind === 'game' && e.context)?.context
    ) as unknown as LastLaunchInfo | undefined) ??
    null
  );
}

// ---------------- 运行中游戏持久化（重开启动器识别并恢复） ----------------

interface RunningGameRecord {
  pid: number;
  versionId: string;
  effectiveGameDir: string;
  logDir: string;
  startedAt: string;
}

function runningGameFile(): string {
  return path.join(app.getPath('userData'), 'running-game.json');
}

function persistRunningGame(record: RunningGameRecord): void {
  try {
    fs.writeFileSync(runningGameFile(), JSON.stringify(record, null, 2), 'utf-8');
  } catch {
    /* 写入失败不影响启动 */
  }
}

function clearRunningGame(): void {
  try {
    fs.rmSync(runningGameFile(), { force: true });
  } catch {
    /* 忽略 */
  }
}

/**
 * 重开启动器时恢复运行中游戏的状态显示：
 * 读取上次的运行记录，校验进程存活；存活则恢复 launchState=running + lastLaunch 上下文。
 * 进程句柄不重建（detached 后无法重连 stdio），日志从游戏目录 logs/latest.log 读取。
 */
export function restoreRunningGame(onState: (s: LaunchState) => void): RunningGameRecord | null {
  let record: RunningGameRecord | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(runningGameFile(), 'utf-8'));
    if (Number.isInteger(raw?.pid) && raw.pid > 0 && typeof raw.versionId === 'string') record = raw;
  } catch {
    return null;
  }
  if (!record) return null;
  try {
    process.kill(record.pid, 0); // 存活探测（不杀进程）
  } catch {
    clearRunningGame(); // 残留记录：进程已不在
    return null;
  }
  // 恢复到当前会话的状态跟踪
  lastLaunch = {
    versionId: record.versionId,
    javaPath: '',
    startedAt: record.startedAt,
    effectiveGameDir: record.effectiveGameDir,
    logDir: record.logDir,
    pid: record.pid,
  };
  onState({ status: 'running', text: t('launch.state.restored_running') });
  return record;
}

/** 记录 Java 进程创建前的准备失败，仅供诊断导出，不改变启动流程。 */
export function recordLaunchPreparationError(versionId: string, message: string): void {
  if (!lastLaunch || lastLaunch.versionId !== versionId) {
    lastLaunch = { versionId, javaPath: '', startedAt: new Date().toISOString() };
  }
  lastLaunch.spawnError = message;
  lastLaunch.endedAt = new Date().toISOString();
}

/** 终止当前游戏进程 */
export const killGame = (forceToken?: string) => {
  launchLog.info(t('launch.log.kill_request'));
  if (restartPending) throw new Error(t('launch.error.restart_in_progress'));
  return gameSession.requestStop(requestGameWindowClose, forceToken);
};

/**
 * 沿 inheritsFrom 读取版本链并合并：
 * - libraries 合并（子在前）
 * - arguments 合并（父在前，子的 game/jvm 追加在后，兼容 forge/fabric）
 * - mainClass/type/assets/assetIndex/javaVersion/minecraftArguments 子缺省继承父
 * 返回合并结果与链条最底层原版 id（client jar 用它的）。
 * 实现复用 versions.resolveVersionChain（与 flatten 自包含语义一致）。
 */
function resolveChain(id: string): { merged: VersionJson; baseId: string } {
  return resolveVersionChain(id);
}

/** 按空格拆分用户 JVM 参数，支持简单双引号 */
function splitArgs(s: string): string[] {
  if (!s.trim()) return [];
  return (s.match(/"[^"]*"|[^\s"]+/g) ?? []).map((x) => x.replace(/^"|"$/g, ''));
}

/** 把子进程输出按行切分转发 */
function makeLinePusher(sendLog: SendLog): (chunk: Buffer) => void {
  let buf = '';
  return (chunk: Buffer) => {
    buf += chunk.toString('utf-8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line) sendLog(line);
    }
  };
}

/**
 * 启动游戏。
 * emit 进度 / sendLog 日志行 / onState 状态回调（running/exited/error）。
 */
export async function launch(
  versionId: string,
  emit: ProgressEmit,
  sendLog: SendLog,
  onState: OnState,
  serverAddress?: string,
  options: LaunchOptions = {}
): Promise<void> {
  if (restartPending) throw new Error(t('launch.error.launching_restart'));
  requireDesktopGamePlatform(process.platform);
  const token = gameSession.reserve(versionId);
  launchLog.info(
    t('launch.log.launch_start', {
      version: versionId,
      server: serverAddress ? t('launch.log.launch_server_suffix', { server: serverAddress }) : '',
    })
  );
  invocation = { versionId, folder: gameDir(), emit, sendLog, onState, serverAddress, options: { ...options } };
  try {
    await launchOwned(versionId, emit, sendLog, onState, serverAddress, token, invocation.options);
  } catch (error) {
    gameSession.release(token);
    launchLog.error(t('launch.log.launch_failed', { version: versionId }), error);
    throw error;
  }
}

async function launchOwned(
  versionId: string,
  emit: ProgressEmit,
  sendLog: SendLog,
  onState: OnState,
  serverAddress: string | undefined,
  token: symbol,
  options: LaunchOptions = {}
): Promise<void> {
  const settings = getSettings();
  const deadline = new ProgressDeadline(60000, () => onState({ status: 'error', text: t('launch.state.prepare_stalled') }));
  const originalEmit = emit;
  emit = (event) => {
    if (deadline.signal.aborted) return;
    deadline.progress(JSON.stringify([event.stage, event.progress, event.bytesDone, event.text]));
    originalEmit(event);
  };

  // 日志落盘：gameDir/faionyx-logs/latest.log（每次启动覆盖）
  let logStream: fs.WriteStream | null = null;
  let stdoutStream: fs.WriteStream | null = null;
  let stderrStream: fs.WriteStream | null = null;
  const launchLogDir = path.join(gameDir(), 'faionyx-logs', crypto.randomUUID());
  const sessionStartedAt = new Date().toISOString();
  let sessionDirectory = '';
  try {
    sessionDirectory = instanceDirectoryState(versionId, readVersionJson(versionId)).path;
  } catch {}
  lastLaunch = { versionId, javaPath: '', startedAt: sessionStartedAt, effectiveGameDir: sessionDirectory, logDir: launchLogDir };
  try {
    fs.mkdirSync(launchLogDir, { recursive: true });
    logStream = fs.createWriteStream(path.join(launchLogDir, 'latest.log'), { flags: 'w' });
    stdoutStream = fs.createWriteStream(path.join(launchLogDir, 'stdout.log'), { flags: 'w' });
    stderrStream = fs.createWriteStream(path.join(launchLogDir, 'stderr.log'), { flags: 'w' });
    logStream.on('error', () => undefined);
    stdoutStream.on('error', () => undefined);
    stderrStream.on('error', () => undefined);
  } catch {
    logStream = null;
  }
  const log: SendLog = (line) => {
    sendLog(line);
    try {
      logStream?.write(line + '\n');
    } catch {
      /* 忽略写入失败 */
    }
  };

  let spawned = false;
  const appearance: { offlineSkin: OfflineSkinLaunch | null } = { offlineSkin: null };
  const pipelineStarted = Date.now();
  try {
    launchLog.debug(t('launch.log.pipeline_start', { version: versionId }));
    // a0) 自愈：版本链 json 缺失或链底客户端 jar 缺失时，自动补全下载原版文件
    let baseIdProbe = versionId;
    let chainBroken = false;
    try {
      let cur: VersionJson = readVersionJson(versionId);
      const visited = new Set([versionId]);
      while (cur.inheritsFrom) {
        if (visited.has(cur.inheritsFrom) || visited.size >= 32) throw new Error(t('launch.error.chain_cycle'));
        baseIdProbe = cur.inheritsFrom;
        visited.add(baseIdProbe);
        cur = readVersionJson(baseIdProbe);
      }
    } catch (e) {
      if (baseIdProbe === versionId) {
        // 连入口版本的 json 都丢了，无法推断链条，只能重装
        throw new Error(t('launch.error.version_files_missing', { version: versionId }));
      }
      chainBroken = true;
    }
    // 链底原版 json/jar 可能在 versions 区（独立原版）或 .faionyx/base 依赖区（加载器实例的内部依赖）
    const baseInVersions = fs.existsSync(versionJsonPath(baseIdProbe));
    const jarProbe = baseInVersions ? versionJarPath(baseIdProbe) : baseVersionJarPath(baseIdProbe);
    if (chainBroken || !fs.existsSync(jarProbe)) {
      launchLog.info(t('launch.log.chain_broken', { version: versionId, broken: String(chainBroken) }));
      // 自包含实例（flatten 后）：json 不缺，仅补客户端 jar，绝不重写合并后的 json
      let flattened = false;
      try {
        flattened = readVersionJson(versionId)._flattenedAt !== undefined && !readVersionJson(versionId).inheritsFrom;
      } catch {
        /* json 读取失败按旧链处理 */
      }
      if (flattened && !chainBroken) {
        emit({ stage: 'repair', progress: 0, text: t('launch.state.repair_client_missing') });
        await installClientJarOnly(versionId, emit, deadline.signal);
        emit({ stage: 'repair', progress: 1, text: t('launch.state.repair_done') });
      } else {
        emit({
          stage: 'repair',
          progress: 0,
          text: t('launch.state.repair_files_missing', { version: baseIdProbe }),
        });
        // installVanilla 内部：json 不在则下载，已存在文件校验跳过，只补缺失部分
        // 自定义命名的原版实例：真实 MC 版本 id 从 _mcVersion 取
        let realId = baseIdProbe;
        try {
          const { resolveInstanceMetadata } = await import('./instanceMetadata');
          const { cachedClientVersionEvidence } = await import('./instanceVersionEvidence');
          const profile = readVersionJson(baseIdProbe);
          realId = resolveInstanceMetadata(
            profile,
            (id) => {
              try {
                return readVersionJson(id);
              } catch {
                return undefined;
              }
            },
            (chain) =>
              cachedClientVersionEvidence(
                chain,
                allFolders().flatMap((folder) => [path.join(folder, 'versions'), path.join(folder, '.faionyx', 'base')])
              )
          ).mcVersion;
        } catch {
          /* json 缺失时用 probe（即真实 MC id） */
        }
        const { isMinecraftVersionId } = await import('./instanceMetadata');
        if (!isMinecraftVersionId(realId)) throw new Error(t('launch.error.unknown_mc_version'));
        // 加载器实例的依赖原版补进 base 区；独立原版实例仍在 versions 区修复
        const dest = baseIdProbe !== versionId && !baseInVersions ? 'base' : 'versions';
        await installVanilla(realId, emit, dest, realId !== baseIdProbe ? baseIdProbe : undefined, deadline.signal);
        emit({ stage: 'repair', progress: 1, text: t('launch.state.repair_done') });
      }
    }

    // a0.1) 启动与管理页面共用同一个目录判定，避免配置路径、整合包和已存在
    // 独立内容在 UI 与最终 --gameDir 之间出现分歧；assets 仍使用全局共享目录。
    const effectiveGameDir = instanceDirectoryState(versionId, readVersionJson(versionId)).path;
    let resourcePacksConfigured = false;
    try {
      resourcePacksConfigured = /^\uFEFF?resourcePacks:/m.test(fs.readFileSync(path.join(effectiveGameDir, 'options.txt'), 'utf8'));
    } catch {
      /* a fresh instance */
    }
    launchLog.debug(t('launch.log.game_dir', { version: versionId, dir: effectiveGameDir }));
    fs.mkdirSync(effectiveGameDir, { recursive: true });

    // 默认中文：仅在 options.txt 不存在时写入（绝不覆盖玩家已有设置）
    try {
      const optFile = path.join(effectiveGameDir, 'options.txt');
      if (!fs.existsSync(optFile)) {
        fs.writeFileSync(optFile, 'lang:zh_cn\n', 'utf-8');
      }
    } catch {
      /* 写入失败不影响启动 */
    }

    // a) 版本链合并
    emit({ stage: 'launch', progress: 0, text: t('launch.state.resolve_version') });
    const { merged, baseId } = resolveChain(versionId);
    launchLog.debug(t('launch.log.chain_resolved', { version: versionId, base: baseId }));
    if (!merged.mainClass) throw new Error(t('launch.error.missing_main_class'));
    const instanceConfig = readVersionJson(versionId);
    const { resolveInstanceMetadata } = await import('./instanceMetadata');
    const { readClientVersionEvidence } = await import('./instanceVersionEvidence');
    let instanceMcVersion = resolveInstanceMetadata(instanceConfig, (id) => {
      try {
        return readVersionJson(id);
      } catch {
        return undefined;
      }
    }).mcVersion;
    const clientJar = clientJarPath(baseId);
    const account = selectedAccount();
    if (!account) throw new Error(t('launch.error.no_account'));
    const timed = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      try {
        deadline.signal.throwIfAborted();
        const result = await work();
        deadline.signal.throwIfAborted();
        return result;
      } finally {
        log(`[FAIONYX] ${t('launch.log.prepare_timing', { stage, ms: Date.now() - started })}`);
      }
    };
    // Both runtime selection and game options wait for the same verified client.
    // A repaired client may restore a canonical version missing from a renamed profile.
    let clientPreparation: Promise<void> | undefined;
    const prepareClient = () =>
      (clientPreparation ??= (async () => {
        emit({ stage: 'repair', progress: 0, text: t('launch.state.verify_client') });
        await ensureLaunchArtifact(
          { ...readVersionJson(baseId).downloads?.client, dest: clientJar },
          settings.mirror,
          (done, total) => emit({ stage: 'repair', progress: total ? done / total : 0, text: t('launch.state.repair_client') }),
          deadline.signal
        );
        const canonical = readClientVersionEvidence(clientJar);
        if (canonical) instanceMcVersion = canonical;
      })());
    const [{ classpath, nativesPath, launchAssets }, [validAccount, externalAuthArgs], javaPath] = await waitForPreparation([
      () =>
        timed(t('launch.stage.game_files'), async () => {
          await prepareClient();

          // 默认按键同步（总开关开启时覆盖实例 options.txt 的 key_* 项，其余行原样保留）
          const { syncDefaultGameOptions } = await import('./defaultGameOptions');
          const gameOptionsResult = syncDefaultGameOptions(effectiveGameDir, instanceMcVersion);
          if (gameOptionsResult.applied.length)
            log(`[FAIONYX] ${t('launch.log.synced_options', { count: gameOptionsResult.applied.length })}`);
          if (gameOptionsResult.unsupported.length)
            log(
              `[FAIONYX] ${t('launch.log.unsupported_options', { list: gameOptionsResult.unsupported.join(t('common.list_separator')) })}`
            );
          if (settings.resourcePackSync) {
            const { syncDefaultResourcePacks } = await import('./defaultResourcePacks');
            const count = syncDefaultResourcePacks(effectiveGameDir, instanceMcVersion, clientJarPath(baseId), { resourcePacksConfigured });
            if (count) log(`[FAIONYX] ${t('launch.log.loaded_packs', { count })}`);
          }
          if (settings.keySync) {
            try {
              const { syncKeysToGameDir, keySyncSupportedForVersion } = await import('./keybindings');
              if (!keySyncSupportedForVersion(instanceMcVersion)) {
                log(`[FAIONYX] ${t('launch.log.keycode_skip', { version: instanceMcVersion })}`);
              } else if (syncKeysToGameDir(effectiveGameDir)) log(`[FAIONYX] ${t('launch.log.keys_synced')}`);
            } catch (error) {
              log(`[FAIONYX] ${t('launch.log.keys_failed', { error: error instanceof Error ? error.message : String(error) })}`);
            }
          }

          // a1) 依赖库完整性：缺失则自动补下（含 fabric/quilt 的 maven 坐标库）
          const libTasks = libraryTasks(merged);
          const reused = reuseExternalRuntimeLibraries(
            merged,
            settings.folders.map((f) => f.path),
            librariesDir(),
            libTasks.map((t) => t.dest)
          );
          if (reused) log(`[FAIONYX] ${t('launch.log.libs_reused', { count: reused })}`);
          await repairNeoRuntime(merged, clientJar, readVersionJson(baseId), emit);
          const launchFiles = launchLibraryFiles(merged);
          await mapLaunchFiles(launchFiles, (file) => resolveNativeIntegrity(file, deadline.signal));
          let checkedLibraries = 0,
            lastCheckProgress = 0;
          const invalid = await mapLaunchFiles(launchFiles, async (file) => {
            const reason = await invalidLaunchArtifact(file);
            checkedLibraries++;
            if (checkedLibraries === launchFiles.length || Date.now() - lastCheckProgress >= 80) {
              lastCheckProgress = Date.now();
              emit({
                stage: 'repair',
                progress: checkedLibraries / launchFiles.length,
                text: t('launch.state.check_libraries', { done: checkedLibraries, total: launchFiles.length }),
              });
            }
            return reason;
          });
          const damaged = launchFiles.filter((_, index) => invalid[index]);
          // Restore bad downloads concurrently; wait for every worker before ending preparation.
          let repairIndex = 0,
            repaired = 0;
          const repairs = await Promise.allSettled(
            Array.from({ length: Math.min(8, damaged.length) }, async () => {
              while (repairIndex < damaged.length) {
                const file = damaged[repairIndex++];
                await ensureLaunchArtifact(
                  file,
                  settings.mirror,
                  (done, total) =>
                    emit({
                      stage: 'repair',
                      progress: total ? done / total : 0,
                      bytesDone: done,
                      text: t('launch.state.repair_library', { name: path.basename(file.dest) }),
                    }),
                  deadline.signal
                );
                launchLog.info(t('launch.log.library_repaired', { name: path.basename(file.dest) }));
                emit({
                  stage: 'repair',
                  progress: ++repaired / damaged.length,
                  text: t('launch.state.repair_library_count', { done: repaired, total: damaged.length }),
                });
              }
            })
          );
          const repairFailure = repairs.find((result) => result.status === 'rejected');
          if (repairFailure?.status === 'rejected') throw repairFailure.reason;

          // d) classpath 与 natives 解压
          emit({ stage: 'launch', progress: 0.5, text: t('launch.state.prepare_natives') });
          const { artifacts, natives } = resolvedLibraries(merged);
          const nativesPath =
            process.platform === 'linux' ? path.join(nativesDir(versionId), `linux-${process.arch}`) : nativesDir(versionId);
          fs.mkdirSync(nativesPath, { recursive: true });
          // Legacy LWJGL2 x64 bundles contain both 32- and 64-bit alternatives.
          // ARM64 requires every selected native to match; modern x64 classifier
          // artifacts are single architecture. Do not reject valid legacy bundles.
          if (process.platform === 'linux')
            for (const jar of [
              ...new Set([
                ...(process.arch === 'arm64' ? natives : []),
                ...artifacts.filter((file) => /-natives-linux(?:-arm64)?\.jar$/.test(file)),
              ]),
            ]) {
              const zip = new AdmZip(jar);
              for (const entry of zip.getEntries())
                if (!entry.isDirectory && /\.so(?:\.\d+)*$/.test(entry.entryName))
                  assertNativeElf(entry.getData(), process.arch, `${path.basename(jar)}:${entry.entryName}`);
            }
          for (const jar of natives) {
            if (!fs.existsSync(jar)) continue;
            try {
              const zip = new AdmZip(jar);
              for (const entry of zip.getEntries()) {
                if (entry.isDirectory || entry.entryName.startsWith('META-INF/')) continue;
                zip.extractEntryTo(entry, nativesPath, true, true);
              }
            } catch (error) {
              if (process.platform === 'linux')
                throw new Error(t('launch.error.native_extract', { jar: path.basename(jar), error: String(error) }));
              // Preserve the existing Windows/macOS extraction behavior.
            }
          }
          const classpath = [...new Set([...artifacts, ...natives, clientJar])].join(path.delimiter);

          // Existing installations may belong to another repository. Languages and sounds must
          // use its asset index/objects, not an unrelated launcher's empty default cache.
          const launchAssets = await prepareLaunchAssets(
            merged,
            [path.join(folderOfVersion(versionId), 'assets'), assetsDir(), ...allFolders().map((folder) => path.join(folder, 'assets'))],
            assetsDir(),
            effectiveGameDir,
            async (tasks) => {
              emit({ stage: 'repair', progress: 0, text: t('launch.state.assets', { count: tasks.length }) });
              await downloadAll(
                tasks,
                (done, total, speed, detail) =>
                  emit({
                    stage: 'repair',
                    progress: total ? done / total : 1,
                    text: t('launch.state.assets_progress', { done, total }),
                    bytesDone: detail.bytesDone,
                    speed,
                  }),
                settings.downloadThreads,
                settings.mirror,
                deadline.signal
              );
            }
          );
          log(`[FAIONYX] ${t('launch.log.assets', { root: launchAssets.root, index: launchAssets.indexId })}`);

          return { classpath, nativesPath, launchAssets };
        }),
      () =>
        timed(t('launch.stage.account'), () =>
          waitForPreparation([
            () => getValidAccount(account),
            async () => {
              appearance.offlineSkin = await prepareOfflineSkinLaunch(account, deadline.signal);
              if (appearance.offlineSkin) log(`[FAIONYX] ${t('launch.log.offline_skin')}`);
              return appearance.offlineSkin?.args ?? yggdrasil.launchArguments(account);
            },
          ])
        ),
      () =>
        timed(t('launch.stage.java'), async () => {
          await prepareClient();
          // c) Java：版本独立指定 > 手动指定 > 自动管理
          emit({ stage: 'java', progress: 0, text: t('launch.state.check_java') });
          const requirement = await resolveJavaRequirement(merged, instanceMcVersion, {
            signal: deadline.signal,
            modsDirectory: path.join(effectiveGameDir, 'mods'),
          });
          const need = requirement.recommendedMajor;
          const requiredArch = gameJavaArchitecture(merged);
          let javaPath: string;
          const versionJava = instanceConfig._javaPath;
          const automatic = instanceConfig._javaAuto === true || (!versionJava && (settings.javaAuto || !settings.javaPath));
          if (instanceConfig._javaAuto === true) {
            javaPath = await ensureJava(merged, emit, instanceMcVersion, { requirement, signal: deadline.signal });
          } else if (versionJava) {
            if (!fs.existsSync(versionJava)) {
              throw new Error(t('launch.error.version_java_missing', { path: versionJava }));
            }
            javaPath = versionJava;
            emit({ stage: 'java', progress: 1, text: t('launch.state.use_version_java') });
          } else if (settings.javaAuto) {
            javaPath = await ensureJava(merged, emit, instanceMcVersion, { requirement, signal: deadline.signal });
          } else if (settings.javaPath) {
            if (!fs.existsSync(settings.javaPath)) {
              throw new Error(t('launch.error.manual_java_missing'));
            }
            javaPath = settings.javaPath;
            emit({ stage: 'java', progress: 1, text: t('launch.state.use_manual_java') });
          } else {
            const found = await selectHealthyJava(
              await scanJavaForLaunch(emit, deadline.signal),
              need,
              requiredArch,
              deadline.signal,
              requirement
            );
            if (!found) {
              throw new Error(t('launch.error.java_not_found', { need }));
            }
            javaPath = found.path;
            emit({ stage: 'java', progress: 1, text: t('launch.state.use_local_java', { version: found.version }) });
          }
          launchLog.info(t('launch.log.java_selected', { need, source: requirement.source, path: javaPath }));

          const selectedJavaPath = javaPath;
          javaPath = await resolveJavaExecutable(javaPath, deadline.signal);
          if (selectedJavaPath !== javaPath) log(`[FAIONYX] ${t('launch.log.java_resolved', { path: javaPath })}`);
          const javaInfo = await probeJavaAsync(javaPath, deadline.signal);
          const incompatibility = javaInfo
            ? javaCompatibilityError(javaInfo, requirement, requiredArch, automatic)
            : t('launch.error.java_unusable');
          if (incompatibility) throw new Error(t('launch.error.java_incompatible', { reason: incompatibility }));
          if (!javaInfo) throw new Error(t('launch.error.java_unusable'));
          await validateJavaRuntime(javaPath, javaInfo.major);
          return javaPath;
        }),
    ]);

    const userProperties = serializeYggdrasilUserProperties(validAccount.userProperties);
    const vars: Record<string, string> = {
      auth_player_name: validAccount.username,
      version_name: versionId,
      game_directory: effectiveGameDir,
      assets_root: launchAssets.root,
      assets_index_name: launchAssets.indexId,
      game_assets: launchAssets.gameAssets,
      auth_uuid: validAccount.type === 'yggdrasil' ? validAccount.uuid.replace(/-/g, '') : validAccount.uuid,
      auth_access_token: validAccount.accessToken ?? '',
      auth_session: validAccount.accessToken ?? '',
      clientid: '',
      auth_xuid: '',
      user_type: validAccount.type === 'microsoft' ? 'msa' : 'mojang',
      user_properties: userProperties,
      version_type: 'FAIONYX',
      natives_directory: nativesPath,
      launcher_name: 'FAIONYX',
      launcher_version: app.getVersion(),
      classpath,
      library_directory: librariesDir(),
      classpath_separator: path.delimiter,
    };
    const sub = (s: string): string => s.replace(/\$\{([^}]+)\}/g, (m, k) => vars[k] ?? m);

    /** 展开新版 arguments 数组（字符串或带 rules 的对象） */
    const expandEntries = (entries?: (string | ArgumentEntry)[]): string[] => {
      const out: string[] = [];
      for (const e of entries ?? []) {
        if (typeof e === 'string') {
          out.push(sub(e));
        } else if (e && rulesAllow(e.rules)) {
          const values = Array.isArray(e.value) ? e.value : [e.value];
          for (const v of values) out.push(sub(v));
        }
      }
      return out;
    };

    // 游戏参数：新版 arguments.game / 旧版 minecraftArguments
    let gameArgs: string[];
    if ((merged.arguments?.game?.length ?? 0) > 0) {
      gameArgs = expandEntries(merged.arguments?.game);
    } else if (merged.minecraftArguments) {
      gameArgs = merged.minecraftArguments.split(/\s+/).filter(Boolean).map(sub);
    } else {
      throw new Error(t('launch.error.missing_game_args'));
    }

    // e) JVM 参数
    // Xmx 按真实物理内存钳制：配置文件可能被手改或从大内存机器迁移过来，
    // 超出物理内存的分配会让 JVM 起不来或系统整卡死。
    const totalMemMB = Math.floor(os.totalmem() / 1024 / 1024);
    if (process.platform === 'win32' && settings.memoryOrganizeBeforeLaunch === true) {
      emit({ stage: 'prepare', progress: 0, text: t('launch.state.organize_memory') });
      try {
        const result = await (await import('./memoryOrganizer')).organizeMemory();
        sendLog(
          t('launch.log.memory_organized', {
            before: result.beforeMB,
            after: result.afterMB,
            processed: result.processed,
            skipped: result.skipped,
            failures: Object.keys(result.failures).join(t('common.list_separator')) || t('launch.log.memory_done'),
          })
        );
      } catch (e) {
        sendLog(t('launch.log.memory_failed', { error: String(e) }));
      }
    }
    const availableMemMB = Math.floor(os.freemem() / 1024 / 1024);
    let mem = settings.memoryAuto ? autoMemoryMB(totalMemMB) : Math.min(Math.max(512, settings.memoryMB || 4096), totalMemMB);
    if (settings.memoryAuto && process.platform === 'win32' && settings.memoryOrganizeBeforeLaunch === true)
      mem = Math.min(mem, Math.max(512, availableMemMB - 1024));
    // forge ignoreList 需精确匹配 -cp 上的原版客户端 jar 文件名：实例自定义命名时
    // ${version_name}.jar 与实际 clientJar 不一致，原版 jar 会被模块系统当作自动模块
    // 与 fml 合成的 minecraft 模块重复导出包（ResolutionException 闪退），补写真实文件名
    const clientJarName = path.basename(clientJar);
    const jsonJvmArgs = expandEntries(merged.arguments?.jvm)
      .map((a) => a.trim()) // fabric json 的 -DFabricMcEmu= 等参数值带前导空格，trim 去除
      .map((a) => (a.startsWith('-DignoreList=') && !a.split(',').some((x) => x.trim() === clientJarName) ? `${a},${clientJarName}` : a));
    // 版本 json（MC 官方 1.13+ / fabric / neoforge）的 arguments.jvm 自带
    // -Djava.library.path / -Djna.tmpdir / -cp ${classpath}。手动再补会重复
    // （用户实测命令行里 classpath 与 natives 参数成片重复）。仅在 json 缺失时补。
    const jsonHas = (prefix: string) => jsonJvmArgs.some((a) => a.startsWith(prefix));
    const jsonHasCp = jsonJvmArgs.some((a) => a === '-cp');
    const jvmArgs: string[] = [
      `-Xmx${mem}M`,
      `-Xms${Math.min(mem, 1024)}M`,
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-Dfile.encoding=UTF-8',
      // Modern LWJGL/GLFW must run on the Cocoa main thread; metadata normally
      // already supplies this flag. LWJGL 2 uses AWT and must not receive it.
      ...(process.platform === 'darwin' &&
      !jsonJvmArgs.includes('-XstartOnFirstThread') &&
      merged.libraries?.some((lib) => /^org\.lwjgl:lwjgl:/.test(lib.name ?? ''))
        ? ['-XstartOnFirstThread']
        : []),
      ...(jsonHas('-Djava.library.path=') ? [] : [`-Djava.library.path=${nativesPath}`]),
      ...(jsonHas('-Djna.tmpdir=') ? [] : [`-Djna.tmpdir=${nativesPath}`]),
      // 外置登录 javaagent 与预取元数据必须位于主类之前。
      ...externalAuthArgs,
      // 版本 json 自带的 JVM 参数（forge 的 -p ${classpath} 等依赖它）
      ...jsonJvmArgs,
      ...splitArgs(settings.jvmArgs),
    ];

    // e2) 实例覆盖 > 全局设置。全屏不混入窗口尺寸；最大化使用当前显示器工作区。
    const resolution = resolveGameResolution(settings.resolution, instanceConfig._resolution);
    let workArea: { width: number; height: number } | undefined;
    if (resolution.mode === 'maximized') {
      try {
        workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize;
      } catch {
        /* 无显示器上下文时回退到配置宽高，仍保持窗口模式。 */
      }
    } else if (resolution.mode === 'launcher') {
      try {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.isAlwaysOnTop() && w.isVisible());
        if (win) {
          const size = win.getContentSize();
          // DIP → 物理像素：乘上窗口所在显示器的缩放系数
          const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
          const w = Math.round(size[0] * scale);
          const h = Math.round(size[1] * scale);
          if (w > 0 && h > 0) workArea = { width: w, height: h };
        }
      } catch {
        /* 回退配置宽高 */
      }
    }
    const windowArgs = buildGameWindowArguments(gameArgs, resolution, workArea);
    gameArgs = windowArgs.args;

    // e3) 官方 Quick Play 自 Java 1.20 起支持；旧版只启动正确实例，不注入未知参数。
    const minecraftVersion = instanceMcVersion;
    if (options.createCommandWorld) {
      const world = createCommandWorld(effectiveGameDir, clientJar);
      options.singleplayerWorld = world.id;
      log(`[FAIONYX] ${t('launch.log.world_created', { path: world.path })}`);
    }
    if (options.singleplayerWorld) {
      if (!fs.existsSync(path.join(effectiveGameDir, 'saves', options.singleplayerWorld, 'level.dat')))
        throw new Error(t('launch.error.world_missing'));
      gameArgs.push('--quickPlaySingleplayer', options.singleplayerWorld);
    } else if (serverAddress && supportsQuickPlayMultiplayer(minecraftVersion)) {
      gameArgs.push('--quickPlayMultiplayer', serverAddress);
    } else if (serverAddress) {
      log(`[FAIONYX] ${t('launch.log.no_quickplay', { version: minecraftVersion })}`);
    }

    // g) 启动进程（json 自带 -cp ${classpath} 时不再重复加 -cp；forge 的 -p 是模块路径仍需 -cp）
    const args = [...jvmArgs, ...(jsonHasCp ? [] : ['-cp', classpath]), merged.mainClass, ...gameArgs];
    // 日志中隐藏 accessToken
    const privateLaunchValues = new Set(
      [validAccount.accessToken, validAccount.clientToken, userProperties].filter((value): value is string => !!value)
    );
    const logArgs = args.map((argument) => {
      if (argument.startsWith('-Dauthlibinjector.yggdrasil.prefetched=')) {
        return '-Dauthlibinjector.yggdrasil.prefetched=<metadata>';
      }
      if (
        argument.startsWith('-javaagent:') &&
        (argument.includes('faionyx-offline-skin.jar=') || (appearance.offlineSkin && argument.includes('authlib-injector')))
      )
        return argument.split('=')[0] + '=<local appearance>';
      if (privateLaunchValues.has(argument)) return '***';
      if (validAccount.accessToken && argument.includes(validAccount.accessToken)) {
        return argument.replaceAll(validAccount.accessToken, '***');
      }
      return argument;
    });
    const commandSummary = `${javaPath} ${logArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
    log(
      `[FAIONYX] ${t('launch.log.window_mode', { mode: windowArgs.mode })}` +
        (windowArgs.width && windowArgs.height
          ? t('launch.log.window_size_suffix', { width: windowArgs.width, height: windowArgs.height })
          : t('launch.log.fullscreen_suffix'))
    );
    log(`[FAIONYX] ${t('launch.log.command', { command: commandSummary })}`);
    launchLog.debug(t('launch.log.command', { command: commandSummary }));
    launchLog.info(t('launch.log.prepare_done', { ms: Date.now() - pipelineStarted }));

    emit({ stage: 'launch', progress: 1, text: t('launch.state.launch_process') });
    // 脱离式创建：游戏进程与启动器生命周期完全解耦（Windows CreateProcessW，见 gracefulClose.ts），
    // 关闭启动器时游戏继续运行；stdout/stderr 仍以管道回流，日志体验不变。
    deadline.signal.throwIfAborted();
    for (const message of await upgradeInstalledBridge(
      effectiveGameDir,
      path.join(__dirname, 'faionyx-bridge.jar').replace('app.asar', 'app.asar.unpacked')
    ))
      log('[FAIONYX] ' + message);
    deadline.signal.throwIfAborted();
    deadline.dispose();
    await appearance.offlineSkin?.releasePort();
    const proc = await withDeadline(
      (signal) => spawnGameProcess(javaPath, args, { cwd: effectiveGameDir, signal }),
      15000,
      t('launch.error.spawn_timeout')
    );
    gameSession.attach(token, proc);
    spawned = true;
    const spawnedAt = Date.now();
    const capturedFolder = folderOfVersion(versionId);
    const initialWindowPreference = structuredClone(instanceConfig._resolution ?? settings.resolution);
    let savedWindowSize: LaunchState['savedWindowSize'];
    const windowSizeCapture = watchGameWindowSize(proc, {
      enabled: () => process.platform === 'win32' && getSettings().rememberGameWindowSize === true,
      commit: (size) =>
        withGameFolder(capturedFolder, () => {
          const currentInstance = readVersionJson(versionId)._resolution;
          // A user edit during gameplay wins over the automatic save.
          const next = rememberedWindowResolution(
            initialWindowPreference,
            instanceConfig._resolution,
            getSettings().resolution,
            currentInstance,
            size
          );
          if (!next) return;
          if (instanceConfig._resolution) setVersionResolution(versionId, next);
          else saveSettings({ resolution: next });
          savedWindowSize = {
            scope: instanceConfig._resolution ? 'instance' : 'global',
            previous: initialWindowPreference,
            resolution: next as GameResolution,
          };
          log(`[FAIONYX] ${t('launch.log.window_size_saved', { width: size.width, height: size.height })}`);
        }),
      onError: (error) =>
        log(
          `[FAIONYX] ${t('launch.log.window_size_save_failed', {
            error: error instanceof Error ? error.message : String(error),
          })}`
        ),
    });
    lastLaunch = {
      versionId,
      javaPath,
      startedAt: new Date().toISOString(),
      effectiveGameDir,
      logDir: launchLogDir,
      commandSummary,
      windowMode: windowArgs.mode,
      windowWidth: windowArgs.width,
      windowHeight: windowArgs.height,
      pid: proc.pid,
    };
    // 持久化运行中游戏记录：重开启动器时据此识别并恢复状态
    persistRunningGame({ pid: proc.pid ?? 0, versionId, effectiveGameDir, logDir: launchLogDir, startedAt: lastLaunch.startedAt });
    const exitRecord = rememberExit(() =>
      exitHistory().begin('game', proc.pid ?? 0, versionId, {
        versionId,
        folder: folderOfVersion(versionId),
        javaPath,
        effectiveGameDir,
        logDir: launchLogDir,
        startedAt: lastLaunch!.startedAt,
        pid: proc.pid,
      })
    );
    // spawnGameProcess returns only after the OS confirms process creation.
    launchLog.info(t('launch.log.process_started', { pid: String(proc.pid) }));
    onState({ status: 'running', text: t('launch.state.running') });
    // QuickPlay 直达（创建命令世界/进服）：游戏窗口出现后拉到前台，避免鼠标被锁在未聚焦窗口里
    if (options.singleplayerWorld || serverAddress) {
      void focusGameWindow(proc)
        .then(() => log(`[FAIONYX] ${t('launch.log.window_focused')}`))
        .catch((error) => log(`[FAIONYX] ${t('launch.log.focus_failed', { error: error.message })}`));
    }

    const exitEvidence = new GameExitEvidence();
    const pushStdout = makeLinePusher((line) => {
      exitEvidence.observe(line);
      stdoutStream?.write(line + '\n');
      log(line);
    });
    const pushStderr = makeLinePusher((line) => {
      exitEvidence.observe(line);
      stderrStream?.write(line + '\n');
      log(line);
    });
    proc.stdout?.on('data', pushStdout);
    proc.stderr?.on('data', pushStderr);
    proc.on('error', (err) => {
      // A failed kill can also emit 'error'; it is not evidence that the game exited.
      if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
        launchLog.warn(t('launch.log.process_op_failed', { error: err.message }));
        log(t('launch.log.process_op_failed', { error: err.message }));
        return;
      }
      if (!gameSession.release(token)) return;
      void windowSizeCapture.finish(false);
      launchLog.error(t('launch.log.spawn_failed', { pid: proc.pid ?? t('launch.log.pid_unknown') }), err);
      if (exitRecord) rememberExit(() => exitHistory().end(exitRecord, null));
      logStream?.end();
      stdoutStream?.end();
      stderrStream?.end();
      if (lastLaunch && lastLaunch.pid === proc.pid) {
        lastLaunch.spawnError = err.message;
        lastLaunch.endedAt = new Date().toISOString();
      }
      onState({ status: 'error', text: t('launch.state.spawn_failed', { error: err.message }) });
    });
    proc.on('close', (code) => {
      void appearance.offlineSkin
        ?.dispose()
        .catch((error) => launchLog.warn(t('launch.log.offline_skin_cleanup_failed', { error: String(error) })));
      if (!gameSession.release(token)) return;
      windowSizeCapture.finish(code === 0);
      const runS = spawnedAt ? Math.round((Date.now() - spawnedAt) / 1000) : null;
      const intentional = restartPending?.sessionToken === token || gameSession.wasIntentionalStop(token);
      const exitKind = exitEvidence.classify(code, intentional, process.platform);
      if (exitRecord) rememberExit(() => exitHistory().end(exitRecord, code, intentional, exitKind === 'shutdown-timeout'));
      if (code === 0)
        launchLog.info(
          t('launch.log.exit_normal', { version: versionId, run: runS !== null ? t('launch.log.run_seconds', { seconds: runS }) : '' })
        );
      else if (intentional) launchLog.info(t('launch.log.exit_user', { version: versionId, code: code ?? t('launch.log.pid_unknown') }));
      else if (exitKind === 'shutdown-timeout') launchLog.warn(t('launch.log.exit_timeout', { version: versionId, code }));
      else
        launchLog.warn(
          t('launch.log.exit_abnormal', {
            version: versionId,
            code: code ?? t('launch.log.pid_unknown'),
            run: runS !== null ? t('launch.log.run_seconds', { seconds: runS }) : '',
          })
        );
      logStream?.end();
      stdoutStream?.end();
      stderrStream?.end();
      if (lastLaunch && lastLaunch.pid === proc.pid) {
        lastLaunch.exitCode = code;
        lastLaunch.endedAt = new Date().toISOString();
        clearRunningGame();
      }
      onState({
        status: 'exited',
        savedWindowSize,
        code: code ?? -1,
        exitKind,
        intentionalRestart: restartPending?.sessionToken === token,
        intentionalStop: gameSession.wasIntentionalStop(token),
        text:
          exitKind === 'shutdown-timeout'
            ? t('launch.state.exited_timeout')
            : t('launch.state.exited', { code: code ?? t('launch.log.pid_unknown') }),
      });
    });
  } finally {
    deadline.dispose();
    if (!spawned) await appearance.offlineSkin?.dispose();
    if (!spawned) {
      logStream?.end();
      stdoutStream?.end();
      stderrStream?.end();
    }
  }
}
