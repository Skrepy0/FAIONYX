import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../shared/types';
import type { Settings, VersionCategoryAction } from '../../shared/types';
import {
  assertAvailableCategoryName,
  MAX_VERSION_CATEGORIES,
  normalizeVersionCategoryState,
  versionCategoryKey,
} from '../../shared/versionCategories';
import { getSettings, saveSettings } from './settings';
import { samePath } from './folderPaths';
import { listAllInstalled } from './versions';
import { translate as t } from '../../shared/i18n';

/** Synchronous read/validate/write: concurrent IPC actions never save stale lists. */
export function updateVersionCategories(action: VersionCategoryAction): Settings {
  if (!action || typeof action !== 'object') throw new Error(t('versioncategories.error.invalid_action'));
  const current = getSettings(),
    state = normalizeVersionCategoryState(current);
  if (action.type === 'create') {
    if (state.versionCategories.length >= MAX_VERSION_CATEGORIES)
      throw new Error(t('versioncategories.error.max_categories', { max: MAX_VERSION_CATEGORIES }));
    state.versionCategories.push({ id: randomUUID(), name: assertAvailableCategoryName(state.versionCategories, action.name) });
  } else if (action.type === 'rename' || action.type === 'remove') {
    const category = state.versionCategories.find((row) => row.id === action.id);
    if (!category) throw new Error(t('versioncategories.error.not_found'));
    if (action.type === 'rename') category.name = assertAvailableCategoryName(state.versionCategories, action.name, category.id);
    else {
      state.versionCategories = state.versionCategories.filter((row) => row.id !== category.id);
      state.versionCategoryAssignments = Object.fromEntries(
        Object.entries(state.versionCategoryAssignments).filter(([, id]) => id !== category.id)
      );
    }
  } else if (action.type === 'assign') {
    if (
      !action.target ||
      typeof action.target.id !== 'string' ||
      !action.target.id ||
      typeof action.target.folder !== 'string' ||
      !action.target.folder
    )
      throw new Error(t('versioncategories.error.invalid_target'));
    if (
      typeof action.categoryId !== 'string' ||
      (action.categoryId && !state.versionCategories.some((row) => row.id === action.categoryId))
    )
      throw new Error(t('versioncategories.error.not_found'));
    const root = current.folders.find((folder) => samePath(folder.path, action.target.folder));
    if (!root) throw new Error(t('versioncategories.error.folder_unregistered'));
    const targetKey = versionCategoryKey(action.target.folder, action.target.id, process.platform);
    const instance = listAllInstalled().find(
      (row) => row.id === action.target.id && versionCategoryKey(row.folder, row.id, process.platform) === targetKey
    );
    if (!instance) throw new Error(t('versioncategories.error.instance_not_found'));
    // Preserve the registered/scanned spelling used by the renderer, including
    // legacy symlink paths; never turn it into a different invisible key.
    const key = versionCategoryKey(instance.folder, instance.id, process.platform);
    if (action.categoryId) state.versionCategoryAssignments[key] = action.categoryId;
    else delete state.versionCategoryAssignments[key];
  } else throw new Error(t('versioncategories.error.invalid_action'));
  return saveSettings(state);
}
export function registerVersionCategoriesIpc(): void {
  ipcMain.handle(IPC.versionCategoriesUpdate, (_event, action: VersionCategoryAction) => updateVersionCategories(action));
}
