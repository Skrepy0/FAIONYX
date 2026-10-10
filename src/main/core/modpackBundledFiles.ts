import crypto from 'node:crypto';
import type { PackZip, PackEntry } from './streamPackZip';
import { translate as t } from '../../shared/i18n';

const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '');

/** Locations loaded by Minecraft or common pack loaders; never count loader caches/backups. */
export const PACK_RESOURCE_DIRS = [
  'mods',
  'resourcepacks',
  'shaderpacks',
  'datapacks',
  'config/paxi/datapacks',
  'config/paxi/resourcepacks',
  'config/openloader/data',
  'config/openloader/resources',
  'openloader/data',
  'openloader/resources',
  'global_packs/both',
  'global_packs/datapacks',
  'global_packs/resourcepacks',
  'global_packs/required_data',
  'global_packs/optional_data',
  'global_packs/required_resources',
  'global_packs/optional_resources',
] as const;

export function isPackResource(rel: string): boolean {
  const slash = rel.lastIndexOf('/');
  return (
    PACK_RESOURCE_DIRS.some((dir) => dir === rel.slice(0, slash).toLowerCase()) &&
    /^[^/]+\.(?:jar|zip)(?:\.disabled)?$/i.test(rel.slice(slash + 1))
  );
}

/** Preserve the author's real destination/name, including ZIP packs and disabled mods. */
export class BundledModpackFiles {
  private readonly entries = new Map<number, Array<{ entry: PackEntry; rel: string }>>();
  private readonly hashes = new Map<PackEntry, string>();

  constructor(zip: PackZip, overridesPrefix: string | null) {
    if (!overridesPrefix) return;
    const prefix = normalize(overridesPrefix).replace(/\/+$/, '') + '/';
    const paths = new Set<string>();
    for (const entry of zip.getEntries()) {
      const name = normalize(entry.entryName);
      if (entry.isDirectory || !name.startsWith(prefix)) continue;
      const rel = name.slice(prefix.length);
      if (!isPackResource(rel)) continue;
      if (((entry.attr >>> 16) & 0o170000) === 0o120000) throw new Error(t('packbundled.error.symlink', { name }));
      // Case collisions are unsafe on Windows even when the ZIP was created on another OS.
      const key = rel.toLowerCase();
      if (paths.has(key)) throw new Error(t('packbundled.error.duplicate', { name: rel }));
      paths.add(key);
      if (entry.header.size > 512 * 1024 * 1024) throw new Error(t('packbundled.error.too_large', { name: rel }));
      const group = this.entries.get(entry.header.size) ?? [];
      group.push({ entry, rel });
      this.entries.set(entry.header.size, group);
    }
  }

  async find(file: { size: number; sha1: string }, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || !/^[a-f\d]{40}$/i.test(file.sha1)) return null;
    for (const { entry, rel } of this.entries.get(file.size) ?? []) {
      signal?.throwIfAborted();
      let hash = this.hashes.get(entry);
      if (!hash) {
        hash = entry.digest
          ? await entry.digest('sha1', signal)
          : crypto
              .createHash('sha1')
              .update(await entry.getData())
              .digest('hex');
        this.hashes.set(entry, hash);
        await new Promise<void>((resolve) => setImmediate(resolve));
        signal?.throwIfAborted();
      }
      if (hash === file.sha1.toLowerCase()) return rel;
    }
    return null;
  }
}
