// 无头启动验证：真实启动游戏，running 后观察 20 秒确认存活，然后终止
// 用法: npx tsx --tsconfig scripts/tsconfig.harness.json scripts/harness-launch.ts <versionId>
import { launch, killGame } from '../src/main/core/launch';
import type { ProgressEvent, LaunchState } from '../src/shared/types';

const versionId = process.argv[2] ?? '26.2';
const emit = (e: ProgressEvent) => {
  process.stdout.write(`\r[${e.stage}] ${Math.round((e.progress ?? 0) * 100)}% ${e.text ?? ''}          `);
};
const sendLog = (line: string) => {
  if (/error|exception|failed|mojang|lwjgl|backend/i.test(line)) console.log('\nLOG:', line.slice(0, 200));
};

const t0 = Date.now();
async function main() {
  let running = false;
  await launch(versionId, emit, sendLog, (s: LaunchState) => {
    console.log(`\nSTATE: ${s.status} ${s.text ?? ''}`);
    if (s.status === 'running') running = true;
  }).catch((e) => {
    console.error(`\n❌ 启动调用失败:`, e instanceof Error ? e.message : e);
    process.exit(1);
  });
  if (!running) {
    console.error('\n❌ 未进入 running 状态');
    process.exit(1);
  }
  // 观察 20 秒确认进程存活（未秒退）
  await new Promise((r) => setTimeout(r, 20000));
  const { getRunningVersionId } = await import('../src/main/core/launch');
  const alive = getRunningVersionId() === versionId;
  console.log(alive ? `✅ ${versionId} 启动并存活 20s（${((Date.now() - t0) / 1000).toFixed(0)}s）` : '❌ 进程提前退出');
  killGame();
  process.exit(alive ? 0 : 1);
}
void main();
