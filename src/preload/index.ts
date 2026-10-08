import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, cb: (...args: unknown[]) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
  /** 拖入文件时取真实文件系统路径（Electron 32+ 必须经 webUtils） */
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  platform: process.platform,
}

contextBridge.exposeInMainWorld('faionyx', api)
