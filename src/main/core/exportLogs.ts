/** 启动失败诊断 ZIP：所有文本先脱敏，缺失项写入 manifest，不因单个日志缺失而失败。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, dialog, type BrowserWindow } from 'electron';
import { getSettings } from './settings';
import { gameDir } from './paths';
import { readVersionJson, listAllInstalled } from './versions';
import { getLastLaunch } from './launch';
import { samePath } from './folderPaths';
import { JAVA_PROBE_VM_ARGS } from './javaScanUtils';
import { exitHistory } from './exitHistory';
import { instanceDirectoryState } from './instances';
import { selectedAccount } from './accounts';
import { launcherLogPath } from './launcherLog';
import { redactDiagnosticPath, redactDiagnosticText, safeDiagnosticFilePart } from './diagnostics';
import { writeDiagnosticArchive, type DiagnosticManifestEntry, type DiagnosticSource } from './diagnosticArchive';
import { translate as t } from '../../shared/i18n';

const execFileAsync = promisify(execFile);

export interface DiagnosticManifest {
  schemaVersion: 1;
  exportedAt: string;
  launcher: { name: 'FAIONYX'; version: string };
  instance: {
    id: string;
    name: string;
    minecraftVersion: string;
    loader: string | null;
    loaderVersion: string | null;
    directory: string;
    isolated: boolean;
  };
  process: {
    pid: number | null;
    startedAt: string | null;
    endedAt: string | null;
    exitCode: number | null;
    spawnError: string | null;
    command: string | null;
  };
  java: { path: string; version: string; architecture: string };
  operatingSystem: { platform: string; release: string; architecture: string };
  files: DiagnosticManifestEntry[];
}

function fmtStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function newestCrashReport(dir: string): Promise<string | null> {
  try {
    const root = path.join(dir, 'crash-reports');
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /\.(?:txt|log)$/i.test(entry.name))
        .map(async (entry) => {
          const file = path.join(root, entry.name);
          return { file, mtime: (await fs.promises.stat(file)).mtimeMs };
        })
    );
    return files.sort((a, b) => b.mtime - a.mtime)[0]?.file ?? null;
  } catch {
    return null;
  }
}

async function javaSummary(javaPath: string): Promise<{ path: string; version: string; architecture: string }> {
  const unknown = {
    path: redactDiagnosticPath(javaPath),
    version: t('exportlogs.label.unknown'),
    architecture: t('exportlogs.label.unknown'),
  };
  if (!javaPath) return unknown;
  try {
    const result = await execFileAsync(javaPath, [...JAVA_PROBE_VM_ARGS, '-version'], {
      encoding: 'utf-8',
      timeout: 8_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
    const version = /version\s+"([^"]+)"/i.exec(output)?.[1] ?? output.split(/\r?\n/)[0]?.trim() ?? t('exportlogs.label.unknown');
    const architecture = /64-Bit|x86_64|aarch64/i.test(output)
      ? '64-bit'
      : /32-Bit|i[3-6]86|x86/i.test(output)
        ? '32-bit'
        : t('exportlogs.label.unknown');
    return { path: redactDiagnosticPath(javaPath), version, architecture };
  } catch (error) {
    return {
      ...unknown,
      version: t('exportlogs.error.java_probe_failed', {
        message: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
      }),
    };
  }
}

function summaryText(manifest: DiagnosticManifest): string {
  const m = manifest;
  return [
    t('exportlogs.summary.header'),
    t('exportlogs.summary.exported_at', { value: m.exportedAt }),
    t('exportlogs.summary.launcher', { version: m.launcher.version }),
    t('exportlogs.summary.os', {
      platform: m.operatingSystem.platform,
      release: m.operatingSystem.release,
      architecture: m.operatingSystem.architecture,
    }),
    '',
    t('exportlogs.summary.instance', { name: m.instance.name, id: m.instance.id }),
    t('exportlogs.summary.minecraft', { version: m.instance.minecraftVersion }),
    t('exportlogs.summary.loader', {
      loader: m.instance.loader ?? 'vanilla',
      loaderVersion: m.instance.loaderVersion ? ` ${m.instance.loaderVersion}` : '',
    }),
    t('exportlogs.summary.instance_dir', { value: m.instance.directory }),
    t('exportlogs.summary.isolation', { state: m.instance.isolated ? t('exportlogs.label.on') : t('exportlogs.label.off') }),
    '',
    t('exportlogs.summary.java', { version: m.java.version, architecture: m.java.architecture }),
    t('exportlogs.summary.java_path', { value: m.java.path }),
    t('exportlogs.summary.pid', { value: m.process.pid ?? t('exportlogs.label.unknown') }),
    t('exportlogs.summary.started_at', { value: m.process.startedAt ?? t('exportlogs.label.unknown') }),
    t('exportlogs.summary.ended_at', { value: m.process.endedAt ?? t('exportlogs.label.unknown') }),
    t('exportlogs.summary.exit_code', { value: m.process.exitCode ?? t('exportlogs.label.unknown') }),
    t('exportlogs.summary.spawn_error', { value: m.process.spawnError ?? t('exportlogs.label.no_record') }),
    t('exportlogs.summary.command', { value: m.process.command ?? t('exportlogs.label.not_generated') }),
    '',
    t('exportlogs.summary.manifest_note'),
  ].join('\n');
}

/** 弹原生保存对话框并异步生成 ZIP；取消保存返回 null。 */
export async function exportLaunchLogs(win: BrowserWindow | null, versionId: string): Promise<string | null> {
  // 扫描会同时建立“版本 -> 游戏文件夹”映射，避免活动目录切换后收错实例日志。
  let installed: ReturnType<typeof listAllInstalled> = [];
  try {
    installed = listAllInstalled();
  } catch {
    // 单个来源缺失不阻断导出。
  }
  const last = getLastLaunch();
  const vid = versionId || last?.versionId || 'unknown';
  const item = installed.find((value) => value.id === vid && samePath(value.folder, gameDir()));
  const folder = item?.folder || gameDir();
  let directoryState = item
    ? {
        path: item.gameDirectory || folder,
        isolated: item.isolated === true,
      }
    : { path: folder, isolated: false };
  try {
    directoryState = instanceDirectoryState(vid, readVersionJson(vid));
  } catch {
    // 版本 JSON 缺失时使用已扫描出的目录信息。
  }
  const effectiveGameDir = last?.versionId === vid && last.effectiveGameDir ? last.effectiveGameDir : directoryState.path;
  const isolated = directoryState.isolated;
  const now = new Date();
  const defName = `FAIONYX-Diagnostic-${safeDiagnosticFilePart(item?.mcVersion || vid)}-${fmtStamp(now)}.zip`;
  const opts = {
    title: t('exportlogs.dialog.title'),
    defaultPath: defName,
    filters: [{ name: t('exportlogs.dialog.zip_filter'), extensions: ['zip'] }],
  };
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return null;

  const account = selectedAccount();
  const secrets = [
    account?.accessToken ?? '',
    account?.refreshToken ?? '',
    account?.clientToken ?? '',
    account?.loginIdentifier ?? '',
  ].filter(Boolean);
  const currentLaunch =
    last?.versionId === vid && last.effectiveGameDir && samePath(last.effectiveGameDir, effectiveGameDir)
      ? last
      : (exitHistory()
          .list()
          .find(
            (e) =>
              e.kind === 'game' &&
              e.context?.versionId === vid &&
              e.context?.effectiveGameDir &&
              samePath(String(e.context.effectiveGameDir), effectiveGameDir)
          )?.context as unknown as typeof last);
  const manifest: DiagnosticManifest = {
    schemaVersion: 1,
    exportedAt: now.toISOString(),
    launcher: { name: 'FAIONYX', version: app.getVersion() },
    instance: {
      id: vid,
      name: item?.modpackName || vid,
      minecraftVersion: item?.mcVersion || t('exportlogs.label.unknown'),
      loader: item?.loader ?? null,
      loaderVersion: item?.loaderVersion ?? null,
      directory: redactDiagnosticPath(effectiveGameDir),
      isolated,
    },
    process: {
      pid: currentLaunch?.pid ?? null,
      startedAt: currentLaunch?.startedAt ?? null,
      endedAt: currentLaunch?.endedAt ?? null,
      exitCode: currentLaunch?.exitCode ?? null,
      spawnError: currentLaunch?.spawnError ? redactDiagnosticText(currentLaunch.spawnError, secrets) : null,
      command: currentLaunch?.commandSummary ? redactDiagnosticText(currentLaunch.commandSummary, secrets) : null,
    },
    java: await javaSummary(currentLaunch?.javaPath ?? item?.javaPath ?? getSettings().javaPath),
    operatingSystem: {
      platform: `${os.type()} ${os.version()}`,
      release: os.release(),
      architecture: os.arch(),
    },
    files: [],
  };

  const crash = await newestCrashReport(effectiveGameDir);
  const launchLogDir = currentLaunch?.logDir || path.join(folder, 'faionyx-logs');
  const sources: DiagnosticSource[] = [
    {
      archivePath: crash ? `crash-reports/${path.basename(crash)}` : 'crash-reports/latest.txt',
      source: crash || path.join(effectiveGameDir, 'crash-reports'),
      missingPlaceholder: !crash,
    },
    {
      archivePath: 'minecraft/latest.log',
      source: path.join(effectiveGameDir, 'logs', 'latest.log'),
      missingPlaceholder: true,
    },
    {
      archivePath: 'minecraft/debug.log',
      source: path.join(effectiveGameDir, 'logs', 'debug.log'),
      missingPlaceholder: true,
    },
    {
      archivePath: 'launcher/launcher-current.log',
      source: launcherLogPath(),
      missingPlaceholder: true,
    },
    {
      archivePath: 'launcher/launch-combined.log',
      source: path.join(launchLogDir, 'latest.log'),
      missingPlaceholder: true,
    },
    {
      archivePath: 'process/stdout.log',
      source: path.join(launchLogDir, 'stdout.log'),
      missingPlaceholder: true,
    },
    {
      archivePath: 'process/stderr.log',
      source: path.join(launchLogDir, 'stderr.log'),
      missingPlaceholder: true,
    },
  ];
  // 历史会话归档一并带上（最多 3 份）；缺失时 manifest 只记 missing，不影响导出
  const logsDir = path.dirname(launcherLogPath());
  let archives: string[] = [];
  try {
    archives = fs
      .readdirSync(logsDir)
      .filter((name) => /^launcher-\d{8}-\d{6}.*\.log$/.test(name))
      .sort()
      .reverse()
      .slice(0, 3);
  } catch {
    /* 日志目录不可读时跳过归档 */
  }
  for (const name of archives) {
    sources.push({ archivePath: `launcher/${name}`, source: path.join(logsDir, name) });
  }
  try {
    await writeDiagnosticArchive(result.filePath, manifest, sources, summaryText(manifest), secrets);
    return result.filePath;
  } catch (error) {
    throw new Error(t('exportlogs.error.write_failed', { message: error instanceof Error ? error.message : String(error) }));
  }
}
