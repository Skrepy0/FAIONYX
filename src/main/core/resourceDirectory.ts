import fs from 'node:fs';
import path from 'node:path';
import type { FsEntry } from '../../shared/types';
import type { VersionJson } from './versions';
import { instanceDirectoryState } from './instances';
import { logScope } from './launcherLog';
import { translate as t } from '../../shared/i18n';

export const SELECT_RESOURCE_VERSION = '请先安装或选择一个游戏版本';
export function requireResourceVersion(id: string): void {
  if (!id?.trim()) throw new Error(SELECT_RESOURCE_VERSION);
  if (id === '.' || id === '..' || /[\\/:\0]/.test(id)) throw new Error(t('resourcedir.error.invalid_version_name'));
}

/** Read exactly one selected instance; never enumerate other roots or fall back to a shared directory. */
export async function resolveResourceDirectory(folder: string, id: string, kind: string): Promise<string> {
  requireResourceVersion(id);
  if (!folder || !['mods', 'resourcepacks', 'shaderpacks'].includes(kind)) throw new Error(t('resourcedir.error.invalid_kind'));
  let json: VersionJson;
  try {
    json = JSON.parse((await fs.promises.readFile(path.join(folder, 'versions', id, `${id}.json`), 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(t('resourcedir.error.version_removed'));
  }
  const gameDirectory = instanceDirectoryState(id, json, folder).path;
  const dir = path.join(gameDirectory, kind);
  // Junctions/symlinks must not turn a single resource page into a view of another disk or directory.
  try {
    const [base, target] = await Promise.all([fs.promises.realpath(gameDirectory), fs.promises.realpath(dir)]);
    const rel = path.relative(base, target);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel) throw new Error(t('resourcedir.error.link_outside'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return dir;
}

/** Non-recursive, bounded asynchronous metadata reads. Rendering is paged separately. */
export async function listResourceEntries(dir: string): Promise<FsEntry[]> {
  const start = performance.now();
  let names: fs.Dirent[];
  try {
    names = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(t('resourcedir.error.unreadable'));
  }
  const entries: FsEntry[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, names.length) }, async () => {
      while (index < names.length) {
        const name = names[index++];
        if (name.isSymbolicLink()) continue;
        try {
          const stat = await fs.promises.lstat(path.join(dir, name.name));
          if (stat.isSymbolicLink()) continue;
          entries.push({ name: name.name, size: stat.size, isDir: stat.isDirectory(), mtime: stat.mtimeMs });
        } catch {
          /* A file may be removed while listing. */
        }
      }
    })
  );
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  logScope('resources').info(t('resourcedir.log.read', { dir, count: entries.length, ms: Math.round(performance.now() - start) }));
  return entries;
}
