// Exercise the *built* portable stub and its argument quoting without opening UI,
// touching real userData or launching Minecraft. Keep evidence in the temp root.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const version = require('../package.json').version
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faionyx portable 空格-'))
const executable = path.join(root, `FAIONYX test ${version}.exe`)
fs.copyFileSync(path.resolve(`release/FAIONYX-${version}.exe`), executable)
const marker = path.join(root, 'launch proof.json')
const env = { ...process.env, TEMP: root, TMP: root, ELECTRON_RUN_AS_NODE: '1', FAIONYX_QA_MARKER: marker }
const result = spawnSync(
  executable,
  ['-e', 'require("fs").writeFileSync(process.env.FAIONYX_QA_MARKER,JSON.stringify({exe:process.execPath,argv:process.argv}))'],
  { env, windowsHide: true, timeout: 90000, encoding: 'utf8' }
)
assert.ifError(result.error)
assert.equal(result.status, 0, result.stderr)
assert.ok(fs.existsSync(marker), 'Inner Electron did not start')
const proof = JSON.parse(fs.readFileSync(marker, 'utf8'))
// 便携版解压到 exe 所在文件夹的固定子目录 FAIONYX-runtime（不再占用系统 TEMP 随机目录）
assert.ok(proof.exe.startsWith(path.join(root, 'FAIONYX-runtime')), 'must unpack next to the portable exe, got: ' + proof.exe)
assert.ok(proof.exe.endsWith('FAIONYX.exe'))
fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify({ version, status: result.status, proof, pass: true }, null, 2))
console.log('PASS portable quoting and inner startup: ' + root)
