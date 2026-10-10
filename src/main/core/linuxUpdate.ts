import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { app, shell } from 'electron';
import type { ReleaseInfo } from '../../shared/types';
import { atomicUpdateJson, validateUpdatePayload, type UpdateTransaction } from './updateTransaction';
import { compareSemver } from '../../shared/semver';
import { updateArtifactName, type InstallationKind } from '../../shared/platform';
import { installationKind } from '../platform';
import { assertLinuxElf, assertLinuxManifest, validateLinuxArchive } from './linuxUpdateIdentity';
import { translate as t } from '../../shared/i18n';
export { assertLinuxElf, validateLinuxArchive } from './linuxUpdateIdentity';
const run = promisify(execFile);
// Updater directories contain the physical ASAR archive. Electron's normal fs
// presents it as a virtual directory; only these payload operations use raw fs.
const physicalFs: typeof fs = process.versions.electron ? require('original-fs') : fs;
const data = () => app.getPath('userData');
const marker = () => path.join(data(), 'linux-update.json');
const claim = () => marker() + '.applying';
export const linuxUpdateDir = () => path.join(data(), 'linux-updates');
export const linuxInstallationKind = installationKind;
export const linuxUpdateAssetName = (version: string, arch = process.arch, kind = installationKind()) =>
  updateArtifactName(version, 'linux', arch, kind);
