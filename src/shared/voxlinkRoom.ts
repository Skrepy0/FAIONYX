/** 房间标题与客户端来源标识分开；两端共用默认名称及输入约束。 */
import { translate as t } from './i18n';

export const DEFAULT_VOXLINK_ROOM_NAME = t('voxlinkroom.default_room_name');
export const VOXLINK_ROOM_NAME_MAX = 32;

export function normalizeVoxlinkRoomName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error(t('voxlinkroom.error.name_required'));
  if (name.length > VOXLINK_ROOM_NAME_MAX) throw new Error(t('voxlinkroom.error.name_too_long'));
  return name;
}

export function isVoxlinkContentBlocked(error: unknown): boolean {
  return (
    (error as { code?: string })?.code === 'CONTENT_BLOCKED' ||
    /\bCONTENT_BLOCKED\b/.test(error instanceof Error ? error.message : String(error))
  );
}

export const VOXLINK_ROOM_BLOCKED_MESSAGE = t('voxlinkroom.blocked_message');
