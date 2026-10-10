/** Display the publisher's release timestamp in the player's local timezone, to the minute. */
import { translate as t } from './i18n';

export function formatReleaseTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return t('releasetime.unknown');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