export function linuxAppTarget(): string | null {
  if (process.platform !== 'linux' || installationKind() === 'development') return null;
  return installationKind() === 'appimage' ? path.resolve(process.env.APPIMAGE!) : path.dirname(process.execPath);
}
export function linuxUpdateSupported(): boolean {
  const target = linuxAppTarget();
  if (!target) return false;
  if (installationKind() === 'deb') return true;
  if (installationKind() === 'appimage' && linuxAppImageUpdateReason()) return false;
  try {
    fs.accessSync(path.dirname(target), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
/** Replacement must restart the exact launcher PID, including during rollback. */
export function linuxAppImageUpdateReason(): string | null {
  if (installationKind() !== 'appimage') return null;
  try {
    const appDir = process.env.APPDIR;
    if (process.env.APPIMAGE_EXTRACT_AND_RUN || !appDir || Number(fs.statfsSync(appDir).type) !== 0x65735546)
      throw Error('extracted runtime');
    fs.accessSync('/dev/fuse', fs.constants.R_OK | fs.constants.W_OK);
    return null;
  } catch {
    return t('linuxupdate.error.appimage_unsafe_replace');
  }
}
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};
export function readLinuxUpdate(file = marker()): (UpdateTransaction & { installedHash?: string; kind?: InstallationKind }) | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      parsed.schema !== 1 ||
      !/^[a-f\d-]{36}$/i.test(parsed.id) ||
      parsed.target !== linuxAppTarget() ||
      !inside(linuxUpdateDir(), parsed.file) ||
      !/^[a-f\d]{64}$/.test(parsed.sha256) ||
      !Number.isSafeInteger(parsed.size) ||
      parsed.size <= 0 ||
      !/^\d+\.\d+\.\d+$/.test(parsed.release?.version) ||
      path.basename(parsed.file) !== linuxUpdateAssetName(parsed.release.version) ||
      !['upgrade', 'rollback', 'local'].includes(parsed.mode)
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}
export const clearLinuxUpdate = () => fs.rmSync(marker(), { force: true });
export const blockedLinuxVersion = () => (readLinuxUpdate(claim()) ?? readLinuxUpdate(claim() + '.failed'))?.release.version;
async function verifyDirectory(dir: string, version: string): Promise<void> {
  assertLinuxManifest(await fs.promises.readFile(path.join(dir, 'resources/faionyx-linux.json'), 'utf8'), version, 'portable-directory');
  const fd = await fs.promises.open(path.join(dir, 'faionyx'), 'r');
  try {
    const bytes = Buffer.alloc(64);
    await fd.read(bytes, 0, 64, 0);
    assertLinuxElf(bytes);
  } finally {
    await fd.close();
  }
  await fs.promises.access(path.join(dir, 'faionyx'), fs.constants.X_OK);
  if (!(await physicalFs.promises.stat(path.join(dir, 'resources/app.asar'))).isFile())
    throw new Error(t('linuxupdate.error.missing_app_archive'));
}
export async function verifyLinuxAppImage(file: string, version: string): Promise<void> {
  const fd = await fs.promises.open(file, 'r');
  try {
    const bytes = Buffer.alloc(64);
    await fd.read(bytes, 0, 64, 0);
    assertLinuxElf(bytes);
    if (bytes.toString('binary', 8, 11) !== 'AI\x02') throw new Error(t('linuxupdate.error.not_type2_appimage'));
    const block = Buffer.alloc(65536 + 3);
    let offset = 0,
      carry = 0,
      candidates = 0;
    while (offset < 1024 ** 3) {
      const read = await fd.read(block, carry, 65536, offset);
      if (!read.bytesRead) break;
      const length = carry + read.bytesRead;
      for (let i = block.indexOf('hsqs'); i >= 0 && i <= length - 4; i = block.indexOf('hsqs', i + 1)) {
        if (++candidates > 64) throw new Error(t('linuxupdate.error.too_many_filesystems'));
        try {
          const raw = (
            await run('/usr/bin/unsquashfs', ['-o', String(offset - carry + i), '-cat', file, 'resources/faionyx-linux.json'], {
              timeout: 10000,
              maxBuffer: 8192,
            })
          ).stdout;
          assertLinuxManifest(raw, version, 'appimage');
          return;
        } catch {
          /* binary text may also contain the magic */
        }
      }
      carry = Math.min(3, length);
      block.copy(block, 0, length - carry, length);
      offset += read.bytesRead;
    }
    throw new Error(t('linuxupdate.error.appimage_version_unverifiable'));
  } finally {
    await fd.close();
  }
}
export async function verifyLinuxDeb(file: string, version: string): Promise<void> {
  const { stdout } = await run('/usr/bin/dpkg-deb', ['-f', file, 'Package', 'Version', 'Architecture'], { timeout: 15000 });
  const values = Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => line.split(/:\s*/, 2))
  );
  if (values.Package !== 'faionyx' || values.Version !== version || values.Architecture !== (process.arch === 'arm64' ? 'arm64' : 'amd64'))
    throw new Error(t('linuxupdate.error.deb_mismatch'));
}
export async function validateLinuxPendingUpdate(txn: UpdateTransaction): Promise<void> {
  await validateUpdatePayload(txn);
  if (installationKind() === 'appimage') await verifyLinuxAppImage(txn.file, txn.release.version);
  else if (installationKind() === 'deb') await verifyLinuxDeb(txn.file, txn.release.version);
  else await validateLinuxArchive(txn.file);
}
export async function stageLinuxUpdate(release: ReleaseInfo, file: string, sha256: string, mode: UpdateTransaction['mode']): Promise<void> {
  const appImageReason = linuxAppImageUpdateReason();
  if (appImageReason) throw Error(appImageReason);
  if (!linuxUpdateSupported()) throw new Error(t('linuxupdate.error.app_dir_not_writable'));
  if (!inside(linuxUpdateDir(), file) || path.basename(file) !== linuxUpdateAssetName(release.version))
    throw new Error(t('linuxupdate.error.pick_official_package'));
  const txn: UpdateTransaction = {
    schema: 1,
    id: randomUUID(),
    target: linuxAppTarget()!,
    file,
    sha256,
    size: fs.statSync(file).size,
    from: app.getVersion(),
    release,
    mode,
  };
  await validateLinuxPendingUpdate(txn);
  atomicUpdateJson(marker(), txn);
}
const q = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const hashTarget = (target: string, kind: InstallationKind) => (kind === 'appimage' ? target : path.join(target, 'resources/app.asar'));
async function hash(file: string): Promise<string> {
  const value = (await run('/usr/bin/sha256sum', ['--', file])).stdout.slice(0, 64);
  if (!/^[a-f\d]{64}$/.test(value)) throw new Error(t('linuxupdate.error.hash_unverifiable'));
  return value;
}
export function linuxUpdaterScript(
  txn: UpdateTransaction,
  staged: string,
  oldHash: string,
  newHash: string,
  pid: number,
  stateDir: string,
  kind: InstallationKind
): string {
  const backup = path.join(path.dirname(txn.target), '.FAIONYX-backup-' + txn.id + (kind === 'appimage' ? '.AppImage' : ''));
  const applying = path.join(stateDir, 'linux-update.json.applying');
  const state = JSON.stringify({
    from: txn.from,
    to: txn.release.version,
    time: new Date().toISOString(),
    backupPath: backup,
    backupVersion: txn.from,
    result: 'applied',
  });
  const executable = kind === 'appimage' ? txn.target : path.join(txn.target, 'faionyx');
  return [
    '#!/bin/sh',
    'set -eu',
    'exec >>' + q(path.join(stateDir, 'linux-updater.log')) + ' 2>&1',
    "fail() { printf '%s' '" +
      t('linuxupdate.script.fail_keep') +
      "' >" +
      q(path.join(stateDir, 'update-failed.flag')) +
      '; mv -f ' +
      q(applying) +
      ' ' +
      q(applying + '.failed') +
      ' 2>/dev/null || true; }',
    'trap fail EXIT',
    'n=0',
    'while kill -0 ' + pid + ' 2>/dev/null; do n=$((n+1)); [ "$n" -lt 120 ] || exit 1; sleep 0.5; done',
    '[ "$(sha256sum -- ' + q(hashTarget(txn.target, kind)) + ' | cut -c1-64)" = ' + q(oldHash) + ' ]',
    '[ "$(sha256sum -- ' + q(hashTarget(staged, kind)) + ' | cut -c1-64)" = ' + q(newHash) + ' ]',
    '[ ! -e ' + q(backup) + ' ]',
    'mv -- ' + q(txn.target) + ' ' + q(backup),
    'if ! mv -- ' + q(staged) + ' ' + q(txn.target) + '; then mv -- ' + q(backup) + ' ' + q(txn.target) + '; exit 1; fi',
    "printf '%s' " + q(state) + ' >' + q(path.join(stateDir, 'update-state.json.tmp')),
    'mv -f -- ' + q(path.join(stateDir, 'update-state.json.tmp')) + ' ' + q(path.join(stateDir, 'update-state.json')),
    '# Normal FUSE mode execs AppRun in this PID. Extract-and-run forks a wrapper.',
    '# Do not inherit a wrapper mode whose PID could exit while Electron remains.',
    'unset APPIMAGE APPDIR APPIMAGE_EXTRACT_AND_RUN',
    q(executable) + ' >/dev/null 2>&1 &',
    'launched=$!',
    "start_time() { sed 's/.*) //' /proc/$1/stat 2>/dev/null | awk '{print $20}'; }",
    'launched_start=$(start_time "$launched")',
    'n=0',
    'while [ "$n" -lt 240 ]; do',
    ' if [ "$(cat ' +
      q(applying + '.receipt') +
      ' 2>/dev/null || true)" = ' +
      q(txn.id) +
      ' ]; then mv -f -- ' +
      q(applying) +
      ' ' +
      q(applying + '.completed') +
      '; trap - EXIT; exit 0; fi',
    ' n=$((n+1)); sleep 0.5',
    'done',
    '# Stop only the exact launcher child (PID plus starttime), never its game or process group.',
    'if kill -0 "$launched" 2>/dev/null; then',
    ' [ -n "$launched_start" ] && [ "$(start_time "$launched")" = "$launched_start" ] || exit 1',
    ' kill -TERM "$launched"',
    ' n=0; while kill -0 "$launched" 2>/dev/null; do n=$((n+1)); [ "$n" -lt 120 ] || exit 1; sleep 0.25; done',
    'fi',
    '# Restore only after the failed child exited. Never run old and new instances together.',
    '[ "$(sha256sum -- ' + q(hashTarget(txn.target, kind)) + ' | cut -c1-64)" = ' + q(newHash) + ' ]',
    '[ "$(sha256sum -- ' + q(hashTarget(backup, kind)) + ' | cut -c1-64)" = ' + q(oldHash) + ' ]',
    'mv -- ' + q(txn.target) + ' ' + q(staged + '.failed'),
    'mv -- ' + q(backup) + ' ' + q(txn.target),
    "printf '%s' '" + t('linuxupdate.script.restored') + "' >" + q(path.join(stateDir, 'update-failed.flag')),
    'mv -f -- ' + q(applying) + ' ' + q(applying + '.failed'),
    'trap - EXIT',
    q(executable) + ' >/dev/null 2>&1 &',
    'exit 1',
    '',
  ].join('\n');
}
let acknowledged: UpdateTransaction | null = null;
export async function applyLinuxUpdateOnStartup(): Promise<boolean> {
  if (!linuxUpdateSupported()) {
    const reason = linuxAppImageUpdateReason();
    if (reason && readLinuxUpdate()) {
      try {
        fs.appendFileSync(path.join(data(), 'linux-updater.log'), new Date().toISOString() + ' ' + reason + '\n');
        fs.writeFileSync(path.join(data(), 'update-failed.flag'), reason);
      } catch {
        /* inability to write diagnostics must not prevent opening the original application */
      }
    }
    return false;
  }
  try {
    const previous = readLinuxUpdate(claim());
    if (previous) {
      if (
        previous.release.version === app.getVersion() &&
        previous.installedHash === (await hash(hashTarget(previous.target, installationKind())))
      ) {
        acknowledged = previous;
        return false;
      }
      try {
        if (previous.helperPid) {
          process.kill(previous.helperPid, 0);
          return false;
        }
      } catch {
        /* interrupted helper */
      }
      fs.renameSync(claim(), claim() + '.failed');
    }
    const txn = readLinuxUpdate();
    if (!txn) return false;
    if (txn.mode === 'upgrade' && compareSemver(txn.release.version, app.getVersion()) <= 0) {
      clearLinuxUpdate();
      return false;
    }
    await validateLinuxPendingUpdate(txn);
    const kind = installationKind();
    if (kind === 'deb') {
      const failure = await shell.openPath(txn.file);
      if (failure) throw new Error(t('linuxupdate.error.open_deb_failed', { failure }));
      atomicUpdateJson(path.join(data(), 'linux-installer-handoff.json'), {
        package: txn.file,
        version: txn.release.version,
        time: new Date().toISOString(),
        status: 'awaiting-system-confirmation',
      });
      clearLinuxUpdate();
      return false;
    }
    const stageRoot = fs.mkdtempSync(path.join(path.dirname(txn.target), '.FAIONYX-update-'));
    const staged = path.join(stageRoot, kind === 'appimage' ? path.basename(txn.target) : 'FAIONYX');
    if (kind === 'appimage') {
      await fs.promises.copyFile(txn.file, staged);
      await fs.promises.chmod(staged, 0o755);
    } else {
      await run(
        '/usr/bin/tar',
        ['--extract', '--gzip', '--file', txn.file, '--directory', stageRoot, '--no-same-owner', '--no-same-permissions'],
        { timeout: 120000 }
      );
      await verifyDirectory(staged, txn.release.version);
    }
    const oldHash = await hash(hashTarget(txn.target, kind)),
      installedHash = await hash(hashTarget(staged, kind));
    const script = path.join(linuxUpdateDir(), 'apply-' + txn.id + '.sh');
    fs.writeFileSync(script, linuxUpdaterScript(txn, staged, oldHash, installedHash, process.pid, data(), kind), { mode: 0o700 });
    fs.renameSync(marker(), claim());
    atomicUpdateJson(claim(), { ...txn, kind, installedHash });
    const helper = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      helper.once('spawn', resolve);
      helper.once('error', reject);
    });
    atomicUpdateJson(claim(), { ...txn, kind, installedHash, helperPid: helper.pid });
    helper.unref();
    app.exit(0);
    return true;
  } catch (error) {
    try {
      fs.appendFileSync(path.join(data(), 'linux-updater.log'), new Date().toISOString() + ' ' + String(error) + '\n');
      const txn = readLinuxUpdate();
      if (txn) atomicUpdateJson(claim() + '.failed', txn);
      clearLinuxUpdate();
      fs.writeFileSync(path.join(data(), 'update-failed.flag'), String(error));
    } catch {
      /* current app must still open */
    }
    return false;
  }
}
export async function acknowledgeLinuxUpdate(): Promise<void> {
  if (!acknowledged) return;
  const file = path.join(data(), 'update-state.json'),
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  atomicUpdateJson(file, { ...state, result: 'ok' });
  fs.writeFileSync(claim() + '.receipt', acknowledged.id);
}
export async function stageLinuxBackup(backup: string, version: string): Promise<void> {
  const kind = installationKind();
  if (kind === 'deb') throw new Error(t('linuxupdate.error.deb_restore_via_installer'));
  const dir = path.join(linuxUpdateDir(), randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const assetName = linuxUpdateAssetName(version),
    file = path.join(dir, assetName);
  if (kind === 'appimage') {
    await verifyLinuxAppImage(backup, version);
    await fs.promises.copyFile(backup, file);
  } else {
    await verifyDirectory(backup, version);
    const copy = path.join(dir, 'FAIONYX');
    await physicalFs.promises.cp(backup, copy, { recursive: true, dereference: true });
    await run('/usr/bin/tar', ['--format=ustar', '--dereference', '-czf', file, '-C', dir, 'FAIONYX'], { timeout: 120000 });
  }
  await stageLinuxUpdate(
    { version, assetName, assetSize: fs.statSync(file).size, assetUrl: '', body: '', publishedAt: '' },
    file,
    await hash(file),
    'rollback'
  );
}
