import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { redactDiagnosticPath, redactDiagnosticText, safeDiagnosticFilePart } from '../src/main/core/diagnostics'
import { writeDiagnosticArchive, type DiagnosticManifestEntry } from '../src/main/core/diagnosticArchive'

test('诊断日志会脱敏启动 token、认证头、密码、查询参数和用户目录', () => {
  const known = 'known-session-secret'
  const input = [
    '--accessToken mc-access-token --clientId client-secret --username Player',
    'Authorization: Bearer bearer-token',
    'password=plain-password',
    '{"refresh_token":"refresh-value"}',
    `url=https://example.test/callback?token=query-token&ok=1`,
    `known=${known}`,
    'C:\\Users\\Alice\\AppData\\Roaming\\.minecraft',
  ].join('\n')
  const output = redactDiagnosticText(input, [known])

  for (const secret of [
    'mc-access-token',
    'client-secret',
    'bearer-token',
    'plain-password',
    'refresh-value',
    'query-token',
    known,
    'C:\\Users\\Alice',
  ]) {
    assert.equal(output.includes(secret), false, `仍包含敏感信息：${secret}`)
  }
  assert.match(output, /<redacted>/)
  assert.match(output, /%USERPROFILE%/)
})

test('诊断文件名过滤 Windows 非法字符，路径隐藏当前用户主目录', () => {
  assert.equal(safeDiagnosticFilePart('1.20.4:<bad>|name?'), '1.20.4__bad__name_')
  const privatePath = path.join(os.homedir(), 'Games', '.minecraft')
  assert.equal(redactDiagnosticPath(privatePath).includes(os.homedir()), false)
})

test('诊断归档生成真实 ZIP，记录缺失项并脱敏每份文本', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-diagnostic-test-'))
  const source = path.join(root, 'latest.log')
  const missing = path.join(root, 'debug.log')
  const destination = path.join(root, 'diagnostic.zip')
  const secret = 'super-secret-session-token'
  await fs.promises.writeFile(source, `Authorization: Bearer ${secret}\nOK\n`, 'utf-8')
  const manifest: { schemaVersion: number; files: DiagnosticManifestEntry[] } = {
    schemaVersion: 1,
    files: [],
  }
  try {
    await writeDiagnosticArchive(
      destination,
      manifest,
      [
        { archivePath: 'minecraft/latest.log', source },
        { archivePath: 'minecraft/debug.log', source: missing, missingPlaceholder: true },
      ],
      `summary ${secret}`,
      [secret]
    )
    const zip = new AdmZip(destination)
    const names = zip.getEntries().map((entry) => entry.entryName)
    assert.deepEqual(names.sort(), ['manifest.json', 'minecraft/debug.log', 'minecraft/latest.log', 'summary.txt'])
    const allText = zip
      .getEntries()
      .map((entry) => entry.getData().toString('utf-8'))
      .join('\n')
    assert.equal(allText.includes(secret), false)
    const packedManifest = JSON.parse(zip.readAsText('manifest.json')) as typeof manifest
    assert.equal(packedManifest.files[0].status, 'included')
    assert.equal(packedManifest.files[1].status, 'missing')
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})
