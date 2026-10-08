import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { downloadAll, downloadFile, type DownloadBatchProgress } from '../src/main/core/download'
import { DownloadProgressTracker, SmoothedSpeedEstimator } from '../src/main/core/downloadProgress'
import { createWeightedProgressEmit, ProgressEventGuard, VERSION_INSTALL_STAGE_RANGES } from '../src/main/core/progress'
import { finishTask, pauseTask, registerTask, resumeTask } from '../src/main/core/tasks'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function assertMonotonic(values: number[]): void {
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] >= values[i - 1], `${values[i]} < ${values[i - 1]} at ${i}`)
  }
}

test('字节聚合在并发乱序完成和重试回报较小值时保持单调', () => {
  const tracker = new DownloadProgressTracker()
  const a = tracker.add(100)
  const b = tracker.add(200)
  const c = tracker.add(50)
  tracker.seal()
  const values = [
    tracker.update(b, 80).fraction,
    tracker.complete(c, 50).fraction,
    tracker.update(a, 60).fraction,
    tracker.update(b, 20).fraction, // 模拟重试从较小 received 重新报告
    tracker.complete(a, 100).fraction,
    tracker.complete(b, 200).fraction,
  ].filter((value): value is number => value != null)
  assertMonotonic(values)
  assert.equal(values.at(-1), 1)
})

test('未知大小不伪造百分比，发现总量后才切换确定进度', () => {
  const tracker = new DownloadProgressTracker()
  const id = tracker.add()
  tracker.seal()
  const unknown = tracker.update(id, 20)
  assert.equal(unknown.indeterminate, true)
  assert.equal(unknown.fraction, null)
  assert.equal(unknown.bytesTotal, null)
  const known = tracker.update(id, 30, 100)
  assert.equal(known.indeterminate, false)
  assert.equal(known.fraction, 0.3)
})

test('动态增加文件时重建剩余进度区间而不回退', () => {
  const tracker = new DownloadProgressTracker()
  const first = tracker.add(100)
  tracker.seal()
  const before = tracker.update(first, 50).fraction ?? 0
  const added = tracker.add(100)
  const afterAdd = tracker.snapshot().fraction ?? 0
  const afterWork = tracker.update(added, 50).fraction ?? 0
  const done = tracker.complete(first, 100).fraction ?? 0
  assertMonotonic([before, afterAdd, afterWork, done])
})

test('平滑速度与 ETA 在降速、恢复和暂停时始终有限且限幅', () => {
  const estimator = new SmoothedSpeedEstimator()
  assert.deepEqual(estimator.sample(0, 10_000, 0), { speedBps: 0, etaSeconds: null })
  const fast = estimator.sample(2_000, 8_000, 1_000)
  const slow = estimator.sample(2_100, 7_900, 2_000)
  const recovered = estimator.sample(4_100, 5_900, 3_000)
  for (const value of [fast, slow, recovered]) {
    assert.ok(Number.isFinite(value.speedBps) && value.speedBps >= 0)
    assert.ok(value.etaSeconds == null || (Number.isFinite(value.etaSeconds) && value.etaSeconds >= 0))
  }
  assert.ok((slow.etaSeconds ?? 0) <= (fast.etaSeconds ?? 0) * 1.35 + 5)
  assert.deepEqual(estimator.sample(4_100, 5_900, 4_000, true), {
    speedBps: 0,
    etaSeconds: null,
  })
})

test('下载、校验与加载器阶段按稳定权重映射且 IPC 出口拒绝回跳和非法 ETA', () => {
  const values: number[] = []
  const guard = new ProgressEventGuard()
  const emit = createWeightedProgressEmit((event) => {
    const normalized = guard.normalize(event)
    values.push(normalized.overall ?? -1)
    assert.ok(normalized.etaSeconds == null || normalized.etaSeconds >= 0)
  }, VERSION_INSTALL_STAGE_RANGES)

  emit({ stage: 'version-json', progress: 1, text: '版本信息完成' })
  emit({ stage: 'libraries', progress: 0.75, text: '依赖下载中', etaSeconds: 12.4 })
  emit({ stage: 'libraries', progress: 0.2, text: '分块重试', etaSeconds: -1 })
  emit({ stage: 'client', progress: Number.NaN, text: '游戏下载中' })
  emit({ stage: 'assets', progress: 0.5, text: '资源下载中' })
  emit({ stage: 'loader', progress: 1, text: '加载器完成' })
  emit({ stage: 'fabric-api', progress: 1, text: 'API 完成' })
  emit({ stage: 'done', progress: 1, text: '完成' })

  assertMonotonic(values)
  assert.equal(values.at(-1), 1)
})

