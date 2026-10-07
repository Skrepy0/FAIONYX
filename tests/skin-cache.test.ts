import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SkinProfileCache } from '../src/main/core/skinProfileCache'
import type { ProfileSkins } from '../src/shared/types'

test('skin disk cache survives restart, isolates accounts, and never stores credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faionyx-skin-cache-'))
  try {
    let downloads = 0
    const png = 'data:image/png;base64,' + fs.readFileSync('src/renderer/src/assets/splash-face.png').toString('base64')
    const profile = { username: 'test', skins: [{ url: 'https://example.invalid/skin.png', variant: 'slim', dataUrl: png }], capes: [], accessToken: 'NEVER_PERSIST' } as ProfileSkins
    const load = async () => { downloads++; return profile }
    await Promise.all([new SkinProfileCache(() => dir).get('account-A', load)])
    const restarted = new SkinProfileCache(() => dir)
    assert.equal((await restarted.get('account-A', load)).skins[0].dataUrl, png)
    assert.equal(downloads, 1)
    await restarted.get('account-B', load)
    assert.equal(downloads, 2)
    assert.equal((await restarted.get('account-A', async () => { throw Error('offline') }, true)).skins[0].dataUrl, png)
    const cached = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('')
    assert(!cached.includes('NEVER_PERSIST'))
    await Promise.all([restarted.get('account-C', load), restarted.get('account-C', load)])
    assert.equal(downloads, 3)
    fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'broken')
    assert((await new SkinProfileCache(() => dir).get('account-A', load)).skins.length)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
