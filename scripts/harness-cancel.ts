// 取消链路验证：大文件下载中触发 abort，确认立即抛出「已取消」且 .part 被清理
import { downloadAll } from '../src/main/core/download'
import { registerTask, cancelTask } from '../src/main/core/tasks'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

async function main() {
  const task = registerTask('取消链路自测', 'download')
  const dest = path.join(os.tmpdir(), `faionyx-cancel-test-${Date.now()}.jar`)
  const url = 'https://piston-data.mojang.com/v1/objects/2dc72797acbc1b63fc16a11c4ac393605f453754/client.jar'
  let lastPct = 0
  const timer = setTimeout(() => {
    console.log('→ 触发取消')
    cancelTask(task.id)
  }, 1500)
  try {
    await downloadAll(
      [{ url, dest }],
      (d, t) => {
        const pct = t ? Math.round((d / t) * 100) : 0
        if (pct !== lastPct) {
          lastPct = pct
          process.stdout.write(`\r${pct}%`)
        }
      },
      1,
      'official',
      task.controller.signal
    )
    clearTimeout(timer)
    console.error('\n❌ 下载完成（取消未生效）')
    fs.rmSync(dest, { force: true })
    process.exit(1)
  } catch (e) {
    clearTimeout(timer)
    const msg = e instanceof Error ? e.message : String(e)
    const partLeft = fs.existsSync(dest + '.part')
    fs.rmSync(dest, { force: true })
    fs.rmSync(dest + '.part', { force: true })
    if (msg === '已取消' && !partLeft) {
      console.log(`\n✅ 取消生效：抛出「已取消」，.part 已清理（取消时进度 ${lastPct}%）`)
      process.exit(0)
    }
    console.error(`\n❌ 异常: ${msg}（.part 残留=${partLeft}）`)
    process.exit(1)
  }
}
void main()
