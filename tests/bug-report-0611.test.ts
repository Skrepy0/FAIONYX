import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { neoRuntimePaths, reuseExternalRuntimeLibraries, missingNeoRuntime } from '../src/main/core/externalRuntime'
import { CarouselPlayback } from '../src/shared/carouselPlayback'
import { carouselTiming } from '../src/shared/appearancePolicy'
import { JavaProbeCache } from '../src/main/core/javaProbeCache'
import { trackBootTask, waitForBootTasks } from '../src/renderer/src/bootTasks'
import { GameSession } from '../src/main/core/gameSession'
import { parseModArchive } from '../src/main/core/modMetadata'
import { resolveInstanceMetadata } from '../src/main/core/instanceMetadata'
import { modMatchesInstance, modMismatchReasons, matchesVersionRange } from '../src/shared/modCompatibility'

test('BUG06 old NeoForge production client requires all four generated artifacts, modern FML11 keeps new layout', () => {
  const old = { id: 'renamed', arguments: { game: ['--fml.neoForgeVersion=21.1.248', '--fml.mcVersion', '1.21.1', '--fml.neoFormVersion', '20240808.144430'] } }
  const relative = neoRuntimePaths(old)
  assert.equal(relative.length, 4)
  assert(relative.some(p => p.endsWith('neoforge-21.1.248-client.jar')))
  assert(relative.some(p => p.endsWith('client-1.21.1-20240808.144430-srg.jar')))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faionyx-neo-libs-test-'))
  try {
    const external = path.join(root, 'external'), shared = path.join(root, 'shared')
    for (const rel of relative) { const file = path.join(external, 'libraries', rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture runtime') }
    assert.equal(missingNeoRuntime(old, shared).length, 4)
    assert.equal(reuseExternalRuntimeLibraries(old, [external], shared, []), 4)
    assert.deepEqual(missingNeoRuntime(old, shared), [])
    assert.equal(reuseExternalRuntimeLibraries(old, [external], shared, []), 0)
    const modern = neoRuntimePaths({ id: 'arbitrary', libraries: [{ name: 'net.neoforged.fancymodloader:loader:11.0.16' }], arguments: { game: ['--fml.neoForgeVersion', '26.2.0.66', '--fml.mcVersion', '26.2', '--fml.neoFormVersion', '2'] } })
    assert.equal(modern.length, 2)
    assert(modern.some(p => p.includes('minecraft-client-patched')))
    assert(!modern.some(p => p.endsWith('-srg.jar')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('BUG02 1.21.1 NeoForge TOML semantics and exclusive upper-bound diagnosis do not depend on filenames', () => {
  const metadata = resolveInstanceMetadata({ id: '任意名字', inheritsFrom: '1.21.1', libraries: [{ name: 'net.neoforged.fancymodloader:loader:4.0.43' }], arguments: { game: ['--fml.neoForgeVersion', '21.1.248', '--fml.mcVersion', '1.21.1'] } }, id => ({ id }))
  assert.equal(metadata.loader, 'neoforge'); assert.equal(metadata.mcVersion, '1.21.1')
  // 上界为下界的补丁延伸时开区间纳入上界（[1.21,1.21.1) 含 1.21.1，社区笔误宽容）
  for (const [range, expected] of [['[1.21,1.21.1)', true], ['[1.21.1,1.21.2)', true], ['[1.21.1,1.21.1]', true]] as const) {
    const zip = new AdmZip()
    zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nImplementation-Version: 7.0.1\r\n'))
    zip.addFile('META-INF/neoforge.mods.toml', Buffer.from(`modLoader='javafml'\nloaderVersion='[4,)'\n[[mods]]\nmodId='fixture'\nversion='\${file.jarVersion}'\n[[dependencies.fixture]]\nmodId='minecraft'\ntype='required'\nversionRange='${range}'\n[[dependencies.fixture]]\nmodId='neoforge'\ntype='required'\nversionRange='[21.1.200,)'`))
    const mod = parseModArchive(zip, 'fake.jar', 'misleading-26.2-Forge.jar')
    const instance = { id: 'arbitrary', ...metadata }
    assert.equal(mod.version, '7.0.1')
    assert.equal(modMatchesInstance(mod, instance), expected)
    assert.equal(modMismatchReasons(mod, instance).length === 0, expected)
    if (!expected) assert(modMismatchReasons(mod, instance)[0].includes('圆括号不含边界'))
  }
  // 次版本上界不宽容：[1.21,1.22) 不含 1.22
  assert.equal(matchesVersionRange('[1.21,1.22)', '1.22'), false)
  assert.equal(matchesVersionRange('[26.2.0.57,26.3)', '26.3'), false)
})

test('BUG07 ordinary Stop is graceful; force requires an issued nonce for the same JVM', async () => {
  const session = new GameSession(), child = new EventEmitter() as ChildProcess
  Object.assign(child, { exitCode: null, signalCode: null })
  let kills = 0
  child.kill = () => { kills++; queueMicrotask(() => { session.release(token); child.emit('close', 1) }); return true }
  const token = session.reserve('qa'); session.attach(token, child)
  await assert.rejects(session.requestStop(async () => {}, 'not-issued', 10), /失效/)
  const timeout = await session.requestStop(async () => {}, undefined, 10)
  assert(timeout.requiresForce); assert.equal(kills, 0); assert(session.busy)
  await session.requestStop(async () => {}, timeout.forceToken, 10)
  assert.equal(kills, 1); assert(!session.busy)
  const newChild = new EventEmitter() as ChildProcess, newToken = session.reserve('qa')
  session.attach(newToken, newChild)
  await assert.rejects(session.requestStop(async () => {}, timeout.forceToken, 10), /失效/)
  const normal = await session.requestStop(async () => { session.release(newToken); newChild.emit('close', 0) })
  assert.equal(normal.requiresForce, false); assert.equal(kills, 1)
})

test('BUG08 each slide has its own duration; leaving/reentering pauses time without resetting the slide', () => {
  const slides = [{ path: 'a', durationMs: 1000 }, { path: 'b', durationMs: 4000 }, { path: 'c', durationMs: 2000 }]
  const player = new CarouselPlayback(slides, 0)
  assert.equal(player.tick(999), 0); assert.equal(player.tick(1000), 1)
  const saved = player.bookmark(2500)
  assert.deepEqual(saved, { path: 'b', remainingMs: 2500 })
  const resumed = new CarouselPlayback(slides, 100000, saved)
  assert.equal(resumed.tick(102499), 1); assert.equal(resumed.tick(102500), 2)
  assert.equal(resumed.tick(104500), 0)
  assert.equal(new CarouselPlayback([slides[2], slides[0]], 0, saved).index, 0)
  assert.equal(new CarouselPlayback([], 0).bookmark(10).path, '')
  const policy = carouselTiming({ images: ['a', 'b'], intervalSeconds: -1, durations: { a: 999, b: 2, deleted: 9 } })
  assert.equal(policy.intervalSeconds, 1); assert.deepEqual(policy.durations, { a: 120, b: 2 })
})

test('BUG01 Java probe cache survives process restart and invalidates changed runtime/release metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faionyx-javacache-test-'))
  try {
    const exe = path.join(root, 'bin/java.exe'), file = () => path.join(root, 'probe-cache.json')
    fs.mkdirSync(path.dirname(exe)); fs.writeFileSync(exe, 'jvm fixture')
    const cache = new JavaProbeCache(file), info = { path: exe, major: 21, version: '21.0.3', is64Bit: true }
    assert.equal(cache.get(exe), null); cache.put(exe, info)
    assert.deepEqual(new JavaProbeCache(file).get(exe), info)
    fs.writeFileSync(path.join(root, 'release'), 'updated release')
    assert.equal(cache.get(exe), null)
    cache.put(exe, info); fs.writeFileSync(exe, 'different jvm fixture')
    assert.equal(cache.get(exe), null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('BUG01 slow optional skin network cannot keep the usable UI behind the splash', async () => {
  let finish!: (value: string) => void
  const slow = trackBootTask(() => new Promise<string>(r => { finish = r }), 10)
  await waitForBootTasks()
  finish('eventual cached texture')
  assert.equal(await slow, 'eventual cached texture')
})

test('BUG03–05 global capture reaches Teleports; solid blurred panels and home search remain present', () => {
  const app = fs.readFileSync('src/renderer/src/App.vue', 'utf8')
  assert.match(app, /window.addEventListener\(type, listener as EventListener, true\)/)
  assert.match(app, /backdrop-filter: blur\(24px\) saturate\(130%\)/)
  assert.match(app, /canGoBack && store.currentView !== 'home'/)
  assert(!app.includes('v-else class="search-box"'))
  assert.match(app, /dlOpen.value = false/)
})
