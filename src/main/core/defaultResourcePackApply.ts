import type { InstanceTarget } from '../../shared/instanceCenter';
import { centerTarget, assertInstanceIdle } from './instanceCenter';
import { activeLaunchStates } from './launchUiState';
import { withFileJob } from './fileJobs';
import { withGameFolder } from './paths';
import { samePath } from './folderPaths';
import { resolveInstanceMetadata, isMinecraftVersionId } from './instanceMetadata';
import { readClientVersionEvidence } from './instanceVersionEvidence';
import { readVersionJson, resolveVersionChain, clientJarPath } from './versions';
import { applyDefaultResourcePacks } from './defaultResourcePacks';
import { translate as t } from '../../shared/i18n';

function assertNoActiveLaunch(directory: string): void {
  for (const state of activeLaunchStates()) {
    if (!state.folder || !state.versionId) continue;
    let dir: string;
    try {
      dir = centerTarget({ folder: state.folder, id: state.versionId }).dir;
    } catch {
      continue;
    }
    if (samePath(dir, directory)) throw new Error(t('defresourcepackapply.error.game_running'));
  }
}
/** Resolve the chosen instance's actual directory; shared instances use the same guard and selection. */
export async function applyDefaultResourcePacksToInstance(target: InstanceTarget): Promise<{ count: number; shared: boolean }> {
  if (!target || typeof target.id !== 'string' || typeof target.folder !== 'string')
    throw new Error(t('defresourcepackapply.error.select_target'));
  const initial = centerTarget(target);
  return withFileJob(initial.dir, undefined, async () => {
    assertNoActiveLaunch(initial.dir);
    await assertInstanceIdle(initial.dir);
    assertNoActiveLaunch(initial.dir);
    const current = centerTarget(target);
    if (!samePath(initial.dir, current.dir)) throw new Error(t('defresourcepackapply.error.dir_changed'));
    const count = withGameFolder(current.folder, () => {
      const { baseId } = resolveVersionChain(target.id),
        client = clientJarPath(baseId);
      const metadata = resolveInstanceMetadata(
        current.json,
        (id) => {
          try {
            return readVersionJson(id);
          } catch {
            return undefined;
          }
        },
        () => readClientVersionEvidence(client)
      );
      if (metadata.broken || !isMinecraftVersionId(metadata.mcVersion)) throw new Error(t('defresourcepackapply.error.unknown_mc_version'));
      return applyDefaultResourcePacks(current.dir, metadata.mcVersion, client);
    });
    return { count, shared: !current.state.isolated };
  });
}
