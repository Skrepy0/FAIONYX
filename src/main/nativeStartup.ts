import { BrowserWindow, ipcMain, dialog, type IpcMainEvent } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { StartupGate, BOOT_STAGES, canAssembleBoot, type BootStage } from '../shared/startup';
import { launcherLog } from './core/launcherLog';

const FADE_DURATION_MS = 260;
const FADE_TICK_MS = 16;
const POLL_INTERVAL_MS = 20;
const CLEANUP_DELAY_MS = 1500;
const VISIBLE_WAIT_MS = 700;
const VISIBLE_POLL_MS = 15;
/** Hard ceiling for the whole splash lifecycle. Anything beyond this is a stuck boot. */
const WATCHDOG_TIMEOUT_MS = 45_000;

const BOOT_LABELS = ['读取配置…', '加载账户…', '扫描游戏实例…', '准备主界面…', '准备首帧…'] as const;

export interface NativeStartup {
  attach(window: BrowserWindow): void;
}

export function showStartupWindow(window: BrowserWindow, animated = true) {
  if (!animated) {
    window.show();
    window.webContents.setBackgroundThrottling(true);
    return;
  }
  window.setOpacity(0);
  window.show();
  window.webContents.setBackgroundThrottling(true);
  fadeIn(window);
}

function fadeIn(window: BrowserWindow) {
  const started = Date.now();
  const timer = setInterval(() => {
    if (window.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    const t = Math.min(1, (Date.now() - started) / FADE_DURATION_MS);
    window.setOpacity(t * t * (3 - 2 * t));
    if (t === 1) {
      clearInterval(timer);
      window.emit('faionyx:startup-opacity-complete');
    }
  }, FADE_TICK_MS);
}

/** Keep the original native scene alive through readiness, assembly and reveal. No renderer swap. */
export function createNativeStartup(signal: string, pid: number): NativeStartup {
  const gate = new StartupGate();

  try {
    launcherLog('Startup animation mode: ' + readFileSync(`${signal}.motion`, 'utf8'));
  } catch {
    // Motion preference file is optional.
  }

  let main: BrowserWindow | null = null;
  let attached = false;
  let disposed = false;
  let revealed = false;
  let crashReported = false; // NEW: 独立于 disposed，用于崩溃提示去重
  let readySent = false;
  let lastSignalText = '';

  let pollTimer: NodeJS.Timeout | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;
  let watchdogTimer: NodeJS.Timeout | null = null;

  const listeners: Array<[string, (...args: any[]) => void]> = [];

  const send = (text: string) => {
    // 去重按 lastSignalText；`closed` 只在 cleanup 写一次，且 cleanup 后
    // 所有会调用 send 的路径都被 disposed 挡住，无重复语义风险。
    if (text === lastSignalText) return;
    try {
      writeFileSync(signal, text);
      lastSignalText = text;
    } catch {
      // Signal file may already be gone; best-effort.
    }
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }

    for (const [name, handler] of listeners) ipcMain.removeListener(name, handler);
    listeners.length = 0;

    send('closed');
  };

  const update = () => {
    if (disposed || revealed) return;

    if (gate.state.ready) {
      if (!readySent) {
        readySent = true;
        send('ready');
      }
      return;
    }
    if (readySent) return;

    const prefix = canAssembleBoot(gate.state) ? 'assembling\n' : 'loading\n';
    send(prefix + BOOT_LABELS[Math.min(BOOT_LABELS.length - 1, gate.completed.size)]);
  };

  const doReveal = (animated: boolean) => {
    if (revealed || !main || main.isDestroyed()) return;

    // 先尝试显示；只有窗口真正显示成功才进入 revealed 状态。
    // 若 show/setOpacity 抛异常，revealed 保持 false，watchdog 会接管。
    try {
      showStartupWindow(main, animated);
    } catch (err) {
      launcherLog(`Startup: reveal failed — ${String(err)}`);
      return;
    }

    revealed = true;
    send('reveal');
    launcherLog('Startup: unified native scene reveals fully painted main window');

    cleanupTimer = setTimeout(cleanup, CLEANUP_DELAY_MS);
    cleanupTimer.unref();
  };

  /** Pre-reveal failure path. Idempotent via disposed. */
  const fail = (window: BrowserWindow, message: string) => {
    if (disposed || revealed) return;
    cleanup();
    void dialog.showMessageBox({ type: 'error', title: 'FAIONYX 初始化失败', message }).finally(() => {
      if (!window.isDestroyed()) window.close();
    });
  };

  /**
   * Post-reveal failure path. 独立于 disposed：cleanupTimer 在 reveal 后
   * 1.5s 会触发 cleanup()，若此时才崩溃仍应弹窗，不能被 disposed 吞掉。
   * 只用 crashReported 去重，防止 render-process-gone + did-fail-load 连弹两个框。
   */
  const crashAfterReveal = (window: BrowserWindow, message: string) => {
    if (crashReported) return;
    crashReported = true;
    if (window.isDestroyed()) return;

    cleanup(); // 幂等
    void dialog.showMessageBox({ type: 'error', title: 'FAIONYX 运行异常', message }).finally(() => {
      if (!window.isDestroyed()) window.close();
    });
  };

  const startTimers = () => {
    pollTimer = setInterval(() => {
      if (disposed) return;

      if (existsSync(`${signal}.finished`)) {
        cleanup();
        return;
      }

      // 注意：PID 复用场景下 alive 可能恒为真。当前由 watchdog 兜底最坏情况，
      // 不单独修探测逻辑。
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }

      if (!alive) {
        if (gate.state.ready) {
          doReveal(false);
          cleanup();
        }
        return;
      }

      if (!readySent || !existsSync(`${signal}.assembled`)) return;

      let status = '';
      try {
        status = readFileSync(`${signal}.assembled`, 'utf8');
      } catch {
        return;
      }
      if (status !== 'ready' && status !== 'reduced') return;

      gate.assembled = true;
      if (gate.canReveal) doReveal(status !== 'reduced');
    }, POLL_INTERVAL_MS);
    pollTimer.unref();

    watchdogTimer = setTimeout(() => {
      if (disposed || revealed) return;
      launcherLog(`Startup watchdog fired after ${WATCHDOG_TIMEOUT_MS}ms — forcing resolution`);

      if (!main || main.isDestroyed()) {
        cleanup();
        return;
      }
      if (gate.state.ready) {
        doReveal(false);
      } else {
        fail(main, '主界面初始化超时，请检查后端进程是否正常运行。');
      }
    }, WATCHDOG_TIMEOUT_MS);
    watchdogTimer.unref();
  };

  return {
    attach(window: BrowserWindow) {
      if (attached) return;
      attached = true;
      main = window;

      const onStage = (event: IpcMainEvent, stage: BootStage) => {
        if (!main || event.sender !== main.webContents) return;
        if (!BOOT_STAGES.includes(stage)) return;
        gate.completed.add(stage);
        update();
      };
      const onRendererReady = (event: IpcMainEvent) => {
        if (!main || event.sender !== main.webContents) return;
        gate.rendererReady = true;
        update();
      };
      listeners.push(['boot:stage', onStage], ['boot:renderer-ready', onRendererReady]);
      ipcMain.on('boot:stage', onStage);
      ipcMain.on('boot:renderer-ready', onRendererReady);

      window.once('ready-to-show', () => {
        gate.painted = true;
        update();
      });
      window.once('closed', cleanup);

      // 单一持久处理器，按 revealed 分支；两个事件都靠 crashReported / disposed 去重。
      window.webContents.on('render-process-gone', (_e, details) => {
        if (window.isDestroyed()) return;
        if (revealed) crashAfterReveal(window, `主界面进程退出：${details.reason}`);
        else fail(window, `主界面进程退出：${details.reason}`);
      });
      window.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
        if (!isMainFrame || code === -3 || window.isDestroyed()) return;
        if (revealed) crashAfterReveal(window, `无法加载主界面：${description}`);
        else fail(window, `无法加载主界面：${description}`);
      });

      startTimers();
      update();
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function awaitNativeStartup(signal: string): Promise<number | null> {
  const deadline = Date.now() + VISIBLE_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(`${signal}.visible`, 'utf8');
      const pid = Number(text);
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        return pid;
      }
    } catch {
      // Not ready yet — retry until deadline.
    }
    await sleep(VISIBLE_POLL_MS);
  }
  return null;
}
