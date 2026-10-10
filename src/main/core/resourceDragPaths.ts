import fs from 'node:fs';
import path from 'node:path';
import { safeRelative } from './backupStore';
import { translate as t } from '../../shared/i18n';

/** Native drag must begin in the IPC gesture callback, before releasing the mouse. */
export function dragPath(root: string, relative: string): string {
  safeRelative(relative);
  let file = path.resolve(root);
  const base = fs.lstatSync(file);
  if (!base.isDirectory() || base.isSymbolicLink()) throw new Error(t('resourcedrag.error.not_regular_dir'));
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(t('resourcedrag.error.symlink'));
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(t('resourcedrag.error.special_file'));
  return file;
}
export function dragResourceFilesSync(directory: string, names: unknown): string[] {
  if (!Array.isArray(names) || !names.length || names.length > 1000) throw new Error(t('resourcedrag.error.batch_range'));
  return [...new Set(names)].map((name) => {
    if (typeof name !== 'string' || name.includes('/') || name.includes('\\')) throw new Error(t('resourcedrag.error.invalid_name'));
    return dragPath(directory, name);
  });
}
export async function dragResourceFiles(directory: string, names: unknown): Promise<string[]> {
  return dragResourceFilesSync(directory, names);
}
