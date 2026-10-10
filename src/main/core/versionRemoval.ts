import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileJob } from './fileJobs';
import { translate as t } from '../../shared/i18n';

/** Use the native recycle operation instead of deleting children before discovering a locked parent. */
export async function recycleVersion(
  folder: string,
  id: string,
  deps: {
    assertIdle(directory: string): Promise<void>;
    trash(directory: string): Promise<void>;
  }
): Promise<void> {
  if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(id) || /[. ]$/.test(id)) {
    throw new Error(t('versionremoval.error.invalid_name'));
  }
  const parent = path.resolve(folder, 'versions'),
    target = path.resolve(parent, id);
  if (path.dirname(target) !== parent) throw new Error(t('versionremoval.error.path_outside'));
  return withFileJob(target, undefined, async () => {
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(t('versionremoval.error.dir_link'));
    if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error(t('versionremoval.error.versions_link'));
    await deps.assertIdle(target);
    // Recheck after asynchronous process inspection; no traversal into child links.
    const current = await fs.lstat(target);
    if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev)
      throw new Error(t('versionremoval.error.changed'));
    try {
      await deps.trash(target);
      try {
        await fs.lstat(target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw e;
      }
      throw new Error(t('versionremoval.error.not_removed'));
    } catch (error) {
      throw new Error(
        t('versionremoval.error.trash_failed', {
          target,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  });
}
