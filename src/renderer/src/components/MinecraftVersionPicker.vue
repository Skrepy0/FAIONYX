<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import type { RemoteVersion } from '@shared/types';
import { filterVersions, versionCategories, versionCategory, type VersionCategory } from '@shared/versionPicker';
import { getManifest } from '../api';
import { t } from '@renderer/i18n';
const props = defineProps<{ modelValue: string; disabled?: boolean }>(),
  emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();
const open = ref(false),
  loading = ref(false),
  error = ref(''),
  query = ref(''),
  category = ref<VersionCategory>('release'),
  versions = ref<RemoteVersion[]>([]),
  active = ref(0),
  manual = ref(false),
  manualValue = ref(''),
  anchor = ref<HTMLElement>(),
  panel = ref<HTMLElement>(),
  search = ref<HTMLInputElement>(),
  list = ref<HTMLElement>(),
  position = ref<Record<string, string>>({});
const rows = computed(() => filterVersions(versions.value, category.value, query.value));
function locate() {
  const r = anchor.value?.getBoundingClientRect();
  if (!r) return;
  const below = innerHeight - r.bottom - 16,
    above = r.top - 16,
    up = below < 300 && above > below;
  const h = Math.max(100, Math.min(430, up ? above : below)),
    w = Math.min(Math.max(420, r.width), innerWidth - 24);
  position.value = {
    left: Math.max(12, Math.min(r.left, innerWidth - w - 12)) + 'px',
    width: w + 'px',
    height: h + 'px',
    ...(up ? { bottom: innerHeight - r.top + 6 + 'px' } : { top: r.bottom + 6 + 'px' }),
  };
}
async function load(refresh = false) {
  loading.value = true;
  error.value = '';
  try {
    versions.value = await getManifest(refresh);
  } catch {
    error.value = t('mvp.load_failed');
  } finally {
    loading.value = false;
  }
}
async function show() {
  if (props.disabled) return;
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  locate();
  addEventListener('pointerdown', outside, true);
  addEventListener('keydown', keyboard, true);
  addEventListener('resize', locate);
  addEventListener('scroll', scroll, true);
  if (!versions.value.length) await load();
  active.value = Math.max(
    0,
    rows.value.findIndex((v) => v.id === props.modelValue)
  );
  await nextTick();
  search.value?.focus();
  reveal();
}
function close() {
  open.value = false;
  manual.value = false;
  removeEventListener('pointerdown', outside, true);
  removeEventListener('keydown', keyboard, true);
  removeEventListener('resize', locate);
  removeEventListener('scroll', scroll, true);
}
function outside(e: PointerEvent) {
  if (!panel.value?.contains(e.target as Node) && !anchor.value?.contains(e.target as Node)) close();
}
function scroll(e: Event) {
  if (!panel.value?.contains(e.target as Node)) locate();
}
function choose(id: string) {
  emit('update:modelValue', id);
  close();
  anchor.value?.focus();
}
function reveal() {
  void nextTick(() => list.value?.querySelector<HTMLElement>('[data-active=true]')?.scrollIntoView({ block: 'nearest' }));
}
function reset() {
  active.value = 0;
  if (list.value) list.value.scrollTop = 0;
}
function keyboard(e: KeyboardEvent) {
  if (!open.value) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
    anchor.value?.focus();
  }
  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) && !manual.value) {
    e.preventDefault();
    e.stopImmediatePropagation();
    active.value =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? rows.value.length - 1
          : Math.max(0, Math.min(rows.value.length - 1, active.value + (e.key === 'ArrowDown' ? 1 : -1)));
    reveal();
  }
  if (e.key === 'Enter' && e.target === search.value && rows.value[active.value]) {
    e.preventDefault();
    choose(rows.value[active.value].id);
  }
}
onBeforeUnmount(close);
</script>
<template>
  <button
    ref="anchor"
    type="button"
    class="version-picker-trigger input"
    :disabled="disabled"
    :aria-expanded="open"
    aria-haspopup="listbox"
    :aria-label="t('mvp.aria_label')"
    @click="show"
  >
    <span>{{ modelValue || t('mvp.placeholder') }}</span
    ><span>⌄</span>
  </button>
  <Teleport to="body"
    ><Transition name="popover"
      ><section v-if="open" ref="panel" class="version-picker-popup" :style="position" @wheel.stop>
        <div class="version-picker-top">
          <input
            ref="search"
            v-model="query"
            class="input"
            role="combobox"
            :aria-label="t('mvp.search_aria')"
            aria-controls="migration-version-list"
            :aria-expanded="open"
            :aria-activedescendant="'mc-option-' + active"
            :placeholder="t('mvp.search_placeholder')"
            @input="reset"
          />
          <div class="version-categories">
            <button
              v-for="c in versionCategories"
              :class="{ active: category === c.value }"
              :aria-pressed="category === c.value"
              @click="
                category = c.value;
                reset();
              "
            >
              {{ t(c.label) }}
            </button>
          </div>
        </div>
        <div ref="list" id="migration-version-list" class="version-picker-list" role="listbox" :aria-label="t('mvp.list_aria')">
          <div v-if="loading" class="version-picker-message">{{ t('mvp.loading') }}</div>
          <div v-else-if="error" class="version-picker-message">
            {{ error }}<button class="btn btn-ghost" @click="load(true)">{{ t('mvp.retry') }}</button
            ><button class="btn btn-ghost" @click="manual = true">{{ t('mvp.manual') }}</button>
          </div>
          <div v-else-if="!rows.length" class="version-picker-message">
            {{ t('mvp.no_match')
            }}<button
              class="btn btn-ghost"
              @click="
                category = 'all';
                reset();
              "
            >
              {{ t('mvp.search_all') }}
            </button>
          </div>
          <button
            v-for="(v, i) in rows"
            v-else
            :id="'mc-option-' + i"
            :key="v.id"
            role="option"
            :aria-selected="modelValue === v.id"
            :data-active="active === i"
            class="version-picker-option"
            @pointermove="active = i"
            @click="choose(v.id)"
          >
            <span
              ><strong>{{ v.id }}</strong
              ><small>{{ t(versionCategories.find((c) => c.value === versionCategory(v))?.label ?? '') }}</small></span
            ><time>{{ v.releaseTime.slice(0, 10) }}</time
            ><b>{{ v.id === modelValue ? '✓' : '' }}</b>
          </button>
        </div>
        <form v-if="manual" class="version-picker-manual" @submit.prevent="choose(manualValue.trim())">
          <input v-model="manualValue" class="input" :placeholder="t('mvp.full_version')" :aria-label="t('mvp.manual_aria')" /><button
            class="btn btn-gold"
            :disabled="!manualValue.trim()"
          >
            {{ t('mvp.select') }}
          </button>
        </form>
        <footer>
          {{ t('mvp.selected_prefix') }}{{ modelValue || t('mvp.none_selected') }} · {{ rows.length }} {{ t('mvp.results_count') }}
        </footer>
      </section></Transition
    ></Teleport
  >
