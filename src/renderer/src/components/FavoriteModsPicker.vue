<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CommunityFile, InstallOptions, LoaderName } from '@shared/types';
import type { FavoriteInstallIntent, FavoriteInstallSkip, FavoriteSkipReason, ModFavorite } from '@shared/modFavorites';
import SelectMenu from './SelectMenu.vue';
import { cancelFavoriteVersions, errText, requestFavoriteVersions } from '../api';
import { favorites, loadFavorites } from '../modFavorites';
import { t } from '@renderer/i18n';

const props = defineProps<{
  mc: string;
  loader: '' | LoaderName;
  modelValue?: InstallOptions['favoriteMods'];
  intent?: FavoriteInstallIntent;
}>();
const emit = defineEmits<{
  'update:modelValue': [InstallOptions['favoriteMods']];
  'update:intent': [FavoriteInstallIntent | undefined];
  ready: [boolean];
}>();
type Status = 'loading' | 'available' | 'incompatible' | 'unlinked' | 'unreliable' | 'query-error' | 'needs-loader';
interface Row {
  favorite: ModFavorite;
  files: CommunityFile[];
  selected: string;
  checked: boolean;
  approvedSkip: boolean;
  status: Status;
  message: string;
}
const enabled = ref(false),
  rows = ref<Row[]>([]),
  loadingFavorites = ref(false),
  error = ref(''),
  retry = ref(0),
  baseOnly = ref(false);
const busy = computed(() => loadingFavorites.value || rows.value.some((row) => row.status === 'loading'));
const selectedCount = computed(() =>
  baseOnly.value ? 0 : rows.value.filter((row) => row.status === 'available' && row.checked && row.selected).length
);
const skippedCount = computed(() =>
  baseOnly.value ? rows.value.length : rows.value.filter((row) => row.approvedSkip || (row.status === 'available' && !row.checked)).length
);
const pendingCount = computed(() => rows.value.length - selectedCount.value - skippedCount.value);
let generation = 0;
const tickets = new Set<string>();

function skipReason(row: Row): FavoriteSkipReason {
  return row.status === 'available'
    ? 'deselected'
    : row.status === 'unlinked'
      ? 'unlinked'
      : row.status === 'query-error'
        ? 'query-error'
        : row.status === 'unreliable'
          ? 'unreliable'
          : 'incompatible';
}
function update() {
  if (!enabled.value) {
    emit('update:modelValue', undefined);
    emit('update:intent', undefined);
    emit('ready', true);
    return;
  }
  const selected = baseOnly.value
    ? []
    : rows.value
        .filter((row) => row.status === 'available' && row.checked && row.selected)
        .map((row) => ({ source: row.favorite.source!, projectId: row.favorite.projectId!, fileId: row.selected }));
  const approvedSkips: FavoriteInstallSkip[] = rows.value
    .filter((row) => baseOnly.value || row.approvedSkip || (row.status === 'available' && !row.checked))
    .map((row) => ({
      key: row.favorite.key,
      name: row.favorite.name,
      reason: baseOnly.value ? 'base-only' : skipReason(row),
      ...(row.message ? { message: row.message.slice(0, 1000) } : {}),
    }));
  emit('update:modelValue', selected);
  emit('update:intent', {
    enabled: true,
    expected: rows.value.map((row) => ({ key: row.favorite.key, name: row.favorite.name })),
    approvedSkips,
    ...(baseOnly.value ? { baseOnly: true } : {}),
  });
  emit(
    'ready',
    !busy.value &&
      !error.value &&
      (baseOnly.value || (!!props.loader && selected.length > 0 && selected.length <= 100 && pendingCount.value === 0))
  );
}
function cancelQueries() {
  for (const ticket of tickets) void cancelFavoriteVersions(ticket).catch(() => {});
  tickets.clear();
}
async function queryRow(row: Row, current = generation) {
  const mc = props.mc,
    loader = props.loader;
  if (!loader || !row.favorite.source || !row.favorite.projectId) return;
  row.status = 'loading';
  row.approvedSkip = false;
  row.checked = true;
  row.selected = '';
  row.files = [];
  row.message = '';
  baseOnly.value = false;
  const ticket = crypto.randomUUID();
  tickets.add(ticket);
  update();
  try {
    const result = await requestFavoriteVersions(row.favorite.source, row.favorite.projectId, mc, loader, ticket),
      files = result.files;
    if (current !== generation) return;
    row.files = files;
    row.selected = files.find((file) => file.releaseType === 'release')?.fileId || files[0]?.fileId || '';
    row.status = row.selected ? 'available' : result.status === 'unreliable' ? 'unreliable' : 'incompatible';
    row.approvedSkip = row.status === 'incompatible';
    row.checked = row.status === 'available';
    row.message = row.selected ? '' : row.status === 'unreliable' ? t('dup.favorite.unreliable') : t('dup.favorite.incompatible');
  } catch (failure) {
    if (current !== generation) return;
    row.status = 'query-error';
    row.message = t('dup.favorite.query_failed', { error: errText(failure) }).slice(0, 1000);
  } finally {
    tickets.delete(ticket);
    if (current === generation) update();
  }
}
function approveSkip(row: Row) {
  row.approvedSkip = true;
  row.checked = false;
  baseOnly.value = false;
  update();
}
function changeChecked(row: Row) {
  row.approvedSkip = !row.checked;
  baseOnly.value = false;
  update();
}
function continueWithoutFavorites() {
  baseOnly.value = true;
  update();
}
function resumeSelection() {
  baseOnly.value = false;
  update();
}
watch(
  [
    () => props.mc,
    () => props.loader,
    enabled,
    retry,
    () => JSON.stringify(favorites.value.map((f) => [f.key, f.name, f.source, f.projectId])),
  ],
  async (_n, _o, cleanup) => {
    const current = ++generation;
    cleanup(() => {
      if (current === generation) generation++;
      cancelQueries();
    });
    rows.value = [];
    error.value = '';
    baseOnly.value = false;
    loadingFavorites.value = enabled.value;
    update();
    if (!enabled.value) return;
    try {
      await loadFavorites(true);
      if (current !== generation) return;
      rows.value = favorites.value.map((favorite) => ({
        favorite,
        files: [],
        selected: '',
        checked: !!favorite.source && !!favorite.projectId,
        approvedSkip: !favorite.source || !favorite.projectId,
        status: !favorite.source || !favorite.projectId ? 'unlinked' : props.loader ? 'loading' : 'needs-loader',
        message: !favorite.source || !favorite.projectId ? t('dup.favorite.unlinked') : '',
      }));
      loadingFavorites.value = false;
      await Promise.all(rows.value.filter((row) => row.status === 'loading').map((row) => queryRow(row, current)));
    } catch (failure) {
      if (current === generation) error.value = t('dup.favorite.read_failed', { error: errText(failure) });
    } finally {
      if (current === generation) {
        loadingFavorites.value = false;
        update();
      }
    }
  },
  { immediate: true }
);
</script>

