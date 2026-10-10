import crypto from 'node:crypto';
import { flatten, stateText, shiftEntity, shiftBlockEntity, type Projection, type ProjectionRegion } from './projectionFormats';
import { writeTypedNbt, tag, type NbtTag } from './typedNbt';
import type { ProjectionFormat } from '../../shared/projections';
import { translate as t } from '../../shared/i18n';
function canonical(node: NbtTag): NbtTag {
  if (node.type === 10)
    return tag(
      10,
      Object.fromEntries(
        Object.keys(node.value)
          .sort()
          .map((k) => [k, canonical(node.value[k])])
      )
    );
  if (node.type === 9) return tag(9, node.value.map(canonical), node.elementType);
  return node;
}
function tags(items: NbtTag[]) {
  return items
    .map((item) => writeTypedNbt(tag(10, { value: canonical(item) }), '', false).toString('base64'))
    .sort()
    .join('|');
}
function blocks(r: ProjectionRegion) {
  const names = r.palette.map(stateText),
    hash = crypto.createHash('sha256'),
    chunk = Buffer.alloc(16384),
    seen = new Uint8Array(names.length);
  hash.update(JSON.stringify({ size: r.size, offset: r.offset }));
  // Hash state names rather than palette indexes: writers may add unused air entries.
  for (const i of r.blocks) seen[i] = 1;
  const used = [...new Set(names.filter((_n, i) => seen[i]))].sort(),
    ids = new Map(used.map((n, i) => [n, i]));
  hash.update(JSON.stringify(used));
  const mapped = names.map((n) => ids.get(n) ?? 0);
  let count = 0;
  for (const i of r.blocks) {
    chunk.writeUInt32BE(mapped[i], count * 4);
    if (++count === 4096) {
      hash.update(chunk);
      count = 0;
    }
  }
  if (count) hash.update(chunk.subarray(0, count * 4));
  return hash.digest('hex');
}
/** Re-read output and compare every voxel and typed entity payload after explicit loss choices. */
export function assertProjectionEquivalent(expected: Projection, actual: Projection, format: ProjectionFormat) {
  const regions = (p: Projection) => (format === 'litematic' ? p.regions : p.regions.length === 1 ? p.regions : [flatten(p)]);
  const a = regions(expected),
    b = regions(actual);
  if (a.length !== b.length || (format !== 'schematic' && (expected.dataVersion || 0) !== (actual.dataVersion || 0)))
    throw Error(t('projectionvalidation.error.region_or_version'));
  for (let i = 0; i < a.length; i++) {
    const left = a[i],
      right = b[i];
    if (blocks(left) !== blocks(right)) throw Error(t('projectionvalidation.error.blocks_or_offset'));
    if (
      tags(left.entities.map((e) => shiftEntity(e, left.offset))) !== tags(right.entities.map((e) => shiftEntity(e, right.offset))) ||
      tags(left.blockEntities.map((e) => shiftBlockEntity(e, left.offset))) !==
        tags(right.blockEntities.map((e) => shiftBlockEntity(e, right.offset)))
    )
      throw Error(t('projectionvalidation.error.entities'));
    if (
      format === 'litematic' &&
      (left.name !== right.name || JSON.stringify(left.signedSize || left.size) !== JSON.stringify(right.signedSize || right.size))
    )
      throw Error(t('projectionvalidation.error.region_direction'));
    if (tags([tag(10, left.extra)]) !== tags([tag(10, right.extra)])) throw Error(t('projectionvalidation.error.region_extra'));
  }
  if (tags([tag(10, expected.extra)]) !== tags([tag(10, actual.extra)])) throw Error(t('projectionvalidation.error.extra'));
  const generated = new Set(['Name', 'RegionCount', 'TotalVolume', 'TotalBlocks']);
  for (const [key, value] of Object.entries(expected.metadata)) {
    if (format === 'litematic' && generated.has(key)) continue;
    if (!actual.metadata[key] || tags([value]) !== tags([actual.metadata[key]]))
      throw Error(t('projectionvalidation.error.metadata', { key }));
  }
}
