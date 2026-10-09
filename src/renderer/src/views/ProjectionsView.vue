<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ProjectionCatalog, ProjectionEntry, ProjectionRequest, ProjectionResult } from '@shared/projections';
import { errText } from '../api';
import { store, toast } from '../store';
import { t } from '@renderer/i18n';
import ContentSkeleton from '../components/ContentSkeleton.vue';
import SelectMenu from '../components/SelectMenu.vue';
import ConfirmModal from '../components/ConfirmModal.vue';
import ProjectionConvert from '../components/ProjectionConvert.vue';
const converting = ref<ProjectionEntry>();
const data = ref<ProjectionCatalog>({ entries: [], warnings: [], library: '', instances: [] });
const loading = ref(false),
  busy = ref(false),
  error = ref(''),
  query = ref(''),
  kind = ref('all'),
  source = ref('all'),
  page = ref(1),
  selected = ref<string[]>([]),
  target = ref(''),
  confirm = ref<'trash' | 'dispatch' | ''>('');
const results = ref<ProjectionResult[]>([]);
let generation = 0,
  disposed = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const activeFolder = computed(() => store.settings?.activeFolder || store.settings?.gameDir || '');
const folderFilter = ref('');
const folderOptions = computed(() => [
  { value: '', label: t('projections.filter.folder_all') },
  ...(store.settings?.folders ?? []).map((f) => ({ value: f.path, label: f.name + ' · ' + f.path })),
]);
const kindOptions = computed(() => [
  { value: 'all', label: t('projections.filter.kind_all') },
  ...['litematic', 'schem', 'schematic', 'nbt'].map((v) => ({ value: v, label: '.' + v })),
]);
const sourceOptions = computed(() => [
  { value: 'all', label: t('projections.filter.source_all') },
  { value: 'library', label: t('projections.filter.source_library') },
  { value: 'instances', label: t('projections.filter.source_instances') },
]);
watch(
  () => JSON.stringify([activeFolder.value, store.settings?.folders]),
  () => {
    void refresh(true);
  }
);
watch(folderOptions, (options) => {
  if (!options.some((o) => o.value === folderFilter.value)) folderFilter.value = '';
});
watch(
  () => store.fsRefreshTick,
  () => {
    if (!busy.value) void refresh();
  }
);
const invoke = <T,>(channel: string, ...args: unknown[]) => window.faionyx.invoke(channel, ...args) as Promise<T>;
const filtered = computed(() =>
  data.value.entries.filter(
    (e) =>
      (!folderFilter.value || e.folder === folderFilter.value) &&
      (kind.value === 'all' || e.kind === kind.value) &&
      (source.value === 'all' || (source.value === 'library' ? e.library : !e.library)) &&
      `${e.name} ${e.source} ${e.directory}`.toLowerCase().includes(query.value.trim().toLowerCase())
  )
);
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 40)));
const rows = computed(() => filtered.value.slice((page.value - 1) * 40, page.value * 40));
const targets = computed(() => data.value.instances.map((i) => ({ value: JSON.stringify([i.folder, i.id]), label: i.name })));
const size = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
watch([query, kind, source, folderFilter], () => {
  page.value = 1;
  selected.value = [];
});
async function refresh(silent = false) {
  const id = ++generation;
  if (!silent) loading.value = true;
  error.value = '';
  try {
    const next = await invoke<ProjectionCatalog>('projections:list');
    if (disposed || id !== generation) return;
    data.value = next;
    if (!targets.value.some((tg) => tg.value === target.value)) target.value = '';
    selected.value = selected.value.filter((sid) => next.entries.some((e) => e.id === sid));
    page.value = Math.min(page.value, pages.value);
    if (!silent) target.value = '';
  } catch (e) {
    if (!disposed && id === generation) error.value = errText(e);
  } finally {
    if (!disposed && id === generation) loading.value = false;
  }
}
function drag(event: DragEvent, entry: ProjectionEntry) {
  event.preventDefault();
  event.stopPropagation();
  if (busy.value || loading.value || store.editMode) return;
  window.faionyx.send('projections:drag', selected.value.includes(entry.id) ? [...selected.value] : [entry.id]);
}
function autoRefresh() {
  if (!busy.value && !loading.value && !selected.value.length && !target.value && document.visibilityState === 'visible')
    void refresh(true);
}
function selectPage() {
  const ids = rows.value.map((e) => e.id);
  selected.value = ids.every((id) => selected.value.includes(id))
    ? selected.value.filter((id) => !ids.includes(id))
    : [...new Set([...selected.value, ...ids])];
}
async function open(entry?: ProjectionEntry) {
  try {
    await invoke('projections:open', entry?.id);
  } catch (e) {
    toast(errText(e), 'error');
  }
}
async function execute(action: ProjectionRequest['action'] | 'import') {
  if (busy.value) return;
  const ids = [...selected.value],
    destination = target.value === '' ? undefined : data.value.instances.find((i) => JSON.stringify([i.folder, i.id]) === target.value);
  confirm.value = '';
  busy.value = true;
  try {
    const result =
      action === 'import'
        ? await invoke<ProjectionResult[] | null>('projections:import')
        : await invoke<ProjectionResult[] | null>('projections:operate', { action, ids, target: destination });
    if (result) {
      results.value = result;
      const failed = result.filter((r) => !r.ok);
      selected.value = failed.map((r) => r.id);
      toast(
        failed.length
          ? t('projections.toast.done_partial', {
              ok: String(result.length - failed.length),
              failed: String(failed.length),
            })
          : t('projections.toast.done', { count: String(result.length) }),
        failed.length ? 'error' : 'success'
      );
      await refresh();
    }
  } catch (e) {
    toast(errText(e), 'error');
  } finally {
    busy.value = false;
  }
}
function escape(e: KeyboardEvent) {
  if (e.key === 'Escape') confirm.value = '';
}
onMounted(() => {
  void refresh();
  window.addEventListener('keydown', escape);
  window.addEventListener('focus', autoRefresh);
  refreshTimer = setInterval(autoRefresh, 15000);
});
onUnmounted(() => {
  disposed = true;
  generation++;
  clearInterval(refreshTimer);
  window.removeEventListener('keydown', escape);
  window.removeEventListener('focus', autoRefresh);
});
</script>

