import { app, dialog, safeStorage, BrowserWindow, webContents, type IpcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TicketService, TicketError, type TicketFile } from './tickets';
import { translate as t } from '../../../shared/i18n';
import type { TicketResult } from '../../../shared/voxlinkTickets';
import { TICKET_FILES_MAX, TICKET_BYTES_MAX } from '../../../shared/voxlinkTickets';
import { protectedCredentialStorage } from '../credentialProtection';
export function registerTicketIpc(ipc: IpcMain, base: () => string) {
  const service = new TicketService(path.join(app.getPath('userData'), 'voxlink_tickets.json'), base, {
    seal: (text) => {
      if (!protectedCredentialStorage(safeStorage))
        throw new TicketError('SECRET_UNAVAILABLE', t('voxlink.ticketsipc.error.secret_unavailable'));
      return 'enc:' + safeStorage.encryptString(text).toString('base64');
    },
    open: (text) => {
      if (!text.startsWith('enc:')) return text;
      if (!protectedCredentialStorage(safeStorage)) throw Error('encryption');
      return safeStorage.decryptString(Buffer.from(text.slice(4), 'base64'));
    },
  });
  const grants = new Map<string, { owner: number; file: TicketFile; expires: number }>(),
    operations = new Map<string, AbortController>();
  const owned = (owner: number, ids: unknown): TicketFile[] => {
    if (!Array.isArray(ids) || ids.length > TICKET_FILES_MAX || ids.some((id) => typeof id !== 'string'))
      throw new TicketError('INVALID_ATTACHMENTS', t('voxlink.ticketsipc.error.invalid_attachments'));
    return [...new Set(ids)].map((id) => {
      const grant = grants.get(id);
      if (!grant || grant.owner !== owner || grant.expires < Date.now())
        throw new TicketError('INVALID_ATTACHMENTS', t('voxlink.ticketsipc.error.attachments_expired'));
      return grant.file;
    });
  };
  ipc.handle('voxlink:tickets:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender),
      options = {
        title: t('voxlink.ticketsipc.label.pick_title'),
        properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      },
      result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    if (result.filePaths.length > TICKET_FILES_MAX) throw Error(t('voxlink.ticketsipc.error.too_many_attachments'));
    const files = await Promise.all(
      result.filePaths.map(async (file) => {
        const resolved = await fs.realpath(file),
          stat = await fs.stat(resolved);
        if (!stat.isFile()) throw Error(t('voxlink.ticketsipc.error.not_a_file'));
        return { path: resolved, name: path.basename(resolved), size: stat.size, mtime: stat.mtimeMs };
      })
    );
    if (files.reduce((n, f) => n + f.size, 0) > TICKET_BYTES_MAX) throw Error(t('voxlink.ticketsipc.error.attachments_total_limit'));
    for (const [id, value] of grants) if (value.expires < Date.now()) grants.delete(id);
    if (grants.size > 200) throw Error(t('voxlink.ticketsipc.error.too_many_grants'));
    return files.map((file) => {
      const id = randomUUID();
      grants.set(id, { owner: event.sender.id, file, expires: Date.now() + 3600000 });
      return { id, name: file.name, size: file.size };
    });
  });
  ipc.handle('voxlink:tickets:release', (_event, ids: unknown) => {
    if (Array.isArray(ids)) for (const id of ids) if (grants.get(id)?.owner === _event.sender.id) grants.delete(id);
  });
  ipc.handle('voxlink:tickets:list', () => service.list());
  ipc.handle('voxlink:tickets:cancel', (event, operation: string) => operations.get(event.sender.id + ':' + operation)?.abort());
  const handle = (
    name: string,
    fn: (payload: any, signal: AbortSignal, files: TicketFile[], progress: (n: number, total: number) => void) => Promise<unknown>,
    attachments = false
  ) =>
    ipc.handle(name, async (event, payload: any): Promise<TicketResult<unknown>> => {
      if (!payload || typeof payload.operation !== 'string' || !/^[\w-]{1,100}$/.test(payload.operation))
        return { ok: false, code: 'INVALID_OPERATION', message: t('voxlink.ticketsipc.error.invalid_operation') };
      const key = event.sender.id + ':' + payload.operation,
        controller = new AbortController();
      operations.get(key)?.abort();
      operations.set(key, controller);
      let lastProgress = 0;
      try {
        const files = attachments ? owned(event.sender.id, payload.attachments ?? []) : [],
          progress = (bytes: number, total: number) => {
            if (event.sender.isDestroyed() || (Date.now() - lastProgress < 200 && bytes < total)) return;
            lastProgress = Date.now();
            event.sender.send('voxlink:tickets:progress', { operation: payload.operation, bytes, total });
          };
        const value = await fn(payload, controller.signal, files, progress);
        if (attachments) for (const id of payload.attachments ?? []) grants.delete(id);
        return { ok: true, value };
      } catch (error) {
        return error instanceof TicketError
          ? { ok: false, code: error.code, message: error.message, retryAt: error.retryAt }
          : { ok: false, code: 'OPERATION_FAILED', message: t('voxlink.ticketsipc.error.operation_failed') };
      } finally {
        if (operations.get(key) === controller) operations.delete(key);
      }
    });
  handle('voxlink:tickets:poll', (_p, signal) => service.pollOnce(signal));
  handle('voxlink:tickets:detail', (p, signal) => service.detail(p.id, signal));
  handle('voxlink:tickets:submit', (p, signal, files, progress) => service.submit(p.description, files, signal, progress), true);
  handle('voxlink:tickets:reply', (p, signal, files, progress) => service.reply(p.id, p.text, files, signal, progress), true);
  handle('voxlink:tickets:retract', (p, signal) => service.retract(p.id, p.msg, signal));
  handle('voxlink:tickets:delete', (p, signal) => service.remove(p.id, signal));
  const cleanup = (contents: Electron.WebContents) =>
    contents.once('destroyed', () => {
      for (const [key, controller] of operations)
        if (key.startsWith(contents.id + ':')) {
          controller.abort();
          operations.delete(key);
        }
      for (const [id, grant] of grants) if (grant.owner === contents.id) grants.delete(id);
    });
  for (const contents of webContents.getAllWebContents()) cleanup(contents);
  app.on('web-contents-created', (_e, contents) => cleanup(contents));
}
