import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { commitIsolationFiles, hasIsolationContent, planIsolationFiles } from '../src/main/core/isolationFiles'

async function fixture(): Promise<{ root: string; source: string; destination: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-isolation-test-'))
  const source = path.join(root, 'minecraft')
  const destination = path.join(source, 'versions', 'test-instance')
  await fs.promises.mkdir(path.join(source, 'saves', 'World'), { recursive: true })
  await fs.promises.mkdir(path.join(source, 'mods'), { recursive: true })
  await fs.promises.writeFile(path.join(source, 'saves', 'World', 'level.dat'), 'level')
  await fs.promises.writeFile(path.join(source, 'mods', 'shared.jar'), 'shared')
  await fs.promises.writeFile(path.join(source, 'options.txt'), 'lang:zh_cn')
  return { root, source, destination }
}

test('隔离迁移计划仅统计白名单数据并标出不覆盖的目标冲突', async () => {
  const { root, source, destination } = await fixture()
  try {
    await fs.promises.mkdir(path.join(destination, 'mods'), { recursive: true })
    await fs.promises.writeFile(path.join(destination, 'mods', 'private.jar'), 'private')
    await fs.promises.writeFile(path.join(source, 'unrelated.bin'), 'ignore')

    assert.equal(hasIsolationContent(destination), true)
    const plan = planIsolationFiles('test-instance', source, destination)
    assert.deepEqual(
      plan.items.map((item) => item.name),
      ['saves', 'mods', 'options.txt']
    )
    assert.deepEqual(plan.conflicts, ['mods'])
    assert.equal(plan.totalFiles, 3)
    assert.equal(plan.totalBytes, Buffer.byteLength('levelsharedlang:zh_cn'))
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('事务迁移保留源数据与冲突项，提交后不遗留 staging', async () => {
  const { root, source, destination } = await fixture()
  try {
    await fs.promises.mkdir(path.join(destination, 'mods'), { recursive: true })
    await fs.promises.writeFile(path.join(destination, 'mods', 'private.jar'), 'private')
    const plan = planIsolationFiles('test-instance', source, destination)
    let committed = false
    await commitIsolationFiles(plan, () => {
      committed = true
    })

    assert.equal(committed, true)
    assert.equal(await fs.promises.readFile(path.join(destination, 'saves', 'World', 'level.dat'), 'utf-8'), 'level')
    assert.equal(await fs.promises.readFile(path.join(destination, 'options.txt'), 'utf-8'), 'lang:zh_cn')
    assert.equal(await fs.promises.readFile(path.join(destination, 'mods', 'private.jar'), 'utf-8'), 'private')
    assert.equal(fs.existsSync(path.join(destination, 'mods', 'shared.jar')), false)
    assert.equal(fs.existsSync(path.join(source, 'saves', 'World', 'level.dat')), true)
    assert.equal(
      (await fs.promises.readdir(destination)).some((name) => name.startsWith('.isolation-staging-')),
      false
    )
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('元数据提交失败会回滚所有本次新增项', async () => {
  const { root, source, destination } = await fixture()
  try {
    const plan = planIsolationFiles('test-instance', source, destination)
    await assert.rejects(
      commitIsolationFiles(plan, () => {
        throw new Error('模拟 JSON 写入失败')
      }),
      /模拟 JSON 写入失败/
    )
    assert.equal(fs.existsSync(path.join(destination, 'saves')), false)
    assert.equal(fs.existsSync(path.join(destination, 'mods')), false)
    assert.equal(fs.existsSync(path.join(destination, 'options.txt')), false)
    assert.equal(fs.existsSync(path.join(source, 'saves', 'World', 'level.dat')), true)
    assert.deepEqual(await fs.promises.readdir(destination), [])
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})
