// Isolated real-JVM verification. Bundle with esbuild, run via Electron.
const { app } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const original = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'faionyx', 'settings.json'), 'utf8'))
const qa = process.env.FAIONYX_QA_RESUME || fs.mkdtempSync(path.join(os.tmpdir(), 'faionyx-quick-actions-'))
if (path.dirname(path.resolve(qa)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(qa).startsWith('faionyx-quick-actions-')) throw new Error('QA resume must be an owned temp fixture')
const report = path.join(qa, 'qa-report.log')
for (const name of ['log', 'error']) { const originalLog = console[name].bind(console); console[name] = (...args) => { fs.appendFileSync(report, args.map(a => a instanceof Error ? a.stack : String(a)).join(' ') + '\n'); originalLog(...args) } }
const folder = path.join(qa, 'games'); let id = process.env.FAIONYX_QA_VERSION || '26.2'
const installNeo = process.env.FAIONYX_QA_INSTALL_NEO
const sourceRoots = [...(process.env.FAIONYX_QA_SOURCE_ROOT ? [process.env.FAIONYX_QA_SOURCE_ROOT] : []), ...original.folders.map(f => f.path)]
const source = sourceRoots.map(root => path.join(root, 'versions', id)).find(p => fs.existsSync(path.join(p, id + '.jar')) && fs.existsSync(path.join(p, id + '.json')))
if (!source && !installNeo) throw new Error('Missing runtime fixture ' + id)
const dest = path.join(folder, 'versions', id)
if (source) {
fs.mkdirSync(dest, { recursive: true })
const profile = JSON.parse(fs.readFileSync(path.join(source, id + '.json'), 'utf8'))
fs.writeFileSync(path.join(dest, id + '.json'), JSON.stringify({ ...profile, _gameDir: true }))
fs.copyFileSync(path.join(source, id + '.jar'), path.join(dest, id + '.jar'))
}
app.setPath('userData', qa)
fs.writeFileSync(path.join(qa, 'settings.json'), JSON.stringify({ folders: [...original.folders, { path: folder, name: 'QA', isDefault: false }], gameDir: folder, activeFolder: folder, mirror: original.mirror, javaAuto: true, memoryMB: 3072, closeAfterLaunch: false, resolution: { width: 854, height: 480, mode: 'windowed', fullscreen: false } }))
console.log('QA_ROOT=' + qa)
const waitUntil = async (fn, limit = 150000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > limit) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 250)) } }
app.whenReady().then(async () => {
  const launch = require('../src/main/core/launch.ts'), paths = require('../src/main/core/paths.ts'), accounts = require('../src/main/core/accounts.ts'), nbt = require('../src/main/core/nbt.ts')
  accounts.addOffline('FaionyxQA')
  let joined = 0, saved = 0
  const lines = [], states = []
  try {
    if (installNeo) {
      const loaders = require('../src/main/core/loaders.ts')
      const versions = require('../src/main/core/versions.ts')
      await paths.withGameFolder(folder, async () => {
        const previousInstall = versions.scanInstalledFolder(folder).versions.find(v => v.mcVersion === '1.21.1' && v.loader === 'neoforge' && v.loaderVersion === installNeo)
        if (previousInstall) {
          if (fs.existsSync(dest) && !fs.readdirSync(dest).length) fs.rmdirSync(dest)
          if (previousInstall.id !== id) versions.renameVersion(previousInstall.id, id)
        } else await loaders.installLoader('neoforge', '1.21.1', installNeo, e => console.log('INSTALL=' + e.text), id)
      })
      const file = path.join(dest, id + '.json')
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), _gameDir: true }))
    }
    await paths.withGameFolder(folder, () => launch.launch(id, e => { if (e.stage !== 'libraries') console.log('STAGE=' + e.stage + ' ' + e.text) }, line => {
      lines.push(line)
      if (/joined the game|logged in with entity/i.test(line)) joined++
      if (/Saving chunks|All dimensions are saved|Saving worlds/i.test(line)) saved++
      if (/FAIONYX|ERROR|Exception|joined the game|Saving worlds|dimensions are saved/.test(line)) console.log(line.slice(0, 350))
    }, state => { states.push(state.status); console.log('STATE=' + state.status) }, undefined, { createCommandWorld: true }))
    await waitUntil(() => { if (states.includes('exited') && !joined) throw new Error('Game exited before entering test world'); return joined > 0 })
    console.log('PASS_ENTERED_NEW_WORLD')
    const worlds = fs.readdirSync(path.join(dest, 'saves'))
    assert.equal(worlds.length, 1)
    const world = path.join(dest, 'saves', worlds[0]), oldPid = launch.getLastLaunch().pid
    const result = await launch.restartGame(id, folder)
    assert.equal(result.requiresForce, false, 'Restart must gracefully close, not require force')
    assert(saved > 0, 'Game must log actual world save')
    const savedData = nbt.parseNbt(fs.readFileSync(path.join(world, 'level.dat'))).Data
    console.log('SAVED_DATA_KEYS=' + Object.keys(savedData).join(','))
    assert.equal(savedData.allowCommands, 1)
    assert(fs.existsSync(path.join(world, 'region')) || fs.existsSync(path.join(world, 'dimensions', 'minecraft', 'overworld', 'region')))
    assert.notEqual(launch.getLastLaunch().pid, oldPid)
    await waitUntil(() => joined >= 2)
    assert.deepEqual(fs.readdirSync(path.join(dest, 'saves')), worlds)
    console.log('PASS_GRACEFUL_RESTART_SAVED_AND_REJOINED_SAME_WORLD')
    // Close this test's JVM normally and let it finish saving, then cancel restart.
    const stopped = await launch.killGame()
    assert.equal(stopped.requiresForce, false, 'Ordinary End Game must gracefully save, never kill')
    await waitUntil(() => !launch.isBusy(), 40000)
    console.log('PASS_FINAL_GRACEFUL_CLOSE')
  } catch (e) { console.error('QA_FAILED', e); process.exitCode = 1 }
  finally {
    // On a failed assertion keep the owned test world recoverable: ask normal exit.
    if (launch.isBusy()) {
      try { launch.cancelRestart(); const { requestGameWindowClose } = require('../src/main/core/gracefulClose.ts'); await requestGameWindowClose({ pid: launch.getLastLaunch()?.pid, exitCode: null, signalCode: null }); await waitUntil(() => !launch.isBusy(), 40000) } catch (e) { console.error('QA_GAME_STILL_OPEN', String(e)) }
    }
    app.exit(process.exitCode || 0)
  }
})
