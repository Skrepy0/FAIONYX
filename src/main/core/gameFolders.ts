import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FolderScanResult, GameFolder } from '../../shared/types';
import { getSettings, saveSettings } from './settings';
import { canonicalPath, pathIdentity, resolveMinecraftRoot } from './folderPaths';
import { scanInstalledFolder } from './versions';
import { logScope } from './launcherLog';
import { defaultGameFolder } from './defaultGameFolder';
import { translate as t } from '../../shared/i18n';

const folderLog = logScope('folders');

const cleanName = (value: string): string => {
  const name = value.trim();
  if (!name) throw new Error(t('gamefolders.error.name_empty'));
  if (name.length > 64) throw new Error(t('gamefolders.error.name_too_long'));
  return name;
};

function normalizedFolders(): GameFolder[] {
  const current = getSettings().folders;
  const seen = new Set<string>();
  const result: GameFolder[] = [];
  for (const folder of current) {
    const resolved = canonicalPath(folder.path);
    const identity = pathIdentity(resolved);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({ ...folder, path: resolved });
  }
  if (result.length && !result.some((folder) => folder.isDefault)) result[0].isDefault = true;
  if (result.filter((folder) => folder.isDefault).length > 1) {
    let found = false;
    for (const folder of result) {
      if (folder.isDefault && !found) found = true;
      else folder.isDefault = false;
    }
  }
  return result;
}

function persistFolders(folders: GameFolder[], active?: string): GameFolder[] {
  const current = getSettings();
  const activeFolder = active ?? current.activeFolder;
  const selected = folders.find((folder) => pathIdentity(folder.path) === pathIdentity(activeFolder));
  const fallback = folders.find((folder) => folder.isDefault) ?? folders[0];
  saveSettings({
    folders,
    activeFolder: selected?.path ?? fallback.path,
    gameDir: selected?.path ?? fallback.path,
  });
  return folders;
}

export function listGameFolders(): { folders: GameFolder[]; active: string } {
  const current = getSettings();
  const folders = normalizedFolders();
  const selected = folders.find((folder) => pathIdentity(folder.path) === pathIdentity(current.activeFolder));
  const active = selected?.path ?? folders.find((folder) => folder.isDefault)?.path ?? folders[0].path;
  const changed =
    folders.length !== current.folders.length ||
    active !== current.activeFolder ||
    folders.some(
      (folder, index) =>
        folder.path !== current.folders[index]?.path ||
        folder.name !== current.folders[index]?.name ||
        folder.isDefault !== current.folders[index]?.isDefault
    );
  if (changed) persistFolders(folders, active);
  return { folders, active };
}

export function addGameFolder(input: string): { folders: GameFolder[]; folder: GameFolder; structure: FolderScanResult['structure'] } {
  const resolved = resolveMinecraftRoot(input);
  const current = listGameFolders();
  const duplicate = current.folders.find((folder) => pathIdentity(folder.path) === pathIdentity(resolved.path));
  if (duplicate) {
    folderLog.info(t('gamefolders.log.reuse', { path: duplicate.path, structure: String(resolved.structure) }));
    return { folders: current.folders, folder: duplicate, structure: resolved.structure };
  }
  const folder: GameFolder = {
    path: resolved.path,
    name: path.basename(resolved.path) || resolved.path,
    isDefault: false,
  };
  folderLog.info(t('gamefolders.log.register', { path: folder.path, structure: String(resolved.structure) }));
  return {
    folders: persistFolders([...current.folders, folder]),
    folder,
    structure: resolved.structure,
  };
}

export function renameGameFolder(input: string, displayName: string): GameFolder[] {
  const identity = pathIdentity(input);
  const name = cleanName(displayName);
  const current = listGameFolders();
  if (!current.folders.some((folder) => pathIdentity(folder.path) === identity)) {
    throw new Error(t('ipc.error.folder_unregistered'));
  }
  return persistFolders(
    current.folders.map((folder) => (pathIdentity(folder.path) === identity ? { ...folder, name } : folder)),
    current.active
  );
}

