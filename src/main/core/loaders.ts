/**
 * 加载器：fabric / quilt / forge / neoforge 的版本列表与安装
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { downloadLimiter } from './downloadLimits';
import { withFileJob } from './fileJobs';
import { runParallelTasks } from './parallelTasks';
import { ParallelProgress } from './parallelProgress';
import { copyRuntimeProfile } from './packRuntime';
import { fmlArgument, missingNeoRuntime, reuseExternalRuntimeLibraries } from './externalRuntime';
import type { FabricApiVersion, LoaderName, ProgressEvent } from '../../shared/types';
import { BMCL_MAVEN_ROOT, downloadAll, downloadFile, fetchSignal } from './download';
import { isCancelError } from './tasks';
import { translate as t } from '../../shared/i18n';
import { downloadLoaderInstaller } from './installerDownload';
import { prepareInstallerDependencies } from './installerDependencies';
import { SmoothedSpeedEstimator } from './downloadProgress';
import { logScope } from './launcherLog';

const loaderLog = logScope('loader');
import { getSettings } from './settings';
import { gameDir, librariesDir, registerVersionFolder, versionDir, versionJsonPath, versionsDir } from './paths';
import { ensureJava } from './java';
import {
  installVanilla,
  libraryTasks,
  migrateDependencyVanilla,
  readVersionJson,
  scanInstalledFolder,
  flattenInstance,
  type VersionJson,
} from './versions';

export type ProgressEmit = (e: ProgressEvent) => void;

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal: fetchSignal(signal) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ---------------- 版本列表 ----------------

/** 版本号倒序比较器：数字段数值比、同位稳定版优先于预发布（beta 等文本段），最新排最前 */
function compareVersionDesc(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const xa = pa[i];
    const xb = pb[i];
    if (xa === undefined) return 1; // 段数少 = 更旧，排后
    if (xb === undefined) return -1;
    const aNum = /^\d+$/.test(xa);
    const bNum = /^\d+$/.test(xb);
    if (aNum && bNum) {
      const d = Number(xb) - Number(xa);
      if (d !== 0) return d;
    } else if (aNum) {
      return -1; // 同位数字段（正式）优先于文本段（beta/rc）
    } else if (bNum) {
      return 1;
    } else {
      const c = xb.localeCompare(xa); // 文本段按字母倒序（rc > beta）
      if (c !== 0) return c;
    }
  }
  return 0;
}

