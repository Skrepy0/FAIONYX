import type { RemoteVersion } from './types';
export type VersionCategory = 'release' | 'preview' | 'snapshot' | 'old' | 'all';
/** label 为 i18n 键（versionpicker.filter.*），由调用方通过 t() 取显示名 */
export const versionCategories: { value: VersionCategory; label: string }[] = [
  { value: 'release', label: 'versionpicker.filter.release' },
  { value: 'preview', label: 'versionpicker.filter.preview' },
  { value: 'snapshot', label: 'versionpicker.filter.snapshot' },
  { value: 'old', label: 'versionpicker.filter.old' },
  { value: 'all', label: 'versionpicker.filter.all' },
];
export function versionCategory(v: RemoteVersion): VersionCategory {
  if (v.type === 'release') return 'release';
  if (v.type === 'old_alpha' || v.type === 'old_beta') return 'old';
  return /(?:[-\s](?:pre|rc)(?:[-\s]?\d|release)|pre-release|release candidate)/i.test(v.id) ? 'preview' : 'snapshot';
}
export function filterVersions(versions: RemoteVersion[], category: VersionCategory, query: string) {
  const q = query.trim().toLowerCase();
  return versions
    .filter((v) => (category === 'all' || versionCategory(v) === category) && v.id.toLowerCase().includes(q))
    .sort((a, b) => Date.parse(b.releaseTime) - Date.parse(a.releaseTime));
}
