import { app, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InstallOptions } from '../../shared/types';
import { IPC_EVENT } from '../../shared/types';
import type { InstanceTarget } from '../../shared/instanceCenter';
import type { SupplementalFailure } from '../../shared/supplementalMods';
import { centerTarget, assertInstanceIdle } from './instanceCenter';
import { prepareInstallMods, favoriteInstallResult } from './modFavorites';
import { installRecordingMods } from './recordingMods';
import { registerTask, finishTask } from './tasks';
import { resolveInstanceMetadata } from './instanceMetadata';
import { readVersionJson } from './versions';
import { withGameFolder } from './paths';
import { translate as t } from '../../shared/i18n';
interface Stored extends SupplementalFailure {
  options: InstallOptions;
}
let publish: (list: SupplementalFailure[]) => void = () => {};
const running = new Set<string>();
const file = () => path.join(app.getPath('userData'), 'supplemental-mod-retries.json');
function rows(): Stored[] {
  try {
    const value = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!Array.isArray(value) || value.length > 100) throw Error('format');
    return value.filter(
      (v) =>
        v &&
        typeof v.id === 'string' &&
        typeof v.target?.folder === 'string' &&
        typeof v.target?.id === 'string' &&
        typeof v.versionId === 'string' &&
        v.options &&
        typeof v.options === 'object'
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw Error(t('supplemental.error.unreadable'));
  }
}
const visible = (list: Stored[]) => list.map(({ options, ...v }) => v);
function save(list: Stored[]) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const temp = file() + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(list));
    fs.renameSync(temp, file());
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
  publish(visible(list));
  return visible(list);
}
export function recordSupplementalFailure(target: InstanceTarget, versionId: string, options: InstallOptions, error: unknown) {
  return save([
    ...rows().filter((r) => r.target.id !== target.id || r.target.folder !== target.folder),
    { id: randomUUID(), target, versionId, options, message: error instanceof Error ? error.message : String(error) },
  ]);
}
export function registerSupplementalModsIpc(getWin: () => BrowserWindow | null) {
  publish = (list) => getWin()?.webContents.send('mods:supplementalPending', list);
  ipcMain.handle('mods:supplementalList', () => visible(rows()));
  ipcMain.handle('mods:supplementalKeep', (_e, id: string) => {
    if (running.has(id)) throw Error(t('supplemental.error.retrying_wait'));
    return save(rows().filter((r) => r.id !== id));
  });
  ipcMain.handle('mods:supplementalRetry', async (_e, id: string, withResult?: boolean) => {
    const entry = rows().find((r) => r.id === id);
    if (!entry) throw Error(t('supplemental.error.expired'));
    if (running.has(id)) throw Error(t('supplemental.error.already_retrying'));
    running.add(id);
    const task = registerTask(t('supplemental.task.retry', { id: entry.target.id }), 'download');
    let ok = false;
    try {
      const current = centerTarget(entry.target);
      await assertInstanceIdle(current.dir);
      const metadata = withGameFolder(current.folder, () => resolveInstanceMetadata(current.json, readVersionJson));
      if (metadata.broken || metadata.mcVersion !== entry.versionId || metadata.loader !== entry.options.loader)
        throw Error(t('supplemental.error.version_changed'));
      const files = await prepareInstallMods(entry.versionId, entry.options, task.controller.signal);
      await installRecordingMods(path.join(current.dir, 'mods'), files, task.controller.signal, (progress) =>
        getWin()?.webContents.send(IPC_EVENT.progress, {
          taskId: task.id,
          taskTitle: task.title,
          stage: 'download',
          progress,
          text: t('supplemental.state.download_verify'),
        })
      );
      const result = await favoriteInstallResult(
        entry.options,
        files,
        path.join(current.dir, 'mods'),
        current.folder,
        current.target.id,
        task.controller.signal
      );
      ok = true;
      const pending = save(rows().filter((r) => r.id !== id));
      return withResult === true ? { pending, result } : pending;
    } catch (e) {
      save(rows().map((r) => (r.id === id ? { ...r, message: e instanceof Error ? e.message : String(e) } : r)));
      throw e;
    } finally {
      running.delete(id);
      getWin()?.webContents.send(IPC_EVENT.taskDone, { taskId: task.id, ok, cancelled: task.controller.signal.aborted });
      finishTask(task.id);
    }
  });
}
