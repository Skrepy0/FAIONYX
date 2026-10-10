import type { ServerEntry } from '../../shared/types';
import { parseServerAddress } from './serverUtils';
import { translate as t } from '../../shared/i18n';

/** Edit launcher metadata in place; preserve identity, instance bindings and history. */
export function editedServers(list: ServerEntry[], id: string, name: string, address: string): ServerEntry[] {
  const current = list.find((s) => s.id === id);
  if (!current) throw new Error(t('serverediting.error.not_found'));
  const trimmed = name.trim();
  if (!trimmed) throw new Error(t('serverediting.error.name_required'));
  const parsed = parseServerAddress(address);
  const folderKey = (folder?: string) => (folder ?? '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const duplicate = list.some(
    (s) =>
      s.id !== id &&
      (s.normalizedAddress ?? parseServerAddress(s.address).normalizedAddress) === parsed.normalizedAddress &&
      (s.versionId ?? '') === (current.versionId ?? '') &&
      (!current.versionId || folderKey(s.folder) === folderKey(current.folder))
  );
  if (duplicate) throw new Error(t('serverediting.error.duplicate'));
  return list.map((s) =>
    s.id === id
      ? {
          ...s,
          source: 'launcher',
          name: trimmed,
          address: parsed.address,
          normalizedAddress: parsed.normalizedAddress,
          host: parsed.host,
          port: parsed.port,
        }
      : s
  );
}

/** Rename only references owned by the selected game root. Ambiguous legacy IDs stay intact. */
export function renamedServerBindings(
  list: ServerEntry[],
  oldId: string,
  newId: string,
  folder?: string,
  ambiguous = false
): ServerEntry[] {
  const key = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const root = folder ? key(folder) : '';
  return list.map((s) => {
    const source = s.sourceGameDirectory ? key(s.sourceGameDirectory) : '';
    const belongs = !root || (s.folder ? key(s.folder) === root : source ? source === root || source.startsWith(root + '/') : !ambiguous);
    if (!belongs) return s;
    return {
      ...s,
      ...(s.versionId === oldId ? { versionId: newId } : {}),
      ...(s.candidateVersionIds?.includes(oldId)
        ? { candidateVersionIds: s.candidateVersionIds.map((id) => (id === oldId ? newId : id)) }
        : {}),
    };
  });
}
