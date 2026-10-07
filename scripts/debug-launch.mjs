/**
 * 诊断脚本：复刻 FAIONYX 启动逻辑，捕获 MC 真实崩溃输出
 * 用法: node scripts/debug-launch.mjs <versionId>
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const versionId = process.argv[2] || 'fabric-loader-0.19.5-26.2'
const gameDir = path.join(process.env.APPDATA, '.faionyx')
const vdir = (id) => path.join(gameDir, 'versions', id)
const vjson = (id) => JSON.parse(fs.readFileSync(path.join(vdir(id), `${id}.json`), 'utf-8'))

// 版本链合并
const chain = []
let cur = vjson(versionId)
while (cur) {
  chain.push(cur)
  cur = cur.inheritsFrom ? vjson(cur.inheritsFrom) : null
}
const baseId = chain[chain.length - 1].id
const childFirst = (k) => chain.map((c) => c[k]).find((v) => v != null)
const parentFirst = [...chain].reverse()
const merged = {
  mainClass: childFirst('mainClass'),
  assets: childFirst('assets'),
  assetIndex: childFirst('assetIndex'),
  javaVersion: childFirst('javaVersion'),
  libraries: chain.flatMap((c) => c.libraries ?? []),
  arguments: {
    game: parentFirst.flatMap((c) => c.arguments?.game ?? []),
    jvm: parentFirst.flatMap((c) => c.arguments?.jvm ?? [])
  }
}

// rules（windows）：无一匹配 → 拒绝
const allow = (rules) => {
  if (!rules?.length) return true
  let ok = false
  for (const r of rules) {
    if (r.features) continue
    if (r.os && r.os.name && r.os.name !== 'windows') continue
    ok = r.action === 'allow'
  }
  return ok
}

// libraries + natives（含 maven 坐标形式）
const libRoot = path.join(gameDir, 'libraries')
const artifacts = []
const natives = []
const seen = new Set()
const mavenPath = (name) => {
  const p = name.split(':')
  if (p.length < 3) return null
  const [g, a, v, classifier] = p
  return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${classifier ? `-${classifier}` : ''}.jar`
}
for (const lib of merged.libraries) {
  if (!allow(lib.rules)) continue
  const art = lib.downloads?.artifact
  let rel = art?.path
  if (!rel && lib.name && lib.url) rel = mavenPath(lib.name)
  if (rel) {
    const p = path.join(libRoot, rel)
    if (!seen.has(p)) { seen.add(p); artifacts.push(p) }
  }
  const nkey = lib.natives?.windows?.replace('${arch}', '64')
  const nat = nkey && lib.downloads?.classifiers?.[nkey]
  if (nat?.path) {
    const p = path.join(libRoot, nat.path)
    if (!seen.has(p)) { seen.add(p); natives.push(p) }
  }
}
const missing = [...artifacts, ...natives].filter((p) => !fs.existsSync(p))
if (missing.length) console.log('MISSING LIBS:\n' + missing.join('\n'))

// natives 解压
const nativesDir = path.join(vdir(versionId), 'natives')
fs.mkdirSync(nativesDir, { recursive: true })
for (const jar of natives) {
  if (!fs.existsSync(jar)) continue
  try {
    const zip = new AdmZip(jar)
    for (const e of zip.getEntries()) {
      if (e.isDirectory || e.entryName.startsWith('META-INF/')) continue
      zip.extractEntryTo(e, nativesDir, true, true)
    }
  } catch {}
}

// 账号（离线假账号）
const md5 = crypto.createHash('md5').update('OfflinePlayer:kamu').digest('hex')
const uuid = `${md5.slice(0, 8)}-${md5.slice(8, 12)}-3${md5.slice(13, 16)}-${((parseInt(md5.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${md5.slice(18, 20)}-${md5.slice(20, 32)}`
const clientJar = path.join(vdir(baseId), `${baseId}.jar`)
const classpath = [...new Set([...artifacts, ...natives, clientJar])].join(';')
const indexId = merged.assetIndex?.id ?? merged.assets ?? 'legacy'

const vars = {
  auth_player_name: 'kamu',
  version_name: versionId,
  game_directory: gameDir,
  assets_root: path.join(gameDir, 'assets'),
  assets_index_name: merged.assets ?? indexId,
  auth_uuid: uuid,
  auth_access_token: crypto.randomBytes(16).toString('hex'),
  clientid: '',
  auth_xuid: '',
  user_type: 'mojang',
  version_type: 'FAIONYX-debug',
  natives_directory: nativesDir,
  launcher_name: 'FAIONYX',
  launcher_version: 'debug',
  classpath,
  library_directory: libRoot,
  classpath_separator: ';'
}
const expand = (entries) =>
  (entries ?? []).flatMap((e) => {
    if (typeof e === 'string') return [e]
    if (!allow(e.rules)) return []
    return Array.isArray(e.value) ? e.value : [e.value]
  })
const subst = (s) => s.replace(/\$\{(\w+)\}/g, (m, k) => vars[k] ?? m)

const jvmArgs = [
  '-Xmx4096M', '-Xms1024M', '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200', '-Dfile.encoding=UTF-8',
  `-Djava.library.path=${nativesDir}`, `-Djna.tmpdir=${nativesDir}`,
  ...expand(merged.arguments.jvm).map(subst)
]
const gameArgs = expand(merged.arguments.game).map(subst)
const args = [...jvmArgs, '-cp', classpath, merged.mainClass, ...gameArgs]

// 找 java 25
const found = spawnSync('where', ['java'], { encoding: 'utf-8' }).stdout?.split(/\r?\n/).filter(Boolean) ?? []
let java = found[0]
console.log('java candidates:', found)
console.log('use java:', java)
console.log('mainClass:', merged.mainClass, '| libs:', artifacts.length, '| natives:', natives.length)

const proc = spawn(java, args, { cwd: gameDir })
const out = []
proc.stdout.on('data', (d) => out.push(d))
proc.stderr.on('data', (d) => out.push(d))
proc.on('exit', (code) => {
  const text = Buffer.concat(out).toString('utf-8')
  fs.writeFileSync(path.join(__dirname, 'debug-launch.log'), text, 'utf-8')
  console.log('exit code:', code)
  console.log('---- 输出前 3000 字 ----')
  console.log(text.slice(0, 3000))
  process.exit(0)
})
setTimeout(() => { console.log('60s 超时仍在运行（说明可能启动成功！），结束进程'); proc.kill(); process.exit(0) }, 60000)
