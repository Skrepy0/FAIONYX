import fs from 'node:fs';
import path from 'node:path';
import type { InstalledVersion } from '../../shared/types';
import { translate as t } from '../../shared/i18n';

/** The validated scanner target carries the actual --gameDir, including isolation. */
export function importResourceFiles(files: string[], target: InstalledVersion, kind: string): number {
  if (!['mods', 'resourcepacks', 'shaderpacks'].includes(kind) || !target.gameDirectory)
    throw new Error(t('resourcefiles.error.invalid_dir'));
  if (!files.length) throw new Error(t('resourcefiles.error.no_files'));
  const dir = path.join(target.gameDirectory, kind);
  const names = new Set<string>();
  const copies = files.map((file) => {
    const name = path.basename(file),
      stat = fs.statSync(file),
      dest = path.join(dir, name);
    if (stat.isDirectory() ? kind === 'mods' : !(kind === 'mods' ? /\.jar(?:\.disabled)?$/i : /\.zip$/i).test(name))
      throw new Error(t('resourcefiles.error.unsupported_on_page', { name }));
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(t('resourcefiles.error.unsupported_type'));
    if (names.has(name.toLowerCase()) || fs.existsSync(dest)) throw new Error(t('resourcefiles.error.same_name', { name }));
    names.add(name.toLowerCase());
    return { file, dest, directory: stat.isDirectory() };
  });
  fs.mkdirSync(dir, { recursive: true });
  for (const item of copies) {
    if (item.directory) fs.cpSync(item.file, item.dest, { recursive: true, force: false, errorOnExist: true });
    else fs.copyFileSync(item.file, item.dest, fs.constants.COPYFILE_EXCL);
  }
  return copies.length;
}
