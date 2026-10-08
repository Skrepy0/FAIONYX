// flatten 验收：改名基础原版 → 离线账号启动 flatten 实例
import { launch, killGame } from '../src/main/core/launch'
import fs from 'node:fs'

const ACCOUNTS = 'C:/Users/ROG/AppData/Roaming/faionyx/accounts.json'

async function main() {
  // 临时切换选中账号为离线账号（测完恢复）
  const raw = fs.readFileSync(ACCOUNTS, 'utf-8')
  const acc = JSON.parse(raw)
  const origSelected = acc.selectedId
  const offline = acc.accounts.find((a: { type: string; id: string }) => a.type === 'offline')
  acc.selectedId = offline?.id ?? origSelected
  fs.writeFileSync(ACCOUNTS, JSON.stringify(acc, null, 2))
  console.log('已临时切换到离线账号:', offline?.username)

  try {
    console.log('== 改名基础原版 26.1.2 → 26.1.2-old ==')
    const dir = 'D:/Snapshot 2.2.10/.minecraft/versions/26.1.2'
    const renamed = 'D:/Snapshot 2.2.10/.minecraft/versions/26.1.2-old'
    fs.renameSync(dir, renamed)

    console.log('== 启动 flatten 实例 neoforge-26.1.2.103（基础原版已消失） ==')
    let running = false
    await launch(
      'neoforge-26.1.2.103',
      () => undefined,
      () => undefined,
      (s) => {
        if (s.status === 'running') running = true
        console.log('  STATE:', s.status, s.text)
      }
    )
    if (!running) {
      console.log('  [FAIL] 未进入 running')
      process.exitCode = 1
      return
    }
    await new Promise((r) => setTimeout(r, 20000))
    console.log('  [OK] 存活 20s（自包含实例在基础原版缺失时照常启动）')
    killGame()
    await new Promise((r) => setTimeout(r, 3000))

    fs.renameSync(renamed, dir)
    console.log('== 已恢复 26.1.2 目录名 ==')
  } finally {
    const cur = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf-8'))
    cur.selectedId = origSelected
    fs.writeFileSync(ACCOUNTS, JSON.stringify(cur, null, 2))
    console.log('账号选择已恢复')
  }
}
void main()
