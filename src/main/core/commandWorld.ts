import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import AdmZip from 'adm-zip'
import { NbtList, writeNbt } from './nbt'
import { supportsQuickPlayMultiplayer } from './serverUtils'

function worldGeneration(seed: bigint, splitFormat: boolean) {
  const noise = (dimension: string, biome: string) => ({ type: `minecraft:${dimension}`, generator: { type: 'minecraft:noise', settings: `minecraft:${biome}`, biome_source: biome === 'end' ? { type: 'minecraft:the_end' } : { type: 'minecraft:multi_noise', preset: `minecraft:${biome}` } } })
  return { seed, [splitFormat ? 'generate_structures' : 'generate_features']: 1, bonus_chest: 0, dimensions: {
    'minecraft:overworld': noise('overworld', 'overworld'),
    'minecraft:the_nether': noise('the_nether', 'nether'),
    'minecraft:the_end': noise('the_end', 'end')
  } }
}

export function buildCommandWorldData(version: { id: string; world_version: number; stable?: boolean; series_id?: string }, name: string, seed: bigint, splitFormat = false): Buffer {
  return zlib.gzipSync(writeNbt({ Data: {
    DataVersion: version.world_version,
    Version: { Name: version.id, Id: version.world_version, Snapshot: version.stable === false ? 1 : 0, Series: version.series_id ?? 'main' },
    version: 19133, LevelName: name, GameType: 1, allowCommands: 1, hardcore: 0,
    ...(splitFormat ? { difficulty_settings: { difficulty: 'easy', locked: 0 } } : { Difficulty: 1 }),
    initialized: 0, LastPlayed: BigInt(Date.now()), Time: 0n, DayTime: 0n,
    DataPacks: { Enabled: new NbtList(8, ['vanilla']), Disabled: new NbtList(8, []) },
    ...(splitFormat ? {} : { WorldGenSettings: worldGeneration(seed, false), DragonFight: { NeedsStateScanning: 1, DragonKilled: 0, PreviouslyKilled: 0 } })
  } }))
}

/** Creates ONLY a new world. The game generates terrain and applies the instance's mods.
 * No source save is cloned and no global options are modified. */
export function createCommandWorld(gameDirectory: string, clientJar: string): { id: string; path: string } {
  const zip = new AdmZip(clientJar)
  const version = JSON.parse(zip.readAsText('version.json')) as { id: string; world_version: number; stable?: boolean; series_id?: string }
  if (!supportsQuickPlayMultiplayer(version.id)) throw new Error('此 Minecraft 版本不支持官方单人 Quick Play（需要 1.20+）；请在游戏内新建世界并开启命令')
  if (!Number.isInteger(version.world_version) || version.world_version < 0) throw new Error('客户端缺少真实世界数据版本，未创建存档')
  const id = `FAIONYX-Test-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`
  const destination = path.join(gameDirectory, 'saves', id)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.mkdirSync(destination) // exclusive, never reuses an existing world
  const seed = crypto.randomBytes(8).readBigInt64BE()
  // 26.1 snapshot 6+ moves world generation into namespaced SavedData. Detect the
  // actual client codec capability, including snapshots, instead of a display ID.
  const worldGenClass = zip.readFile('net/minecraft/world/level/levelgen/WorldGenSettings.class')
  const splitFormat = !!worldGenClass?.includes(Buffer.from('SavedDataType'))
  fs.writeFileSync(path.join(destination, 'level.dat'), buildCommandWorldData(version, `命令测试 ${new Date().toLocaleString('zh-CN')}`, seed, splitFormat), { flag: 'wx' })
  if (splitFormat) {
    const data = path.join(destination, 'data', 'minecraft'); fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(data, 'world_gen_settings.dat'), zlib.gzipSync(writeNbt({ DataVersion: version.world_version, data: worldGeneration(seed, true) })), { flag: 'wx' })
  }
  return { id, path: destination }
}
