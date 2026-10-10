import { translate as t } from '../../shared/i18n';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import { IPC_EVENT } from '../../shared/types';
import type { ProjectionAnalysis, ProjectionChoices, ProjectionFormat } from '../../shared/projections';
import { registerTask, finishTask } from './tasks';
import { withFileJob } from './fileJobs';
import { projectionVersions } from './projectionConversion';
export function runProjectionWorker<T = any>(
  data: Record<string, unknown>,
  signal?: AbortSignal,
  progress?: (fraction: number, text: string) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(path.join(__dirname, 'projectionWorker.cjs'), {
      workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      void worker.terminate();
      error ? reject(error) : resolve(result!);
    };
    const cancel = () => finish(new Error(t('projjobs.error.task_cancelled_kept'))),
      timer = setTimeout(() => finish(new Error(t('projjobs.error.parse_timeout'))), 120000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.on('message', (message) => {
      if (settled) return;
      if (message.progress !== undefined) progress?.(message.progress, message.text);
      else if (message.error) finish(new Error(message.error));
      else finish(undefined, message.result);
    });
    worker.once('error', (e) => finish(e));
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(t('projjobs.error.worker_exited_early', { code: String(code ?? '') })));
    });
  });
}
export function registerProjectionConversion(
  getWin: () => BrowserWindow | null,
  resolveSource: (id: string) => Promise<{ file: string; format: ProjectionFormat }>
) {
  const analyses = new Map<string, { view: ProjectionAnalysis; sourceId: string; file: string; time: number }>();
  const task = async <T>(title: string, run: (signal: AbortSignal, progress: (fraction: number, text: string) => void) => Promise<T>) => {
    const job = registerTask(title, 'world');
    let ok = false;
    try {
      const result = await run(job.controller.signal, (fraction, text) =>
        getWin()?.webContents.send(IPC_EVENT.progress, { taskId: job.id, taskTitle: title, stage: 'world', progress: fraction, text })
      );
      ok = true;
      return result;
    } finally {
      getWin()?.webContents.send(IPC_EVENT.taskDone, { taskId: job.id, ok, cancelled: job.controller.signal.aborted });
      finishTask(job.id);
    }
  };
  ipcMain.handle('projections:versions', () => projectionVersions());
  ipcMain.handle('projections:analyze', async (_e, id: string, format: ProjectionFormat, version?: string) => {
    for (const [id, a] of analyses) if (Date.now() - a.time > 1800000) analyses.delete(id);
    if (analyses.size >= 16) throw new Error(t('projjobs.error.too_many_pending'));
    const source = await resolveSource(id),
      data = await task(t('projjobs.task.analyze'), (signal, progress) =>
        runProjectionWorker<Omit<ProjectionAnalysis, 'id'>>(
          { file: source.file, sourceFormat: source.format, action: 'analyze', format, version },
          signal,
          progress
        )
      ),
      view = { ...data, id: crypto.randomUUID() };
    analyses.set(view.id, { view, sourceId: id, file: source.file, time: Date.now() });
    return view;
  });
  ipcMain.handle('projections:discardAnalysis', (_e, id: string) => {
    analyses.delete(id);
  });
  ipcMain.handle('projections:convert', async (_e, id: string, choices: ProjectionChoices) => {
    const a = analyses.get(id);
    if (!a || Date.now() - a.time > 1800000) throw new Error(t('projjobs.error.analysis_expired'));
    if (!choices || typeof choices !== 'object' || JSON.stringify(choices).length > 1000000)
      throw new Error(t('projjobs.error.invalid_choices'));
    const current = await resolveSource(a.sourceId);
    if (current.file !== a.file || current.format !== a.view.sourceFormat) throw new Error(t('projjobs.error.source_changed'));
    return task(t('projjobs.task.convert'), async (signal, progress) => {
      const bytes = Buffer.from(
        await runProjectionWorker<Uint8Array>(
          {
            file: a.file,
            sourceFormat: a.view.sourceFormat,
            action: 'convert',
            hash: a.view.sourceHash,
            format: a.view.targetFormat,
            version: a.view.targetVersion,
            choices,
          },
          signal,
          progress
        )
      );
      const dir = path.dirname(a.file),
        name = path.basename(a.file, path.extname(a.file)) + '-converted';
      let output = '';
      await withFileJob(dir, signal, async () => {
        signal.throwIfAborted();
        const temp = path.join(dir, '.faionyx-convert-' + crypto.randomUUID() + '.part');
        try {
          await fs.writeFile(temp, bytes, { flag: 'wx' });
          signal.throwIfAborted();
          for (let n = 1; n < 10000; n++) {
            const candidate = path.join(dir, name + (n === 1 ? '' : '-' + n) + '.' + a.view.targetFormat);
            try {
              await fs.link(temp, candidate);
              output = candidate;
              break;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            }
          }
          if (!output) throw new Error(t('projjobs.error.name_conflicts'));
          if (signal.aborted) {
            await fs.unlink(output);
            signal.throwIfAborted();
          }
        } finally {
          await fs.unlink(temp).catch(() => {});
        }
      });
      analyses.delete(id);
      progress(1, t('projjobs.text.convert_verified'));
      return { path: output, name: path.basename(output) };
    });
  });
}
