import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyRuntimeProfile, packRuntimeProfile } from '../src/main/core/packRuntime'

test('pack owns actual runtime metadata for every loader, with no extra loader wrapper or self inheritance', () => {
  for (const loader of [undefined, 'fabric', 'quilt', 'forge', 'neoforge'] as const) {
    const runtime = {
      id: 'My Pack',
      mainClass: 'real.Main',
      libraries: [{ name: 'test:lib:1' }],
      ...(loader ? { inheritsFrom: '26.2' } : {}),
    }
    const pack = packRuntimeProfile(runtime, 'My Pack', { mcVersion: '26.2', loader, loaderVersion: '1', name: 'Pack', packVersion: '2' })
    assert.equal(pack.id, 'My Pack')
    assert.equal(pack.mainClass, 'real.Main')
    assert.equal(pack.inheritsFrom, loader ? '26.2' : undefined)
    assert.equal(pack._gameDir, true)
  }
  assert.throws(() => packRuntimeProfile({ id: 'a', inheritsFrom: 'a' }, 'a', { mcVersion: '26.2', name: 'a', packVersion: '1' }))
})
test('reusing an existing loader preserves its files and copies only runtime into pack', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faionyx-pack-runtime-'))
  try {
    const source = path.join(root, 'loader')
    fs.mkdirSync(path.join(source, 'saves'), { recursive: true })
    fs.writeFileSync(
      path.join(source, 'loader.json'),
      JSON.stringify({ id: 'loader', inheritsFrom: '26.2', _thumbnail: 'user-image', _javaPath: 'user-specific-java' })
    )
    fs.writeFileSync(path.join(source, 'loader.jar'), 'runtime')
    fs.writeFileSync(path.join(source, 'saves', 'world'), 'user-world')
    copyRuntimeProfile(root, 'loader', 'Pack')
    assert.equal(fs.readFileSync(path.join(source, 'saves', 'world'), 'utf8'), 'user-world')
    assert.deepEqual(fs.readdirSync(path.join(root, 'Pack')).sort(), ['Pack.jar', 'Pack.json'])
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'Pack', 'Pack.json'), 'utf8')).id, 'Pack')
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'Pack', 'Pack.json'), 'utf8'))._thumbnail, undefined)
    assert.throws(() => copyRuntimeProfile(root, 'loader', '../escape'))
    assert.throws(() => copyRuntimeProfile(root, 'loader', 'Pack'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
