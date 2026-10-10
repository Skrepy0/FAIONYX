<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { IPC, type JavaInfo, type WorldImportInfo } from '@shared/types';
import type {
  BackupManifest,
  DiagnosticFinding,
  InstanceOperation,
  InstanceOverview,
  InstanceScreenshot,
  InstanceWorld,
} from '@shared/instanceCenter';
import type { ModChangePlan } from '@shared/modManagement';
import { instanceCenter } from '../instanceCenter';
import { store, refreshInstalled, toast, openSettings } from '../store';
import { errText, setVersionJava, exportLaunchLogs, selectFile, probeWorld, importWorld } from '../api';
import SelectMenu from './SelectMenu.vue';
const previousFocus = document.activeElement as HTMLElement | null;
const target = structuredClone({ ...instanceCenter.target! });
const tab = ref(instanceCenter.tab),
  busy = ref(false),
  loading = ref(true),
  error = ref(''),
  overview = ref<InstanceOverview>();
const worlds = ref<InstanceWorld[]>([]),
  backups = ref<BackupManifest[]>([]),
  shots = ref<InstanceScreenshot[]>([]),
  shotTotal = ref(0),
  page = ref(0),
  search = ref(''),
  lightbox = ref(-1);
const findings = ref<DiagnosticFinding[]>([]),
  java = ref<JavaInfo[]>([]),
  javaPath = ref(''),
  planId = ref(''),
  session = ref('');
const form = ref<'' | 'clone' | 'restore' | 'import' | 'disable' | 'dependencies'>(''),
  name = ref(''),
  destination = ref(target.folder),
  includeSaves = ref(true),
  includeShots = ref(false),
  restore = ref<BackupManifest>(),
  overwrite = ref(false);
const dependencies = ref<ModChangePlan>();
const selectedMods = ref<string[]>([]);
const worldInput = ref(''),
  worldInfo = ref<WorldImportInfo>(),
  candidate = ref(''),
  mismatch = ref(false);
