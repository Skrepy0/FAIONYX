import { dialog, ipcMain, nativeImage, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { selectedAccount } from './accounts';
import { applyOfflineSkinBytes, uploadSkin } from './skins';
import { isBasePixel } from '../../shared/skinPixels';
import { translate as t } from '../../shared/i18n';
function png(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 200000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value))
    throw new Error(t('skineditor.error.invalid_png'));
  const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty() || image.getSize().width !== 64 || image.getSize().height !== 64) throw new Error(t('skineditor.error.size_64'));
  const bitmap = image.toBitmap();
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
      if (isBasePixel(x, y) && bitmap[(y * 64 + x) * 4 + 3] !== 255) throw new Error(t('skineditor.error.transparent_base'));
  return image.toPNG();
}
export function registerSkinEditorIpc(getWin: () => BrowserWindow | null) {
  ipcMain.handle('skin:editorSave', async (_e, value: unknown) => {
    const bytes = png(value),
      win = getWin();
    const options = {
      title: t('skineditor.dialog.save_title'),
      defaultPath: 'skin.png',
      filters: [{ name: t('skineditor.dialog.png_filter'), extensions: ['png'] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, bytes);
    return true;
  });
  ipcMain.handle('skin:editorUpload', async (_e, value: unknown, variant: unknown, accountId: unknown) => {
    if (!selectedAccount() || selectedAccount()?.id !== accountId) throw new Error(t('skineditor.error.account_changed'));
    if (variant !== 'classic' && variant !== 'slim') throw new Error(t('skineditor.error.invalid_model'));
    const account = { ...selectedAccount()! },
      bytes = png(value);
    if (account.type === 'offline') return applyOfflineSkinBytes(bytes, variant, account.id, t('skineditor.filename.drawn_skin'));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'faionyx-skin-'));
    const file = path.join(dir, 'skin.png');
    try {
      await fs.writeFile(file, bytes);
      return await uploadSkin(file, variant, account.id);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
