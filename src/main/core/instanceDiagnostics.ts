import { scanModDirectory } from './modScan';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DiagnosticFinding, InstanceTarget } from '../../shared/instanceCenter';
import type { JavaInfo } from '../../shared/types';
import { centerTarget, assertInstanceIdle } from './instanceCenter';
import { withGameFolder, assetsDir, defaultFolderPath } from './paths';
import { resolveVersionChain, launchLibraryFiles, clientJarPath } from './versions';
import { invalidLaunchArtifact, ensureLaunchArtifact, type LaunchArtifact } from './launchIntegrity';
import {
  listJavaSummary,
  resolveJavaRequirement,
  javaCompatibilityError,
  probeJavaAsync,
  resolveJavaExecutable,
  validateCandidateJava,
  type JavaRequirement,
} from './java';
import { gameJavaArchitecture } from './javaArchitecture';
import { readClientVersionEvidence } from './instanceVersionEvidence';
import { getSettings } from './settings';
import { exitHistory } from './exitHistory';
import { getLastLaunch } from './launch';
import { analyzeDiagnosticText } from './diagnosticRules';
import { samePath } from './folderPaths';
import { safePath, type BackupProgress } from './backupStore';
import { withFileJob } from './fileJobs';
import { redactDiagnosticText } from './diagnostics';
import { selectDiagnosticSession } from './diagnosticSession';
import { translate as t } from '../../shared/i18n';
const plans = new Map<string, { target: InstanceTarget; files: LaunchArtifact[]; metadata: string; time: number }>();
async function tail(file: string) {
  const stat = await fs.promises.stat(file);
  const size = Math.min(stat.size, 2 * 1024 * 1024),
    handle = await fs.promises.open(file, 'r');
  try {
    const data = Buffer.alloc(size);
    await handle.read(data, 0, size, stat.size - size);
    return data.toString('utf8');
  } finally {
    await handle.close();
  }
}
export async function diagnoseInstance(
  target: InstanceTarget,
  signal?: AbortSignal,
  progress?: BackupProgress
): Promise<{ id: string; findings: DiagnosticFinding[]; java: JavaInfo[]; session?: string; requiredJava: number | null }> {
  const c = centerTarget(target);
  return withGameFolder(c.folder, async () => {
    const findings: DiagnosticFinding[] = [],
      { merged, baseId } = resolveVersionChain(target.id);
    const client = { ...merged.downloads?.client, dest: clientJarPath(baseId) };
    const verifiedMcVersion = (await invalidLaunchArtifact(client)) ? undefined : readClientVersionEvidence(client.dest);
    let requirement: JavaRequirement | undefined;
    try {
      requirement = await resolveJavaRequirement(merged, verifiedMcVersion, { signal, modsDirectory: path.join(c.dir, 'mods') });
    } catch (error) {
      signal?.throwIfAborted();
      findings.push({
        rule: 'java-requirement',
        title: t('instdiag.rule.java_requirement_title'),
        confidence: 'unknown',
        evidence: redactDiagnosticText(String(error)),
        advice: t('instdiag.rule.java_requirement_advice'),
        action: 'java',
      });
    }
    const need = requirement?.recommendedMajor ?? null,
      arch = gameJavaArchitecture(merged),
      java: JavaInfo[] = [];
    if (requirement)
      for (const candidate of await listJavaSummary()) {
        signal?.throwIfAborted();
        if (javaCompatibilityError(candidate, requirement, arch, true)) continue;
        try {
          const actual = await validateCandidateJava(candidate, signal);
          if (!javaCompatibilityError(actual, requirement, arch, true)) java.push(actual);
        } catch {
          signal?.throwIfAborted();
        }
      }
    const configured = c.json._javaAuto ? undefined : c.json._javaPath || (!getSettings().javaAuto ? getSettings().javaPath : undefined);
    if (configured && !fs.existsSync(configured))
      findings.push({
        rule: 'java-missing',
        title: t('instdiag.rule.java_missing_title'),
        confidence: 'certain',
        evidence: redactDiagnosticText(configured),
        advice: need ? t('instdiag.rule.java_missing_advice_version', { version: need }) : t('instdiag.rule.java_missing_advice_generic'),
        action: 'java',
      });
    else if (configured && requirement) {
      try {
        const exe = await resolveJavaExecutable(configured, signal),
          selected = await probeJavaAsync(exe, signal);
        if (!selected) throw new Error(t('launch.error.java_unusable'));
        const error = javaCompatibilityError(selected, requirement, arch);
        if (error) throw new Error(error);
        await validateCandidateJava(selected, signal);
      } catch (error) {
        signal?.throwIfAborted();
        findings.push({
          rule: 'java-selection',
          title: t('instdiag.rule.java_selection_title'),
          confidence: 'certain',
          evidence: redactDiagnosticText(String(error)),
          advice: t('instdiag.rule.java_selection_advice'),
          action: 'java',
        });
      }
    } else if (requirement && !java.length)
      findings.push({
        rule: 'java-unavailable',
        title: t('instdiag.rule.java_unavailable_title'),
        confidence: 'possible',
        evidence: t('instdiag.rule.java_unavailable_evidence', { version: need ?? '', arch: arch ? '，' + arch : '' }),
        advice: t('instdiag.rule.java_unavailable_advice'),
        action: 'java',
      });
    const files: LaunchArtifact[] = [client, ...launchLibraryFiles(merged)];
    const asset = merged.assetIndex;
    if (asset && /^[\w.-]+$/.test(asset.id) && asset.id !== '.' && asset.id !== '..')
      files.push({ ...asset, dest: path.join(assetsDir(), 'indexes', asset.id + '.json') });
    const bad: LaunchArtifact[] = [];
    async function check(file: LaunchArtifact) {
      signal?.throwIfAborted();
      const reason = await invalidLaunchArtifact(file);
      if (reason) {
        bad.push(file);
        if (findings.filter((f) => f.rule === 'files').length < 10)
          findings.push({
            rule: 'files',
            title: t('instdiag.rule.files_title'),
            confidence: 'certain',
            evidence: path.basename(file.dest) + '：' + reason,
            advice: file.url ? t('instdiag.rule.files_advice_repair') : t('instdiag.rule.files_advice_no_url'),
            action: file.url ? 'files' : undefined,
          });
      }
    }
    for (let i = 0; i < files.length; i++) {
      await check(files[i]);
      progress?.(i + 1, files.length, t('instdiag.progress.check_files'));
    }
    if (asset && !bad.some((f) => f.dest.endsWith('/' + asset.id + '.json') || path.basename(f.dest) === asset.id + '.json')) {
      try {
        const index = JSON.parse(await fs.promises.readFile(path.join(assetsDir(), 'indexes', asset.id + '.json'), 'utf8'));
        const objects = Object.values(index.objects || {}) as Array<{ hash: string; size: number }>;
        for (let i = 0; i < objects.length; i++) {
          const o = objects[i];
          if (!/^[a-f0-9]{40}$/.test(o.hash)) continue;
          await check({
            dest: path.join(assetsDir(), 'objects', o.hash.slice(0, 2), o.hash),
            sha1: o.hash,
            size: o.size,
            url: 'https://resources.download.minecraft.net/' + o.hash.slice(0, 2) + '/' + o.hash,
          });
          if (i % 64 === 0) progress?.(i, objects.length, t('instdiag.progress.check_assets'));
        }
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }
    const latest = getLastLaunch(),
      hist = exitHistory()
        .list()
        .filter(
          (e) =>
            e.kind === 'game' &&
            e.context?.effectiveGameDir &&
            samePath(String(e.context.effectiveGameDir), c.dir) &&
            e.context.versionId === target.id
        );
    const context = selectDiagnosticSession(target.id, c.dir, [...(latest ? [latest] : []), ...hist.map((e) => e.context!)]);
    let session: string | undefined;
    if (context?.logDir && context.startedAt) {
      session = String(context.startedAt);
      const logDir = String(context.logDir);
      let text = '';
      for (const name of ['stdout.log', 'stderr.log'])
        try {
          const f = await safePath(logDir, name);
          text += '\n' + (await tail(f));
        } catch {}
      findings.push(...analyzeDiagnosticText(text));
    } else
      findings.push({
        rule: 'no-session',
        title: t('instdiag.rule.no_session_title'),
        confidence: 'unknown',
        evidence: t('instdiag.rule.no_session_evidence'),
        advice: t('instdiag.rule.no_session_advice'),
      });
    if (findings.some((f) => f.action === 'mods'))
      try {
        const mods = await scanModDirectory(path.join(c.dir, 'mods'), false);
        for (const f of findings.filter((f) => f.action === 'mods'))
          f.mods = mods
            .filter(
              (m) =>
                f.evidence.includes(m.fileName) ||
                (m.id &&
                  new RegExp('(?:^|[^a-zA-Z0-9_])' + m.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^a-zA-Z0-9_])').test(f.evidence))
            )
            .map((m) => ({ fileName: m.fileName, name: m.name || m.fileName, icon: m.iconDataUrl }));
      } catch {}
    for (const [id, p] of plans) if (Date.now() - p.time > 30 * 60 * 1000) plans.delete(id);
    const id = crypto.randomUUID();
    plans.set(id, { target: c.target, files: bad.filter((f) => f.url), metadata: JSON.stringify(merged), time: Date.now() });
    return { id, findings, java, session, requiredJava: need };
  });
}
export async function repairInstanceFiles(planId: string, signal?: AbortSignal, progress?: BackupProgress) {
  const p = plans.get(planId);
  if (!p || Date.now() - p.time > 30 * 60 * 1000) throw new Error(t('instdiag.error.plan_expired'));
  const c = centerTarget(p.target);
  await assertInstanceIdle(c.dir);
  return withGameFolder(c.folder, async () => {
    if (JSON.stringify(resolveVersionChain(p.target.id).merged) !== p.metadata) throw new Error(t('instdiag.error.version_changed'));
    let done = 0;
    for (const f of p.files) {
      signal?.throwIfAborted();
      await assertInstanceIdle(c.dir);
      const roots = [c.folder, defaultFolderPath()];
      const root = roots.find((r) => {
        const rel = path.relative(r, f.dest);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!root) throw new Error(t('instdiag.error.repair_outside_gamedir'));
      await safePath(root, path.relative(root, f.dest).split(path.sep).join('/'), true);
      await withFileJob(f.dest, signal, () => ensureLaunchArtifact(f, getSettings().mirror, undefined, signal));
      progress?.(++done, p.files.length, t('instdiag.progress.repair_files', { done, total: p.files.length }));
    }
    plans.delete(planId);
    return done;
  });
}
