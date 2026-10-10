import { ipcMain, dialog, shell, type BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { IPC, IPC_EVENT, type ProgressEvent } from '../../shared/types';
import type { InstanceTarget, InstanceOperation } from '../../shared/instanceCenter';
import * as center from './instanceCenter';
import { instanceBackups } from './changeProtection';
import { safePath, exportTreeZip, type BackupProgress } from './backupStore';
import { diagnoseInstance, repairInstanceFiles } from './instanceDiagnostics';
import { registerTask, finishTask, isCancelError, waitIfTaskPaused } from './tasks';
import { planMissingDependencies, applyMissingDependencies } from './modManagement';
import { translate as t } from '../../shared/i18n';
export function registerInstanceCenterIpc(getWin: () => BrowserWindow | null) {
  const send = (event: string, payload: unknown) => getWin()?.webContents.send(event, payload);
  async function task<T>(title: string, action: (signal: AbortSignal, progress: BackupProgress) => Promise<T>): Promise<T> {
    const job = registerTask(title, 'world');
    const progress: BackupProgress = (done, total, text) =>
      send(IPC_EVENT.progress, {
        taskId: job.id,
        taskTitle: job.title,
        stage: 'world',
        progress: total ? done / total : 0,
        text,
      } satisfies ProgressEvent);
    progress(0, 1, t('instcipc.state.preparing'));
    try {
      const result = await action(job.controller.signal, progress);
      send(IPC_EVENT.taskDone, { taskId: job.id, ok: true });
      return result;
    } catch (e) {
      send(IPC_EVENT.taskDone, { taskId: job.id, ok: false, cancelled: isCancelError(e), error: String(e) });
      throw e;
    } finally {
      finishTask(job.id);
    }
  }
  ipcMain.handle(IPC.centerOverview, (_e, target: InstanceTarget) => center.centerOverview(target));
  ipcMain.handle(IPC.centerWorlds, (_e, target: InstanceTarget) => center.centerWorlds(target));
  ipcMain.handle(IPC.centerScreenshots, (_e, target: InstanceTarget, page: number) => center.centerScreenshots(target, page));
  ipcMain.handle(IPC.centerBackups, (_e, target: InstanceTarget) => instanceBackups(center.centerTarget(target).dir).list());
  ipcMain.handle(IPC.centerDiagnose, (_e, target: InstanceTarget) =>
    task(t('instcipc.label.check_env'), (signal, progress) => diagnoseInstance(target, signal, progress))
  );
  ipcMain.handle('center:dependencyPlan', (_e, target: InstanceTarget, name: string) => {
    const c = center.centerTarget(target);
    return planMissingDependencies(c.target.id, c.folder, name);
  });
  ipcMain.handle('center:dependencyApply', (_e, id: string, confirmed: boolean) =>
    task(t('instcipc.label.add_dependencies'), (signal, progress) =>
      applyMissingDependencies(id, confirmed === true, signal, (done) => progress(done, 1, t('instcipc.state.downloading_deps')))
    )
  );
  ipcMain.handle(IPC.centerOperation, async (_e, o: InstanceOperation & { planId?: string }) => {
    const c = center.centerTarget(o.target);
    switch (o.kind) {
      case 'backup':
        return task(o.world ? t('instcipc.label.backup_world') : t('instcipc.label.backup_instance'), (s, p) =>
          center.backupInstance(
            c.target,
            o.world ? t('instcipc.label.world_manual_backup') : t('instc.label.manual_backup'),
            false,
            o.world,
            s,
            p
          )
        );
      case 'clone':
        return task(t('instcipc.label.clone_instance'), (s, p) =>
          center.cloneInstance(c.target, o.name || '', o.destinationFolder || c.folder, o.saves !== false, o.screenshots === true, s, p)
        );
      case 'restore': {
        if (!o.backupId) throw new Error(t('instcipc.error.choose_backup'));
        const m = await instanceBackups(c.dir).read(o.backupId);
        if (m.metadata?.type === 'world')
          return task(t('instcipc.label.restore_world'), (s, p) =>
            center.restoreWorld(c.target, o.backupId!, o.name || '', o.overwrite === true, s, p)
          );
        if (o.overwrite)
          return task(t('instcipc.label.overwrite_restore_instance'), (s, p) => center.restoreInstanceInPlace(c.target, o.backupId!, s, p));
        return task(t('instcipc.label.restore_instance'), (s, p) =>
          center.cloneInstance(c.target, o.name || '', o.destinationFolder || c.folder, true, true, s, p, o.backupId)
        );
      }
      case 'repair':
        return task(t('instcipc.label.repair_files'), (s, p) => repairInstanceFiles(o.planId || '', s, p));
      case 'worldExport': {
        center.validateInstanceName(o.world || '');
        await center.assertInstanceIdle(c.dir);
        const source = await safePath(c.dir, 'saves/' + o.world),
          picked = await dialog.showSaveDialog({
            title: t('instcipc.label.export_world'),
            defaultPath: o.world + '.zip',
            filters: [{ name: 'ZIP', extensions: ['zip'] }],
          });
        if (picked.canceled || !picked.filePath) return null;
        if (fs.existsSync(picked.filePath)) throw new Error(t('instcipc.error.export_exists'));
        return task(t('instcipc.label.export_world'), async (s) => {
          await center.assertInstanceIdle(c.dir);
          await exportTreeZip(source, picked.filePath!, s);
          return picked.filePath;
        });
      }
      default:
        throw new Error(t('instcipc.error.unknown_operation'));
    }
  });
  ipcMain.handle(
    IPC.centerFile,
    async (_e, target: InstanceTarget, kind: 'world' | 'screenshot' | 'preview' | 'directory', id: string, save = false) => {
      const c = center.centerTarget(target);
      let file = c.dir;
      if (kind === 'world') {
        center.validateInstanceName(id);
        file = await safePath(c.dir, 'saves/' + id);
      } else if (kind === 'screenshot' || kind === 'preview') {
        center.validateInstanceName(id);
        if (!/\.png$/i.test(id)) throw new Error(t('instcipc.error.png_only'));
        file = await safePath(c.dir, 'screenshots/' + id);
      } else if (kind !== 'directory') throw new Error(t('instcipc.error.unknown_file_kind'));
      if (kind === 'preview') {
        if ((await fs.promises.stat(file)).size > 64 * 1024 * 1024) throw new Error(t('instcipc.error.screenshot_too_large'));
        return 'data:image/png;base64,' + (await fs.promises.readFile(file)).toString('base64');
      }
      if (save && kind === 'screenshot') {
        const out = await dialog.showSaveDialog({ defaultPath: id, filters: [{ name: 'PNG', extensions: ['png'] }] });
        if (!out.canceled && out.filePath) await fs.promises.copyFile(file, out.filePath, fs.constants.COPYFILE_EXCL);
      } else {
        const error = await shell.openPath(kind === 'screenshot' ? path.dirname(file) : file);
        if (error) throw new Error(error);
      }
    }
  );
}