</template>
<style scoped>
.version-picker-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  text-align: left;
  cursor: pointer;
  width: 100%;
  gap: 12px;
}
.version-picker-popup {
  position: fixed;
  z-index: 12000;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background: var(--card-solid);
  color: var(--text);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  max-height: calc(100vh - 24px);
}
.version-picker-top {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.version-picker-top input {
  width: 100%;
}
.version-categories {
  display: flex;
  gap: 4px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.version-categories button {
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  padding: 6px 8px;
  cursor: pointer;
}
.version-categories button.active {
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 600;
}
.version-picker-list {
  overflow: auto;
  overscroll-behavior: contain;
  min-height: 0;
  flex: 1;
  padding: 6px;
}
.version-picker-option {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 52px;
  flex-shrink: 0;
  gap: 12px;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.version-picker-option[data-active='true'] {
  background: var(--hover);
}
.version-picker-option[aria-selected='true'] {
  background: var(--accent-soft);
}
.version-picker-option > span {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.version-picker-option small,
.version-picker-option time {
  font-size: 11px;
  color: var(--text-dim);
}
.version-picker-option b {
  width: 12px;
  color: var(--accent);
}
.version-picker-message {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--text-dim);
}
footer {
  flex-shrink: 0;
  padding: 9px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
}
.version-picker-manual {
  display: flex;
  gap: 8px;
  padding: 10px;
}
</style>
