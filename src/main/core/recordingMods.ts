import fs from 'node:fs';
import path from 'node:path';
import type { CommunityFile, InstallOptions, LoaderName } from '../../shared/types';
import type { RecordingKind } from '../../shared/recordings';
import { RECORDING_PROJECTS, compatibleRecordingMod, resolveRecordingDependencies } from '../../shared/recordingMods';
import { communityExactFile, communityFiles } from './community';
import { withFileJob } from './fileJobs';
import { modHash, replaceModFiles } from './modTransaction';
import { assertInstanceIdle } from './instanceCenter';
import { rememberModIdentity } from './modState';
import { translate as t } from '../../shared/i18n';

export async function recordingModVersions(kind: RecordingKind, mc: string, loader: LoaderName): Promise<CommunityFile[]> {
  if (
    !Object.hasOwn(RECORDING_PROJECTS, kind) ||
    !['fabric', 'quilt', 'forge', 'neoforge'].includes(loader) ||
    typeof mc !== 'string' ||
    mc.length > 100
  )
    throw new Error(t('recordingmods.error.selection_required'));
  return (await communityFiles('modrinth', RECORDING_PROJECTS[kind], { kind: 'mod', mcVersion: mc, loader })).filter(
    (f) => f.projectId === RECORDING_PROJECTS[kind] && compatibleRecordingMod(f, mc, loader)
  );
}
export async function prepareRecordingMod(mc: string, opts: InstallOptions): Promise<CommunityFile[]> {
  if (!opts.recordingMod) return [];
  if (!opts.loader) throw new Error(t('recordingmods.error.loader_required'));
  const selection = opts.recordingMod;
  const selected = (await recordingModVersions(selection.kind, mc, opts.loader)).find((f) => f.fileId === selection.fileId);
  if (!selected) throw new Error(t('recordingmods.error.version_unavailable'));
  const roots = [selected];
  if (opts.loader === 'fabric' && opts.fabricApi) {
    const api = (await communityFiles('modrinth', 'P7dR8mSH', { kind: 'mod', mcVersion: mc, loader: opts.loader })).find(
      (f) => f.version === opts.fabricApi
    );
    if (!api) throw new Error(t('recordingmods.error.fabric_api_unavailable'));
    roots.push(api);
  }
  return resolveRecordingDependencies(roots, mc, opts.loader, async (project, file) => {
    if (file) {
      const exact = await communityExactFile('modrinth', project, file);
      if (project && exact.projectId !== project) throw new Error(t('recordingmods.error.project_mismatch'));
      return exact;
    }
    if (!project) throw new Error(t('recordingmods.error.dependency_no_project'));
    const candidate = (await communityFiles('modrinth', project, { kind: 'mod', mcVersion: mc, loader: opts.loader })).find((f) =>
      compatibleRecordingMod(f, mc, opts.loader!)
    );
    if (!candidate) throw new Error(t('recordingmods.error.dependency_no_compatible', { project }));
    return candidate;
  });
}
export async function installRecordingMods(
  dir: string,
  files: CommunityFile[],
  signal?: AbortSignal,
  progress?: (fraction: number) => void
) {
  await fs.promises.mkdir(dir, { recursive: true });
  if ((await fs.promises.lstat(dir)).isSymbolicLink()) throw new Error(t('recordingmods.error.dir_link'));
  return withFileJob(dir, signal, async () => {
    const needed: CommunityFile[] = [];
    for (const f of files) {
      const dest = path.join(dir, f.fileName);
      if (fs.existsSync(dest)) {
        if ((await modHash(dest)) !== f.sha1) throw new Error(t('recordingmods.error.same_name_conflict', { name: f.fileName }));
      } else needed.push(f);
    }
    if (needed.length)
      await replaceModFiles(
        dir,
        needed.map((f) => ({ name: f.fileName, sha1: f.sha1!, url: f.url, size: f.size })),
        () => assertInstanceIdle(path.dirname(dir)),
        signal,
        progress
      );
    for (const f of files) if (f.source && f.projectId && f.sha1) rememberModIdentity(dir, f.sha1, `${f.source}:${f.projectId}`);
  });
}
