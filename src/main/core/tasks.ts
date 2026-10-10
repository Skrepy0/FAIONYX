/**
 * 后台任务注册表：安装/导入/下载类任务的取消控制
 * 每个任务持有一个 AbortController，取消信号贯穿 downloadAll/downloadFile
 */
import { logScope } from './launcherLog';
import { translate as t } from '../../shared/i18n';

const taskLog = logScope('tasks');

export interface TaskRecord {
  id: string;
  /** 展示名（如「导入整合包 xxx.zip」「安装版本 26.2」） */
  title: string;
  kind: 'version' | 'modpack' | 'download' | 'world' | 'java';
  controller: AbortController;
  /** 仅在底层任务已经退出并完成清理后才会 resolve。 */
  settled: Promise<void>;
  status: 'running' | 'paused' | 'cancelling';
}

const tasks = new Map<string, TaskRecord>();
let seq = 0;

interface InternalTaskRecord extends TaskRecord {
  settle: () => void;
  resumeWaiters: Set<() => void>;
}

const taskBySignal = new WeakMap<AbortSignal, InternalTaskRecord>();

/** 为 AbortSignal.any 等派生信号继承同一暂停门控。 */
export function inheritTaskControl(source: AbortSignal | undefined, target: AbortSignal): void {
  if (!source) return;
  const rec = taskBySignal.get(source);
  if (rec) taskBySignal.set(target, rec);
}

export function registerTask(title: string, kind: TaskRecord['kind']): TaskRecord {
  const id = `${kind}-${Date.now()}-${++seq}`;
  let settle = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const rec: InternalTaskRecord = {
    id,
    title,
    kind,
    controller: new AbortController(),
    settled,
    settle,
    status: 'running',
    resumeWaiters: new Set(),
  };
  tasks.set(id, rec);
  taskBySignal.set(rec.controller.signal, rec);
  taskLog.debug(t('tasks.log.registered', { title, id }));
  return rec;
}

export function cancelTask(id: string): boolean {
  const rec = tasks.get(id) as InternalTaskRecord | undefined;
  if (!rec) {
    taskLog.debug(t('tasks.log.cancel_missing', { id }));
    return false;
  }
  if (rec.status !== 'cancelling') {
    taskLog.info(t('tasks.log.cancel', { title: rec.title, id }));
    rec.status = 'cancelling';
    rec.controller.abort(new DOMException('已取消', 'AbortError'));
    for (const resume of rec.resumeWaiters) resume();
    rec.resumeWaiters.clear();
  }
  return true;
}

export function finishTask(id: string): void {
  const rec = tasks.get(id) as InternalTaskRecord | undefined;
  if (rec) taskLog.debug(t('tasks.log.finished', { title: rec.title, id }));
  rec?.settle();
  if (rec) {
    for (const resume of rec.resumeWaiters) resume();
    rec.resumeWaiters.clear();
    taskBySignal.delete(rec.controller.signal);
  }
  tasks.delete(id);
}

export function pauseTask(id: string): boolean {
  const rec = tasks.get(id);
  if (!rec || rec.status !== 'running') {
    taskLog.warn(t('tasks.log.pause_missing', { id }));
    return false;
  }
  taskLog.info(t('tasks.log.paused', { title: rec.title, id }));
  rec.status = 'paused';
  return true;
}

export function resumeTask(id: string): boolean {
  const rec = tasks.get(id) as InternalTaskRecord | undefined;
  if (!rec || rec.status !== 'paused') {
    taskLog.warn(t('tasks.log.resume_missing', { id }));
    return false;
  }
  taskLog.info(t('tasks.log.resumed', { title: rec.title, id }));
  rec.status = 'running';
  for (const resume of rec.resumeWaiters) resume();
  rec.resumeWaiters.clear();
  return true;
}

export function isTaskPaused(signal?: AbortSignal): boolean {
  return !!signal && taskBySignal.get(signal)?.status === 'paused';
}

/** 下载 worker/流读取边界调用；暂停时不继续读网络、不写文件，也不派发新任务。 */
export async function waitIfTaskPaused(signal?: AbortSignal): Promise<void> {
  if (!signal) return;
  throwIfCancelled(signal);
  const rec = taskBySignal.get(signal);
  if (!rec || rec.status !== 'paused') return;
  await new Promise<void>((resolve, reject) => {
    const resume = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      rec.resumeWaiters.delete(resume);
      reject(new Error(t('ipc.text.cancelled')));
    };
    rec.resumeWaiters.add(resume);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  throwIfCancelled(signal);
}

/**
 * 发出取消后等待任务主流程退出。IPC 只有在 finally/回滚完成后才返回，避免 UI
 * 在网络、文件写入或安装器仍运行时把任务假装成“已取消”。
 */
export async function cancelTaskAndWait(id: string, timeoutMs = 30_000): Promise<boolean> {
  const rec = tasks.get(id);
  if (!rec) return false;
  cancelTask(id);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      rec.settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(t('tasks.error.cancel_timeout'))), timeoutMs);
      }),
    ]);
  } catch (error) {
    taskLog.warn(t('tasks.log.cancel_timeout', { timeout: timeoutMs, title: rec.title, id }), error);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return true;
}

/** 取消错误的统一判定（abort 信号抛出） */
export function isCancelError(e: unknown): boolean {
  return e instanceof Error && (e.message === '已取消' || e.name === 'AbortError' || /aborted|取消/i.test(e.message));
}

/** 阶段边界手动检查（下载循环之外的长流程节点调用） */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(t('ipc.text.cancelled'));
}

/** 可取消的退避等待；取消时不必等定时器自然结束。 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error(t('ipc.text.cancelled')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
