import { randomUUID } from 'node:crypto';
import type { GameProcessHandle } from './gracefulClose';
import { translate as t } from '../../shared/i18n';

interface SessionEntry {
  token: symbol;
  versionId: string;
  child?: GameProcessHandle;
  stopping: boolean;
  stopApproval?: string;
  exited?: boolean;
  onExit?: () => void;
}

/**
 * 退出提示语（纯函数供测试）：启动器任何正常退出路径都不终止游戏进程，
 * 只记录「游戏继续运行」；无运行中的游戏时返回 null（不写日志）。
 */
export function formatExitGamesLine(pids: number[]): string | null {
  if (!pids.length) return null;
  return t('main.log.exit_game_running', { pids: pids.join(t('common.list_separator')) });
}

/**
 * 多会话游戏进程管理：允许同时运行多个游戏实例（多开）。
 * 每个会话持有独立 token；停止/重启按 token 寻址，默认操作最近启动的会话。
 */
export class GameSession {
  private sessions = new Map<symbol, SessionEntry>();
  private lastToken?: symbol;

  get busy(): boolean {
    return this.sessions.size > 0;
  }
  /** 最近启动会话的版本 id（无会话时 null） */
  get versionId(): string | null {
    return (this.lastToken && this.sessions.get(this.lastToken)?.versionId) ?? null;
  }
  /** 最近启动会话的 token */
  get token(): symbol | undefined {
    return this.lastToken;
  }
  /** 会话数量 */
  get count(): number {
    return this.sessions.size;
  }

  /** 全部运行中的版本 id（改名/写操作的占用校验用） */
  runningIds(): Set<string> {
    return new Set([...this.sessions.values()].filter((s) => !s.exited).map((s) => s.versionId));
  }

  /** 运行中游戏的 PID 列表（仅供退出日志等观测用途；清理流程绝不据此终止进程） */
  runningPids(): number[] {
    return [...this.sessions.values()]
      .filter((s) => !s.exited)
      .map((s) => s.child?.pid)
      .filter((p): p is number => typeof p === 'number');
  }

  /** 指定版本是否正在运行 */
  isRunning(versionId: string): boolean {
    return [...this.sessions.values()].some((s) => s.versionId === versionId && !s.exited);
  }

  /** 找到指定版本最近会话的 token（无则 undefined） */
  tokenOf(versionId: string): symbol | undefined {
    for (const [tok, s] of [...this.sessions.entries()].reverse()) {
      if (s.versionId === versionId) return tok;
    }
    return undefined;
  }

  /** 是否处于「玩家主动停止」流程（exit 回调标注 intentionalStop 用） */
  wasIntentionalStop(token: symbol): boolean {
    return this.sessions.get(token)?.stopping === true || this.stoppedIntent.has(token);
  }
  /** 已完成的主动停止记录（会话释放后保留一次性标记） */
  private stoppedIntent = new Set<symbol>();

  /** Save-first stop. Only a timed-out request can authorize force for this JVM. */
  async requestStop(
    requestClose: (child: GameProcessHandle) => Promise<void>,
    forceToken?: string,
    timeoutMs = 30000,
    token: symbol | undefined = this.lastToken
  ): Promise<{ requiresForce: boolean; forceToken?: string }> {
    const entry = token ? this.sessions.get(token) : undefined;
    if (!entry?.child) throw new Error(t('gamesession.error.no_running_game'));
    if (entry.stopping) throw new Error(t('gamesession.error.stopping_wait'));
    if (forceToken && entry.stopApproval !== forceToken) throw new Error(t('gamesession.error.force_expired'));
    entry.stopping = true;
    try {
      if (forceToken) {
        entry.stopApproval = undefined;
        await this.stop(8000, token);
      } else {
        try {
          await this.stopGracefully(requestClose, timeoutMs, token);
        } catch {
          if (!this.sessions.has(entry.token)) return { requiresForce: false };
          entry.stopApproval = randomUUID();
          return { requiresForce: true, forceToken: entry.stopApproval };
        }
      }
      return { requiresForce: false };
    } finally {
      entry.stopping = false;
    }
  }

  async stopGracefully(
    requestClose: (child: GameProcessHandle) => Promise<void>,
    timeoutMs = 30000,
    token: symbol | undefined = this.lastToken
  ): Promise<void> {
    const entry = token ? this.sessions.get(token) : undefined;
    const child = entry?.child;
    if (!entry || !child) throw new Error(t('gamesession.error.preparing_retry'));
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('close', exited);
      };
      const exited = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(t('gamesession.error.graceful_timeout')));
      }, timeoutMs);
      child.once('close', exited);
      // A failed close request does not mean the JVM exited. Keep listening until
      // actual close or timeout; force termination is a separate confirmed action.
      void requestClose(child).catch(() => {});
    });
  }

  /** 多开：每次启动创建独立会话，永不冲突 */
  reserve(versionId: string): symbol {
    const token = Symbol(versionId);
    this.sessions.set(token, { token, versionId, stopping: false });
    this.lastToken = token;
    return token;
  }

  attach(token: symbol, child: GameProcessHandle): void {
    const entry = this.sessions.get(token);
    if (!entry) throw new Error(t('gamesession.error.session_invalid'));
    entry.child = child;
    // The owned JVM's OS exit releases its file handles. Pipe drainage can finish
    // later (or a descendant can retain stdout); keep diagnostic ownership until
    // close, but do not continue blocking resource operations in that interval.
    // killed/signalCode only record a request, not confirmation of process exit.
    entry.onExit = () => {
      entry.exited = true;
    };
    child.once('exit', entry.onExit);
  }

  release(token: symbol): boolean {
    const entry = this.sessions.get(token);
    if (!entry) return false;
    if (entry.onExit) entry.child?.off('exit', entry.onExit);
    if (entry.stopping) this.stoppedIntent.add(token);
    this.sessions.delete(token);
    if (this.lastToken === token) {
      const keys = [...this.sessions.keys()];
      this.lastToken = keys[keys.length - 1];
    }
    // stoppedIntent 只保留最近几个，防内存泄漏
    if (this.stoppedIntent.size > 16) {
      const first = this.stoppedIntent.values().next().value;
      if (first) this.stoppedIntent.delete(first);
    }
    return true;
  }

  async stop(timeoutMs = 8000, token: symbol | undefined = this.lastToken): Promise<void> {
    const entry = token ? this.sessions.get(token) : undefined;
    if (!entry) throw new Error(t('gamesession.error.no_process_to_stop'));
    const child = entry.child;
    if (!child) throw new Error(t('gamesession.error.preparing_wait'));
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        child.off('close', exited);
        child.off('error', failed);
      };
      const exited = () => {
        clean();
        resolve();
      };
      const failed = (error: Error) => {
        clean();
        reject(error);
      };
      const timer = setTimeout(() => failed(new Error(t('gamesession.error.exit_unconfirmed'))), timeoutMs);
      child.once('close', exited);
      child.once('error', failed);
      try {
        if (child.exitCode === null && child.signalCode === null && !child.kill()) {
          failed(new Error(t('gamesession.error.kill_rejected')));
        }
      } catch (error) {
        failed(error as Error);
      }
    });
    // Only the owning process callback releases the session and announces its exit.
  }
}
