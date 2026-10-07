import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { probeModpack, restoreModpackUserFiles } from '../src/main/core/modpacks'

async function makePack(index: Record<string, unknown>, extras: Record<string, string> = {}): Promise<{ root: string; file: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-mrpack-test-'))
  const file = path.join(root, 'example.mrpack')
  const zip = new AdmZip()
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index)))
  for (const [name, value] of Object.entries(extras)) zip.addFile(name, Buffer.from(value))
  zip.writeZip(file)
  return { root, file }
}

const validIndex = () => ({
  formatVersion: 1,
  game: 'minecraft',
  name: 'Test Pack',
  versionId: '2.0.0',
  dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' },
  files: [
    {
      path: 'mods/client.jar',
      hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
      downloads: ['https://cdn.example.test/client.jar', 'https://backup.example.test/client.jar'],
      fileSize: 1234,
      env: { client: 'required', server: 'required' }
    },
    {
      path: 'mods/server-only.jar',
      env: { client: 'unsupported', server: 'required' }
    }
  ]
})

test('mrpack 校验格式并统计客户端文件、overrides 与 client-overrides', async () => {
  const { root, file } = await makePack(validIndex(), {
    'overrides/config/common.toml': 'common=true',
    'client-overrides/config/client.toml': 'client=true'
  })
  try {
    const info = await probeModpack(file)
    assert.equal(info.format, 'mrpack')
    assert.equal(info.innerName, 'Test Pack')
    assert.equal(info.mcVersion, '1.20.1')
    assert.equal(info.loader, 'fabric')
    assert.equal(info.loaderVersion, '0.15.11')
    assert.equal(info.fileCount, 1)
    assert.equal(info.downloadBytes, 1234)
    assert.equal(info.hasOverrides, true)
    assert.equal(info.hasClientOverrides, true)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('mrpack 拒绝未知格式版本与非 Minecraft game', async () => {
  const unsupported = await makePack({ ...validIndex(), formatVersion: 2 })
  const wrongGame = await makePack({ ...validIndex(), game: 'other' })
  try {
    await assert.rejects(probeModpack(unsupported.file), /格式版本.*当前支持 1/)
    await assert.rejects(probeModpack(wrongGame.file), /不是 Minecraft/)
  } finally {
    await fs.promises.rm(unsupported.root, { recursive: true, force: true })
    await fs.promises.rm(wrongGame.root, { recursive: true, force: true })
  }
})

test('mrpack 拒绝路径穿越、无可信 HTTPS 来源和无校验哈希', async () => {
  const cases = [
    {
      patch: { path: '../escape.jar' },
      expected: /路径不安全/
    },
    {
      patch: { downloads: ['http://insecure.example.test/file.jar'] },
      expected: /可信 HTTPS/
    },
    {
      patch: { hashes: {} },
      expected: /缺少 SHA1\/SHA512/
    }
  ]
  for (const current of cases) {
    const index = validIndex()
    index.files[0] = { ...index.files[0], ...current.patch }
    const fixture = await makePack(index)
    try {
      await assert.rejects(probeModpack(fixture.file), current.expected)
    } finally {
      await fs.promises.rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test('整合包更新只恢复用户文件，覆盖模式不会带回未知包目录', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-pack-restore-'))
  const backup = path.join(root, 'backup')
  const update = path.join(root, 'update')
  const overwrite = path.join(root, 'overwrite')
  try {
    for (const base of [backup, update, overwrite]) {
      await fs.promises.mkdir(path.join(base, 'mods'), { recursive: true })
      await fs.promises.mkdir(path.join(base, 'config'), { recursive: true })
    }
    await fs.promises.mkdir(path.join(backup, 'saves', 'World'), { recursive: true })
    await fs.promises.mkdir(path.join(backup, 'legacy-pack-folder'), { recursive: true })
    await fs.promises.writeFile(path.join(backup, 'saves', 'World', 'level.dat'), 'world')
    await fs.promises.writeFile(path.join(backup, 'config', 'user.toml'), 'user-config')
    await fs.promises.writeFile(path.join(backup, 'mods', 'managed.jar'), 'old-pack-mod')
    await fs.promises.writeFile(path.join(backup, 'mods', 'user.jar'), 'user-mod')
    await fs.promises.writeFile(path.join(backup, 'legacy-pack-folder', 'old.dat'), 'legacy')
    for (const base of [update, overwrite]) {
      await fs.promises.writeFile(path.join(base, 'config', 'user.toml'), 'new-default')
      await fs.promises.writeFile(path.join(base, 'mods', 'managed.jar'), 'new-pack-mod')
    }

    const managed = new Set(['mods/managed.jar'])
    await restoreModpackUserFiles(backup, update, 'update', managed)
    await restoreModpackUserFiles(backup, overwrite, 'overwrite', managed)

    assert.equal(await fs.promises.readFile(path.join(update, 'config', 'user.toml'), 'utf-8'), 'user-config')
    assert.equal(await fs.promises.readFile(path.join(update, 'mods', 'managed.jar'), 'utf-8'), 'new-pack-mod')
    assert.equal(await fs.promises.readFile(path.join(update, 'mods', 'user.jar'), 'utf-8'), 'user-mod')
    assert.equal(fs.existsSync(path.join(update, 'legacy-pack-folder', 'old.dat')), true)
    assert.equal(fs.existsSync(path.join(overwrite, 'saves', 'World', 'level.dat')), true)
    assert.equal(fs.existsSync(path.join(overwrite, 'mods', 'user.jar')), true)
    assert.equal(fs.existsSync(path.join(overwrite, 'legacy-pack-folder')), false)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})
