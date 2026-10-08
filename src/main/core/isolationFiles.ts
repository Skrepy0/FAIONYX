import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IsolationMigrationPlan } from '../../shared/types';

export const ISOLATION_DIRS = ['saves', 'mods', 'config', 'resourcepacks', 'shaderpacks', 'screenshots'] as const;
export const ISOLATION_FILES = ['options.txt', 'servers.dat'] as const;
export const ISOLATION_MARKERS = [...ISOLATION_DIRS, ...ISOLATION_FILES] as const;

export function hasIsolationContent(instancePath: string): boolean {
  return ISOLATION_MARKERS.some((name) => fs.existsSync(path.join(instancePath, name)));
}

function treeSize(input: string): { files: number; bytes: number } {
  const stat = fs.lstatSync(input);
  if (stat.isSymbolicLink()) return { files: 0, bytes: 0 };
  if (!stat.isDirectory()) return { files: 1, bytes: stat.size };
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(input)) {
    const child = treeSize(path.join(input, entry));
    files += child.files;
    bytes += child.bytes;
  }
  return { files, bytes };
}

/** 仅规划固定白名单中的玩家数据，符号链接不计入也不复制。 */
export function planIsolationFiles(versionId: string, source: string, destination: string): IsolationMigrationPlan {
  const items: IsolationMigrationPlan['items'] = [];
  const conflicts: string[] = [];
  for (const name of ISOLATION_MARKERS) {
    const from = path.join(source, name);
    if (!fs.existsSync(from)) continue;
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) continue;
    if (fs.existsSync(path.join(destination, name))) conflicts.push(name);
    const size = treeSize(from);
    items.push({ name, kind: stat.isDirectory() ? 'directory' : 'file', ...size });
  }
  return {
    versionId,
    source,
    destination,
    items,
    conflicts,
    totalFiles: items.reduce((sum, item) => sum + item.files, 0),
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
  };
}

function isNotSymbolicLink(source: string): boolean {
  return !fs.lstatSync(source).isSymbolicLink();
}

/**
 * 先把全部非冲突项复制到实例内的临时目录，再逐项原子改名提交。
 * commitMetadata（写版本 JSON）失败也会删除本次新增项；既有冲突项从不改动。
 */
export async function commitIsolationFiles(plan: IsolationMigrationPlan, commitMetadata: () => void): Promise<void> {
  fs.mkdirSync(plan.destination, { recursive: true });
  const staging = path.join(plan.destination, `.isolation-staging-${crypto.randomUUID()}`);
  const created: string[] = [];
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const item of plan.items) {
      if (plan.conflicts.includes(item.name)) continue;
      const source = path.join(plan.source, item.name);
      const staged = path.join(staging, item.name);
      if (item.kind === 'directory') {
        await fs.promises.cp(source, staged, {
          recursive: true,
          errorOnExist: true,
          force: false,
          dereference: false,
          filter: isNotSymbolicLink,
        });
      } else {
        await fs.promises.copyFile(source, staged, fs.constants.COPYFILE_EXCL);
      }
    }
    for (const item of plan.items) {
      const staged = path.join(staging, item.name);
      if (!fs.existsSync(staged)) continue;
      const destination = path.join(plan.destination, item.name);
      // 规划后若外部程序创建了同名项，也必须继续遵守“不覆盖”。
      if (fs.existsSync(destination)) continue;
      await fs.promises.rename(staged, destination);
      created.push(destination);
    }
    commitMetadata();
  } catch (error) {
    for (const item of created.reverse()) {
      await fs.promises.rm(item, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