import { t } from '@renderer/i18n';
const sections = [
  ['overview', t('ic.tab_overview')],
  ['worlds', t('ic.tab_worlds')],
  ['screenshots', t('ic.tab_screenshots')],
  ['backups', t('ic.tab_backups')],
  ['diagnostics', t('ic.tab_diagnostics')],
];
const folders = computed(() => (store.settings?.folders || []).map((f) => ({ value: f.path, label: f.name })));
const filtered = computed(() => worlds.value.filter((w) => w.name.toLowerCase().includes(search.value.toLowerCase())));
const image = computed(() => shots.value[lightbox.value]);
const fullImage = ref('');
watch(image, async (selected) => {
  fullImage.value = '';
  if (!selected) return;
  try {
    const data = await invoke<string>(IPC.centerFile, target, 'preview', selected.id);
    if (image.value?.id === selected.id) fullImage.value = data;
  } catch (e) {
    error.value = errText(e);
  }
});
const invoke = <T,>(channel: string, ...args: unknown[]) => window.faionyx.invoke(channel, ...args) as Promise<T>;
const formatDate = (v: string | number | undefined) => (v ? new Date(v).toLocaleString() : t('ic.unknown'));
const size = (bytes: number) => (bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(1) + ' GB' : (bytes / 1024 ** 2).toFixed(1) + ' MB');
async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    overview.value = await invoke(IPC.centerOverview, target);
    if (tab.value === 'worlds') worlds.value = await invoke(IPC.centerWorlds, target);
    if (tab.value === 'backups') backups.value = await invoke(IPC.centerBackups, target);
    if (tab.value === 'screenshots') {
      const r = await invoke<{ total: number; items: InstanceScreenshot[] }>(IPC.centerScreenshots, target, page.value);
      shots.value = r.items;
      shotTotal.value = r.total;
    }
  } catch (e) {
    error.value = errText(e);
  } finally {
    loading.value = false;
  }
}
async function chooseTab(value: string) {
  tab.value = value;
  form.value = '';
  await refresh();
}
async function perform(action: () => Promise<unknown>) {
  busy.value = true;
  error.value = '';
  try {
    await action();
    toast(t('ic.op_done'), 'success');
    form.value = '';
    await refreshInstalled();
    await refresh();
  } catch (e) {
    error.value = errText(e);
  } finally {
    busy.value = false;
  }
}
const op = (operation: Omit<InstanceOperation, 'target'> & { planId?: string }) => invoke(IPC.centerOperation, { ...operation, target });
function navigate(view: 'mods' | 'packs' | 'shaders' | 'game') {
  instanceCenter.target = null;
  store.currentView = view;
}
function close() {
  instanceCenter.target = null;
}
function key(e: KeyboardEvent) {
  if (document.querySelector('.select-menu-float')) return;
  if (e.key === 'Tab') {
    const root = document.querySelector('.ic-lightbox') || document.querySelector('.ic-dialog') || document.querySelector('.ic');
    const elements = [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') || [])].filter(
      (n) => n.getClientRects().length
    );
    if (elements.length) {
      const index = elements.indexOf(document.activeElement as HTMLElement);
      if ((e.shiftKey && index <= 0) || (!e.shiftKey && (index === elements.length - 1 || index === -1))) {
        e.preventDefault();
        elements[e.shiftKey ? elements.length - 1 : 0].focus();
      }
    }
  }
  if (e.key === 'Escape') {
    e.stopImmediatePropagation();
    if (lightbox.value >= 0) lightbox.value = -1;
    else if (form.value) form.value = '';
    else close();
  }
  if (lightbox.value >= 0 && e.key === 'ArrowRight') lightbox.value = Math.min(shots.value.length - 1, lightbox.value + 1);
  if (lightbox.value >= 0 && e.key === 'ArrowLeft') lightbox.value = Math.max(0, lightbox.value - 1);
}
async function diagnose() {
  busy.value = true;
  error.value = '';
  try {
    const r = await invoke<{ id: string; findings: DiagnosticFinding[]; java: JavaInfo[]; session?: string }>(IPC.centerDiagnose, target);
    findings.value = r.findings;
    java.value = r.java;
    javaPath.value = r.java[0]?.path || '';
    planId.value = r.id;
    session.value = r.session || '';
  } catch (e) {
    error.value = errText(e);
  } finally {
    busy.value = false;
  }
}
function openRestore(b: BackupManifest) {
  restore.value = b;
  name.value = (b.metadata?.type === 'world' ? String(b.metadata.world) : target.id) + t('ic.restore_suffix');
  overwrite.value = false;
  form.value = 'restore';
}
async function prepareImport() {
  try {
    const f = await selectFile();
    if (!f) return;
    const info = await probeWorld(f);
    if (!info?.candidates.length) throw new Error(t('ic.no_valid_worlds'));
    worldInput.value = f;
    worldInfo.value = info;
    candidate.value = info.candidates[0].id;
    name.value = info.candidates[0].worldName;
    form.value = 'import';
  } catch (e) {
    error.value = errText(e);
  }
}
async function disableSelected() {
  const results = await invoke<Array<{ ok: boolean; fileName: string; error?: string }>>(
    'mods:setEnabled',
    target.id,
    target.folder,
    [...selectedMods.value],
    false
  );
  selectedMods.value = results.filter((r) => !r.ok).map((r) => r.fileName);
  if (selectedMods.value.length)
    throw new Error(
      results
        .filter((r) => !r.ok)
        .map((r) => r.fileName + t('ic.colon') + r.error)
        .join('\n')
    );
  await diagnose();
}
async function checkDependencies(fileName: string) {
  busy.value = true;
  error.value = '';
  try {
    dependencies.value = await invoke('center:dependencyPlan', target, fileName);
    form.value = 'dependencies';
  } catch (e) {
    error.value = errText(e);
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  document.addEventListener('keydown', key, true);
  await refresh();
  document.querySelector<HTMLElement>(`[aria-label="${t('ic.close_aria')}"]`)?.focus();
  if (tab.value === 'diagnostics') await diagnose();
});
onUnmounted(() => {
  document.removeEventListener('keydown', key, true);
  previousFocus?.focus();
});
</script>
<template>
  <Teleport to="body">
    <div class="ic-mask" @pointerdown.self="close">
      <section class="ic" role="dialog" aria-modal="true" aria-labelledby="ic-title" data-ui="instance-center:page">
        <header class="ic-header">
          <div>
            <small>{{ t('ic.center_title') }}</small>
            <h2 id="ic-title">{{ overview?.name || target.id }}</h2>
            <p>
              {{ overview?.mcVersion }} <span v-if="overview?.loader">· {{ overview.loader }}</span> ·
              {{ overview?.shared ? t('ic.shared_dir') : t('ic.isolated_dir') }}
            </p>
          </div>
          <button class="btn btn-ghost" :aria-label="t('ic.close_aria')" @click="close">✕</button>
        </header>
        <nav class="ic-tabs" :aria-label="t('ic.instance_func')">
          <button v-for="[value, label] in sections" :key="value" :class="{ active: tab === value }" @click="chooseTab(value)">
            {{ label }}
          </button>
        </nav>
        <div :key="tab" class="ic-content">
          <p v-if="error" class="ic-error" role="alert">
            {{ error }} <button class="btn btn-sm" :disabled="busy" @click="refresh">{{ t('ic.reload') }}</button>
          </p>
          <p v-if="overview?.running" class="ic-hint">{{ t('ic.running_hint') }}</p>
          <p v-if="loading" class="ic-empty">{{ t('ic.reading') }}</p>
          <template v-else-if="tab === 'overview'">
            <div class="ic-summary" data-ui="instance-center:overview">
              <div>
                <h3>{{ t('ic.manage_independent') }}</h3>
                <p class="ic-path">{{ overview?.directory }}</p>
              </div>
              <button class="btn btn-ghost" @click="perform(() => invoke(IPC.centerFile, target, 'directory', ''))">
                {{ t('ic.open_dir') }}
              </button>
            </div>
            <div class="ic-grid">
              <button class="ic-card" @click="navigate('mods')">
                <strong>{{ t('ic.mods_mgmt') }} →</strong><span>{{ t('ic.mods_hint') }}</span></button
              ><button class="ic-card" @click="navigate('packs')">
                <strong>{{ t('ic.packs_mgmt') }} →</strong><span>{{ t('ic.packs_hint') }}</span></button
              ><button class="ic-card" @click="navigate('shaders')">
                <strong>{{ t('ic.shaders_mgmt') }} →</strong><span>{{ t('ic.shaders_hint') }}</span></button
              ><button class="ic-card" @click="navigate('game')">
                <strong>{{ t('ic.version_settings') }} →</strong><span>{{ t('ic.version_hint') }}</span>
              </button>
            </div>
            <div class="ic-card">
              <h3>{{ t('ic.clone_instance') }}</h3>
              <p>{{ t('ic.clone_hint') }}</p>
              <button
                class="btn btn-gold"
                :disabled="busy || overview?.running"
                @click="
                  name = target.id + t('ic.clone_suffix');
                  form = 'clone';
                "
              >
                {{ t('ic.clone_btn') }}
              </button>
            </div>
          </template>
          <template v-else-if="tab === 'worlds'">
            <div class="ic-tools">
              <input v-model="search" class="input" :placeholder="t('ic.search_world')" :aria-label="t('ic.search_world_aria')" /><button
                class="btn btn-gold"
                :disabled="busy || overview?.running"
                @click="prepareImport"
              >
                {{ t('ic.import_world') }}
              </button>
            </div>
            <div v-for="w in filtered" :key="w.id" class="ic-row">
              <img v-if="w.icon" :src="w.icon" alt="" />
              <div v-else class="ic-world-icon">▧</div>
              <div class="ic-grow">
                <strong>{{ w.name }}</strong
                ><small
                  >{{ w.version || t('ic.unknown_version') }} · {{ w.mode || t('ic.unknown_mode') }} · {{ formatDate(w.lastPlayed) }}</small
                >
                <p v-if="w.error" class="ic-error">{{ w.error }}</p>
              </div>
              <div class="ic-actions">
                <button class="btn btn-sm" @click="perform(() => invoke(IPC.centerFile, target, 'world', w.id))">{{ t('ic.open') }}</button
                ><button
                  class="btn btn-sm"
                  :disabled="busy || overview?.running"
                  @click="perform(() => op({ kind: 'worldExport', world: w.id }))"
                >
                  {{ t('ic.export_zip') }}</button
                ><button
                  class="btn btn-sm"
                  :disabled="busy || overview?.running"
                  @click="perform(() => op({ kind: 'backup', world: w.id }))"
                >
                  {{ t('ic.backup') }}
                </button>
              </div>
            </div>
            <p v-if="!filtered.length" class="ic-empty">{{ t('ic.no_matched_worlds') }}</p>
            <button class="btn btn-ghost" @click="chooseTab('backups')">{{ t('ic.view_backups') }} →</button>
          </template>
          <template v-else-if="tab === 'screenshots'">
            <div class="ic-shots">
              <button v-for="(s, i) in shots" :key="s.id" class="ic-shot" @click="lightbox = i">
                <img :src="s.image" loading="lazy" :alt="t('ic.screenshot_alt')" /><span>{{ s.id }}</span>
              </button>
            </div>
            <p v-if="!shots.length" class="ic-empty">{{ t('ic.no_screenshots') }}</p>
            <div class="ic-tools">
              <button
                class="btn btn-sm"
                :disabled="page === 0 || loading"
                @click="
                  page--;
                  refresh();
                "
              >
                {{ t('ic.prev_page') }}</button
              ><span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(shotTotal / 24)) }}</span
              ><button
                class="btn btn-sm"
                :disabled="(page + 1) * 24 >= shotTotal || loading"
                @click="
                  page++;
                  refresh();
                "
              >
                {{ t('ic.next_page') }}
              </button>
            </div>
          </template>
          <template v-else-if="tab === 'backups'">
            <div class="ic-summary">
              <div>
                <h3>{{ t('ic.backup_protect') }}</h3>
                <p>{{ t('ic.backup_protect_hint') }}</p>
              </div>
              <button class="btn btn-gold" :disabled="busy || overview?.running" @click="perform(() => op({ kind: 'backup' }))">
                {{ t('ic.backup_instance') }}
              </button>
            </div>
            <div v-for="b in backups" :key="b.id" class="ic-row">
              <div class="ic-grow">
                <strong>{{ b.title }}</strong
                ><small
                  >{{ formatDate(b.createdAt) }} · {{ b.automatic ? t('ic.auto_protect') : t('ic.manual_backup') }} · {{ b.files.length }}
                  {{ t('ic.files_count') }} · {{ size(b.files.reduce((n, f) => n + f.size, 0)) }}</small
                >
              </div>
              <button class="btn btn-sm" :disabled="busy || overview?.running" @click="openRestore(b)">{{ t('ic.restore_btn') }}…</button>
            </div>
            <p v-if="!backups.length" class="ic-empty">{{ t('ic.no_backups') }}</p>
          </template>
          <template v-else-if="tab === 'diagnostics'">
            <div class="ic-summary">
              <div>
                <h3>{{ t('ic.check_env') }}</h3>
                <p>{{ t('ic.check_env_hint') }}{{ session ? t('ic.log_session') + formatDate(session) : '' }}</p>
              </div>
              <button class="btn btn-gold" :disabled="busy" @click="diagnose">{{ busy ? t('ic.processing') : t('ic.start_check') }}</button>
            </div>
            <div v-for="(f, i) in findings" :key="f.rule + i" class="ic-card">
              <div class="ic-tools">
                <strong>{{ f.title }}</strong
                ><span class="ic-badge">{{
                  f.confidence === 'certain' ? t('ic.confirmed') : f.confidence === 'possible' ? t('ic.possible') : t('ic.insufficient')
                }}</span>
              </div>
              <div v-for="mod in f.mods" :key="mod.fileName" class="ic-row">
                <input
                  v-if="['duplicate', 'mod-version'].includes(f.rule) && !mod.fileName.endsWith('.disabled')"
                  v-model="selectedMods"
                  :value="mod.fileName"
                  type="checkbox"
                  :aria-label="t('ic.select_disable', { name: mod.fileName })"
                /><img v-if="mod.icon" :src="mod.icon" alt="" />
                <div class="ic-grow">
                  <strong>{{ mod.fileName }}</strong
                  ><small>{{ mod.name }}</small>
                </div>
                <button
                  v-if="f.rule === 'dependency'"
                  class="btn btn-sm"
                  :disabled="busy || overview?.running"
                  @click="checkDependencies(mod.fileName)"
                >
                  {{ t('ic.check_deps') }}
                </button>
              </div>
              <pre>{{ f.evidence }}</pre>
              <p>{{ f.advice }}</p>
              <div class="ic-actions">
                <button
                  v-if="f.action === 'files'"
                  class="btn btn-sm"
                  :disabled="busy || overview?.running"
                  @click="perform(() => op({ kind: 'repair', planId }))"
                >
                  {{ t('ic.repair_files') }}
                </button>
                <button v-if="f.action === 'mods'" class="btn btn-sm" @click="navigate('mods')">{{ t('ic.open_mods_mgmt') }}</button>
                <template v-if="f.rule === 'graphics'"
                  ><button
                    v-for="driver in [
                      ['NVIDIA', 'https://www.nvidia.com/Download/index.aspx'],
                      ['AMD', 'https://www.amd.com/en/support'],
                      ['Intel', 'https://www.intel.com/content/www/us/en/download-center/home.html'],
                    ]"
                    :key="driver[0]"
                    class="btn btn-sm"
                    @click="invoke('app:openExternal', driver[1])"
                  >
                    {{ driver[0] }} {{ t('ic.official_driver') }}
                  </button></template
                >
              </div>
            </div>
            <button v-if="selectedMods.length" class="btn btn-gold" :disabled="busy || overview?.running" @click="form = 'disable'">
              {{ t('ic.disable_selected', { count: String(selectedMods.length) }) }}…
            </button>
            <div v-if="findings.some((f) => f.action === 'java')" class="ic-card">
              <h3>{{ t('ic.select_java') }}</h3>
              <SelectMenu
                v-model="javaPath"
                :options="java.map((j) => ({ value: j.path, label: 'Java ' + j.major + ' · ' + j.path }))"
                :placeholder="t('ic.no_compatible_runtime')"
              />
              <div class="ic-actions">
                <button
                  class="btn btn-gold"
                  :disabled="busy || !javaPath || overview?.running"
                  @click="perform(() => setVersionJava(target.id, javaPath, false, target.folder))"
                >
                  {{ t('ic.apply_instance') }}</button
                ><button
                  class="btn btn-ghost"
                  @click="
                    close();
                    openSettings('java');
                  "
                >
                  {{ t('ic.manage_java') }}
                </button>
              </div>
            </div>
            <button class="btn btn-ghost" :disabled="busy" @click="perform(() => exportLaunchLogs(target.id, target.folder))">
              {{ t('ic.export_diagnostic_log') }}
            </button>
          </template>
          <p v-if="busy" class="ic-hint" role="status">{{ t('ic.task_running') }}</p>
        </div>
        <div v-if="form" class="ic-dialog-mask">
          <section class="ic-dialog" role="dialog" :aria-label="t('ic.op_confirm')">
            <header>
              <h3>
                {{
                  form === 'clone'
                    ? t('ic.form_clone')
                    : form === 'restore'
                      ? t('ic.form_restore')
                      : form === 'disable'
                        ? t('ic.form_disable')
                        : form === 'dependencies'
                          ? t('ic.form_dependencies')
                          : t('ic.form_import')
                }}
              </h3>
              <button class="btn btn-sm" :aria-label="t('ic.close_confirm')" @click="form = ''">✕</button>
            </header>
            <template v-if="form === 'disable'"
              ><p>{{ t('ic.disable_hint') }}</p>
              <pre>{{ selectedMods.join('\n') }}</pre>
            </template>
            <template v-else-if="form === 'dependencies'"
              ><p>{{ dependencies?.changelog }}</p>
              <div v-for="f in dependencies?.files" :key="f.fileName" class="ic-row">
                <strong>{{ f.fileName }}</strong
                ><small>{{ f.version }}</small>
              </div></template
            >
            <label v-else-if="!overwrite || restore?.metadata?.type === 'world'"
              >{{ t('ic.name_label') }}<input v-model="name" class="input" maxlength="120"
            /></label>
            <template v-if="form === 'clone' || (form === 'restore' && restore?.metadata?.type !== 'world' && !overwrite)"
              ><label>{{ t('ic.target_folder') }}<SelectMenu v-model="destination" :options="folders" /></label
            ></template>
            <template v-if="form === 'clone'"
              ><label class="ic-check"><input v-model="includeSaves" type="checkbox" />{{ t('ic.include_worlds') }}</label
              ><label class="ic-check"><input v-model="includeShots" type="checkbox" />{{ t('ic.include_screenshots') }}</label>
              <p v-if="overview?.shared" class="ic-hint">{{ t('ic.shared_clone_hint') }}</p>
              <details>
                <summary>{{ t('ic.view_clone_scope') }}</summary>
                <p>{{ overview?.roots.join('、') }}</p>
              </details></template
            >
            <template v-if="form === 'restore'"
              ><p>
                {{ t('ic.restore_desc_prefix') }}{{ restore?.metadata?.type === 'world' ? t('ic.world') : t('ic.isolated_instance')
                }}{{ t('ic.restore_desc_suffix') }}
              </p>
              <label v-if="restore?.metadata?.type === 'world' || !overview?.shared" class="ic-check"
                ><input v-model="overwrite" type="checkbox" />{{ t('ic.overwrite')
                }}{{ restore?.metadata?.type === 'world' ? t('ic.same_name_world') : t('ic.current_instance')
                }}{{ t('ic.overwrite_suffix') }}</label
              ></template
            >
            <template v-if="form === 'import'"
              ><SelectMenu
                v-model="candidate"
                :options="
                  (worldInfo?.candidates || []).map((c) => ({
                    value: c.id,
                    label: c.worldName + ' · ' + (c.minecraftVersion || t('ic.unknown_version')),
                  }))
                "
              /><label class="ic-check"><input v-model="mismatch" type="checkbox" />{{ t('ic.allow_mismatch') }}</label></template
            >
            <p v-if="error" class="ic-error">{{ error }}</p>
            <footer>
              <button class="btn btn-ghost" @click="form = ''">{{ t('common.cancel') }}</button
              ><button
                class="btn btn-gold"
                :disabled="busy || (form === 'disable' ? !selectedMods.length : form === 'dependencies' ? !dependencies : !name.trim())"
                @click="
                  perform(() =>
                    form === 'dependencies'
                      ? invoke('center:dependencyApply', dependencies?.id, true)
                      : form === 'disable'
                        ? disableSelected()
                        : form === 'clone'
                          ? op({ kind: 'clone', name, destinationFolder: destination, saves: includeSaves, screenshots: includeShots })
                          : form === 'restore'
                            ? op({ kind: 'restore', name, destinationFolder: destination, backupId: restore?.id, overwrite })
                            : importWorld(worldInput, {
                                candidateId: candidate,
                                worldName: name,
                                targetFolder: target.folder,
                                targetVersionId: target.id,
                                allowVersionMismatch: mismatch,
                              })
                  )
                "
              >
                {{ busy ? t('ic.processing') : t('ic.confirm') }}
              </button>
            </footer>
          </section>
        </div>
      </section>
    </div>
    <div v-if="image" class="ic-lightbox" role="dialog" :aria-label="t('ic.view_screenshot')">
      <header>
        <strong>{{ image.id }}</strong
        ><button class="btn" @click="lightbox = -1">{{ t('ic.close_view') }} ✕</button>
      </header>
      <img :src="fullImage || image.image" :alt="t('ic.screenshot_full_alt')" />
      <footer>
        <button class="btn" :disabled="lightbox === 0" @click="lightbox--">{{ t('ic.prev_shot') }}</button
        ><button class="btn" @click="perform(() => invoke(IPC.centerFile, target, 'screenshot', image.id, true))">
          {{ t('ic.save_as') }}</button
        ><button class="btn" @click="perform(() => invoke(IPC.centerFile, target, 'screenshot', image.id))">
          {{ t('ic.open_location') }}</button
        ><button class="btn" :disabled="lightbox === shots.length - 1" @click="lightbox++">{{ t('ic.next_shot') }}</button>
      </footer>
    </div>
  </Teleport>
