import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MASCOTS, addMascotHits, normalizeMascotSound, sortMascots, type MascotBatch, type MascotState } from '../../shared/mascots';
import { translate as t } from '../../shared/i18n';

const ids = MASCOTS.map((m) => m.id) as string[];
const file = () => path.join(app.getPath('userData'), 'mascot-counts.json');
interface SavedState extends MascotState {
  receipts: Array<{ batchId: string; hash: string }>;
}
let pending: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = pending.then(work, work);
  pending = result.catch(() => {});
  return result;
}
function owner(event: IpcMainInvokeEvent) {
  if (!BrowserWindow.fromWebContents(event.sender) || event.sender.isDestroyed()) throw new Error(t('mascots.error.window_closed'));
}
const publicState = (state: SavedState): MascotState => ({
  counts: state.counts,
  order: state.order,
  sound: normalizeMascotSound(state.sound),
});
async function read(): Promise<SavedState> {
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8'));
    if (!raw || !raw.counts || !Array.isArray(raw.order)) throw new Error(t('mascots.error.invalid_format'));
    return {
      counts: Object.fromEntries(ids.map((id) => [id, Number.isSafeInteger(raw.counts[id]) && raw.counts[id] >= 0 ? raw.counts[id] : 0])),
      order: [...new Set([...raw.order.filter((id: string) => ids.includes(id)), ...ids])] as string[],
      sound: normalizeMascotSound(raw.sound),
      receipts: Array.isArray(raw.receipts)
        ? raw.receipts.filter((r: any) => typeof r?.batchId === 'string' && typeof r?.hash === 'string').slice(-256)
        : [],
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { counts: {}, order: [...ids], sound: normalizeMascotSound(), receipts: [] };
    throw new Error(t('mascots.error.record_unreadable'));
  }
}
async function write(state: SavedState) {
  state.order = sortMascots(state);
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file() + '.tmp', JSON.stringify(state));
  await fs.rename(file() + '.tmp', file());
  return publicState(state);
}
export function validateMascotBatch(value: unknown): MascotBatch {
  const batch = value as MascotBatch;
  if (
    !batch ||
    typeof batch.batchId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(batch.batchId) ||
    !Array.isArray(batch.hits) ||
    !batch.hits.length ||
    batch.hits.length > 512 ||
    batch.hits.some((id) => !ids.includes(id))
  )
    throw new Error(t('mascots.error.invalid_batch'));
  if (
    batch.tieOrder !== undefined &&
    (!Array.isArray(batch.tieOrder) ||
      batch.tieOrder.length !== ids.length ||
      new Set(batch.tieOrder).size !== ids.length ||
      batch.tieOrder.some((id) => !ids.includes(id)))
  )
    throw new Error(t('mascots.error.invalid_tie_order'));
  return batch;
}
export function registerMascotsIpc() {
  ipcMain.handle('mascots:state', (event) => {
    owner(event);
    return serialize(async () => publicState(await read()));
  });
  ipcMain.handle('mascots:batch', (event, value) => {
    owner(event);
    const batch = validateMascotBatch(value),
      hash = createHash('sha256')
        .update(JSON.stringify({ hits: batch.hits, tieOrder: batch.tieOrder }))
        .digest('hex');
    return serialize(async () => {
      const state = await read(),
        receipt = state.receipts.find((r) => r.batchId === batch.batchId);
      if (receipt) {
        if (receipt.hash !== hash) throw new Error(t('mascots.error.batch_id_used'));
        return publicState(state);
      }
      const next = addMascotHits({ ...state, order: batch.tieOrder || state.order }, batch.hits) as SavedState;
      next.receipts = [...state.receipts, { batchId: batch.batchId, hash }].slice(-256);
      return write(next);
    });
  });
  // Preserve the 1.1.6 IPC for older in-process callers.
  ipcMain.handle('mascots:slap', (event, id) => {
    owner(event);
    if (!ids.includes(id)) throw new Error(t('mascots.error.invalid_id'));
    return serialize(async () => write(addMascotHits(await read(), [id]) as SavedState));
  });
  ipcMain.handle('mascots:sound', (event, value) => {
    owner(event);
    if (typeof value?.muted !== 'boolean' || typeof value?.volume !== 'number' || !Number.isFinite(value.volume))
      throw new Error(t('mascots.error.invalid_sound'));
    return serialize(async () => {
      const state = await read();
      state.sound = normalizeMascotSound(value);
      return write(state);
    });
  });
  ipcMain.handle('mascots:reset', (event, confirmed, scope) => {
    owner(event);
    if (confirmed !== true) throw new Error(t('mascots.error.confirm_reset'));
    if (scope !== undefined && scope !== 'kamu') throw new Error(t('mascots.error.invalid_scope'));
    return serialize(async () => {
      const state = await read();
      if (scope === 'kamu') state.counts.kamu = 0;
      else {
        state.counts = {};
        state.order = [...ids];
      }
      return write(state);
    });
  });
}
