import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canonicalPath, pathIdentity, resolveMinecraftRoot, samePath } from '../src/main/core/folderPaths'

test('游戏根目录识别支持根目录、versions 目录与 .minecraft 上级目录', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-folders-test-'))
  const minecraft = path.join(root, '.minecraft')
  await fs.promises.mkdir(path.join(minecraft, 'versions'), { recursive: true })
  try {
    assert.equal(resolveMinecraftRoot(root).path, canonicalPath(minecraft))
    assert.equal(resolveMinecraftRoot(minecraft).path, canonicalPath(minecraft))
    assert.equal(resolveMinecraftRoot(path.join(minecraft, 'versions')).path, canonicalPath(minecraft))
    assert.equal(resolveMinecraftRoot(minecraft).structure, 'minecraft')
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('路径身份会消除点段、尾分隔符，并在可用时解析 junction', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-folder-id-test-'))
  const target = path.join(root, 'target')
  const link = path.join(root, 'junction')
  await fs.promises.mkdir(target)
  try {
    assert.equal(samePath(target, path.join(target, '.')), true)
    assert.equal(pathIdentity(target + path.sep), pathIdentity(target))
    try {
      await fs.promises.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      assert.equal(samePath(target, link), true)
    } catch {
      // 某些受限 CI 禁止创建符号链接；基础规范化断言仍然有效。
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})
