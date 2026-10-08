import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { matchesVersionRange as matches, modMatchesInstance, instanceKey, compareVersions } from '../src/shared/modCompatibility'
import { resolveInstanceMetadata } from '../src/main/core/instanceMetadata'
import { scanModTargets, selectModTarget, copyCompatibleMods } from '../src/main/core/modTargets'
import { parseModFile } from '../src/main/core/modinfo'
import type { InstalledVersion, ModInfo } from '../src/shared/types'

test('reported NeoForge interval and every inclusive/exclusive boundary', () => {
  assert.equal(matches('[26.2]', '26.2'), true)
  for (const [range, lower, upper] of [
    ['[26.2.0.57,26.3)', true, false],
    ['(26.2.0.57,26.3]', false, true],
    ['[26.2.0.57,26.3]', true, true],
    ['(26.2.0.57,26.3)', false, false],
  ] as const) {
    assert.equal(matches(range, '26.2.0.57'), lower, range)
    assert.equal(matches(range, '26.3'), upper, range)
    assert.equal(matches(range, '26.2.0.66'), true, range)
    assert.equal(matches(range, '26.2.0.56'), false, range)
  }
  assert(matches('(,1.0],[1.2,)', '1.3'))
  assert(!matches('(,1.0],[1.2,)', '1.1'))
  assert(!matches('[26.2,', '26.2'))
  assert(!matches('[26.2,26.3)', ''))
})

test('Fabric/Quilt AND, OR, wildcard, caret, tilde and non-release versions', () => {
  for (const range of ['>=1.20.1 <1.21', '~1.20.1', '1.20.x']) {
    assert(matches(range, '1.20.4'))
    assert(!matches(range, '1.21'))
    assert(!matches(range, '1.19.4'))
  }
  assert(matches('^0.15.2', '0.15.11'))
  assert(!matches('^0.15.2', '0.16.0'))
  assert(matches('1.20.1 || >=26.2 <26.3', '26.2'))
  assert(!matches('1.20.1 || >=26.2 <26.3', '26.3'))
  assert(matches('[47.1,)', '47.2.0'))
  assert(matches('[26.1.2.65-beta,26.2)', '26.1.2.65'))
  assert(compareVersions('26.1.2.65-beta', '26.1.2.65') < 0)
  assert(matches('26.2', '26.2.0+build.2'))
  assert(matches('24w14a', '24w14a'))
  assert(!matches('24w14a', '24w15a'))
})

test('CurseForge-style hyphen ranges and hyphen bounds inside Maven intervals', () => {
  // Bare hyphen range is inclusive on both ends (CF file pages, some mods.toml).
  for (const range of ['1.20.1-1.20.4', '1.20.1 - 1.20.4']) {
    assert(matches(range, '1.20.1'), range)
    assert(matches(range, '1.20.3'), range)
    assert(matches(range, '1.20.4'), range)
    assert(!matches(range, '1.20.5'), range)
    assert(!matches(range, '1.20'), range)
    assert(!matches(range, '1.21'), range)
  }
  // Hyphen inside an interval bound: lower bound expands to the low end, upper to the high end.
  assert(matches('[1.20.1-1.20.4,)', '1.20.1'))
  assert(matches('[1.20.1-1.20.4,)', '1.21'))
  assert(!matches('[1.20.1-1.20.4,)', '1.20'))
  assert(matches('[,1.20.1-1.20.4]'.replace('[,', '(,'), '1.20.4'))
  assert(!matches('(,1.20.1-1.20.4]', '1.20.5'))
  // Prerelease tags are never mistaken for hyphen ranges.
  assert(!matches('26.1.2.65-beta', '26.1.2.65'))
  assert(matches('26.1.2.65-beta', '26.1.2.65-beta'))
  assert(matches('[26.1.2.65-beta,26.2)', '26.1.2.66'))
  assert(!matches('[26.1.2.65-beta,26.2)', '26.2'))
})

