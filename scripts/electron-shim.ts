// electron 模块垫片：让 src/main/core/* 的 TS 模块可在 node(tsx) 下运行
import path from 'node:path';
import os from 'node:os';

const appData = path.join(os.homedir(), 'AppData', 'Roaming');
export const app = {
  getPath(name: string): string {
    if (name === 'userData') return path.join(appData, 'faionyx');
    if (name === 'appData') return appData;
    if (name === 'temp' || name === 'tmp') return os.tmpdir();
    return appData;
  },
  getVersion: () => '0.0.0-harness',
  getName: () => 'faionyx',
};
export const ipcMain = { handle: () => undefined, on: () => undefined };
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) };
export const shell = { openPath: async () => '', showItemInFolder: () => undefined, openExternal: async () => undefined };
export const screen = {
  getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workAreaSize: { width: 1920, height: 1040 } }),
  getDisplayNearestPoint: () => ({ workAreaSize: { width: 1920, height: 1040 } }),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
};
export const nativeTheme = { themeSource: 'system' };
export class BrowserWindow {}
export default { app, ipcMain, dialog, shell, BrowserWindow };
