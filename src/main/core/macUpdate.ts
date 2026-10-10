import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { app } from 'electron';
import type { ReleaseInfo } from '../../shared/types';
import { atomicUpdateJson, validateUpdatePayload, type UpdateTransaction } from './updateTransaction';
import { updateAssetName } from './updateTrust';
import { sha256File, currentVersion } from './selfUpdate';
import { compareSemver } from '../../shared/semver';
import { translate as t } from '../../shared/i18n';

const run = promisify(execFile);
const data = () => app.getPath('userData');
const marker = () => path.join(data(), 'mac-update.json');
const claim = () => marker() + '.applying';
function recordFailure(error: unknown): void {
  try {
    fs.appendFileSync(path.join(data(), 'mac-updater.log'), `${new Date().toISOString()} ${String(error)}\n`);
  } catch {
    /* preserve startup on read-only storage */
  }
}
export const macUpdateDir = () => path.join(data(), 'mac-updates');
export function macAppTarget(): string | null {
  if (process.platform !== 'darwin' || !app.isPackaged) return null;
  const target = path.resolve(process.execPath, '../../..');
  return target.endsWith('.app') && fs.existsSync(path.join(target, 'Contents/Info.plist')) ? target : null;
}
export function macUpdateSupported(): boolean {
  const target = macAppTarget();
  if (!target || target.startsWith('/Volumes/') || target.includes('/AppTranslocation/')) return false;
  try {
    fs.accessSync(path.dirname(target), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
export function readMacUpdate(file = marker()): UpdateTransaction | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as UpdateTransaction;
    if (
      parsed.schema !== 1 ||
      !/^[a-f\d-]{36}$/i.test(parsed.id) ||
      parsed.target !== macAppTarget() ||
      !inside(macUpdateDir(), parsed.file) ||
      !/^[a-f\d]{64}$/.test(parsed.sha256) ||
      !Number.isSafeInteger(parsed.size) ||
      parsed.size <= 0 ||
      !/^\d+\.\d+\.\d+$/.test(parsed.release?.version) ||
      path.basename(parsed.file) !== updateAssetName(parsed.release.version) ||
      !['upgrade', 'rollback', 'local'].includes(parsed.mode)
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}
export function clearMacUpdate(): void {
  fs.rmSync(marker(), { force: true });
}
export function blockedMacVersion(): string | undefined {
  return (readMacUpdate(claim()) ?? readMacUpdate(claim() + '.failed'))?.release.version;
}
export async function stageMacUpdate(release: ReleaseInfo, file: string, sha256: string, mode: UpdateTransaction['mode']): Promise<void> {
  if (!macUpdateSupported()) throw new Error(t('macupdate.error.app_dir_not_writable'));
  if (path.basename(file) !== updateAssetName(release.version) || !inside(macUpdateDir(), file))
    throw new Error(t('macupdate.error.pick_arch_zip'));
  const txn: UpdateTransaction = {
    schema: 1,
    id: randomUUID(),
    target: macAppTarget()!,
    file,
    sha256,
    size: fs.statSync(file).size,
    from: currentVersion(),
    release,
    mode,
  };
  await validateUpdatePayload(txn);
  validateMacArchive(file);
  atomicUpdateJson(marker(), txn);
}

/** Reject traversal and escaping symlinks before handing the archive to ditto. */
export function validateMacArchive(file: string): void {
  const entries = new AdmZip(file).getEntries();
  let total = 0,
    hasApp = false;
  for (const e of entries) {
    const name = e.entryName;
    if (
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').includes('..') ||
      !(name.startsWith('FAIONYX.app/') || name === 'FAIONYX.app' || name.startsWith('__MACOSX/'))
    )
      throw new Error(t('macupdate.error.path_escape'));
    total += e.header.size;
    if (total > 3 * 1024 ** 3) throw new Error(t('macupdate.error.size_abnormal'));
    if (name === 'FAIONYX.app/Contents/Resources/app.asar') hasApp = true;
    if (((e.attr >>> 16) & 0xf000) === 0xa000) {
      const link = e.getData().toString('utf8');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), link));
      if (path.posix.isAbsolute(link) || !resolved.startsWith('FAIONYX.app/')) throw new Error(t('macupdate.error.symlink_escape'));
    }
  }
  if (!hasApp) throw new Error(t('macupdate.error.missing_app'));
}
async function verifyBundle(bundle: string, version: string): Promise<void> {
  const plist = path.join(bundle, 'Contents/Info.plist');
  const value = async (key: string) => (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).stdout.trim();
  if (
    (await value('CFBundleIdentifier')) !== 'com.faionyx.launcher' ||
    (await value('CFBundleShortVersionString')) !== version ||
    (await value('CFBundleExecutable')) !== 'FAIONYX'
  )
    throw new Error(t('macupdate.error.identity_mismatch'));
  await run('/usr/bin/lipo', [path.join(bundle, 'Contents/MacOS/FAIONYX'), '-verify_arch', process.arch === 'arm64' ? 'arm64' : 'x86_64']);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
}
const asar = (bundle: string) => path.join(bundle, 'Contents/Resources/app.asar');
// Hash the archive bytes outside Electron's virtual ASAR filesystem.
async function asarHash(bundle: string): Promise<string> {
  const hash = (await run('/usr/bin/shasum', ['-a', '256', asar(bundle)])).stdout.slice(0, 64);
  if (!/^[a-f\d]{64}$/.test(hash)) throw new Error(t('macupdate.error.archive_unverifiable'));
  return hash;
}
const q = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export function macUpdaterScript(
  txn: UpdateTransaction,
  stage: string,
  oldHash: string,
  newHash: string,
  pid: number,
  stateDir: string
): string {
  const backup = path.join(path.dirname(txn.target), `.FAIONYX-backup-${txn.id}.app`);
  const applying = path.join(stateDir, 'mac-update.json.applying');
  const state = JSON.stringify({
    from: txn.from,
    to: txn.release.version,
    time: new Date().toISOString(),
    backupPath: backup,
    backupVersion: txn.from,
    result: 'applied',
  });
  return `#!/bin/sh
set -eu
exec >>${q(path.join(stateDir, 'mac-updater.log'))} 2>&1
fail() { printf '%s' '${t('macupdate.script.fail_keep')}' >${q(path.join(stateDir, 'update-failed.flag'))}; mv -f ${q(applying)} ${q(applying + '.failed')} 2>/dev/null || true; }
trap fail EXIT
n=0
while kill -0 ${pid} 2>/dev/null; do n=$((n+1)); [ "$n" -lt 120 ] || exit 1; sleep 0.5; done
[ "$(/usr/bin/shasum -a 256 ${q(asar(txn.target))} | /usr/bin/awk '{print $1}')" = ${q(oldHash)} ]
[ "$(/usr/bin/shasum -a 256 ${q(asar(stage))} | /usr/bin/awk '{print $1}')" = ${q(newHash)} ]
/usr/bin/codesign --verify --deep --strict ${q(stage)}
/bin/mv ${q(txn.target)} ${q(backup)}
if ! /bin/mv ${q(stage)} ${q(txn.target)}; then /bin/mv ${q(backup)} ${q(txn.target)}; exit 1; fi
printf '%s' ${q(state)} >${q(path.join(stateDir, 'update-state.json.tmp'))}
/bin/mv -f ${q(path.join(stateDir, 'update-state.json.tmp'))} ${q(path.join(stateDir, 'update-state.json'))}
/usr/bin/open -n ${q(txn.target)}
n=0
while [ "$n" -lt 240 ]; do
  if [ "$(cat ${q(applying + '.receipt')} 2>/dev/null || true)" = ${q(txn.id)} ]; then
    mv -f ${q(applying)} ${q(applying + '.completed')}
    trap - EXIT
    exit 0
  fi
  n=$((n+1)); sleep 0.5
done
# Never kill the relaunched app or a game to roll back; retain the backup for explicit recovery.
exit 1
`;
}
let acknowledged: UpdateTransaction | null = null;
export async function applyMacUpdateOnStartup(): Promise<boolean> {
  if (!macUpdateSupported()) return false;
  try {
    const previous = readMacUpdate(claim()) as (UpdateTransaction & { installedHash?: string }) | null;
    if (previous) {
      if (previous.release.version === currentVersion() && previous.installedHash === (await asarHash(previous.target))) {
        await verifyBundle(previous.target, currentVersion());
        acknowledged = previous;
        return false;
      }
      try {
        if (previous.helperPid) {
          process.kill(previous.helperPid, 0);
          return false;
        }
      } catch {
        /* interrupted */
      }
      fs.renameSync(claim(), claim() + '.failed');
    }
  } catch (error) {
    recordFailure(error);
    // A damaged/interrupted transaction must never prevent the launcher from opening.
    try {
      fs.renameSync(claim(), claim() + '.failed');
      fs.writeFileSync(path.join(data(), 'update-failed.flag'), String(error));
    } catch {
      /* read-only state */
    }
    return false;
  }
  const txn = readMacUpdate();
  if (!txn) return false;
  try {
    if (txn.mode === 'upgrade' && compareSemver(txn.release.version, currentVersion()) <= 0) {
      clearMacUpdate();
      return false;
    }
    await validateUpdatePayload(txn);
    validateMacArchive(txn.file);
    const stagingDir = fs.mkdtempSync(path.join(path.dirname(txn.target), '.FAIONYX-update-'));
    await run('/usr/bin/ditto', ['-x', '-k', txn.file, stagingDir]);
    const stagedApp = path.join(stagingDir, 'FAIONYX.app');
    await verifyBundle(stagedApp, txn.release.version);
    const oldHash = await asarHash(txn.target),
      installedHash = await asarHash(stagedApp);
    const script = path.join(macUpdateDir(), `apply-${txn.id}.sh`);
    fs.writeFileSync(script, macUpdaterScript(txn, stagedApp, oldHash, installedHash, process.pid, data()), { mode: 0o700 });
    fs.renameSync(marker(), claim());
    atomicUpdateJson(claim(), { ...txn, installedHash });
    const helper = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      helper.once('spawn', resolve);
      helper.once('error', reject);
    });
    atomicUpdateJson(claim(), { ...txn, installedHash, helperPid: helper.pid });
    helper.unref();
    app.exit(0);
    return true;
  } catch (error) {
    recordFailure(error);
    try {
      atomicUpdateJson(claim() + '.failed', txn);
      clearMacUpdate();
      fs.rmSync(claim(), { force: true });
      fs.writeFileSync(path.join(data(), 'update-failed.flag'), String(error));
    } catch {
      /* Reporting failure must not block opening the existing application. */
    }
    return false;
  }
}
export async function acknowledgeMacUpdate(): Promise<void> {
  if (!acknowledged) return;
  const stateFile = path.join(data(), 'update-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  atomicUpdateJson(stateFile, { ...state, result: 'ok' });
  fs.writeFileSync(claim() + '.receipt', acknowledged.id);
}
export async function stageMacBackup(backup: string, version: string): Promise<void> {
  await verifyBundle(backup, version);
  const dir = path.join(macUpdateDir(), randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  // Backup's unique basename must become the canonical app name inside the ZIP.
  const copy = path.join(dir, 'FAIONYX.app');
  await run('/usr/bin/ditto', [backup, copy]);
  const assetName = updateAssetName(version),
    file = path.join(dir, assetName);
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', copy, file]);
  await stageMacUpdate(
    { version, publishedAt: '', body: '', assetUrl: '', assetName, assetSize: fs.statSync(file).size },
    file,
    await sha256File(file),
    'rollback'
  );
}