/** 只解除登记，不删除磁盘中的任何文件。 */
export function removeGameFolder(input: string): GameFolder[] {
  const identity = pathIdentity(input);
  const current = listGameFolders();
  const target = current.folders.find((folder) => pathIdentity(folder.path) === identity);
  if (!target) throw new Error(t('ipc.error.folder_unregistered'));
  folderLog.info(t('gamefolders.log.unregister', { path: target.path }));
  let folders = current.folders.filter((folder) => pathIdentity(folder.path) !== identity);
  // 失效/最后一个文件夹也允许解除绑定：移除后自动补回内置默认文件夹，不留死锁
  if (!folders.length) {
    const { app } = require('electron');
    const fallback = defaultGameFolder(app.getPath('appData'));
    fs.mkdirSync(fallback, { recursive: true });
    folders = [{ path: fallback, name: t('gamefolders.label.default_folder'), isDefault: true }];
    folderLog.info(t('gamefolders.log.rebuilt_default', { path: fallback }));
  }
  if (target.isDefault) folders[0] = { ...folders[0], isDefault: true };
  const nextActive =
    pathIdentity(current.active) === identity ? (folders.find((folder) => folder.isDefault) ?? folders[0]).path : current.active;
  return persistFolders(folders, nextActive);
}

export function setDefaultGameFolder(input: string): GameFolder[] {
  const identity = pathIdentity(input);
  const current = listGameFolders();
  const selected = current.folders.find((folder) => pathIdentity(folder.path) === identity);
  if (!selected) {
    throw new Error(t('ipc.error.folder_unregistered'));
  }
  assertWritableDownloadFolder(selected.path);
  return persistFolders(
    current.folders.map((folder) => ({
      ...folder,
      isDefault: pathIdentity(folder.path) === identity,
    })),
    selected.path
  );
}

function assertWritableDownloadFolder(folder: string): void {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(t('gamefolders.error.folder_missing'));
  const probe = path.join(folder, `.faionyx-write-test-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' });
    fs.unlinkSync(probe);
  } catch (error) {
    if (fs.existsSync(probe)) {
      try {
        fs.unlinkSync(probe);
      } catch {
        /* Preserve the write error. */
      }
    }
    throw new Error(t('gamefolders.error.folder_not_writable', { error: error instanceof Error ? error.message : String(error) }));
  }
}

/** Register and select the new download root in one settings commit; existing roots remain registered. */
export function setDownloadGameFolder(input: string): GameFolder[] {
  const resolved = resolveMinecraftRoot(input);
  assertWritableDownloadFolder(resolved.path);
  const current = listGameFolders();
  const identity = pathIdentity(resolved.path);
  const registered = current.folders.some((folder) => pathIdentity(folder.path) === identity);
  const folders = registered
    ? current.folders
    : [
        ...current.folders,
        {
          path: resolved.path,
          name: path.basename(resolved.path) || resolved.path,
          isDefault: false,
        },
      ];
  return persistFolders(
    folders.map((folder) => ({ ...folder, isDefault: pathIdentity(folder.path) === identity })),
    resolved.path
  );
}

export function setActiveGameFolder(input: string): string {
  const identity = pathIdentity(input);
  const current = listGameFolders();
  const folder = current.folders.find((value) => pathIdentity(value.path) === identity);
  if (!folder) throw new Error(t('ipc.error.folder_unregistered'));
  if (!fs.existsSync(folder.path)) throw new Error(t('gamefolders.error.folder_gone'));
  persistFolders(current.folders, folder.path);
  return folder.path;
}

export function scanGameFolder(input: string): FolderScanResult {
  const started = Date.now();
  const current = listGameFolders();
  const identity = pathIdentity(input);
  const folder = current.folders.find((value) => pathIdentity(value.path) === identity);
  if (!folder) throw new Error(t('ipc.error.folder_unregistered'));
  if (!fs.existsSync(folder.path)) {
    folderLog.warn(t('gamefolders.log.scan_missing', { path: folder.path }));
    return {
      folder,
      structure: 'missing',
      status: 'error',
      versions: [],
      errors: [t('gamefolders.error.folder_unavailable')],
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  }
  const structure = fs.existsSync(path.join(folder.path, '.faionyx'))
    ? 'faionyx'
    : fs.existsSync(path.join(folder.path, 'versions'))
      ? 'minecraft'
      : 'empty';
  const scanned = scanInstalledFolder(folder.path);
  if (scanned.errors.length) {
    folderLog.warn(
      t('gamefolders.log.scan_warnings', {
        path: folder.path,
        structure: String(structure),
        versions: scanned.versions.length,
        warnings: scanned.errors.length,
        ms: Date.now() - started,
      }),
      new Error(scanned.errors.join('；'))
    );
  } else {
    folderLog.info(
      t('gamefolders.log.scan_done', {
        path: folder.path,
        structure: String(structure),
        versions: scanned.versions.length,
        ms: Date.now() - started,
      })
    );
  }
  return {
    folder,
    structure,
    status: scanned.errors.length ? 'warning' : 'ready',
    versions: scanned.versions,
    errors: scanned.errors,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}
