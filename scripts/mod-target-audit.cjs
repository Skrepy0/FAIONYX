// Read-only audit of registered game roots against regression MOD metadata.
// Bundle with esbuild, then run via Electron. Does not read account storage.
const { app } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const original = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'faionyx/settings.json'), 'utf8'));
const qa = fs.mkdtempSync(path.join(os.tmpdir(), 'faionyx-mod-target-audit-'));
app.setPath('userData', qa);
fs.writeFileSync(
  path.join(qa, 'settings.json'),
  JSON.stringify({ folders: original.folders, gameDir: original.gameDir, activeFolder: original.activeFolder })
);
app.whenReady().then(() => {
  try {
    const { scanModTargets } = require('../src/main/core/modTargets.ts');
    const { scanInstalledFolder } = require('../src/main/core/versions.ts');
    const { modMatchesInstance } = require('../src/shared/modCompatibility.ts');
    const scanned = scanModTargets(
      original.folders.map((f) => f.path),
      scanInstalledFolder
    );
    assert.equal(scanned.errors.length, 0, scanned.errors.join(';'));
    console.log('REGISTERED_ROOTS=' + original.folders.length + ' SCANNED_INSTANCES=' + scanned.versions.length);
    for (const mod of [
      { loader: 'forge', mcRange: '[1.20.1,1.21)', loaderRange: '[47,)' },
      { loader: 'neoforge', mcRange: '[26.2]', loaderRange: '[26.2.0.57,26.3)' },
      { loader: 'fabric', mcRange: '26.2', loaderRange: '>=0.19' },
    ]) {
      const targets = scanned.versions.filter((v) => modMatchesInstance(mod, v));
      assert(targets.length, 'Expected a real compatible ' + mod.loader + ' target');
      console.log(
        JSON.stringify({
          requirement: mod,
          targets: targets.map((v) => ({
            id: v.id,
            mc: v.mcVersion,
            loader: v.loader,
            loaderVersion: v.loaderVersion,
            isolated: v.isolated,
          })),
        })
      );
    }
    console.log('PASS_REAL_REGISTERED_TARGETS');
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