/** 获取加载器可用版本列表（最新在前）；signal 用于任务取消 */
export async function listLoaderVersions(loader: LoaderName, mcVersion: string, signal?: AbortSignal): Promise<string[]> {
  loaderLog.debug(t('loaders.log.list_query', { loader, mcVersion }));
  let list: string[];
  switch (loader) {
    case 'fabric': {
      const arr = (await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`, signal)) as {
        loader?: { version?: string };
      }[];
      list = arr.map((x) => x.loader?.version).filter((v): v is string => !!v);
      break;
    }
    case 'quilt': {
      const arr = (await fetchJson(`https://meta.quiltmc.org/v3/versions/loader/${mcVersion}`, signal)) as {
        loader?: { version?: string };
      }[];
      list = arr.map((x) => x.loader?.version).filter((v): v is string => !!v);
      break;
    }
    case 'forge': {
      const arr = (await fetchJson(`https://bmclapi2.bangbang93.com/forge/minecraft/${mcVersion}`, signal)) as { version?: string }[];
      list = arr.map((x) => x.version).filter((v): v is string => !!v);
      break;
    }
    case 'neoforge': {
      try {
        const res = await fetch(`https://bmclapi2.bangbang93.com/neoforge/list/${mcVersion}`, {
          signal: fetchSignal(signal),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as unknown;
        if (Array.isArray(data)) {
          list = data.map((x) => (typeof x === 'string' ? x : ((x as { version?: string }).version ?? ''))).filter(Boolean);
          break;
        }
        throw new Error(t('loaders.error.return_format'));
      } catch {
        // 取消不降级：直接抛「已取消」
        if (signal?.aborted) throw new Error(t('loaders.error.cancelled'));
        // 回退：解析 maven-metadata.xml，过滤 mc 前缀（1.20.4 -> 20.4）
        loaderLog.warn(t('loaders.log.neoforge_fallback', { mcVersion }));
        const res = await fetch('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', {
          signal: fetchSignal(signal),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: neoforge maven-metadata`);
        const xml = await res.text();
        const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
        const prefix = mcVersion.replace(/^1\./, '');
        list = all.filter((v) => v.startsWith(prefix)).reverse();
        break;
      }
    }
  }
  // 统一按版本号倒序：最新版本排最前（下拉默认选中第一个即最新版）
  return list.sort(compareVersionDesc);
}

// ---------------- 安装 ----------------

/** 选一个可用 java 运行安装器：优先本机扫描，实在不行用 ensureJava 下载 */
async function pickJavaForInstaller(mcVersion: string, emit: ProgressEmit, signal?: AbortSignal): Promise<string> {
  const vj = readVersionJson(mcVersion);
  return await ensureJava(vj, emit, mcVersion, { signal });
}

/** 运行 forge/neoforge 安装器：全量输出落盘 installer.log；失败带最后 30 行；--mirror= 等号形式，失败降级去 mirror 重试；signal 取消时杀掉安装器进程 */
function runInstaller(javaPath: string, jar: string, emit: ProgressEmit, signal?: AbortSignal, target = gameDir()): Promise<void> {
  // External Java installers rewrite launcher_profiles.json in their target folder.
  // Only this final installer phase is serialized; version/file downloads remain concurrent.
  emit({ stage: 'loader-process', progress: 0, indeterminate: true, text: t('loaders.state.installer_wait_dir') });
  return withFileJob(path.join(target, '.faionyx-installer'), signal, () => {
    emit({ stage: 'loader-process', progress: 0, indeterminate: true, text: t('loaders.state.installer_starting') });
    return runInstallerUnlocked(javaPath, jar, emit, signal, target);
  });
}

function runInstallerUnlocked(
  javaPath: string,
  jar: string,
  emit: ProgressEmit,
  signal: AbortSignal | undefined,
  target: string
): Promise<void> {
  const useMirror = getSettings().mirror === 'bmclapi';

  const buildArgs = (withMirror: boolean): string[] => {
    const args = ['-jar', jar, '--installClient', target];
    if (withMirror) args.push(`--mirror=${BMCL_MAVEN_ROOT}`);
    return args;
  };

  const runOnce = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      loaderLog.info(t('loaders.log.run_installer', { jar: path.basename(jar), target }));
      const proc = spawn(javaPath, args, { windowsHide: true, cwd: target });
      let cancelled = false;
      let spawnError: Error | null = null;
      const onAbort = () => {
        cancelled = true;
        try {
          proc.kill();
        } catch {
          /* 忽略 */
        }
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      const allLines: string[] = [];
      let tail = '';
      const onData = (d: Buffer): void => {
        const lines = (tail + d.toString('utf-8')).split(/\r?\n/);
        tail = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) allLines.push(l);
        const shortTail = lines.slice(-2).join(' ').slice(-160);
        emit({
          stage: 'loader-process',
          progress: 0,
          indeterminate: true,
          text: t('loaders.state.installer_generating', { tail: shortTail || t('common.processing') }),
        });
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => {
        spawnError = e;
      });
      // close 保证 stdout/stderr 已关闭；取消 IPC 只有到这里才可确认安装器真正停止。
      proc.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (tail.trim()) allLines.push(tail);
        // 全量输出落盘，便于排查
        try {
          const logDir = path.join(target, 'faionyx-logs');
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(
            path.join(logDir, 'installer.log'),
            allLines.join('\n') +
              `\n\n${t('loaders.log.exit_code_line', { code: code ?? t('loaders.label.unknown'), args: args.join(' ') })}\n`,
            'utf-8'
          );
        } catch {
          /* 日志写盘失败不影响流程 */
        }
        if (cancelled || signal?.aborted) reject(new Error(t('loaders.error.cancelled')));
        else if (spawnError) {
          loaderLog.error(t('loaders.log.installer_spawn_error', { error: String(spawnError) }));
          reject(spawnError);
        } else if (code === 0) resolve();
        else {
          const last = allLines.slice(-30).join('\n');
          loaderLog.error(t('loaders.log.installer_failed', { code: code ?? t('loaders.label.unknown'), tail: last.slice(-400) }));
          reject(new Error(t('loaders.error.installer_exit', { code: code ?? t('loaders.label.unknown'), tail: last })));
        }
      });
    });

  return runOnce(buildArgs(useMirror)).catch((err) => {
    if (signal?.aborted || isCancelError(err)) throw new Error(t('loaders.error.cancelled'));
    if (!useMirror) throw err;
    loaderLog.warn(t('loaders.log.mirror_retry'));
    emit({ stage: 'loader', progress: 0.7, text: t('loaders.state.mirror_retry') });
    return runOnce(buildArgs(false));
  });
}

/** Regenerate only missing production libraries in a private installer workspace.
 * The installer cannot rewrite a player's version JSON, options, mods or saves. */
export async function repairNeoRuntime(json: VersionJson, clientJar: string, baseJson: VersionJson, emit: ProgressEmit): Promise<void> {
  if (!missingNeoRuntime(json, librariesDir()).length) return;
  const neo = fmlArgument(json, '--fml.neoForgeVersion'),
    mc = fmlArgument(json, '--fml.mcVersion');
  if (!neo || !mc) throw new Error(t('loaders.error.neo_metadata_incomplete'));
  loaderLog.info(t('loaders.log.neo_repair_start', { neo }));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'faionyx-runtime-repair-'));
  // Keep failed repair logs for diagnosis; successful workspaces contain no player data.
  const jar = path.join(staging, 'installer.jar');
  emit({ stage: 'repair', progress: 0, text: t('loaders.state.repair_neo', { neo }) });
  const vanilla = path.join(staging, 'versions', mc);
  fs.mkdirSync(vanilla, { recursive: true });
  fs.copyFileSync(clientJar, path.join(vanilla, mc + '.jar'));
  fs.writeFileSync(path.join(vanilla, mc + '.json'), JSON.stringify({ ...baseJson, id: mc }));
  fs.writeFileSync(path.join(staging, 'launcher_profiles.json'), JSON.stringify({ profiles: {}, settings: {}, version: 3 }));
  const tasks = libraryTasks(json);
  // Seed declared and generated libraries with copies, not directory junctions.
  reuseExternalRuntimeLibraries(
    json,
    [path.dirname(librariesDir()), ...getSettings().folders.map((f) => f.path)],
    path.join(staging, 'libraries'),
    tasks.map((t) => path.join(staging, 'libraries', path.relative(librariesDir(), t.dest)))
  );
  try {
    const mirror = getSettings().mirror;
    const repairEmit: ProgressEmit = (event) =>
      emit({ ...event, stage: 'repair', text: t('loaders.state.repair_neo_prefix', { text: event.text }) });
    await downloadLoaderInstaller(
      `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neo}/neoforge-${neo}-installer.jar`,
      jar,
      mirror,
      (done, total) =>
        repairEmit({
          stage: 'repair',
          progress: total ? done / total : 0,
          text: t('loaders.state.download_installer', { size: (done / 1024 / 1024).toFixed(1) }),
          bytesDone: done,
          bytesTotal: total || undefined,
        })
    );
    const java = await ensureJava(baseJson, emit, mc);
    await prepareInstallerDependencies(jar, staging, mirror, repairEmit);
    await runInstaller(java, jar, repairEmit, undefined, staging);
    reuseExternalRuntimeLibraries(
      json,
      [staging],
      librariesDir(),
      tasks.map((t) => t.dest)
    );
    const missing = missingNeoRuntime(json, librariesDir());
    if (missing.length) throw new Error(t('loaders.error.neo_libs_missing', { list: missing.join(t('common.list_separator')) }));
    fs.rmSync(staging, { recursive: true, force: true });
  } catch (error) {
    loaderLog.error(t('loaders.log.neo_repair_failed', { neo }), error);
    throw new Error(t('loaders.error.neo_repair_failed', { dir: staging, error: error instanceof Error ? error.message : String(error) }));
  }
}

/** 安装完成后扫描 versions/ 找安装器生成的版本目录名 */
function findInstalledDir(loader: LoaderName, mcVersion: string, loaderVersion: string): string | null {
  const dir = versionsDir();
  if (!fs.existsSync(dir)) return null;
  // Match resolved runtime metadata, never a display-name substring (e.g. .66 vs .660).
  const candidates = scanInstalledFolder(gameDir())
    .versions.filter((item) => item.loader === loader && item.mcVersion === mcVersion && item.loaderVersion === loaderVersion)
    .map((item) => ({ name: item.id, mtime: fs.statSync(versionDir(item.id)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.name ?? null;
}

/** 给安装好的版本 json 补写 _loader/_loaderVersion 标记 */
function tagLoaderJson(id: string, loader: LoaderName, loaderVersion: string): void {
  const p = versionJsonPath(id);
  const j = JSON.parse(fs.readFileSync(p, 'utf-8')) as VersionJson;
  j._loader = loader;
  j._loaderVersion = loaderVersion;
  fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf-8');
}

/**
 * 安装加载器，返回新版本的 id。
 * 原版作为内部依赖：fabric/quilt 直接装进 .faionyx/base（不进版本列表）；
 * forge/neoforge 安装器强制要求 versions/ 下存在原版，先落地、装完（无论成败）再迁移进 base。
 */
export async function installLoader(
  loader: LoaderName,
  mcVersion: string,
  loaderVersion: string,
  emit: ProgressEmit,
  instanceName?: string,
  signal?: AbortSignal
): Promise<string> {
  const started = Date.now();
  loaderLog.info(
    t('loaders.log.install_start', {
      loader,
      loaderVersion,
      mcVersion,
      instance: instanceName ? t('loaders.log.install_instance_suffix', { name: instanceName }) : '',
    })
  );
  try {
    const id = await installLoaderInternal(loader, mcVersion, loaderVersion, emit, instanceName, signal);
    loaderLog.info(t('loaders.log.install_done', { loader, loaderVersion, id, seconds: ((Date.now() - started) / 1000).toFixed(1) }));
    return id;
  } catch (error) {
    if (!isCancelError(error)) loaderLog.error(t('loaders.log.install_failed', { loader, loaderVersion }), error);
    else loaderLog.debug(t('loaders.log.install_cancelled', { loader, loaderVersion }));
    throw error;
  }
}

async function installLoaderInternal(
  loader: LoaderName,
  mcVersion: string,
  loaderVersion: string,
  emit: ProgressEmit,
  instanceName?: string,
  signal?: AbortSignal
): Promise<string> {
  emit({ stage: 'version-json', progress: 0, text: t('loaders.state.check_vanilla', { mcVersion }) });
  const vanillaPreExisted = fs.existsSync(versionJsonPath(mcVersion));
  const installerBased = loader === 'forge' || loader === 'neoforge';
  const prepareVanilla = (report: ProgressEmit, signal?: AbortSignal, runtimeReady?: (signal: AbortSignal) => Promise<void>) =>
    installVanilla(mcVersion, report, vanillaPreExisted || installerBased ? 'versions' : 'base', undefined, signal, false, runtimeReady);

  if (!installerBased) await prepareVanilla(emit, signal);

  // ---- fabric / quilt：profile json 直写 ----
  if (loader === 'fabric' || loader === 'quilt') {
    const base = loader === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';
    emit({ stage: 'loader', progress: 0.1, text: t('loaders.state.fetch_profile', { loader, loaderVersion }) });
    const profile = (await fetchJson(`${base}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`, signal)) as VersionJson;
    const id = instanceName?.trim() || profile.id;
    if (!id) throw new Error(t('loaders.error.profile_missing_id', { loader }));
    // 自定义实例名：json id 同步改写，inheritsFrom 保持不变
    profile.id = id;
    profile._loader = loader;
    profile._loaderVersion = loaderVersion;
    fs.mkdirSync(versionDir(id), { recursive: true });
    fs.writeFileSync(versionJsonPath(id), JSON.stringify(profile, null, 2), 'utf-8');

    // profile 自带的依赖库也要下载
    const tasks = libraryTasks(profile);
    const mirror = getSettings().mirror;
    await downloadAll(
      tasks,
      (d, total, speed, detail) =>
        emit({
          stage: 'loader',
          progress: 0.1 + (detail.fraction ?? 0) * 0.9,
          text: t('loaders.state.deps', { loader, done: d, total }),
          speed,
          etaSeconds: detail.etaSeconds ?? undefined,
          bytesDone: detail.bytesDone,
          bytesTotal: detail.bytesTotal ?? undefined,
          indeterminate: detail.indeterminate,
        }),
      downloadLimiter.maxConcurrent,
      mirror,
      signal
    );
    emit({ stage: 'done', progress: 1, text: t('loaders.state.install_done', { id }) });
    registerVersionFolder(id, gameDir()); // fabric/quilt 实例注册到当前活动文件夹
    // 落地即拍平为自包含实例：原版内容合并进实例 json，client jar 复制进实例目录
    try {
      flattenInstance(id);
    } catch {
      /* flatten 失败保留旧式继承，不影响启动 */
    }
    return id;
  }

  // ---- forge / neoforge：下载 installer 并运行 ----
  const fileBase = loader === 'forge' ? `forge-${mcVersion}-${loaderVersion}-installer.jar` : `neoforge-${loaderVersion}-installer.jar`;
  const officialUrl =
    loader === 'forge'
      ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${loaderVersion}/${fileBase}`
      : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/${fileBase}`;

  const jarPath = path.join(os.tmpdir(), `faionyx-${loader}-installer-${Date.now()}.jar`);
  try {
    // A user-owned matching loader instance must not be renamed into a new pack.
    const reusable = instanceName?.trim() ? findInstalledDir(loader, mcVersion, loaderVersion) : null;
    let id: string;
    if (reusable && reusable !== instanceName!.trim() && !fs.existsSync(path.join(versionDir(reusable), '.installing'))) {
      await prepareVanilla(emit, signal);
      id = instanceName!.trim();
      copyRuntimeProfile(versionsDir(), reusable, id);
      registerVersionFolder(id, gameDir());
    } else {
      // Installer metadata/libraries do not depend on assets or the client jar.
      // Java waits for client/libraries and installer dependencies; asset downloads
      // continue. Every writer is drained before committing or rolling back.
      const parallel = new ParallelProgress(
        [
          { id: 'vanilla', label: t('loaders.label.vanilla_env'), weight: 0.6 },
          { id: 'installer', label: t('loaders.label.loader_download'), weight: 0.2 },
          { id: 'processor', label: t('loaders.label.generate_runtime'), weight: 0.2 },
        ],
        emit,
        t('loaders.state.parallel_prepare'),
        [0, 0.9]
      );
      parallel.waiting('processor', t('loaders.state.wait_all'));
      let resolvePrepared!: () => void, rejectPrepared!: (error: unknown) => void;
      const prepared = {
        promise: new Promise<void>((resolve, reject) => {
          resolvePrepared = resolve;
          rejectPrepared = reject;
        }),
        resolve: () => resolvePrepared(),
        reject: (error: unknown) => rejectPrepared(error),
      };
      void prepared.promise.catch(() => {}); // A sibling can fail before vanilla reaches this barrier.
      await runParallelTasks(
        [
          async (signal) => {
            await prepareVanilla(
              (e) => parallel.update('vanilla', e),
              signal,
              async (signal) => {
                parallel.waiting('processor', t('loaders.state.wait_loader_deps'));
                await prepared.promise;
                signal.throwIfAborted();
                const processorEmit: ProgressEmit = (e) => parallel.update('processor', e);
                processorEmit({ stage: 'java', progress: 0, indeterminate: true, text: t('loaders.state.check_java') });
                const javaPath = await pickJavaForInstaller(
                  mcVersion,
                  (e) => processorEmit({ ...e, progress: 0, overall: undefined, indeterminate: true }),
                  signal
                );
                // Forge/NeoForge 安装器要求目标目录存在 launcher_profiles.json，否则报错退出
                const lp = path.join(gameDir(), 'launcher_profiles.json');
                if (!fs.existsSync(lp)) {
                  fs.writeFileSync(lp, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), 'utf-8');
                }
                signal?.throwIfAborted();
                processorEmit({ stage: 'loader-process', progress: 0, indeterminate: true, text: t('loaders.state.generate_runtime') });
                await runInstaller(javaPath, jarPath, processorEmit, signal);
                processorEmit({ stage: 'loader-process', progress: 1, text: t('loaders.state.runtime_generated') });

                parallel.done('processor');
              }
            );
            parallel.done('vanilla');
          },
          async (signal) => {
            try {
              const loaderEmit: ProgressEmit = (e) => parallel.update('installer', e);
              loaderEmit({ stage: 'loader', progress: 0.2, text: t('loaders.state.download_loader_installer', { loader }) });
              const estimator = new SmoothedSpeedEstimator();
              let networkBytes = 0;
              await downloadLoaderInstaller(
                officialUrl,
                jarPath,
                getSettings().mirror,
                (d, total, wire = 0) => {
                  networkBytes += wire;
                  const rate = estimator.sample(networkBytes, total ? Math.max(0, total - d) : null, performance.now());
                  loaderEmit({
                    stage: 'loader',
                    progress: 0.2 + (total ? (d / total) * 0.4 : 0),
                    text: t('loaders.state.download_installer', { size: (d / 1024 / 1024).toFixed(1) }),
                    speed: rate.speedBps,
                    etaSeconds: rate.etaSeconds ?? undefined,
                    bytesDone: d,
                    bytesTotal: total || undefined,
                  });
                },
                signal
              );

              await prepareInstallerDependencies(jarPath, gameDir(), getSettings().mirror, loaderEmit, signal);
              parallel.done('installer');
              prepared.resolve();
            } catch (error) {
              prepared.reject(error);
              throw error;
            }
          },
        ],
        signal
      );

      const id0 = findInstalledDir(loader, mcVersion, loaderVersion);
      if (!id0) throw new Error(t('loaders.error.no_version_dir'));
      // 自定义实例名：重命名安装器生成的目录与 json id
      id = id0;
      if (instanceName?.trim() && instanceName.trim() !== id0) {
        const { renameVersion } = await import('./versions');
        renameVersion(id0, instanceName.trim());
        id = instanceName.trim();
      }
    }
    tagLoaderJson(id, loader, loaderVersion);

    // 完整性自愈：安装器可能半失败（json 已写但部分库未下载，如 client 校验失败中止）
    // 逐文件校验版本 json 声明的库，缺失则经镜像补齐；补不齐则明确报错
    emit({ stage: 'loader', progress: 0.92, text: t('loaders.state.verify_libraries') });
    const profileJson = readVersionJson(id);
    const libTasks = libraryTasks(profileJson);
    reuseExternalRuntimeLibraries(
      profileJson,
      [gameDir(), ...getSettings().folders.map((f) => f.path)],
      librariesDir(),
      libTasks.map((t) => t.dest)
    );
    const missing = libTasks.filter((t) => !fs.existsSync(t.dest));
    if (missing.length) {
      emit({ stage: 'loader', progress: 0.94, text: t('loaders.state.fill_libraries', { count: missing.length }) });
      await downloadAll(
        missing,
        (d, total, speed, detail) =>
          emit({
            stage: 'loader',
            progress: 0.94 + (detail.fraction ?? 0) * 0.05,
            text: t('loaders.state.fill_libraries_progress', { done: d, total }),
            speed,
            etaSeconds: detail.etaSeconds ?? undefined,
            bytesDone: detail.bytesDone,
            bytesTotal: detail.bytesTotal ?? undefined,
            indeterminate: detail.indeterminate,
          }),
        downloadLimiter.maxConcurrent,
        getSettings().mirror,
        signal
      );
    }
    emit({ stage: 'done', progress: 1, text: t('loaders.state.install_done', { id }) });
    registerVersionFolder(id, gameDir()); // forge/neoforge 实例注册到当前活动文件夹
    // 落地即拍平为自包含实例（此时原版 json/jar 仍在 versions/ 可直接合并复制；finally 再迁移进依赖缓存区）
    try {
      flattenInstance(id);
    } catch {
      /* flatten 失败保留旧式继承，不影响启动 */
    }
    return id;
  } finally {
    fs.rmSync(jarPath, { force: true });
    // 本次安装临时落地的原版条目迁移进依赖区（无论成败），版本列表只保留加载器实例
    if (!vanillaPreExisted) {
      try {
        migrateDependencyVanilla(mcVersion);
      } catch {
        /* 迁移失败不阻断安装结果 */
      }
    }
  }
}

// ---------------- Fabric API（Modrinth 数据源，MCIM 国内镜像回退） ----------------

const MODRINTH_BASES = ['https://api.modrinth.com/v2', 'https://mod.mcimirror.top/modrinth/v2'];
const MODRINTH_UA = { 'User-Agent': 'FAIONYX/0.4.1 (faionyx launcher)' };

interface ModrinthFile {
  url?: string;
  filename?: string;
  primary?: boolean;
  hashes?: { sha1?: string };
}
interface ModrinthVersion {
  version_number?: string;
  date_published?: string;
  files?: ModrinthFile[];
}

/** 按 mc 版本缓存查询结果，避免列表与下载两次请求 */
const fabricApiCache = new Map<string, ModrinthVersion[]>();

async function fetchFabricApiVersions(mcVersion: string, signal?: AbortSignal): Promise<ModrinthVersion[]> {
  const cached = fabricApiCache.get(mcVersion);
  if (cached) return cached;
  const gv = encodeURIComponent(JSON.stringify([mcVersion]));
  const ld = encodeURIComponent(JSON.stringify(['fabric']));
  let lastErr: unknown = null;
  for (const base of MODRINTH_BASES) {
    try {
      const res = await fetch(`${base}/project/fabric-api/version?game_versions=${gv}&loaders=${ld}`, {
        headers: MODRINTH_UA,
        signal: fetchSignal(signal),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = (await res.json()) as ModrinthVersion[];
      if (!Array.isArray(arr)) throw new Error(t('loaders.error.response_format'));
      fabricApiCache.set(mcVersion, arr);
      return arr;
    } catch (e) {
      if (signal?.aborted) throw new Error(t('loaders.error.cancelled'));
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Fabric API 可用版本列表（最新在前） */
export async function listFabricApiVersions(mcVersion: string): Promise<FabricApiVersion[]> {
  const arr = await fetchFabricApiVersions(mcVersion);
  return arr.filter((v) => !!v.version_number).map((v) => ({ version: v.version_number as string, date: v.date_published ?? '' }));
}

/** 下载指定版本 Fabric API 到 gameDir/mods */
export async function installFabricApi(
  mcVersion: string,
  version: string,
  emit: ProgressEmit,
  signal?: AbortSignal,
  /** 目标 mods 目录（隔离实例为 versions/<id>/mods）；缺省回落共享 mods */
  modsDir?: string
): Promise<void> {
  emit({ stage: 'fabric-api', progress: 0, text: t('loaders.state.fabric_api_query', { version }) });
  const arr = await fetchFabricApiVersions(mcVersion, signal);
  const v = arr.find((x) => x.version_number === version);
  const file = v?.files?.find((f) => f.primary) ?? v?.files?.[0];
  if (!file?.url || !file.filename) {
    throw new Error(t('loaders.error.fabric_api_not_found', { mcVersion, version }));
  }
  const dest = path.join(modsDir ?? path.join(gameDir(), 'mods'), file.filename);
  emit({ stage: 'fabric-api', progress: 0.2, text: t('loaders.state.fabric_api_download', { version }) });
  await downloadFile(file.url, dest, undefined, file.hashes?.sha1, 'official', signal);
  emit({ stage: 'fabric-api', progress: 1, text: t('loaders.state.fabric_api_done') });
}
