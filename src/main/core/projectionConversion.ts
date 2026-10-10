import { translate as t } from '../../shared/i18n';
import { minecraftData } from './projectionRegistry';
import type { ProjectionAnalysis, ProjectionChoices, ProjectionDifference, ProjectionFormat } from '../../shared/projections';
import {
  compound,
  flatten,
  position,
  readProjection,
  stateTag,
  stateText,
  value,
  writeProjection,
  type Projection,
} from './projectionFormats';
import { assertProjectionEquivalent } from './projectionValidation';
export function projectionVersions(): { version: string; dataVersion: number; supported: boolean }[] {
  return (minecraftData as any).versions.pc
    .filter((v: any) => v.releaseType === 'release' && /^(1\.20(?:\.\d+)?|1\.21(?:\.\d+)?|26\.\d+(?:\.\d+)?)$/.test(v.minecraftVersion))
    .map((v: any) => ({
      version: v.minecraftVersion,
      dataVersion: v.dataVersion,
      supported: !!minecraftData(v.minecraftVersion)?.blocksArray,
    }));
}
export const versionName = (dataVersion?: number) => projectionVersions().find((v: any) => v.dataVersion === dataVersion)?.version;
export function validateState(text: string, version: string): string | undefined {
  const tagValue = stateTag(text),
    c = compound(tagValue),
    name = value(c, 'Name', 8),
    data = minecraftData(version);
  if (!data?.blocksByName) return t('projconv.error.target_registry_missing');
  if (!name.startsWith('minecraft:')) return t('projconv.error.modded_block_unsupported');
  const block = data.blocksByName[name.slice(10)] as any;
  if (!block) return t('projconv.error.block_missing');
  const props = c.Properties ? compound(c.Properties) : {},
    schema = block.states || [];
  for (const [key, v] of Object.entries(props)) {
    const state = schema.find((s: any) => s.name === key);
    if (!state) return t('projconv.error.property_missing', { key });
    const values =
      state.values || (state.type === 'bool' ? ['true', 'false'] : Array.from({ length: state.num_values }, (_, i) => String(i)));
    if (!values.includes(String(v.value))) return t('projconv.error.property_value_rejected', { key, value: String(v.value) });
  }
  const missing = schema.filter((s: any) => !Object.hasOwn(props, s.name)).map((s: any) => s.name);
  if (missing.length) return t('projconv.error.properties_required', { list: missing.join(t('common.list_separator')) });
}
export function analyzeProjection(
  p: Projection,
  format: ProjectionFormat,
  targetVersion?: string
): Omit<ProjectionAnalysis, 'id' | 'sourceHash'> {
  if (!['litematic', 'schem', 'schematic', 'nbt'].includes(format)) throw new Error(t('projconv.error.target_format_invalid'));
  const sourceVersion = versionName(p.dataVersion),
    differences: ProjectionDifference[] = [],
    blocks = p.regions.reduce((n, r) => n + r.blocks.length, 0);
  const result: Omit<ProjectionAnalysis, 'id' | 'sourceHash'> = {
    sourceFormat: p.format,
    targetFormat: format,
    sourceVersion,
    targetVersion,
    differences,
    blocks,
  };
  if (targetVersion && !projectionVersions().find((v) => v.version === targetVersion && v.supported)) {
    result.unsupported = t('projconv.state.version_registry_missing');
    return result;
  }
  const cross = !!targetVersion && targetVersion !== sourceVersion;
  if (
    p.format === 'litematic' &&
    format === 'litematic' &&
    (p.raw.Version?.value !== 6 || p.raw.SubVersion?.value !== 1) &&
    Object.keys(p.raw).length
  )
    differences.push({
      key: 'litematicEncoding',
      kind: 'data',
      description: t('projconv.diff.litematic_encoding'),
      count: 1,
      discardOnly: true,
    });
  const spongeUpgrade =
    p.format === 'schem' && format === 'schem' && (p.raw.Schematic ? compound(p.raw.Schematic) : p.raw).Version?.value !== 3;
  if (spongeUpgrade)
    differences.push({
      key: 'spongeVersion',
      kind: 'data',
      description: t('projconv.diff.sponge_version'),
      count: 1,
      discardOnly: true,
    });
  if (cross && !sourceVersion) {
    result.unsupported = t('projconv.state.source_version_unknown');
    return result;
  }
  if (format === 'schematic' && cross) {
    result.unsupported = t('projconv.state.schematic_cross_version');
    return result;
  }
  if (format !== 'litematic') {
    try {
      const flat = flatten(p);
      if (format === 'nbt' && flat.blocks.length > 180000) result.unsupported = t('projconv.state.too_many_blocks');
    } catch (e) {
      result.unsupported = e instanceof Error ? e.message : String(e);
    }
  }
  if (p.regions.length > 1 && format !== 'litematic')
    differences.push({
      key: 'regions',
      kind: 'data',
      description: t('projconv.diff.regions_merged'),
      count: p.regions.length,
      discardOnly: true,
    });
  else if (format !== 'litematic' && p.regions.some((r) => r.signedSize?.some((v) => v < 0)))
    differences.push({
      key: 'direction',
      kind: 'data',
      description: t('projconv.diff.direction_dropped'),
      count: 1,
      discardOnly: true,
    });
  if (format === 'nbt' && p.regions.some((r) => r.offset.some((v) => v !== 0)))
    differences.push({
      key: 'nativeOffset',
      kind: 'data',
      description: t('projconv.diff.native_offset'),
      count: 1,
      discardOnly: true,
    });
  if (format === 'schematic' && p.dataVersion !== 1343)
    differences.push({
      key: 'legacyVersion',
      kind: 'data',
      description: t('projconv.diff.legacy_version'),
      count: 1,
      discardOnly: true,
    });
  const legacy = new Set<string>(Object.values((minecraftData as any).legacy.pc.blocks));
  for (const [ri, r] of p.regions.entries()) {
    const counts = new Map<number, number>();
    for (const b of r.blocks) counts.set(b, (counts.get(b) || 0) + 1);
    for (const [pi, tagValue] of r.palette.entries()) {
      if (!counts.has(pi)) continue;
      const text = stateText(tagValue),
        reason = cross
          ? validateState(text, targetVersion!)
          : format === 'schematic' && !legacy.has(text) && !text.startsWith('legacy:block_')
            ? t('projconv.error.legacy_schematic_block')
            : format !== 'schematic' && text.startsWith('legacy:block_')
              ? t('projconv.error.legacy_id_unmappable')
              : undefined;
      if (reason)
        differences.push({
          key: `block:${ri}:${pi}`,
          kind: 'block',
          description: text + ' · ' + reason,
          count: counts.get(pi)!,
          replacement: 'minecraft:air',
        });
      const unknown = Object.keys(compound(tagValue)).filter((k) => !['Name', 'Properties'].includes(k));
      if (unknown.length && (cross || format === 'schem' || format === 'schematic'))
        differences.push({
          key: `stateExtra:${ri}:${pi}`,
          kind: 'data',
          description: t('projconv.diff.state_extra', { text, list: unknown.join(t('common.list_separator')) }),
          count: unknown.length,
          discardOnly: true,
        });
    }
    for (const [kind, items] of [
      ['entity', r.entities],
      ['blockEntity', r.blockEntities],
    ] as const)
      for (const [i, tagValue] of items.entries()) {
        // Exact typed payload survives format conversion. Cross-version entity schemas require DFU;
        // no unverified migrations are claimed. The user can explicitly discard each payload.
        if (cross || (format === 'schematic' && p.format !== 'schematic')) {
          const id = compound(tagValue).id?.value || t('projconv.label.unknown_type');
          differences.push({
            key: `${kind}:${ri}:${i}`,
            kind,
            description: t('projconv.diff.entity_migration_unverified', { id }),
            count: 1,
            discardOnly: true,
          });
        } else if (kind === 'blockEntity') {
          const c = compound(tagValue),
            pos = ['x', 'y', 'z'].map((k) => value(c, k, 3)),
            at = pos[0] + pos[2] * r.size[0] + pos[1] * r.size[0] * r.size[2];
          if (differences.some((d) => d.key === `block:${ri}:${r.blocks[at]}`))
            differences.push({
              key: `${kind}:${ri}:${i}`,
              kind,
              description: t('projconv.diff.block_entity_replaced'),
              count: 1,
              discardOnly: true,
            });
        }
      }
    if ((cross || format !== p.format || spongeUpgrade) && Object.keys(r.extra).length)
      differences.push({
        key: `regionExtra:${ri}`,
        kind: 'data',
        description: t('projconv.diff.region_extra', { list: Object.keys(r.extra).join(t('common.list_separator')) }),
        count: Object.keys(r.extra).length,
        discardOnly: true,
      });
  }
  if ((cross || format !== p.format || spongeUpgrade) && Object.keys(p.extra).length)
    differences.push({
      key: 'extra',
      kind: 'data',
      description: t('projconv.diff.extra', { list: Object.keys(p.extra).join(t('common.list_separator')) }),
      count: Object.keys(p.extra).length,
      discardOnly: true,
    });
  if (format === 'nbt' && Object.keys(p.metadata).length)
    differences.push({
      key: 'metadata',
      kind: 'data',
      description: t('projconv.diff.metadata'),
      count: Object.keys(p.metadata).length,
      discardOnly: true,
    });
  return result;
}
export function convertProjection(
  p: Projection,
  format: ProjectionFormat,
  version: string | undefined,
  choices: ProjectionChoices
): Buffer {
  const analysis = analyzeProjection(p, format, version);
  if (analysis.unsupported) throw new Error(analysis.unsupported);
  for (const difference of analysis.differences) {
    const choice = choices[difference.key];
    if (!choice) throw new Error(t('projconv.error.confirm_all_differences', { description: difference.description }));
    if (difference.discardOnly && choice !== 'discard') throw new Error(t('projconv.error.discard_only'));
    const [kind, ri, pi] = difference.key.split(':');
    if (kind === 'block') {
      const replacement = choice === 'discard' ? 'minecraft:air' : choice;
      if (version) {
        const reason = validateState(replacement, version);
        if (reason) throw new Error(t('projconv.error.replacement_unavailable', { reason }));
      }
      if (format === 'schematic' && !Object.values((minecraftData as any).legacy.pc.blocks).includes(replacement))
        throw new Error(t('projconv.error.replacement_legacy_schematic'));
      p.regions[+ri].palette[+pi] = stateTag(replacement);
    }
  }
  for (const [ri, r] of p.regions.entries()) {
    r.entities = r.entities.filter((_t, i) => choices[`entity:${ri}:${i}`] !== 'discard');
    r.blockEntities = r.blockEntities.filter((_t, i) => choices[`blockEntity:${ri}:${i}`] !== 'discard');
    r.palette = r.palette.map((tagValue, pi) =>
      choices[`stateExtra:${ri}:${pi}`] === 'discard' ? stateTag(stateText(tagValue)) : tagValue
    );
    if (choices[`regionExtra:${ri}`] === 'discard') r.extra = {};
  }
  if (choices.extra === 'discard') p.extra = {};
  if (choices.metadata === 'discard') p.metadata = {};
  if (version) p.dataVersion = projectionVersions().find((v) => v.version === version)?.dataVersion;
  const bytes = writeProjection(p, format);
  assertProjectionEquivalent(p, readProjection(bytes, format), format);
  return bytes;
}
