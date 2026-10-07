import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { downloadAll } from '../src/main/core/download'
import {
  abortableDelay,
  cancelTaskAndWait,
  finishTask,
  isCancelError,
  registerTask
} from '../src/main/core/tasks'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('取消会中断流、等待 worker 退出、清理 .part，并阻止新子任务', async () => {
  let slowRequests = 0
  let queuedRequests = 0
  let chunksWritten = 0
  let markRequestStarted = (): void => undefined
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve
  })

  const server = http.createServer((req, res) => {
    if (req.url === '/queued') {
      queuedRequests++
      res.end('should not start')
      return
    }
    slowRequests++
    res.writeHead(200, { 'content-length': String(8 * 1024 * 1024) })
    markRequestStarted()
    const chunk = Buffer.alloc(64 * 1024, 7)
    const timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        clearInterval(timer)
        return
      }
      chunksWritten++
      res.write(chunk)
    }, 10)
    res.on('close', () => clearInterval(timer))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'faionyx-cancel-test-'))
  const first = path.join(root, 'first.bin')
  const second = path.join(root, 'second.bin')
  const task = registerTask('取消链路测试', 'download')

  const outcome = downloadAll(
    [
      { url: `http://127.0.0.1:${address.port}/slow`, dest: first },
      { url: `http://127.0.0.1:${address.port}/queued`, dest: second }
    ],
    undefined,
    1,
    'official',
    task.controller.signal
  )
    .then(() => ({ error: null as unknown }))
    .catch((error: unknown) => ({ error }))
    .finally(() => finishTask(task.id))

  try {
    await requestStarted
    await wait(60)
    const cancelledAt = Date.now()
    assert.equal(await cancelTaskAndWait(task.id), true)
    assert.ok(Date.now() - cancelledAt < 2_000, '取消不应等待网络超时')
    const { error } = await outcome
    assert.equal(isCancelError(error), true)
    const chunksAtSettlement = chunksWritten
    await wait(80)

    assert.equal(slowRequests, 1)
    assert.equal(queuedRequests, 0, '取消后不得启动排队中的下载')
    assert.equal(chunksWritten, chunksAtSettlement, '任务确认取消后网络流不应继续读取')
    assert.equal(fs.existsSync(first), false)
    assert.equal(fs.existsSync(first + '.part'), false)
    assert.equal(fs.existsSync(second), false)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('退避等待可被同一任务信号立即打断', async () => {
  const task = registerTask('退避取消测试', 'download')
  const started = Date.now()
  const outcome = abortableDelay(10_000, task.controller.signal)
    .then(() => null)
    .catch((error: unknown) => error)
    .finally(() => finishTask(task.id))
  const cancellation = cancelTaskAndWait(task.id)
  const error = await outcome
  await cancellation
  assert.equal(isCancelError(error), true)
  assert.ok(Date.now() - started < 1_000)
})
