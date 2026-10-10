import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { downloadAll, type DownloadTask, type MirrorPref } from './download';
import { downloadLimiter } from './downloadLimits';
import type { ProgressEvent } from '../../shared/types';
import { translate as t } from '../../shared/i18n';

/** Read declared remote artifacts only. Empty URLs belong to embedded/generated files. */
export function installerDependencyTasks(jar: string, target: string): DownloadTask[] {
  const zip = new AdmZip(jar),
    tasks = new Map<string, DownloadTask>();
  const root = path.resolve(target, 'libraries');
  for (const name of ['install_profile.json', 'version.json']) {
    const entry = zip.getEntry(name);
    if (!entry) continue; // Old installers continue through their native installer path.
    if (entry.header.size > 8 * 1024 * 1024) throw new Error(t('installer.error.metadata_too_large'));
    const profile = JSON.parse(entry.getData().toString('utf8'));
    for (const lib of profile.libraries ?? []) {
      const artifact = lib.downloads?.artifact;
      if (!artifact?.url || !artifact.path) continue;
      const dest = path.resolve(root, artifact.path),
        relative = path.relative(root, dest);
      if (
        !relative ||
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        artifact.path.includes('\\') ||
        artifact.path.includes(':')
      )
        throw new Error(t('installer.error.dependency_path_escape'));
      const url = new URL(artifact.url);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error(t('installer.error.dependency_url_invalid'));
      // Every existing ancestor is checked: never write through a user-created junction.
      for (let dir = path.dirname(dest); dir.length >= root.length; dir = path.dirname(dir)) {
        if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(t('installer.error.dependency_dir_link'));
        if (dir === root) break;
      }
      const task = { url: artifact.url, dest, sha1: artifact.sha1, size: artifact.size };
      const previous = tasks.get(dest);
      if (previous && (previous.sha1 !== task.sha1 || previous.size !== task.size))
        throw new Error(t('installer.error.conflicting_dependency'));
      tasks.set(dest, task);
    }
  }
  return [...tasks.values()];
}

export async function prepareInstallerDependencies(
  jar: string,
  target: string,
  mirror: MirrorPref,
  emit: (event: ProgressEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const tasks = installerDependencyTasks(jar, target);
  if (!tasks.length) return;
  await downloadAll(
    tasks,
    (done, total, speed, detail) =>
      emit({
        stage: 'loader-dependencies',
        progress: detail.fraction ?? 0,
        text: t('installer.progress.download_dependencies', { done, total }),
        speed,
        bytesDone: detail.bytesDone,
        bytesTotal: detail.bytesTotal ?? undefined,
        etaSeconds: detail.etaSeconds ?? undefined,
        indeterminate: detail.indeterminate,
      }),
    downloadLimiter.maxConcurrent,
    mirror,
    signal
  );
}
