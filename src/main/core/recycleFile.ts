import fs from 'node:fs/promises';
import path from 'node:path';
import { translate as t } from '../../shared/i18n';

/** Recycle one direct child. A failed native operation must never fall back to permanent deletion. */
export async function recycleFile(directory: string, name: string, trash?: (target: string) => Promise<void>): Promise<void> {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
    throw new Error(t('recyclefile.error.invalid_name'));
  }
  const parent = path.resolve(directory),
    target = path.resolve(parent, name);
  if (path.dirname(target) !== parent) throw new Error(t('recyclefile.error.path_escape'));
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error(t('recyclefile.error.resource_dir_link'));
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error(t('recyclefile.error.file_link'));
  const realParent = await fs.realpath(parent);
  const realTarget = await fs.realpath(target);
  if (path.dirname(realTarget) !== realParent) throw new Error(t('recyclefile.error.real_path_escape'));
  const current = await fs.lstat(target);
  if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev) throw new Error(t('recyclefile.error.changed'));
  try {
    if (trash) await trash(realTarget);
    else await (await import('electron')).shell.trashItem(realTarget);
    try {
      await fs.lstat(realTarget);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    throw new Error(t('recyclefile.error.not_removed'));
  } catch (error) {
    throw new Error(
      t('recyclefile.error.trash_failed', {
        name,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
}
