import fs from 'node:fs';
import path from 'node:path';
import type { InstalledVersion, ModInfo, ModInstallResult } from '../../shared/types';
import { modMatchesInstance } from '../../shared/modCompatibility';
import { canonicalPath, pathIdentity } from './folderPaths';

export function scanModTargets(
  folders: string[],
  scan: (folder: string) => { versions: InstalledVersion[]; errors: string[] }
): { versions: InstalledVersion[]; errors: string[] } {
  const versions: InstalledVersion[] = [],
    errors: string[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const key = pathIdentity(folder);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!fs.statSync(folder).isDirectory()) throw new Error('不是文件夹');
      const result = scan(canonicalPath(folder));
      versions.push(...result.versions);
      errors.push(...result.errors.map((e) => `${folder}：${e}`));
    } catch (error) {
      errors.push(`${folder}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { versions, errors };
}

export function selectModTarget(versions: InstalledVersion[], id: string, folder: string): InstalledVersion {
  const target = versions.find((v) => v.id === id && v.folder && pathIdentity(v.folder) === pathIdentity(folder));
  if (!target || target.incomplete || target.failed || !target.gameDirectory) throw new Error('目标实例已移除、不完整或未登记，请重新扫描');
  return target;
}

/** Revalidate in the main process, and use the scanner's effective --gameDir, not active-folder globals. */
export async function copyCompatibleMods(
  files: string[],
  target: InstalledVersion,
  parse: (file: string) => ModInfo
): Promise<ModInstallResult[]> {
  const dir = path.join(target.gameDirectory!, 'mods');
  const results: ModInstallResult[] = [];
  for (const file of files) {
    const name = path.basename(file);
    try {
      const mod = parse(file);
      if (!modMatchesInstance(mod, target))
        throw new Error(`不兼容：MC ${target.mcVersion} / ${target.loader} ${target.loaderVersion ?? '版本未知'}`);
      await fs.promises.mkdir(dir, { recursive: true });
      // Never overwrite user-added content as a side effect of target selection.
      await fs.promises.copyFile(file, path.join(dir, name), fs.constants.COPYFILE_EXCL);
      results.push({ fileName: name, ok: true, message: '已装入' });
    } catch (e) {
      results.push({
        fileName: name,
        ok: false,
        message: (e as NodeJS.ErrnoException).code === 'EEXIST' ? '同名文件已存在，未覆盖' : e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}