<template>
  <section class="recordings-page" data-ui="projections:page">
    <ProjectionConvert v-if="converting" :entry="converting" @close="converting = undefined" @done="refresh()" />
    <header class="page-head recording-heading" data-ui="projections:heading">
      <div data-ui="ProjectionsView:3e7b827962e6">
        <h1 data-ui="ProjectionsView:2ac7467a0648">
          {{ t('projections.title') }} <small>{{ t('projections.count', { count: String(data.entries.length) }) }}</small>
        </h1>
        <p class="muted">{{ t('projections.subtitle') }}</p>
      </div>
      <div class="actions">
        <button data-ui="ProjectionsView:78a31a977742" class="btn btn-ghost" @click="open()">{{ t('projections.open_library') }}</button
        ><button data-ui="ProjectionsView:1594a41b4b07" class="btn btn-gold" :disabled="busy" @click="execute('import')">
          {{ t('projections.import') }}</button
        ><button data-ui="ProjectionsView:54ee9bdbb21c" class="btn btn-ghost" :disabled="busy || loading" @click="refresh()">
          {{ loading ? t('projections.loading') : t('projections.refresh') }}
        </button>
      </div>
    </header>
    <div class="recording-library" data-ui="projections:library">
      <span data-ui="ProjectionsView:2931d23fc4f5" class="muted">{{ t('projections.library_location') }}</span
      ><span class="path" :title="data.library">{{ data.library || t('projections.library_reading') }}</span>
      <details class="recording-help">
        <summary>{{ t('projections.help_summary') }}</summary>
        <p>{{ t('projections.help_body') }}</p>
      </details>
    </div>
    <section class="recording-workspace card">
      <div class="recording-filters" data-ui="projections:filters">
        <SelectMenu v-model="folderFilter" :disabled="busy" :options="folderOptions" />
        <input
          data-ui="ProjectionsView:a4bc662c17f4"
          v-model="query"
          class="input"
          :aria-label="t('projections.filter.search_aria')"
          :placeholder="t('projections.filter.search_placeholder')"
          :disabled="busy"
        />
        <SelectMenu v-model="kind" :disabled="busy" :options="kindOptions" />
        <SelectMenu v-model="source" :disabled="busy" :options="sourceOptions" />
      </div>
      <div data-ui="ProjectionsView:03ebe3d01f67" v-if="error" class="card" role="alert">
        {{ error }}
        <button data-ui="ProjectionsView:d86b658466b7" class="btn btn-ghost" @click="refresh()">{{ t('projections.retry') }}</button>
      </div>
      <details data-ui="ProjectionsView:4886ef0bbbad" v-if="data.warnings.length" class="card">
        <summary>{{ t('projections.warnings_summary', { count: String(data.warnings.length) }) }}</summary>
        <p data-ui="ProjectionsView:a95d7ac71e30" v-for="warning in data.warnings" :key="warning">{{ warning }}</p>
      </details>
      <div v-if="filtered.length" class="recording-controls" data-ui="projections:controls">
        <div class="actions">
          <button data-ui="ProjectionsView:f5fef6266bd6" class="btn btn-ghost" :disabled="busy || !rows.length" @click="selectPage">
            {{ t('projections.select_page') }}</button
          ><button
            data-ui="ProjectionsView:8436cfb2245d"
            class="btn btn-ghost"
            :disabled="busy || !filtered.length"
            @click="selected = filtered.map((e) => e.id)"
          >
            {{ t('projections.select_all_filtered', { count: String(filtered.length) }) }}</button
          ><span>{{ t('projections.selected_count', { count: String(selected.length) }) }}</span
          ><button
            data-ui="ProjectionsView:ed589ee8e06c"
            v-if="selected.length"
            class="btn btn-ghost"
            :disabled="busy"
            @click="selected = []"
          >
            {{ t('projections.clear') }}
          </button>
        </div>
        <div data-ui="ProjectionsView:c59dbb632ead" v-if="selected.length" class="actions operation-row">
          <button data-ui="ProjectionsView:85f3f8414f9d" class="btn btn-gold" :disabled="busy" @click="execute('collect')">
            {{ t('projections.action.collect') }}</button
          ><button data-ui="ProjectionsView:000f81fa6db3" class="btn btn-ghost" :disabled="busy" @click="execute('export')">
            {{ t('projections.action.export') }}</button
          ><SelectMenu
            v-model="target"
            :disabled="busy"
            :options="targets"
            :placeholder="t('projections.action.target_placeholder')"
          /><button
            data-ui="ProjectionsView:fa2131a8e18d"
            class="btn btn-ghost"
            :disabled="busy || target === ''"
            @click="confirm = 'dispatch'"
          >
            {{ t('projections.action.dispatch') }}</button
          ><button data-ui="ProjectionsView:1699f50ec9f0" class="btn btn-danger" :disabled="busy" @click="confirm = 'trash'">
            {{ t('projections.action.trash') }}
          </button>
        </div>
      </div>
      <div data-ui="ProjectionsView:69fb5a4a1573" v-if="loading && data.entries.length" class="status-strip" role="status">
        {{ t('projections.status.updating') }}
      </div>
      <ContentSkeleton v-if="loading && !data.entries.length" class="card" :label="t('projections.skeleton.loading')" />
      <div data-ui="ProjectionsView:9196e415ffb9" v-else-if="!rows.length && !error" class="card empty">
        <span>{{ data.entries.length ? t('projections.empty.no_match') : t('projections.empty.none') }}</span
        ><button
          data-ui="ProjectionsView:c0ed13df1c01"
          v-if="data.entries.length"
          class="btn btn-ghost"
          @click="
            query = '';
            kind = 'all';
            source = 'all';
            folderFilter = '';
          "
        >
          {{ t('projections.empty.clear_filters') }}
        </button>
      </div>
      <div v-else-if="rows.length" :inert="loading || !!error" class="recording-list" data-ui="projections:list">
        <article data-ui="ProjectionsView:2bb2004aef70" v-for="entry in rows" :key="entry.id" class="recording-row">
          <input
            data-ui="ProjectionsView:d29a579f673a"
            v-model="selected"
            type="checkbox"
            :value="entry.id"
            :aria-label="t('projections.row.select_aria', { name: entry.name })"
            :disabled="busy"
          />
          <div
            data-ui="ProjectionsView:3867dfbdf0e7"
            class="recording-info"
            :draggable="!busy && !loading && !store.editMode"
            :title="t('projections.row.drag_title')"
            @dragstart="drag($event, entry)"
          >
            <strong data-ui="ProjectionsView:6f5f6ab090cd" tabindex="0" :title="entry.name">{{ entry.name }}</strong>
            <div data-ui="ProjectionsView:80aad3d6d4fa" class="muted">
              {{ '.' + entry.kind }} · {{ entry.source }} · {{ size(entry.size) }} ·
              {{ t('projections.row.blocks', { count: String(entry.blocks ?? '?') }) }} ·
              {{ entry.gameVersion || entry.dataVersion || t('projections.row.version_unknown') }} ·
              {{ new Date(entry.modified).toLocaleString() }}
            </div>
            <p v-if="entry.error" class="scan-error" role="status">{{ entry.error }}</p>
            <div data-ui="ProjectionsView:2185a2a82be6" class="muted path" :title="entry.directory">{{ entry.directory }}</div>
          </div>
          <button data-ui="ProjectionsView:e41d05dae554" class="btn btn-ghost btn-sm" @click="open(entry)">
            {{ t('projections.row.locate') }}</button
          ><button class="btn btn-ghost btn-sm" :disabled="!!entry.error || busy" @click="converting = entry">
            {{ t('projections.row.convert') }}
          </button>
        </article>
      </div>
      <div data-ui="ProjectionsView:419803271708" v-if="pages > 1" class="actions pagination">
        <button data-ui="ProjectionsView:0fa04d3df515" class="btn btn-ghost" :disabled="page <= 1" @click="page--">
          {{ t('projections.pagination.prev') }}</button
        ><span>{{
          t('projections.pagination.summary', {
            page: String(page),
            pages: String(pages),
            count: String(filtered.length),
          })
        }}</span
        ><button data-ui="ProjectionsView:6380222140de" class="btn btn-ghost" :disabled="page >= pages" @click="page++">
          {{ t('projections.pagination.next') }}
        </button>
      </div>
    </section>
    <details data-ui="ProjectionsView:d26a22685a69" v-if="results.length" open class="card recording-results">
      <summary>{{ t('projections.results.summary') }}</summary>
      <p data-ui="ProjectionsView:3b547d60eb96" v-for="result in results" :key="result.id" :class="{ failed: !result.ok }">
        {{ result.name }}：{{ result.ok ? t('projections.results.ok') : result.error
        }}<span data-ui="ProjectionsView:3a6703ddc9e2" v-if="result.path" class="muted path"> → {{ result.path }}</span>
      </p>
    </details>
    <ConfirmModal
      :open="!!confirm"
      :title="confirm === 'trash' ? t('projections.confirm.trash_title') : t('projections.confirm.dispatch_title')"
      :message="
        confirm === 'trash'
          ? t('projections.confirm.trash_message', { count: String(selected.length) })
          : t('projections.confirm.dispatch_message', { count: String(selected.length) })
      "
      :confirm-text="confirm === 'trash' ? t('projections.confirm.trash_confirm') : t('projections.confirm.dispatch_confirm')"
      @cancel="confirm = ''"
      @confirm="execute(confirm as 'trash' | 'dispatch')"
    />
  </section>
