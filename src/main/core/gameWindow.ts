import type { GameResolution, GameWindowMode } from '../../shared/types';

export const GAME_WIDTH_MIN = 854;
export const GAME_WIDTH_MAX = 7680;
export const GAME_HEIGHT_MIN = 480;
export const GAME_HEIGHT_MAX = 4320;

const MODES: readonly GameWindowMode[] = ['windowed', 'maximized', 'fullscreen'];

export interface WorkAreaSize {
  width: number;
  height: number;
}

export interface GameWindowArguments {
  args: string[];
  mode: GameWindowMode;
  width?: number;
  height?: number;
}

function isMode(value: unknown): value is GameWindowMode {
  return typeof value === 'string' && MODES.includes(value as GameWindowMode);
}

/** 兼容旧版只有 fullscreen 布尔值的配置，并为损坏配置提供稳定默认值。 */
export function normalizeStoredResolution(
  value: Partial<GameResolution> | null | undefined,
  fallback: GameResolution = {
    width: GAME_WIDTH_MIN,
    height: GAME_HEIGHT_MIN,
    mode: 'windowed',
    fullscreen: false,
  }
): GameResolution {
  const legacyFullscreen = value?.fullscreen === true;
  const mode = isMode(value?.mode) ? value.mode : legacyFullscreen ? 'fullscreen' : fallback.mode;
  const width = Number.isFinite(value?.width) ? Math.round(value!.width!) : fallback.width;
  const height = Number.isFinite(value?.height) ? Math.round(value!.height!) : fallback.height;
  return { width, height, mode, fullscreen: mode === 'fullscreen' };
}

export function resolutionValidationError(value: GameResolution): string | null {
  if (!isMode(value.mode)) return '请选择有效的窗口模式';
  if (!Number.isInteger(value.width) || value.width < GAME_WIDTH_MIN || value.width > GAME_WIDTH_MAX) {
    return `窗口宽度必须是 ${GAME_WIDTH_MIN}–${GAME_WIDTH_MAX} 之间的整数`;
  }
  if (!Number.isInteger(value.height) || value.height < GAME_HEIGHT_MIN || value.height > GAME_HEIGHT_MAX) {
    return `窗口高度必须是 ${GAME_HEIGHT_MIN}–${GAME_HEIGHT_MAX} 之间的整数`;
  }
  return null;
}

export function assertValidResolution(value: GameResolution): void {
  const error = resolutionValidationError(value);
  if (error) throw new Error(error);
}

/** 实例设置存在时覆盖全局；结果重新同步旧 fullscreen 字段。 */
export function resolveGameResolution(globalResolution: GameResolution, instanceResolution?: GameResolution | null): GameResolution {
  const global = normalizeStoredResolution(globalResolution);
  const resolved = instanceResolution ? normalizeStoredResolution(instanceResolution, global) : global;
  assertValidResolution(resolved);
  return resolved;
}

/** 清掉版本元数据可能自带的窗口参数，保证最终命令中只有一个权威来源。 */
export function stripGameWindowArguments(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--width' || value === '--height') {
      i++;
      continue;
    }
    if (value === '--fullscreen') continue;
    result.push(value);
  }
  return result;
}

/**
 * 将已校验的配置写入 Minecraft 参数：
 * - windowed：使用配置宽高；
 * - maximized：使用当前显示器工作区宽高，仍保持窗口化，不改显示器分辨率；
 * - fullscreen：只传 --fullscreen，绝不混入窗口尺寸。
 */
export function buildGameWindowArguments(
  baseArgs: readonly string[],
  resolution: GameResolution,
  workArea?: WorkAreaSize
): GameWindowArguments {
  assertValidResolution(resolution);
  const args = stripGameWindowArguments(baseArgs);
  if (resolution.mode === 'fullscreen') {
    return { args: [...args, '--fullscreen'], mode: 'fullscreen' };
  }

  const useWorkArea =
    resolution.mode === 'maximized' &&
    workArea &&
    Number.isFinite(workArea.width) &&
    Number.isFinite(workArea.height) &&
    workArea.width > 0 &&
    workArea.height > 0;
  const width = Math.round(useWorkArea ? workArea!.width : resolution.width);
  const height = Math.round(useWorkArea ? workArea!.height : resolution.height);
  return {
    args: [...args, '--width', String(width), '--height', String(height)],
    mode: resolution.mode,
    width,
    height,
  };
}