test('网络中断后使用 Range 续传并保持单文件进度单调', async () => {
  const payload = crypto.randomBytes(384 * 1024)
  const sha1 = crypto.createHash('sha1').update(payload).digest('hex')
  let requests = 0
  let resumedAt = 0
  const server = http.createServer((req, res) => {
    requests++
    if (requests === 1) {
      res.writeHead(200, { 'content-length': String(payload.length), 'accept-ranges': 'bytes' })
      res.write(payload.subarray(0, payload.length / 2))
      setTimeout(() => res.destroy(), 10)
      return
    }
    const match = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''))
    resumedAt = match ? Number(match[1]) : 0
    res.writeHead(206, {
      'content-length': String(payload.length - resumedAt),
      'content-range': `bytes ${resumedAt}-${payload.length - 1}/${payload.length}`,
    })
    res.end(payload.subarray(resumedAt))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-resume-test-'))
  const dest = path.join(root, 'client.jar')
  const values: number[] = []
  try {
    await downloadFile(`http://127.0.0.1:${address.port}/client.jar`, dest, (done) => values.push(done), sha1, 'official', undefined, [], {
      size: payload.length,
    })
    assert.equal(requests, 2)
    assert.ok(resumedAt > 0 && resumedAt < payload.length)
    assertMonotonic(values)
    assert.deepEqual(await fs.promises.readFile(dest), payload)
    assert.equal(fs.existsSync(dest + '.part'), false)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('多文件并行下载的真实字节进度单调，暂停时停止写盘并可恢复', async () => {
  const payloads = [crypto.randomBytes(512 * 1024), crypto.randomBytes(768 * 1024)]
  const server = http.createServer((req, res) => {
    const index = req.url === '/b' ? 1 : 0
    const payload = payloads[index]
    res.writeHead(200, { 'content-length': String(payload.length) })
    let offset = 0
    const timer = setInterval(
      () => {
        if (res.destroyed || res.writableEnded) return clearInterval(timer)
        const end = Math.min(payload.length, offset + 16 * 1024)
        res.write(payload.subarray(offset, end))
        offset = end
        if (offset >= payload.length) {
          clearInterval(timer)
          res.end()
        }
      },
      index === 0 ? 8 : 13
    )
    res.on('close', () => clearInterval(timer))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-pause-test-'))
  const task = registerTask('暂停恢复测试', 'download')
  const snapshots: DownloadBatchProgress[] = []
  const base = `http://127.0.0.1:${address.port}`
  const outcome = downloadAll(
    [
      { url: `${base}/a`, dest: path.join(root, 'a.bin'), size: payloads[0].length },
      { url: `${base}/b`, dest: path.join(root, 'b.bin'), size: payloads[1].length },
    ],
    (_done, _total, _speed, detail) => snapshots.push({ ...detail }),
    2,
    'official',
    task.controller.signal
  ).finally(() => finishTask(task.id))

  try {
    while (!fs.existsSync(path.join(root, 'a.bin.part'))) await wait(10)
    await wait(80)
    assert.equal(pauseTask(task.id), true)
    await wait(120)
    const sizeAtPause = fs.statSync(path.join(root, 'a.bin.part')).size
    await wait(600)
    assert.equal(fs.statSync(path.join(root, 'a.bin.part')).size, sizeAtPause)
    assert.equal(resumeTask(task.id), true)
    await outcome

    const fractions = snapshots.map((snapshot) => snapshot.fraction).filter((value): value is number => value != null)
    assertMonotonic(fractions)
    assert.equal(fractions.at(-1), 1)
    assert.ok(snapshots.some((snapshot) => snapshot.paused && snapshot.speedBps === 0))
    assert.equal(snapshots.at(-1)?.bytesDone, payloads[0].length + payloads[1].length)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})