</template>
<style scoped>
.ic-mask {
  position: fixed;
  inset: 0;
  z-index: 9500;
  background: #0009;
  backdrop-filter: blur(8px);
  padding: 28px;
  display: grid;
  place-items: center;
}
.ic {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(1120px, 100%);
  height: min(860px, 100%);
  background: var(--card-solid, #192225);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 24px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.ic-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 26px 30px 18px;
  gap: 24px;
}
.ic-header h2 {
  margin: 6px 0;
  font-size: 26px;
  overflow-wrap: anywhere;
}
.ic-header p,
.ic-header small {
  color: var(--text-dim);
  margin: 0;
}
.ic-tabs {
  display: flex;
  gap: 6px;
  padding: 0 30px 16px;
  border-bottom: 1px solid var(--border);
  overflow: auto;
  flex-shrink: 0;
}
.ic-tabs button {
  border: 0;
  background: transparent;
  color: var(--text-dim);
  padding: 10px 24px;
  white-space: nowrap;
  border-radius: 12px;
  font: inherit;
  cursor: pointer;
}
.ic-tabs button.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}
.ic-content {
  padding: 24px 30px;
  overflow: auto;
  min-height: 0;
  overscroll-behavior: contain;
}
.ic-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 24px;
}
.ic-summary h3 {
  margin: 0 0 10px;
}
.ic p {
  line-height: 1.65;
  color: var(--text-dim);
}
.ic-path {
  overflow-wrap: anywhere;
  font-size: 12px;
}
.ic-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 22px;
}
.ic-card {
  display: block;
  min-width: 0;
  text-align: left;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 16px;
  color: var(--text);
  background: var(--card);
  margin-bottom: 14px;
  font: inherit;
}
.ic-grid .ic-card {
  margin: 0;
  cursor: pointer;
  transition:
    background 0.18s,
    transform 0.18s;
}
.ic-grid .ic-card:hover {
  background: var(--accent-soft);
  transform: translateY(-2px);
}
.ic-card span {
  display: block;
  color: var(--text-dim);
  font-size: 13px;
  margin-top: 8px;
}
.ic-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 0;
  border-bottom: 1px solid var(--border);
}
.ic-row img,
.ic-world-icon {
  width: 58px;
  height: 58px;
  object-fit: cover;
  border-radius: 10px;
  flex-shrink: 0;
}
.ic-world-icon {
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  font-size: 28px;
}
.ic-grow {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.ic-grow small {
  display: block;
  color: var(--text-dim);
  margin-top: 8px;
}
.ic-actions,
.ic-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.ic-tools {
  margin-bottom: 16px;
}
.ic-tools .input {
  flex: 1;
  min-width: 180px;
}
.ic-shots {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}
.ic-shot {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0;
  overflow: hidden;
  background: var(--card);
  color: var(--text);
  cursor: pointer;
}
.ic-shot img {
  width: 100%;
  aspect-ratio: 16/9;
  object-fit: cover;
}
.ic-shot span {
  display: block;
  padding: 10px;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ic-empty {
  text-align: center;
  padding: 56px 12px;
}
.ic-error {
  color: var(--danger) !important;
  overflow-wrap: anywhere;
}
.ic-hint {
  background: var(--accent-soft);
  padding: 12px 16px;
  border-radius: 12px;
}
.ic pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 180px;
  overflow: auto;
  background: var(--bg);
  padding: 14px;
  border-radius: 10px;
  font-size: 12px;
}
.ic-badge {
  font-size: 12px !important;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--accent-soft);
  margin: 0 !important;
}
.ic-dialog-mask {
  position: absolute;
  inset: 0;
  background: #0008;
  display: grid;
  place-items: center;
  padding: 24px;
  z-index: 2;
}
.ic-dialog {
  background: var(--card-solid, #192225);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 24px;
  width: min(560px, 100%);
  max-height: 100%;
  overflow: auto;
}
.ic-dialog header,
.ic-dialog footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ic-dialog footer {
  justify-content: flex-end;
  margin-top: 20px;
}
.ic-dialog label {
  display: block;
  margin: 18px 0;
}
.ic-dialog label .input {
  display: block;
  width: 100%;
  margin-top: 8px;
  box-sizing: border-box;
}
.ic-dialog .ic-check {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ic-lightbox {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: #101418fa;
  color: white;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 24px;
}
.ic-lightbox header,
.ic-lightbox footer {
  display: flex;
  gap: 16px;
  align-items: center;
}
.ic-lightbox img {
  min-height: 0;
  flex: 1;
  max-width: 100%;
  object-fit: contain;
}
.ic-lightbox .btn {
  color: white;
  background: #293139;
}
@media (max-width: 800px) {
  .ic-mask {
    padding: 10px;
  }
  .ic-header,
  .ic-content {
    padding: 18px;
  }
  .ic-tabs {
    padding: 0 14px 14px;
  }
  .ic-tabs button {
    padding: 10px 15px;
  }
  .ic-row,
  .ic-summary {
    flex-wrap: wrap;
  }
  .ic-shots {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .ic-header h2 {
    font-size: 21px;
  }
  .ic-actions {
    width: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ic-grid .ic-card {
    transition: none;
  }
}
</style>
