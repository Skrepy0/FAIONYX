import fs from 'node:fs';
import path from 'node:path';
import type { JavaInfo } from '../../shared/types';

/** Public JVM metadata only. A changed executable/release file or seven-day TTL
 * invalidates the probe; warm startup never spawns java just to draw its label. */
export class JavaProbeCache {
  private entries?: Record<string, { stamp: string; at: number; info: JavaInfo }>;
  constructor(private file: () => string) {}
  private stamp(exe: string): string {
    return [exe, path.join(path.dirname(exe), '..', 'release')]
      .map((p) => {
        try {
          const s = fs.statSync(p);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return '';
        }
      })
      .join('|');
  }
  private data() {
    if (!this.entries) {
      try {
        const j = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
        this.entries = j.version === 1 && j.entries && typeof j.entries === 'object' ? j.entries : {};
      } catch {
        this.entries = {};
      }
    }
    return this.entries!;
  }
  get(exe: string): JavaInfo | null {
    const item = this.data()[exe];
    if (
      !fs.existsSync(exe) ||
      !item ||
      item.stamp !== this.stamp(exe) ||
      Date.now() - item.at > 7 * 86400000 ||
      !Number.isFinite(item.info?.major) ||
      typeof item.info?.version !== 'string'
    )
      return null;
    return { ...item.info, path: exe };
  }
  put(exe: string, info: JavaInfo): JavaInfo {
    this.data()[exe] = { stamp: this.stamp(exe), at: Date.now(), info };
    try {
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify({ version: 1, entries: this.data() }));
    } catch {
      /* Cache is optional. */
    }
    return info;
  }
}
