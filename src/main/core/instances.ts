import fs from 'node:fs'
import path from 'node:path'
import type { IsolationMigrationPlan } from '../../shared/types'
import type { VersionJson } from './versions'
import { folderOfVersion, versionDir, versionJsonPath } from './paths'
import { canonicalPath, samePath } from './folderPaths'
import { commitIsolationFiles, hasIsolationContent, planIsolationFiles } from './isolationFiles'
import { logScope } from './launcherLog'

const instanceLog = logScope('instances')

export interface InstanceDirectoryState {
  path: string
  sharedPath: string
  isolated: boolean
  reason: 'explicit' | 'configured-path' | 'modpack' | 'detected-content' | 'shared'
}

/**
 * 启动、资源管理、服务器和 UI 共用的唯一目录判定。
 * 显式 false 优先，避免用户关闭隔离后被遗留文件自动重新开启。
 */
export function instanceDirectoryState(id: string, json: VersionJson, folderOverride?: string): InstanceDirectoryState {
  const sharedPath = canonicalPath(folderOverride || folderOfVersion(id))
  const instancePath = canonicalPath(path.join(sharedPath, 'versions', id))
  if (json._gameDir === true) {
    return { path: instancePath, sharedPath, isolated: true, reason: 'explicit' }
  }
  if (json._gameDir === false) {
    return { path: sharedPath, sharedPath, isolated: false, reason: 'shared' }
  }

  const configured = json._gameDirectory ?? json.gameDirectory
  if (typeof configured === 'string' && configured.trim()) {
    const configuredPath = canonicalPath(path.isAbsolute(configured) ? configured : path.join(instancePath, configured))
    return {
      path: configuredPath,
      sharedPath,
      isolated: !samePath(configuredPath, sharedPath),
      reason: 'configured-path',
    }
  }
  if (json._modpackName) {
    return { path: instancePath, sharedPath, isolated: true, reason: 'modpack' }
  }
  if (hasIsolationContent(instancePath)) {
    return { path: instancePath, sharedPath, isolated: true, reason: 'detected-content' }
  }
  return { path: sharedPath, sharedPath, isolated: false, reason: 'shared' }
}

/** 返回启用隔离前将复制的精确顶层范围和冲突；源文件始终保留。 */
export function isolationMigrationPlan(id: string): IsolationMigrationPlan {
  const source = canonicalPath(folderOfVersion(id))
  const destination = canonicalPath(versionDir(id))
  return planIsolationFiles(id, source, destination)
}

function writeIsolationFlag(id: string, isolated: boolean): void {
  const jsonPath = versionJsonPath(id)
  const original = fs.readFileSync(jsonPath, 'utf-8')
  const json = JSON.parse(original.replace(/^﻿/, '')) as VersionJson
  json._gameDir = isolated
  const temp = `${jsonPath}.isolation-${process.pid}-${Date.now()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(json, null, 2), 'utf-8')
    fs.copyFileSync(temp, jsonPath)
  } catch (error) {
    try {
      fs.writeFileSync(jsonPath, original, 'utf-8')
    } catch {
      // 保留原始异常。
    }
    throw error
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

/** 新建实例使用：只设置目录语义，不复制既有共享内容。 */
export function setNewInstanceIsolation(id: string, isolated: boolean): void {
  instanceLog.debug(`新实例 ${id} 预设版本隔离：${isolated ? '开启' : '关闭'}`)
  writeIsolationFlag(id, isolated)
}

/**
 * 用户开启隔离：先完整复制到临时区，再逐项提交；目标同名项永不覆盖。
 * 任一步失败会删除本次新增项并恢复 JSON。关闭时保留独立目录数据并写显式 false。
 */
export async function applyIsolation(id: string, isolated: boolean, copyShared = true): Promise<IsolationMigrationPlan> {
  instanceLog.info(`实例 ${id} 请求${isolated ? '开启' : '关闭'}版本隔离（copyShared=${copyShared}）`)
  const plan = isolationMigrationPlan(id)
  if (!isolated || !copyShared) {
    writeIsolationFlag(id, isolated)
    instanceLog.info(`实例 ${id} 版本隔离已${isolated ? '开启' : '关闭'}（未复制共享内容）`)
    return plan
  }

  try {
    await commitIsolationFiles(plan, () => writeIsolationFlag(id, true))
    instanceLog.info(
      `实例 ${id} 版本隔离开启完成：复制 ${plan.totalFiles} 个文件（${plan.items.length} 个顶层项），冲突跳过 ${plan.conflicts.length} 项`
    )
    return plan
  } catch (error) {
    instanceLog.error(`实例 ${id} 隔离迁移失败，已回滚`, error)
    throw new Error(`隔离迁移失败，已回滚：${error instanceof Error ? error.message : String(error)}`)
  }
}
