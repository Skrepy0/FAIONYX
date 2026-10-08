import assert from 'node:assert/strict'
import test from 'node:test'
import type { GameResolution } from '../src/shared/types'
import {
  buildGameWindowArguments,
  normalizeStoredResolution,
  resolutionValidationError,
  resolveGameResolution,
} from '../src/main/core/gameWindow'

const windowed: GameResolution = {
  width: 1280,
  height: 720,
  mode: 'windowed',
  fullscreen: false,
}

test('旧 fullscreen 配置迁移为明确窗口模式', () => {
  assert.deepEqual(normalizeStoredResolution({ width: 1920, height: 1080, fullscreen: true }), {
    width: 1920,
    height: 1080,
    mode: 'fullscreen',
    fullscreen: true,
  })
})

test('窗口化参数删除元数据旧值并只写入最终宽高', () => {
  const result = buildGameWindowArguments(['--username', 'player', '--width', '854', '--height', '480', '--fullscreen'], windowed)
  assert.deepEqual(result.args, ['--username', 'player', '--width', '1280', '--height', '720'])
  assert.equal(result.mode, 'windowed')
})

test('全屏不携带窗口尺寸，最大化使用显示器工作区且不传 fullscreen', () => {
  const fullscreen = buildGameWindowArguments([], {
    ...windowed,
    mode: 'fullscreen',
    fullscreen: true,
  })
  assert.deepEqual(fullscreen.args, ['--fullscreen'])
  assert.equal(fullscreen.width, undefined)

  const maximized = buildGameWindowArguments(
    [],
    {
      ...windowed,
      mode: 'maximized',
    },
    { width: 1536, height: 824 }
  )
  assert.deepEqual(maximized.args, ['--width', '1536', '--height', '824'])
  assert.equal(maximized.mode, 'maximized')
})

test('实例窗口配置优先于全局，删除覆盖后恢复全局', () => {
  const instance: GameResolution = {
    width: 1600,
    height: 900,
    mode: 'windowed',
    fullscreen: false,
  }
  assert.deepEqual(resolveGameResolution(windowed, instance), instance)
  assert.deepEqual(resolveGameResolution(windowed, null), windowed)
})

test('非法宽高在进入启动命令前产生可读校验错误', () => {
  assert.match(resolutionValidationError({ ...windowed, width: 0 }) ?? '', /854–7680/)
  assert.match(resolutionValidationError({ ...windowed, height: Number.NaN }) ?? '', /480–4320/)
})
