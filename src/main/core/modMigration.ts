import { isModLocked, setModLocked } from './modState';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CommunityFile, LoaderName } from '../../shared/types';
import type { MigrationEntry, ModMigrationPlan } from '../../shared/modMigration';
import { scanModDirectory } from './modScan';
import { resolveResourceDirectory, requireResourceVersion } from './resourceDirectory';
import { withGameFolder } from './paths';
import { installVersion, type ProgressEmit } from './versions';
import { setNewInstanceIsolation } from './instances';
import { listLoaderVersions } from './loaders';
import { communityFiles, communityExactFile, cfChannel } from './community';
import { httpFetch } from './httpClient';
import { downloadFile } from './download';
import { fileHash } from './fileHash';
import { translate as t } from '../../shared/i18n';
const plans = new Map<string, ModMigrationPlan>(),
  running = new Set<string>();
const MR = 'https://api.modrinth.com/v2';
async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await httpFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'FAIONYX (github.com/Skrepy0/FAIONYX)', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(t('modmigration.error.community_query', { status: r.status }));
  return r.json() as Promise<any>;
}
export function compatibleFile(file: CommunityFile, mc: string, loader: string) {
  return (
    !!file.url &&
    /^https:\/\//.test(file.url) &&
    /^[a-f0-9]{40}$/i.test(file.sha1 || '') &&
    file.gameVersions.includes(mc) &&
    file.loaders.includes(loader as LoaderName) &&
    /\.jar$/i.test(file.fileName) &&
    path.basename(file.fileName) === file.fileName &&
    !/[\\/:\0]/.test(file.fileName)
  );
}
export async function planModMigration(sourceId: string, folder: string, mcVersion: string, loader: LoaderName): Promise<ModMigrationPlan> {
  requireResourceVersion(sourceId);
  if (!/^[a-zA-Z0-9._-]{1,40}$/.test(mcVersion) || !['fabric', 'forge', 'neoforge', 'quilt'].includes(loader))
    throw new Error(t('modmigration.error.invalid_target'));
  const dir = await resolveResourceDirectory(folder, sourceId, 'mods');
  const names = (
    await fs.promises.readdir(dir, { withFileTypes: true }).catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    })
  )
    .filter((e) => e.isFile() && /\.jar(?:\.disabled)?$/i.test(e.name))
    .map((e) => e.name);
  if (names.length > 500) throw new Error(t('modmigration.error.too_many_mods'));
  if (!names.length) throw new Error(t('modmigration.error.no_mods'));
  const [scanned, loaders] = await Promise.all([scanModDirectory(dir, true, names), listLoaderVersions(loader, mcVersion)]);
  if (!loaders[0]) throw new Error(t('modmigration.error.no_loader', { loader, mcVersion }));
  const entries: MigrationEntry[] = [];
  for (const i of scanned)
    entries.push({
      fileName: i.fileName,
      name: i.name || i.fileName,
      currentVersion: i.version || '',
      sha1: i.sha1 || (await fileHash(path.join(dir, i.fileName))),
      disabled: /\.disabled$/i.test(i.fileName),
      status: 'unavailable',
      reason: i.error ? t('modmigration.reason.unparsable') : t('modmigration.reason.unmatched'),
    });
  let originals: any = {},
    updates: any = {},
    mrError = '';
  try {
    originals = await post(MR + '/version_files', { hashes: entries.map((e) => e.sha1), algorithm: 'sha1' });
    updates = await post(MR + '/version_files/update', {
      hashes: entries.map((e) => e.sha1),
      algorithm: 'sha1',
      game_versions: [mcVersion],
      loaders: [loader],
    });
  } catch (e) {
    mrError = String(e);
  }
  const missing = entries.filter((e) => !originals[e.sha1]),
    cfIds = new Map<string, string>();
  if (missing.length) {
    const channel = cfChannel();
    try {
      const result = await post(
        channel.base + '/fingerprints',
        {
          fingerprints: scanned
            .filter((i) => missing.some((e) => e.fileName === i.fileName))
            .map((i) => i.fingerprint)
            .filter((x) => x != null),
        },
        channel.key ? { 'x-api-key': channel.key } : {}
      );
      for (const e of missing) {
        const match = result.data?.exactMatches?.find((m: any) =>
          m.file?.hashes?.some((h: any) => h.algo === 1 && String(h.value).toLowerCase() === e.sha1)
        );
        if (match) cfIds.set(e.sha1, String(match.file.modId || match.id));
      }
    } catch (e) {
      throw new Error(t('modmigration.error.origin_lookup_failed', { error: mrError || String(e) }));
    }
  }
  if (mrError) throw new Error(t('modmigration.error.modrinth_failed', { error: mrError }));
  const versions = new Map<string, CommunityFile>();
  let index = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (index < entries.length) {
        const e = entries[index++],
          v = updates[e.sha1],
          project = originals[e.sha1]?.project_id;
        if (project) {
          e.reason = t('modmigration.reason.project_no_file');
          if (v) {
            const f = v.files?.find((x: any) => x.primary) || v.files?.[0];
            if (f) {
              const file: CommunityFile = {
                source: 'modrinth',
                projectId: v.project_id,
                fileId: v.id,
                fileName: f.filename,
                url: f.url,
                sha1: f.hashes?.sha1,
                size: f.size,
                releaseType: v.version_type || 'release',
                version: v.version_number,
                date: v.date_published,
                gameVersions: v.game_versions || [],
                loaders: v.loaders || [],
                dependencies: v.dependencies?.map((d: any) => ({
                  required: d.dependency_type === 'required',
                  projectId: d.project_id,
                  fileId: d.version_id,
                })),
              };
              if (compatibleFile(file, mcVersion, loader)) {
                e.target = file;
                e.status = 'compatible';
                versions.set(file.source + ':' + file.projectId, file);
              }
            }
          }
        } else if (cfIds.has(e.sha1)) {
          e.reason = t('modmigration.reason.project_no_download');
          const list = await communityFiles('curseforge', cfIds.get(e.sha1)!, { mcVersion, loader, kind: 'mod' });
          const file = list.find((f) => compatibleFile(f, mcVersion, loader));
          if (file) {
            e.target = file;
            e.status = 'compatible';
            versions.set(file.source + ':' + file.projectId, file);
          }
        }
      }
    })
  );
  const warnings: string[] = entries
      .filter((e) => isModLocked(dir, e.sha1))
      .map((e) => t('modmigration.warn.locked_rematch', { name: e.fileName })),
    visited = new Set<string>();
  for (let n = 0; n < entries.length; n++) {
    if (entries.length > 500) throw new Error(t('modmigration.error.too_many_deps'));
    const e = entries[n];
    if (!e.target || e.disabled) continue;
    for (const dep of e.target.dependencies || []) {
      if (!dep.required) continue;
      const source = e.target.source || 'modrinth',
        key = source + ':' + (dep.projectId || '') + ':' + (dep.fileId || '');
      if (visited.has(key)) continue;
      visited.add(key);
      const existing = versions.get(source + ':' + dep.projectId);
      if (existing) {
        if (entries.filter((x) => x.target?.source === source && x.target?.projectId === dep.projectId).every((x) => x.disabled))
          entries.push({
            fileName: '',
            name: existing.fileName,
            currentVersion: '',
            sha1: '',
            disabled: false,
            status: 'dependency',
            target: existing,
          });
        if (dep.fileId && existing.fileId !== dep.fileId)
          warnings.push(t('modmigration.warn.dep_version_mismatch', { name: e.fileName, dep: dep.fileId, current: existing.fileName }));
        continue;
      }
      try {
        const file = dep.fileId
          ? await communityExactFile(source, dep.projectId, dep.fileId)
          : (await communityFiles(source, dep.projectId || '', { mcVersion, loader, kind: 'mod' })).find((f) =>
              compatibleFile(f, mcVersion, loader)
            );
        if (!file || !compatibleFile(file, mcVersion, loader)) throw new Error(t('modmigration.error.no_compatible_file'));
        versions.set(source + ':' + file.projectId, file);
        entries.push({
          fileName: '',
          name: file.fileName,
          currentVersion: '',
          sha1: '',
          disabled: false,
          status: 'dependency',
          target: file,
        });
      } catch (err) {
        warnings.push(
          t('modmigration.warn.dep_unmatched', {
            name: e.fileName || e.name,
            dep: dep.projectId || dep.fileId || t('modmigration.error.unknown'),
            error: String(err),
          })
        );
      }
    }
  }
  const plan: ModMigrationPlan = {
    id: crypto.randomUUID(),
    sourceId,
    folder,
    mcVersion,
    loader,
    loaderVersion: loaders[0],
    entries,
    warnings,
    createdAt: Date.now(),
  };
  for (const [id, p] of plans) if (Date.now() - p.createdAt > 1800000) plans.delete(id);
  plans.set(plan.id, structuredClone(plan));
  return plan;
}
export async function validateMigrationSource(plan: ModMigrationPlan, dir: string) {
  const names = (await fs.promises.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.jar(?:\.disabled)?$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  const expected = plan.entries
    .filter((e) => e.fileName)
    .map((e) => e.fileName)
    .sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(t('modmigration.error.list_changed'));
  for (const e of plan.entries.filter((e) => e.fileName)) {
    const stat = await fs.promises.lstat(path.join(dir, e.fileName));
    if (!stat.isFile() || stat.isSymbolicLink() || (await fileHash(path.join(dir, e.fileName))) !== e.sha1)
      throw new Error(t('modmigration.error.file_changed', { name: e.fileName }));
  }
}
export function migrationInstanceId(source: string, mc: string, id: string) {
  return source.slice(0, 50 - mc.length).replace(/[\uD800-\uDBFF]$/, '') + ' - ' + mc + ' - ' + id.slice(0, 8);
}
export async function applyModMigration(id: string, confirmMissing: boolean, emit: ProgressEmit, signal?: AbortSignal) {
  const plan = plans.get(id);
  if (!plan || Date.now() - plan.createdAt > 1800000) throw new Error(t('modmigration.error.plan_expired'));
  if ((plan.entries.some((e) => e.status === 'unavailable') || plan.warnings.length) && confirmMissing !== true)
    throw new Error(t('modmigration.error.confirm_missing_required'));
  if (running.has(id)) throw new Error(t('modmigration.error.already_running'));
  running.add(id);
  let stage = '';
  try {
    const dir = await resolveResourceDirectory(plan.folder, plan.sourceId, 'mods');
    emit({ stage: 'download', progress: 0, overall: 0, text: t('modmigration.state.validating_source') });
    await validateMigrationSource(plan, dir);
    if (!confirmMissing && plan.entries.some((e) => e.fileName && isModLocked(dir, e.sha1)))
      throw new Error(t('modmigration.error.mod_locked'));
    signal?.throwIfAborted();
    stage = await fs.promises.mkdtemp(path.join(plan.folder, '.faionyx-migration-'));
    let i = 0;
    const used = new Map<string, string>();
    for (const e of plan.entries) {
      signal?.throwIfAborted();
      const base = e.target?.fileName || e.fileName.replace(/\.disabled$/i, ''),
        name = base + (e.disabled || !e.target ? '.disabled' : '');
      const digest = e.target?.sha1 || e.sha1;
      const previous = used.get(name.toLowerCase());
      if (previous) {
        if (previous !== digest) throw new Error(t('modmigration.error.name_conflict', { name }));
        continue;
      }
      used.set(name.toLowerCase(), digest);
      const dest = path.join(stage, name);
      if (e.target)
        await downloadFile(
          e.target.url,
          dest,
          (d, total) =>
            emit({
              stage: 'download',
              progress: total ? d / total : 0,
              overall: (0.65 * (i + (total ? d / total : 0))) / plan.entries.length,
              text: t('modmigration.state.migrating_mod', { name: e.fileName || e.name }),
            }),
          e.target.sha1,
          undefined,
          signal,
          [],
          { size: e.target.size }
        );
      else await fs.promises.copyFile(path.join(dir, e.fileName), dest, fs.constants.COPYFILE_EXCL);
      i++;
    }
    await validateMigrationSource(plan, dir);
    signal?.throwIfAborted();
    const targetId = migrationInstanceId(plan.sourceId, plan.mcVersion, plan.id);
    requireResourceVersion(targetId);
    if (fs.existsSync(path.join(plan.folder, 'versions', targetId))) throw new Error(t('modmigration.error.target_instance_exists'));
    await withGameFolder(plan.folder, async () => {
      await installVersion(
        plan.mcVersion,
        { loader: plan.loader, loaderVersion: plan.loaderVersion, instanceName: targetId },
        (e) =>
          emit({ ...e, overall: 0.65 + 0.3 * (e.overall ?? e.progress), text: t('modmigration.state.preparing_target', { text: e.text }) }),
        signal
      );
      setNewInstanceIsolation(targetId, true);
      const marker = path.join(plan.folder, 'versions', targetId, '.installing');
      await fs.promises.writeFile(marker, t('modmigration.marker.installing'));
      signal?.throwIfAborted();
      const mods = await resolveResourceDirectory(plan.folder, targetId, 'mods');
      if (fs.existsSync(mods)) throw new Error(t('modmigration.error.mods_dir_exists'));
      for (const e of plan.entries)
        if (e.fileName && isModLocked(dir, e.sha1)) {
          if (!confirmMissing) throw new Error(t('modmigration.error.mod_locked_confirm'));
          setModLocked(mods, e.target?.sha1 || e.sha1, true);
        }
      await fs.promises.rename(stage, mods);
      stage = '';
      await fs.promises.writeFile(path.join(plan.folder, 'versions', targetId, 'migration-report.json'), JSON.stringify(plan, null, 2));
      await fs.promises.rm(marker, { force: true });
    });
    plans.delete(id);
    emit({ stage: 'done', progress: 1, overall: 1, text: t('modmigration.state.done', { id: targetId }) });
    return { versionId: targetId, folder: plan.folder };
  } finally {
    running.delete(id);
    if (stage) {
      const resolved = path.resolve(stage),
        root = path.resolve(plan.folder) + path.sep;
      if (!resolved.startsWith(root) || !path.basename(resolved).startsWith('.faionyx-migration-'))
        throw new Error(t('modmigration.error.temp_dir_invalid'));
      await fs.promises.rm(resolved, { recursive: true, force: true });
    }
  }
}