<template>
  <section class="favorite-picker" data-ui="favorites:install">
    <label class="check-option"
      ><input v-model="enabled" type="checkbox" data-ui="favorites:enable" @change="update" /><span
        ><strong>{{ t('dup.favorite.enable') }}</strong
        ><small>{{ t('dup.favorite.enable_hint') }}</small></span
      ></label
    >
    <template v-if="enabled">
      <p v-if="busy" class="muted" role="status">
        {{ t('dup.favorite.checking', { mc, loader: loader || t('dup.favorite.no_loader_selected') }) }}
      </p>
      <p v-if="error" role="alert" class="unavailable">
        {{ error }} <button class="btn btn-ghost btn-sm" @click="retry++">{{ t('common.reread') }}</button>
      </p>
      <p v-if="!loader && !busy && !baseOnly" class="unavailable" role="status">{{ t('dup.favorite.no_loader') }}</p>
      <p v-if="!busy && !rows.length && !error" class="muted" v-html="t('dup.favorite.empty')"></p>
      <div v-for="row in rows" :key="row.favorite.key" class="favorite-row" :data-favorite-key="row.favorite.key">
        <label
          ><input
            v-model="row.checked"
            type="checkbox"
            :disabled="busy || row.status !== 'available' || baseOnly"
            @change="changeChecked(row)"
          /><span>{{ row.favorite.name }}</span></label
        >
        <p v-if="row.message" class="unavailable" :role="row.status === 'query-error' ? 'alert' : 'status'">{{ row.message }}</p>
        <SelectMenu
          v-if="row.files.length"
          v-model="row.selected"
          :disabled="busy || baseOnly || !row.checked"
          :options="row.files.map((file) => ({ value: file.fileId, label: file.version + ' · ' + file.fileName }))"
          @change="update"
        />
        <div v-if="row.status === 'query-error' || row.status === 'unreliable'" class="favorite-row-actions">
          <button class="btn btn-ghost btn-sm" :disabled="busy" data-ui="favorites:retry" @click="queryRow(row)">
            {{ t('dup.favorite.retry_one') }}
          </button>
          <button
            class="btn btn-ghost btn-sm"
            :disabled="busy || row.approvedSkip || baseOnly"
            data-ui="favorites:skip"
            @click="approveSkip(row)"
          >
            {{ row.approvedSkip || baseOnly ? t('dup.favorite.skipped') : t('dup.favorite.skip_one') }}
          </button>
        </div>
      </div>
      <p class="favorite-summary" data-ui="favorites:summary" aria-live="polite">
        {{ t('dup.favorite.summary', { selected: String(selectedCount), skipped: String(skippedCount) })
        }}<span v-if="pendingCount > 0 && !baseOnly">{{ t('dup.favorite.pending', { count: String(pendingCount) }) }}</span>
      </p>
      <button v-if="baseOnly" class="btn btn-ghost btn-sm" data-ui="favorites:resume" @click="resumeSelection">
        {{ t('dup.favorite.reselect') }}
      </button>
      <p v-if="selectedCount > 100" class="unavailable" role="alert">{{ t('dup.favorite.max_100') }}</p>
      <div v-if="!busy && !error && selectedCount === 0" class="favorite-empty-decision">
        <p class="muted">{{ t('dup.favorite.none_to_install') }}</p>
        <button class="btn btn-ghost btn-sm" :disabled="baseOnly" data-ui="favorites:base-only" @click="continueWithoutFavorites">
          {{ baseOnly ? t('dup.favorite.skipped_all') : t('dup.favorite.skip_all') }}
        </button>
      </div>
      <p class="muted favorite-install-help">{{ t('dup.favorite.prereq_hint') }}</p>
    </template>
  </section>
</template>
<style scoped>
.favorite-picker {
  margin: 20px 0;
}
.favorite-row {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-top: 10px;
  background: var(--card-2);
}
.favorite-row label {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.favorite-row label span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.favorite-picker p {
  font-size: 13px;
  line-height: 1.6;
  margin-top: 10px;
}
.unavailable {
  color: var(--danger, #e05260);
  overflow-wrap: anywhere;
}
.favorite-row-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.favorite-summary {
  font-weight: 600;
}
.favorite-empty-decision {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-2);
}
.favorite-install-help {
  padding-top: 12px;
  border-top: 1px solid var(--border);
  margin-top: 14px;
}
</style>