</template>

<style scoped>
/* 样式未改动，沿用原文件 */
.recordings-page {
  max-width: 1440px;
  margin: 0 auto;
  display: grid;
  gap: 20px;
  min-width: 0;
}
.page-head h1 {
  margin: 0 0 8px;
}
.card {
  padding: 22px;
}
.recording-library {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}
.recording-library h3 {
  margin: 0;
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.recording-filters {
  display: grid;
  grid-template-columns: minmax(200px, 1fr) minmax(180px, 1fr) 150px 150px;
  gap: 12px;
}
.recording-controls {
  display: grid;
  gap: 16px;
}
.recording-controls p {
  margin: 0;
}
.operation-row :deep(.select-menu-btn) {
  max-width: 360px;
}
.recording-list {
  overflow: visible;
}
.recording-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
}
.recording-row:last-child {
  border: 0;
}
.recording-info {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 6px;
}
.recording-info[draggable='true'] {
  cursor: grab;
}
.recording-info strong {
  overflow-wrap: anywhere;
}
.path {
  overflow-wrap: anywhere;
  font-size: 12px;
}
.recording-info .path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pagination {
  justify-content: center;
}
.empty {
  text-align: center;
  padding: 40px;
}
.failed {
  color: var(--danger, #e76b75);
}
.recording-results {
  max-height: 300px;
  overflow: auto;
}
.recording-results p {
  overflow-wrap: anywhere;
}
@media (max-width: 800px) {
  .recording-filters {
    grid-template-columns: 1fr 1fr;
  }
  .recording-filters input {
    grid-column: 1/-1;
  }
  .recording-row {
    gap: 10px;
  }
  .card {
    padding: 16px;
  }
}
.recordings-page {
  gap: 12px;
}
.recording-heading {
  display: flex;
  flex-direction: row;
  text-align: left;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.recording-heading h1 {
  font-size: 24px;
}
.recording-heading small {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-dim);
}
.recording-heading p {
  margin: 4px 0;
}
.recording-library {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}
.recording-library .path {
  min-width: 0;
  overflow-wrap: anywhere;
}
.recording-help {
  margin-left: auto;
  max-width: 100%;
  line-height: 1.7;
}
.recording-help summary {
  cursor: pointer;
  white-space: nowrap;
}
.recording-workspace {
  padding: 16px;
  display: grid;
  gap: 12px;
  min-height: 240px;
  align-content: start;
}
.recording-filters {
  grid-template-columns: minmax(190px, 1.5fr) minmax(160px, 1fr) 130px 130px;
}
.recording-filters > input {
  grid-column: 1;
  grid-row: 1;
}
.recording-filters > :first-child {
  grid-column: 2;
}
.recording-controls {
  padding: 8px 0;
  gap: 8px;
  border-bottom: 1px solid var(--border);
}
.recording-controls .actions {
  gap: 8px;
}
.recording-row {
  padding: 12px 0;
  min-height: 72px;
}
.recording-info strong {
  word-break: normal;
  overflow-wrap: break-word;
}
.recording-workspace > .empty {
  background: transparent;
  border: 0;
  min-height: 220px;
  box-shadow: none;
}
.recording-results {
  padding: 12px 16px;
}
.recording-results summary {
  cursor: pointer;
}
@media (max-width: 1150px) {
  .recording-filters {
    grid-template-columns: 1fr 1fr;
  }
  .recording-filters > input {
    grid-column: 1/-1;
  }
  .recording-filters > :first-child {
    grid-row: 2;
    grid-column: 1;
  }
}
@media (max-width: 650px) {
  .recording-filters {
    display: flex;
    flex-direction: column;
  }
  .recording-workspace {
    padding: 12px;
  }
}
</style>
