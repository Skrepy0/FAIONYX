import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImportProbeResult } from '../../shared/types';
import { probeModpack, probeRecognizedModpack } from './modpacks';
import { probeWorld } from './worlds';
import { translate as t } from '../../shared/i18n';

/** A bundled save is subordinate to a recognized pack at every general import entry point. */
export async function probeImport(inputPath: string): Promise<ImportProbeResult> {
  if (!inputPath) throw new Error(t('importprobe.error.select_file'));
  const stat = await fs.lstat(inputPath);
  if (stat.isSymbolicLink()) throw new Error(t('importprobe.error.symlink'));
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(t('importprobe.error.unsupported_type'));
  const ext = path.extname(inputPath).toLowerCase();
  if (stat.isFile() && ext === '.jar') return { kind: 'mod' };
  if (stat.isFile() && (ext === '.zip' || ext === '.mrpack')) {
    const info = ext === '.mrpack' ? await probeModpack(inputPath) : await probeRecognizedModpack(inputPath);
    if (info) return { kind: 'modpack', info };
  }
  const world = await probeWorld(inputPath);
  if (world) return { kind: 'world', info: world };
  if (stat.isDirectory()) return { kind: 'mod' };
  return { kind: 'unsupported', message: t('importprobe.message.unrecognized') };
}
