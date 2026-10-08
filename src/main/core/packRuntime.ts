import fs from 'node:fs'
import path from 'node:path'
import type { VersionJson } from './versions'
import type { LoaderName } from '../../shared/types'

/** Reuse runtime metadata, never copy or move another instance's mods/saves. */
export function copyRuntimeProfile(root: string, sourceId: string, targetId: string): void {
  for (const id of [sourceId, targetId]) {
    if (!id || id === '.' || id === '..' || /[\\/<>:"|?*]/.test(id)) throw new Error('无效的实例名称')
  }
  if (sourceId === targetId) return
  const source = path.join(root, sourceId)
  const target = path.join(root, targetId)
  if (fs.existsSync(target)) throw new Error('目标实例已存在')
  const profile = JSON.parse(fs.readFileSync(path.join(source, `${sourceId}.json`), 'utf8'))
  fs.mkdirSync(target)
  const runtime = Object.fromEntries(Object.entries(profile).filter(([key]) => !key.startsWith('_')))
  fs.writeFileSync(path.join(target, `${targetId}.json`), JSON.stringify({ ...runtime, id: targetId }, null, 2))
  const jar = path.join(source, `${sourceId}.jar`)
  if (fs.existsSync(jar)) fs.copyFileSync(jar, path.join(target, `${targetId}.jar`))
}

export function packRuntimeProfile(
  runtime: VersionJson,
  id: string,
  meta: {
    mcVersion: string
    loader?: LoaderName | null
    loaderVersion?: string | null
    name: string
    packVersion: string
  }
): VersionJson {
  if (runtime.inheritsFrom === id) throw new Error('整合包运行配置不能继承自身')
  return {
    ...runtime,
    id,
    _mcVersion: meta.mcVersion,
    _gameDir: true,
    ...(meta.loader ? { _loader: meta.loader, _loaderVersion: meta.loaderVersion ?? undefined } : {}),
    _modpackName: meta.name,
    _modpackVersion: meta.packVersion,
  }
}
