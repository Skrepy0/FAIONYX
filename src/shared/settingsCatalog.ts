import { translate as t } from './i18n';

/** UI navigation only; settings storage and defaults remain owned by core/settings. */
export const settingsScopes = [
  { id: 'launcher', label: 'settings.scope.launcher' },
  { id: 'game', label: 'settings.scope.game' },
] as const;
export type SettingsScope = (typeof settingsScopes)[number]['id'];
export const settingsCategories = [
  { id: 'appearance', scope: 'launcher', label: 'settings.category.appearance' },
  { id: 'general', scope: 'launcher', label: 'settings.category.general' },
  { id: 'downloads', scope: 'launcher', label: 'settings.category.downloads' },
  { id: 'features', scope: 'launcher', label: 'settings.category.features' },
  { id: 'about', scope: 'launcher', label: 'settings.category.about' },
  { id: 'game', scope: 'game', label: 'settings.category.game' },
  { id: 'display', scope: 'game', label: 'settings.category.display' },
  { id: 'directories', scope: 'game', label: 'settings.category.directories' },
] as const;
export function scopeOfCategory(id: string): SettingsScope {
  return settingsCategories.find((c) => c.id === id)?.scope ?? 'launcher';
}
export type SettingsCategory = (typeof settingsCategories)[number]['id'];
/** name / keywords 均为 i18n 键，显示与搜索时由调用方翻译。 */
export const settingsCatalog = [
  { id: 'theme', category: 'appearance', name: 'settings.catalog.theme.name', keywords: 'settings.catalog.theme.keywords' },
  { id: 'background', category: 'appearance', name: 'settings.catalog.background.name', keywords: 'settings.catalog.background.keywords' },
  { id: 'thumbnail', category: 'appearance', name: 'settings.catalog.thumbnail.name', keywords: 'settings.catalog.thumbnail.keywords' },
  { id: 'motion', category: 'appearance', name: 'settings.catalog.motion.name', keywords: 'settings.catalog.motion.keywords' },
  {
    id: 'ui-window-fit',
    category: 'appearance',
    name: 'settings.catalog.ui-window-fit.name',
    keywords: 'settings.catalog.ui-window-fit.keywords',
  },
  { id: 'isolation', category: 'directories', name: 'settings.catalog.isolation.name', keywords: 'settings.catalog.isolation.keywords' },
  { id: 'memory', category: 'game', name: 'settings.catalog.memory.name', keywords: 'settings.catalog.memory.keywords' },
  { id: 'java', category: 'game', name: 'settings.catalog.java.name', keywords: 'settings.catalog.java.keywords' },
  { id: 'resolution', category: 'display', name: 'settings.catalog.resolution.name', keywords: 'settings.catalog.resolution.keywords' },
  { id: 'jvm', category: 'game', name: 'settings.catalog.jvm.name', keywords: 'settings.catalog.jvm.keywords' },
  { id: 'launch', category: 'general', name: 'settings.catalog.launch.name', keywords: 'settings.catalog.launch.keywords' },
  {
    id: 'installation',
    category: 'downloads',
    name: 'settings.catalog.installation.name',
    keywords: 'settings.catalog.installation.keywords',
  },
  { id: 'downloads', category: 'downloads', name: 'settings.catalog.downloads.name', keywords: 'settings.catalog.downloads.keywords' },
  { id: 'mirror', category: 'downloads', name: 'settings.catalog.mirror.name', keywords: 'settings.catalog.mirror.keywords' },
  { id: 'features', category: 'features', name: 'settings.catalog.features.name', keywords: 'settings.catalog.features.keywords' },
  { id: 'plugins', category: 'features', name: 'settings.catalog.plugins.name', keywords: 'settings.catalog.plugins.keywords' },
  { id: 'update', category: 'about', name: 'settings.catalog.update.name', keywords: 'settings.catalog.update.keywords' },
] as const;
export function searchSettings(query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return words.length
    ? settingsCatalog.filter((item) => words.every((word) => `${t(item.name)} ${t(item.keywords)}`.toLocaleLowerCase().includes(word)))
    : [];
}
export function motionReduced(value: unknown, system: boolean): boolean {
  return value === true || system;
}
