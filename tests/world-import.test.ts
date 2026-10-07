import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import AdmZip from 'adm-zip'
import { parseNbt, writeNbt } from '../src/main/core/nbt'
import { normalizeWorldArchivePath, probeWorld } from '../src/main/core/worlds'

function levelDat(name = '测试世界', version = '1.20.1'): Buffer {
  return zlib.gzipSync(
    writeNbt({
      Data: {
        LevelName: name,
        DataVersion: 3465,
        GameType: 1,
        hardcore: 0,
        Version: { Name: version, Id: 3465 },
        Forge: { Marker: 1 }
      }
    })
  )
}

test('NBT 读取器可解析 gzip level.dat 的嵌套 Compound 与标准数值', () => {
  const parsed = parseNbt(levelDat())
  const data = parsed.Data as Record<string, unknown>
  assert.equal(data.LevelName, '测试世界')
  assert.equal(data.DataVersion, 3465)
  assert.equal((data.Version as Record<string, unknown>).Name, '1.20.1')
})

test('世界目录递归识别 level.dat，并区分确认信息、推断信息和未知 MOD 依赖', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-world-folder-'))
  const world = path.join(root, 'extra', 'World')
  try {
    await fs.promises.mkdir(path.join(world, 'region'), { recursive: true })
    await fs.promises.mkdir(path.join(world, 'datapacks', 'demo'), { recursive: true })
    await fs.promises.mkdir(path.join(world, 'config'), { recursive: true })
    await fs.promises.writeFile(path.join(world, 'level.dat'), levelDat())
    await fs.promises.writeFile(path.join(world, 'region', 'r.0.0.mca'), 'region')
    await fs.promises.writeFile(path.join(world, 'datapacks', 'demo', 'pack.mcmeta'), '{}')
    await fs.promises.writeFile(path.join(world, 'config', 'example.toml'), 'enabled=true')
    await fs.promises.writeFile(path.join(world, 'resources.zip'), 'not-opened-during-probe')

    const result = await probeWorld(root)
    assert.ok(result)
    assert.equal(result.sourceType, 'folder')
    assert.equal(result.candidates.length, 1)
    const candidate = result.candidates[0]
    assert.equal(candidate.id, 'extra/World')
    assert.equal(candidate.worldName, '测试世界')
    assert.equal(candidate.minecraftVersion, '1.20.1')
    assert.equal(candidate.versionConfidence, 'exact')
    assert.equal(candidate.gameMode, '创造')
    assert.equal(candidate.loader, 'forge')
    assert.equal(candidate.loaderConfidence, 'inferred')
    assert.equal(candidate.datapackCount, 1)
    assert.equal(candidate.hasWorldResourcePack, true)
    assert.ok(candidate.modEvidence.some((value) => value.includes('Forge')))
    assert.ok(candidate.modEvidence.some((value) => value.includes('配置')))
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('多层 ZIP 存档按内容识别，并只把 pack.mcmeta + assets 判为资源包', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-world-zip-'))
  const file = path.join(root, 'world.zip')
  try {
    const zip = new AdmZip()
    zip.addFile('wrapper/World/level.dat', levelDat('压缩世界'))
    zip.addFile('wrapper/World/region/r.0.0.mca', Buffer.from('region'))
    zip.addFile('extras/Fancy/pack.mcmeta', Buffer.from('{}'))
    zip.addFile('extras/Fancy/assets/demo/lang/zh_cn.json', Buffer.from('{}'))
    zip.addFile('extras/NotAPack/pack.mcmeta', Buffer.from('{}'))
    zip.writeZip(file)

    const result = await probeWorld(file)
    assert.ok(result)
    const candidate = result.candidates[0]
    assert.equal(candidate.id, 'wrapper/World')
    assert.equal(candidate.worldName, '压缩世界')
    assert.deepEqual(candidate.resourcePacks.map((pack) => pack.name), ['Fancy'])
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('ZIP 路径校验拒绝穿越、绝对路径和 Windows 设备名', () => {
  assert.equal(normalizeWorldArchivePath('outer/World/level.dat'), 'outer/World/level.dat')
  assert.throws(() => normalizeWorldArchivePath('../escape.txt'), /路径穿越/)
  assert.throws(() => normalizeWorldArchivePath('C:/escape.txt'), /绝对路径/)
  if (process.platform === 'win32') {
    assert.throws(() => normalizeWorldArchivePath('World/NUL.txt'), /非法路径/)
  }
})