test('real metadata: custom names, flattened profiles, inherited loaders and missing/cyclic parents', () => {
  const neo = resolveInstanceMetadata(
    {
      id: '任意显示名',
      mainClass: 'net.neoforged.fml.startup.Client',
      arguments: { game: ['--fml.mcVersion', '26.2', '--fml.neoForgeVersion', '26.2.0.66'] },
    },
    () => undefined
  )
  assert.deepEqual(neo, { mcVersion: '26.2', loader: 'neoforge', loaderVersion: '26.2.0.66', broken: false })
  const mod = { loader: 'NeoForge', mcRange: '[26.2]', loaderRange: '[26.2.0.57,26.3)' } as ModInfo
  assert(modMatchesInstance(mod, { id: 'not-a-version', ...neo }))
  assert(!modMatchesInstance(mod, { id: '26.2-NeoForge_26.2.0.66', mcVersion: '26.2', loader: 'neoforge' }))
  for (const [loader, library, lv] of [
    ['fabric', 'net.fabricmc:fabric-loader:0.19.3', '0.19.3'],
    ['quilt', 'org.quiltmc:quilt-loader:0.28.0', '0.28.0'],
    ['forge', 'net.minecraftforge:forge:1.20.1-47.2.0', '47.2.0'],
  ] as const) {
    const result = resolveInstanceMetadata({ id: '自定义名称', clientVersion: '1.20.1', libraries: [{ name: library }] }, () => undefined)
    assert.equal(result.loader, loader)
    assert.equal(result.loaderVersion, lv)
    assert.equal(result.mcVersion, '1.20.1')
    assert(modMatchesInstance({ loader, mcRange: '[1.20.1]', loaderRange: `[${lv},)` }, { id: 'x', ...result }))
  }
  const inherited = resolveInstanceMetadata({ id: 'Pack', inheritsFrom: 'fabric' }, (id) =>
    id === 'fabric' ? { id, inheritsFrom: '1.20.1', libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.11' }] } : { id }
  )
  assert.equal(inherited.mcVersion, '1.20.1')
  assert.equal(inherited.loaderVersion, '0.15.11')
  assert(resolveInstanceMetadata({ id: 'x', inheritsFrom: 'y' }, () => undefined).broken)
  assert(resolveInstanceMetadata({ id: 'x', inheritsFrom: 'y' }, () => ({ id: 'y', inheritsFrom: 'x' })).broken)
})

test('parse real JAR metadata for all supported loaders; arrays preserve OR semantics', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-mod-parser-'))
  try {
    const cases = [
      [
        'fabric.mod.json',
        JSON.stringify({ id: 'x', depends: { minecraft: ['1.20.1', '26.2'], fabricloader: ['>=0.15 <0.16', '>=0.19'] } }),
        'fabric',
      ],
      [
        'quilt.mod.json',
        JSON.stringify({
          quilt_loader: {
            id: 'x',
            depends: [
              { id: 'minecraft', versions: ['1.20.1', '26.2'] },
              { id: 'quilt_loader', versions: '>=0.28' },
            ],
          },
        }),
        'quilt',
      ],
      [
        'META-INF/neoforge.mods.toml',
        '[[mods]]\nmodId="x"\n[[dependencies.x]]\nmodId="minecraft"\nversionRange="[26.2]"\n[[dependencies.x]]\nmodId="neoforge"\nversionRange="[26.2.0.57,26.3)"',
        'neoforge',
      ],
      ['META-INF/mods.toml', '[[mods]]\nmodId="x"\n[[dependencies.x]]\nmodId="minecraft"\nversionRange="[26.2]"', 'forge'],
    ]
    for (const [entry, value, loader] of cases) {
      const file = path.join(root, loader + '.jar'),
        zip = new AdmZip()
      zip.addFile(entry, Buffer.from(value))
      zip.writeZip(file)
      const mod = parseModFile(file)
      assert.equal(mod.error, undefined)
      assert.equal(mod.loader, loader)
      assert(matches(mod.mcRange, '26.2'))
      assert(!matches(mod.mcRange, '26.1'))
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('all registered roots, duplicate IDs, isolation destination, backend revalidation and no overwrite', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-mod-targets-'))
  try {
    const folders = ['A', 'B'].map((n) => path.join(root, n))
    folders.forEach((f) => fs.mkdirSync(f))
    const mod = { loader: 'neoforge', mcRange: '[26.2]', loaderRange: '[26.2.0.57,26.3)' } as ModInfo
    const scan = (folder: string) => ({
      versions: [
        {
          id: 'same',
          folder,
          gameDirectory: path.join(folder, 'versions', 'same'),
          isolated: true,
          mcVersion: '26.2',
          loader: 'neoforge',
          loaderVersion: '26.2.0.66',
        } as InstalledVersion,
      ],
      errors: [],
    })
    const result = scanModTargets([...folders, folders[0]], scan)
    assert.equal(result.versions.length, 2)
    assert.notEqual(instanceKey(result.versions[0]), instanceKey(result.versions[1]))
    const target = selectModTarget(result.versions, 'same', folders[1])
    const file = path.join(root, 'sample.jar')
    fs.writeFileSync(file, 'sample')
    assert((await copyCompatibleMods([file], target, () => mod))[0].ok)
    assert(fs.existsSync(path.join(target.gameDirectory!, 'mods', 'sample.jar')))
    assert(!fs.existsSync(path.join(folders[0], 'versions', 'same', 'mods')))
    assert(!(await copyCompatibleMods([file], target, () => mod))[0].ok)
    assert(!(await copyCompatibleMods([file], { ...target, loaderVersion: '26.3' }, () => mod))[0].ok)
    assert.throws(() => selectModTarget(result.versions, 'same', root))
    assert.equal(scanModTargets([path.join(root, 'missing')], scan).errors.length, 1)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})
