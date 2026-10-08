/**
 * 启动器日志核心的可纯测部分：
 * 归档命名/修剪选择、行格式与脱敏、错误序列化、级别过滤、目录级修剪。
 * electron 依赖（app.getPath）在测试环境中为 undefined，
 * 因此同时验证：所有日志入口在任何失败下都静默、绝不向业务抛错。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  archivedLogFileName,
  selectPrunableArchives,
  pruneArchivedLogs,
  formatLauncherLogLine,
  formatErrorText,
  levelAtLeast,
  minimumLevelFromEnv,
  launcherLog,
  launcherLogError,
  launcherLogWarn,
  logScope,
  flushLauncherLogSync,
} from '../src/main/core/launcherLog'

test('归档文件名按 YYYYMMDD-HHMMSS 生成', () => {
  const name = archivedLogFileName(new Date(2026, 0, 2, 3, 4, 5))
  assert.equal(name, 'launcher-20260102-030405.log')
})

test('修剪选择保留最近 keep 份，时间戳相同的按毫秒后缀视为更新', () => {
  const names = [
    'launcher-20260101-000000.log',
    'launcher-20260102-000000.log',
    'launcher-20260103-000000.log',
    'launcher-20260103-000000-999.log', // 同秒冲突的第二次归档，时间上最新
    'launcher-current.log', // 非 archv 命名，绝不能出现在删除列表
    'settings.json',
  ]
  const pruned = selectPrunableArchives(names, 2)
  // 保留最新两份：-999 毫秒后缀与 0103；删除其余归档
  assert.deepEqual(pruned.sort(), ['launcher-20260101-000000.log', 'launcher-20260102-000000.log'])
  assert.deepEqual(selectPrunableArchives(names, 10), [])
  // keep=0 时全部可删
  assert.equal(selectPrunableArchives(names, 0).length, 4)
})

test('目录级修剪真的删除超量归档且不动 current', () => {
  const dir = mkdtempSync(join(tmpdir(), 'faionyx-log-test-'))
  try {
    const names = []
    for (let d = 1; d <= 9; d++) {
      const name = `launcher-2026010${d}-000000.log`
      writeFileSync(join(dir, name), 'old session\n', 'utf-8')
      names.push(name)
    }
    writeFileSync(join(dir, 'launcher-current.log'), 'current\n', 'utf-8')
    const removed = pruneArchivedLogs(dir, 7)
    assert.equal(removed, 2)
    const left = readdirSync(dir).sort()
    assert.equal(left.length, 8) // 7 份归档 + current
    assert(left.includes('launcher-20260109-000000.log'))
    assert(!left.includes('launcher-20260101-000000.log'))
    assert(left.includes('launcher-current.log'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('行格式：级别大写、作用域可省略、换行压平并脱敏', () => {
  const line = formatLauncherLogLine(new Date(0), 'warn', 'launch', '启动失败\n第二行')
  assert.match(line, /^\[1970-01-01T00:00:00\.000Z\] \[WARN\] \[launch\] 启动失败 第二行$/)
  const noScope = formatLauncherLogLine(new Date(0), 'info', '', 'hello')
  assert.match(noScope, /^\[1970-01-01T00:00:00\.000Z\] \[INFO\] hello$/)
  // accessToken 与用户目录都必须被脱敏
  const secret = formatLauncherLogLine(new Date(0), 'info', 'test', 'access_token=abcdef123456 home=C:\\Users\\somebody')
  assert(!secret.includes('abcdef123456'))
  assert(secret.includes('<redacted>'))
  assert(!secret.includes('C:\\Users\\somebody'))
})

test('错误序列化：保留 name/message/stack、压成单行并脱敏', () => {
  const error = new Error('网络请求失败: access_token=abcdef123456')
  const text = formatErrorText(error)
  assert(text.startsWith('Error: 网络请求失败'))
  assert(!text.includes('\n'))
  assert(!text.includes('abcdef123456'))
  // 非 Error 值与无堆栈错误也要有可读输出
  assert.equal(formatErrorText('plain failure'), 'plain failure')
  const stackless = new Error('no stack')
  stackless.stack = undefined
  assert.equal(formatErrorText(stackless), 'Error: no stack')
})

test('级别过滤：阈值比较与环境变量解析', () => {
  assert(levelAtLeast('info', 'debug'))
  assert(levelAtLeast('info', 'info'))
  assert(!levelAtLeast('debug', 'info'))
  assert(levelAtLeast('error', 'warn'))
  assert.equal(minimumLevelFromEnv({}), 'debug')
  assert.equal(minimumLevelFromEnv({ FAIONYX_LOG_LEVEL: 'warn' }), 'warn')
  assert.equal(minimumLevelFromEnv({ FAIONYX_LOG_LEVEL: 'ERROR' }), 'error')
  assert.equal(minimumLevelFromEnv({ FAIONYX_LOG_LEVEL: 'nonsense' }), 'debug')
})

test('日志入口在 electron app 不可用时静默，绝不影响业务', () => {
  // 测试环境里 app.getPath 不可用：initialize 失败必须被吞掉，
  // 各级别入口、错误对象、同步 flush 都不允许抛错。
  assert.doesNotThrow(() => {
    launcherLog('legacy entry still works')
    launcherLogWarn('scope-test', 'warn message')
    launcherLogError('scope-test', 'error message', new Error('boom'))
    logScope('scope-test').debug('debug message')
    logScope('scope-test').info('info message')
    logScope('scope-test').warn('warn with error', 'string reason')
    logScope('scope-test').error('error with object', { code: 42 })
    flushLauncherLogSync()
    flushLauncherLogSync() // 幂等
  })
})
