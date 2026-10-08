// 无头安装验证：直接调用主进程核心模块安装指定版本（真实下载链路）
// 用法: npx tsx --tsconfig scripts/tsconfig.harness.json scripts/harness-install.ts <versionId> [loader]
import { installVersion, listInstalled } from '../src/main/core/versions'
import type { ProgressEvent } from '../src/shared/types'

const versionId = process.argv[2] ?? '26.2'
const loader = process.argv[3] as 'neoforge' | 'fabric' | undefined

const emit = (e: ProgressEvent) => {
  const pct = Math.round((e.progress ?? 0) * 100)
  process.stdout.write(`\r[${e.stage}] ${pct}% ${e.text ?? ''}                    `)
}

const t0 = Date.now()
async function main() {
  try {
    const id = await installVersion(versionId, loader ? { loader } : {}, emit)
    console.log(`\n✅ 安装成功: ${id}（${((Date.now() - t0) / 1000).toFixed(0)}s）`)
    const found = listInstalled().filter((v) => v.mcVersion === versionId || v.id === id)
    console.log(
      '版本列表中该 MC 版本的条目:',
      JSON.stringify(
        found.map((v) => ({ id: v.id, loader: v.loader, lv: v.loaderVersion, failed: v.failed, incomplete: v.incomplete })),
        null,
        1
      )
    )
    process.exit(0)
  } catch (e) {
    console.error(`\n❌ 安装失败:`, e instanceof Error ? e.message : e)
    process.exit(1)
  }
}
void main()
