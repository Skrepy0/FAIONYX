<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import { store, exitEditMode, toast, type ViewName } from '../store';
import { t } from '@renderer/i18n';
import {
  beginDesign,
  finishDesign,
  flushDesign,
  designDraft,
  designDirty,
  designSaveState,
  designRecovered,
  designStageReady,
  previewAppearance,
  currentDesign,
  designTargets,
  designSelected,
  designSelection,
  selectedDesign,
  designScope,
  changeComponent,
  checkpoint,
  resetComponent,
  resetPage,
  undoDesign,
  designHistory,
  designFuture,
  reorderComponent,
  type DesignTarget,
} from '../visualDesign';
import { snapped, type ComponentDesign } from '@shared/visualDesign';
import { DEFAULT_CUSTOM_THEME, DEFAULT_HOME_LAYOUT, DEFAULT_BACKGROUND, DEFAULT_LAUNCH_THUMBNAIL } from '@shared/types';
import { copyText } from '../api';
const PAGE_LABELS: Record<ViewName, string> = {
  home: 'edit.page_home',
  game: 'edit.page_game',
  mods: 'edit.page_mods',
  packs: 'edit.page_packs',
  shaders: 'edit.page_shaders',
  keys: 'edit.page_keys',
  skins: 'edit.page_skins',
  community: 'edit.page_community',
  servers: 'edit.page_servers',
  friends: 'edit.page_friends',
  settings: 'edit.page_settings',
  accounts: 'edit.page_accounts',
  bridge: 'edit.page_bridge',
};
const pages: { value: ViewName; label: string }[] = [
  { value: 'home', label: t('edit.page_home') },
  { value: 'game', label: t('edit.page_game') },
  { value: 'mods', label: t('edit.page_mods') },
  { value: 'packs', label: t('edit.page_packs') },
  { value: 'shaders', label: t('edit.page_shaders') },
  { value: 'keys', label: t('edit.page_keys') },
  { value: 'skins', label: t('edit.page_skins') },
  { value: 'community', label: t('edit.page_community') },
  { value: 'servers', label: t('edit.page_servers') },
  { value: 'friends', label: t('edit.page_friends') },
  { value: 'settings', label: t('edit.page_settings') },
  { value: 'accounts', label: t('edit.page_accounts') },
  { value: 'bridge', label: t('edit.page_bridge') },
];
const filter = ref(''),
  folded = ref(new Set<string>()),
  tab = ref('layout'),
  mobileTab = ref('properties'),
  snap = ref(true),
  browse = ref(false),
  zoom = ref('fit'),
  scale = ref(1),
  viewport = ref<HTMLElement>(),
  exitOpen = ref(false),
  busy = ref(false),
  themeOpen = ref(false),
  code = ref('');
const logical = reactive({
    width: window.innerWidth,
    height: window.innerHeight,
  }),
  box = ref({ x: 0, y: 0, width: 0, height: 0 }),
  insertion = ref<{ x: number; y: number; width: number; height: number }>(),
  guideX = ref<number>(),
  guideY = ref<number>();
const baseLayers = computed(() => designTargets.value.filter((t) => !t.decoration));
const layers = computed(() =>
  baseLayers.value.filter((t) => {
    if (filter.value) return t.label.toLowerCase().includes(filter.value.toLowerCase());
    let p = t.parentKey;
    while (p) {
      if (folded.value.has(p)) return false;
      p = designTargets.value.find((x) => x.key === p)?.parentKey;
    }
    return true;
  })
);
const parent = computed(() => designTargets.value.find((t) => t.key === designSelected.value?.parentKey));
const ancestors = computed(() => {
  const out: DesignTarget[] = [];
  let p = parent.value;
  while (p) {
    out.unshift(p);
    p = designTargets.value.find((t) => t.key === p!.parentKey);
  }
  return out.slice(-3);
});
const free = computed(() => selectedDesign.value.mode === 'free');
const fields = computed(() =>
  tab.value === 'layout'
    ? [
        ...(free.value
          ? [
              {
                key: 'x',
                label: t('edit.x'),
                unit: 'px',
                min: -10000,
                max: 10000,
              },
              {
                key: 'y',
                label: t('edit.y'),
                unit: 'px',
                min: -10000,
                max: 10000,
              },
            ]
          : []),
        { key: 'width', label: t('edit.width'), unit: 'px', min: 8, max: 10000 },
        { key: 'height', label: t('edit.height'), unit: 'px', min: 8, max: 10000 },
        ...(designSelected.value?.container
          ? [
              { key: 'gap', label: t('edit.gap'), unit: 'px', min: 0, max: 200 },
              {
                key: 'padding',
                label: t('edit.padding'),
                unit: 'px',
                min: 0,
                max: 200,
              },
            ]
          : []),
      ]
    : tab.value === 'appearance'
      ? [
          { key: 'opacity', label: t('edit.opacity'), unit: '%', min: 0, max: 100 },
          { key: 'radius', label: t('edit.radius'), unit: 'px', min: 0, max: 300 },
          { key: 'blur', label: t('edit.blur'), unit: 'px', min: 0, max: 80 },
        ]
      : [
          { key: 'fontSize', label: t('edit.font_size'), unit: 'px', min: 6, max: 200 },
          { key: 'fontWeight', label: t('edit.font_weight'), unit: '', min: 100, max: 900 },
        ]
);
function rgba(key: 'color' | 'background') {
  const el = designSelected.value?.element,
    raw = selectedDesign.value[key] || (el ? getComputedStyle(el)[key === 'color' ? 'color' : 'backgroundColor'] : '');
  if (raw.startsWith('#')) {
    let hex = raw.slice(1);
    if (hex.length === 3 || hex.length === 4)
      hex = hex
        .split('')
        .map((x) => x + x)
        .join('');
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1,
    ];
  }
  const nums = raw.match(/[\d.]+/g)?.map(Number);
  return nums?.length ? [...nums.slice(0, 3), nums[3] ?? 1] : [255, 255, 255, raw === 'transparent' ? 0 : 1];
}
function colorHex(key: 'color' | 'background') {
  return (
    '#' +
    rgba(key)
      .slice(0, 3)
      .map((x) => Math.round(x).toString(16).padStart(2, '0'))
      .join('')
  );
}
function setColor(key: 'color' | 'background', value: string) {
  const alpha = rgba(key)[3];
  changeComponent(
    {
      [key]:
        value +
        Math.round(alpha * 255)
          .toString(16)
          .padStart(2, '0'),
    },
    false
  );
}
function setAlpha(key: 'color' | 'background', value: string) {
  const [r, g, b] = rgba(key);
  changeComponent({ [key]: 'rgba(' + [r, g, b, Number(value) / 100].join(',') + ')' }, false);
}
function value(key: string) {
  const n = selectedDesign.value[key as keyof ComponentDesign];
  return typeof n === 'number' ? Math.round(n * (key === 'opacity' ? 100 : 1) * 100) / 100 : '';
}
function numeric(key: string, e: Event) {
  const raw = (e.target as HTMLInputElement).value;
  changeComponent({
    [key]: raw === '' ? undefined : Number(raw) / (key === 'opacity' ? 100 : 1),
  });
}
function select(t: DesignTarget) {
  designSelection.value = t.scope + '|' + t.key;
  mobileTab.value = 'properties';
}
function fold(t: DesignTarget) {
  const s = new Set(folded.value);
  s.has(t.key) ? s.delete(t.key) : s.add(t.key);
  folded.value = s;
}
function style(t: DesignTarget) {
  return currentDesign.value.pages[t.scope]?.components[t.key] || {};
}
function locked(t: DesignTarget) {
  let p: DesignTarget | undefined = t;
  while (p) {
    if (style(p).locked) return true;
    p = designTargets.value.find((x) => x.key === p!.parentKey);
  }
  return false;
}
function layer(action: string) {
  const n = selectedDesign.value.layer || 0;
  changeComponent({
    layer: action === 'top' ? 99 : action === 'bottom' ? 0 : Math.max(0, Math.min(99, n + (action === 'up' ? 1 : -1))),
  });
}
function align(axis: 'x' | 'y', edge: number) {
  const el = designSelected.value?.element,
    p = el?.parentElement;
  if (!el || !p) return;
  const r = el.getBoundingClientRect(),
    b = p.getBoundingClientRect();
  changeComponent(
    axis === 'x'
      ? {
          x: (selectedDesign.value.x || 0) + (b.left + (b.width - r.width) * edge - r.left) / scale.value,
        }
      : {
          y: (selectedDesign.value.y || 0) + (b.top + (b.height - r.height) * edge - r.top) / scale.value,
        }
  );
}
async function close(action: 'apply' | 'keep' | 'discard') {
  busy.value = true;
  try {
    await finishDesign(action);
    designStageReady.value = false;
    exitEditMode();
  } catch (e) {
    toast(t('edit.save_failed', { error: String(e) }), 'error');
  } finally {
    busy.value = false;
  }
}
function requestClose() {
  if (designDirty.value) exitOpen.value = true;
  else void close('discard');
}
async function exportTheme() {
  try {
    await flushDesign();
    const result = await window.faionyx.invoke('appearance:exportTheme', designDraft.value);
    await copyText(String(result));
    toast(t('edit.theme_copied'), 'success');
  } catch (e) {
    toast(String(e), 'error');
  }
}
async function importTheme() {
  try {
    previewAppearance((await window.faionyx.invoke('appearance:importTheme', code.value, true)) as any);
    themeOpen.value = false;
    code.value = '';
    toast(t('edit.theme_loaded'), 'success');
  } catch (e) {
    toast(String(e), 'error');
  }
}
function defaults() {
  if (confirm(t('edit.confirm_load_defaults')))
    previewAppearance({
      theme: 'transparent',
      custom: structuredClone(DEFAULT_CUSTOM_THEME),
      homeLayout: structuredClone(DEFAULT_HOME_LAYOUT),
      background: structuredClone(DEFAULT_BACKGROUND),
      launchThumbnail: structuredClone(DEFAULT_LAUNCH_THUMBNAIL),
      visualDesign: { version: 1, pages: {} },
    });
}
let raf = 0,
  observer: ResizeObserver | undefined;
function measure() {
  const r = designSelected.value?.element.getBoundingClientRect();
  if (r) box.value = { x: r.x, y: r.y, width: r.width, height: r.height };
  raf = requestAnimationFrame(measure);
}
function resizeWindow() {
  logical.width = window.innerWidth;
  logical.height = window.innerHeight;
  fit();
}
function fit() {
  const r = viewport.value?.getBoundingClientRect();
  if (!r) return;
  scale.value = zoom.value === '100' ? 1 : Math.min(1, (r.width - 40) / logical.width, (r.height - 40) / logical.height);
}
function isTools(e: Event) {
  return !!(e.target as Element)?.closest?.('[data-design-tools]');
}
function navigation(e: Event) {
  return !!(e.target as Element)?.closest?.('.nav-item,.nav-sub-item,.cfg-tabs button,.seg-tabs button,.tabs button,[data-design-nav]');
}
let drag: null | {
    x: number;
    y: number;
    ox: number;
    oy: number;
    width: number;
    height: number;
    resize: boolean;
    left: number;
    top: number;
    changed: boolean;
    target: DesignTarget;
  } = null,
  drop: DesignTarget | undefined,
  dropBefore = true;
function hit(e: MouseEvent | PointerEvent, deep = false) {
  let el = (e.target as Element).closest<HTMLElement>('[data-ui]');
  if (!deep) {
    el = (e.target as Element).closest<HTMLElement>('button,label,.card,article,section,h1,h2,h3,h4,p') || el;
  }
  return designTargets.value.find((t) => t.element === el && !t.decoration);
}
function down(e: PointerEvent, resize = false) {
  if (e.button !== 0 || (!resize && isTools(e))) return;
  if (browse.value) {
    if (!navigation(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    return;
  }
  if (!resize) {
    const t = hit(e);
    if (!t) return;
    select(t);
  }
  const target = designSelected.value;
  if (!target) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (locked(target)) return;
  const r = target.element.getBoundingClientRect();
  drag = {
    x: e.clientX,
    y: e.clientY,
    ox: selectedDesign.value.x || 0,
    oy: selectedDesign.value.y || 0,
    width: r.width / scale.value,
    height: r.height / scale.value,
    resize,
    left: r.left,
    top: r.top,
    changed: false,
    target,
  };
}
function move(e: PointerEvent) {
  if (!drag) return;
  const dx = (e.clientX - drag.x) / scale.value,
    dy = (e.clientY - drag.y) / scale.value;
  if (!drag.changed && Math.abs(dx) + Math.abs(dy) < 4) return;
  if (!drag.resize && !free.value) {
    const candidates = designTargets.value.filter(
      (t) => t !== drag!.target && t.element.parentElement === drag!.target.element.parentElement && !t.decoration
    );
    drop = candidates.find((t) => {
      const r = t.element.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (drop) {
      const r = drop.element.getBoundingClientRect(),
        horizontal = getComputedStyle(drop.element.parentElement!).flexDirection === 'row';
      dropBefore = horizontal ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
      insertion.value = horizontal
        ? {
            x: dropBefore ? r.left : r.right,
            y: r.top,
            width: 3,
            height: r.height,
          }
        : {
            x: r.left,
            y: dropBefore ? r.top : r.bottom,
            width: r.width,
            height: 3,
          };
    } else insertion.value = undefined;
    drag.changed = true;
    return;
  }
  if (!drag.changed) {
    checkpoint();
    drag.changed = true;
  }
  const p = drag.target.element.parentElement!.getBoundingClientRect(),
    s = scale.value;
  if (drag.resize) {
    const w = snapped(drag.width + dx, [], snap.value && !e.altKey),
      h = snapped(drag.height + dy, [], snap.value && !e.altKey);
    changeComponent(
      {
        width: Math.max(8, Math.min(p.width / s, w.value)),
        height: Math.max(8, h.value),
      },
      false
    );
  } else {
    const targets = designTargets.value
      .filter((t) => t.element.parentElement === drag!.target.element.parentElement && t !== drag!.target)
      .map((t) => t.element.getBoundingClientRect());
    const xs = [p.left, p.right - drag.width * s, ...targets.map((r) => r.left)].map((x) => x / s),
      ys = [p.top, p.bottom - drag.height * s, ...targets.map((r) => r.top)].map((y) => y / s);
    const x = snapped(drag.left / s + dx, xs, snap.value && !e.altKey),
      y = snapped(drag.top / s + dy, ys, snap.value && !e.altKey);
    guideX.value = x.guide === undefined ? undefined : x.guide * s;
    guideY.value = y.guide === undefined ? undefined : y.guide * s;
    changeComponent(
      {
        x: drag.ox + (Math.max(p.left / s, Math.min((p.right - drag.width * s) / s, x.value)) - drag.left / s),
        y: drag.oy + (Math.max(p.top / s, Math.min((p.bottom - drag.height * s) / s, y.value)) - drag.top / s),
      },
      false
    );
  }
}
function up() {
  if (drag?.changed && !drag.resize && !free.value && drop) reorderComponent(drop, dropBefore);
  drag = null;
  drop = undefined;
  insertion.value = undefined;
  guideX.value = undefined;
  guideY.value = undefined;
}
function click(e: MouseEvent) {
  if (!isTools(e) && !(browse.value && navigation(e))) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}
function deepSelect(e: MouseEvent) {
  if (isTools(e) || browse.value) return;
  const t = hit(e, true);
  if (t) {
    select(t);
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}
function keys(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (exitOpen.value) {
      exitOpen.value = false;
      return;
    }
    if (themeOpen.value) {
      themeOpen.value = false;
      return;
    }
    if (designSelected.value && parent.value) {
      select(parent.value);
      return;
    }
    requestClose();
    return;
  }
  if (isTools(e)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undoDesign(e.shiftKey);
  }
  if (
    free.value &&
    designSelected.value &&
    !locked(designSelected.value) &&
    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)
  ) {
    e.preventDefault();
    const n = e.shiftKey ? 10 : 1;
    changeComponent({
      x: (selectedDesign.value.x || 0) + (e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0),
      y: (selectedDesign.value.y || 0) + (e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0),
    });
  }
}
onMounted(async () => {
  await beginDesign();
  await nextTick();
  designStageReady.value = true;
  window.addEventListener('resize', resizeWindow);
  observer = new ResizeObserver(fit);
  if (viewport.value) observer.observe(viewport.value);
  fit();
  raf = requestAnimationFrame(measure);
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('click', click, true);
  document.addEventListener('dblclick', deepSelect, true);
  document.addEventListener('keydown', keys, true);
});
onUnmounted(() => {
  designStageReady.value = false;
  window.removeEventListener('resize', resizeWindow);
  observer?.disconnect();
  cancelAnimationFrame(raf);
  document.removeEventListener('pointerdown', down, true);
  document.removeEventListener('pointermove', move, true);
  document.removeEventListener('pointerup', up, true);
  document.removeEventListener('click', click, true);
  document.removeEventListener('dblclick', deepSelect, true);
  document.removeEventListener('keydown', keys, true);
});
</script>
<template>
  <Teleport to="body"
    ><div class="design-workspace">
      <header class="designer-toolbar" data-design-tools>
        <div>
          <strong>{{ t('edit.title') }}</strong
          ><small>{{ designSaveState || t('edit.preview_only') }}</small>
        </div>
        <button :class="{ active: !browse }" @click="browse = !browse">
          {{ browse ? t('edit.browse_nav') : t('edit.select_component') }}</button
        ><label class="toolbar-check">
          <input v-model="snap" type="checkbox" />
          <span>{{ t('edit.snap') }}</span> </label
        ><button :disabled="!designHistory.length" @click="undoDesign()">{{ t('edit.undo') }}</button
        ><button :disabled="!designFuture.length" @click="undoDesign(true)">{{ t('edit.redo') }}</button
        ><select v-model="zoom" :aria-label="t('edit.zoom')" @change="fit">
          <option value="fit">{{ t('edit.zoom_fit') }}</option>
          <option value="100">100%</option></select
        ><button @click="themeOpen = true">{{ t('edit.theme_and_restore') }}</button><span class="spacer" /><button
          :disabled="busy"
          @click="requestClose"
        >
          {{ t('edit.exit') }}</button
        ><button class="primary" :disabled="busy" @click="close('apply')">{{ t('edit.apply_appearance') }}</button>
      </header>
      <aside class="designer-layers-panel" :class="{ mobile: mobileTab === 'layers' }" data-design-tools>
        <div class="mobile-tabs">
          <button @click="mobileTab = 'layers'">{{ t('edit.layers') }}</button
          ><button @click="mobileTab = 'properties'">{{ t('edit.properties') }}</button>
        </div>
        <div class="side-head">
          <strong>{{ t('edit.pages_and_layers') }}</strong
          ><select v-model="store.currentView" :aria-label="t('edit.edit_page')">
            <option v-for="p in pages" :value="p.value">
              {{ p.label }}
            </option></select
          ><input v-model="filter" :placeholder="t('edit.search_component')" :aria-label="t('edit.search_layers')" />
        </div>
        <div class="designer-layers">
          <div
            v-for="t in layers"
            :key="t.scope + t.key"
            class="layer-row"
            :class="{ active: designSelection === t.scope + '|' + t.key }"
            :style="{ paddingLeft: Math.min(4, t.depth - 1) * 12 + 'px' }"
          >
            <button class="fold" :aria-label="t('edit.expand_fold', { label: t })" @click="fold(t)">
              {{ baseLayers.some((x) => x.parentKey === t.key) ? (folded.has(t.key) ? '›' : '⌄') : '·' }}</button
            ><button class="layer-label" :title="t.label" @click="select(t)">
              {{ t.label }}</button
            ><span :title="style(t).locked ? t('edit.locked') : style(t).hidden ? t('edit.hidden') : ''">{{
              style(t).locked ? '▣' : style(t).hidden ? '○' : ''
            }}</span>
          </div>
        </div>
        <small class="side-foot">{{ t('edit.select_hint') }}<br />{{ t('edit.lock_hint') }}</small>
      </aside>
      <main ref="viewport" class="designer-viewport">
        <div class="preview-scroll">
          <div
            class="preview-size"
            :style="{
              width: logical.width * scale + 'px',
              height: logical.height * scale + 'px',
            }"
          >
            <div
              id="design-preview-host"
              :style="{
                width: logical.width + 'px',
                height: logical.height + 'px',
                transform: 'scale(' + scale + ')',
              }"
            ></div>
          </div>
        </div>
        <span class="canvas-caption" data-design-tools>{{ logical.width }} × {{ logical.height }} · {{ Math.round(scale * 100) }}%</span>
      </main>
      <aside class="designer-panel" :class="{ mobile: mobileTab === 'properties' }" data-design-tools>
        <div class="mobile-tabs">
          <button @click="mobileTab = 'layers'">{{ t('edit.layers') }}</button
          ><button @click="mobileTab = 'properties'">{{ t('edit.properties') }}</button>
        </div>
        <div class="property-scroll">
          <p v-if="designRecovered" class="notice">{{ t('edit.draft_recovered') }}</p>
          <template v-if="designSelected"
            ><nav class="breadcrumbs">
              <button v-for="t in ancestors" @click="select(t)">
                {{ t.label }}
              </button>
            </nav>
            <h3>{{ designSelected.label }}</h3>
            <div class="actions">
              <label
                ><input
                  type="checkbox"
                  :checked="selectedDesign.hidden"
                  @change="
                    changeComponent({
                      hidden: ($event.target as HTMLInputElement).checked,
                    })
                  "
                />{{ t('edit.hide') }}</label
              ><label
                ><input
                  type="checkbox"
                  :checked="selectedDesign.locked"
                  @change="
                    changeComponent({
                      locked: ($event.target as HTMLInputElement).checked,
                    })
                  "
                />{{ t('edit.lock') }}</label
              ><button @click="resetComponent">{{ t('edit.reset_component') }}</button>
            </div>
            <div class="property-tabs">
              <button
                v-for="(label, key) in {
                  layout: t('edit.tab_layout'),
                  appearance: t('edit.tab_appearance'),
                  text: t('edit.tab_text'),
                }"
                :class="{ active: tab === key }"
                :disabled="key === 'text' && !designSelected.text"
                @click="tab = key"
              >
                {{ label }}
              </button>
            </div>
            <fieldset :disabled="locked(designSelected)">
              <template v-if="tab === 'layout'"
                ><label class="field"
                  >{{ t('edit.mode')
                  }}<select
                    :value="selectedDesign.mode || 'flow'"
                    @change="
                      changeComponent({
                        mode: ($event.target as HTMLSelectElement).value as any,
                        x: undefined,
                        y: undefined,
                      })
                    "
                  >
                    <option value="flow">{{ t('edit.mode_flow') }}</option>
                    <option value="free">{{ t('edit.mode_free') }}</option>
                  </select></label
                >
                <p class="help">
                  {{
                    free ? t('edit.mode_free_hint') : designSelected.sortable ? t('edit.mode_flow_hint') : t('edit.mode_unsupported_hint')
                  }}
                </p></template
              >
              <div class="designer-grid">
                <label v-for="f in fields" :key="f.key" class="field"
                  ><span
                    >{{ f.label }} <small>{{ f.unit }}</small
                    ><button
                      class="reset"
                      :aria-label="t('edit.reset') + ' ' + f.label"
                      @click.prevent="changeComponent({ [f.key]: undefined })"
                    >
                      ↺
                    </button></span
                  ><input
                    type="number"
                    :aria-label="f.label"
                    :min="f.min"
                    :max="f.max"
                    :step="f.key === 'fontWeight' ? 100 : 1"
                    :value="value(f.key)"
                    :placeholder="t('edit.auto')"
                    @change="numeric(f.key, $event)"
                /></label>
              </div>
              <template v-if="tab === 'layout' && free"
                ><h4>{{ t('edit.align_container') }}</h4>
                <div class="actions">
                  <button @click="align('x', 0)">{{ t('edit.align_left') }}</button
                  ><button @click="align('x', 0.5)">{{ t('edit.align_center_h') }}</button
                  ><button @click="align('x', 1)">{{ t('edit.align_right') }}</button
                  ><button @click="align('y', 0)">{{ t('edit.align_top') }}</button
                  ><button @click="align('y', 0.5)">{{ t('edit.align_center_v') }}</button
                  ><button @click="align('y', 1)">{{ t('edit.align_bottom') }}</button>
                </div>
                <h4>{{ t('edit.layer_order') }}</h4>
                <div class="actions">
                  <button @click="layer('top')">{{ t('edit.layer_top') }}</button
                  ><button @click="layer('up')">{{ t('edit.layer_up') }}</button
                  ><button @click="layer('down')">{{ t('edit.layer_down') }}</button
                  ><button @click="layer('bottom')">{{ t('edit.layer_bottom') }}</button>
                </div></template
              >
              <template v-if="tab === 'appearance'"
                ><label
                  v-for="(label, key) in {
                    color: t('edit.color_text'),
                    background: t('edit.color_background'),
                  }"
                  class="field"
                  >{{ label }}
                  <div class="color-row">
                    <input
                      type="color"
                      :aria-label="label"
                      :value="colorHex(key)"
                      @focus="checkpoint"
                      @input="setColor(key, ($event.target as HTMLInputElement).value)"
                    /><input
                      :aria-label="label + ' ' + t('edit.color_value_label')"
                      :value="selectedDesign[key]"
                      :placeholder="t('edit.color_placeholder')"
                      @change="
                        changeComponent({
                          [key]: ($event.target as HTMLInputElement).value,
                        })
                      "
                    /><button :aria-label="t('edit.reset') + ' ' + label" @click="changeComponent({ [key]: undefined })">↺</button>
                  </div>
                  <div class="alpha-row">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      :aria-label="label + ' ' + t('edit.alpha')"
                      :style="{ '--fill': Math.round(rgba(key)[3] * 100) + '%' }"
                      :value="Math.round(rgba(key)[3] * 100)"
                      @focus="checkpoint"
                      @input="setAlpha(key, ($event.target as HTMLInputElement).value)"
                    /><small>{{ Math.round(rgba(key)[3] * 100) }}%</small>
                  </div></label
                ></template
              >
              <template v-if="tab === 'text'"
                ><label class="field"
                  >{{ t('edit.display_text')
                  }}<textarea
                    :value="selectedDesign.text"
                    :aria-label="t('edit.display_text')"
                    :placeholder="t('edit.display_text_placeholder')"
                    @change="
                      changeComponent({
                        text: ($event.target as HTMLTextAreaElement).value,
                      })
                    "
                  /><button @click="changeComponent({ text: undefined })">{{ t('edit.restore_text') }}</button></label
                ><label class="field"
                  >{{ t('edit.font')
                  }}<input
                    :value="selectedDesign.fontFamily"
                    :aria-label="t('edit.font')"
                    :placeholder="t('edit.font_placeholder')"
                    @change="
                      changeComponent({
                        fontFamily: ($event.target as HTMLInputElement).value,
                      })
                    "
                  /><button @click="changeComponent({ fontFamily: undefined })">{{ t('edit.restore_font') }}</button></label
                ></template
              >
            </fieldset></template
          >
          <div v-else class="property-empty">
            <h3>{{ t('edit.empty_title') }}</h3>
            <p>{{ t('edit.empty_p1') }}</p>
            <p>{{ t('edit.empty_p2') }}</p>
          </div>
        </div>
      </aside>
      <div
        v-if="designSelected && !browse"
        class="designer-outline"
        :style="{
          left: box.x + 'px',
          top: box.y + 'px',
          width: box.width + 'px',
          height: box.height + 'px',
        }"
        data-design-tools
      >
        <span>{{ Math.round(box.width / scale) }} × {{ Math.round(box.height / scale) }}</span
        ><button v-if="!locked(designSelected)" :aria-label="t('edit.drag_resize')" @pointerdown.stop="down($event, true)" />
      </div>
      <div
        v-if="insertion"
        class="insertion"
        :style="{
          left: insertion.x + 'px',
          top: insertion.y + 'px',
          width: insertion.width + 'px',
          height: insertion.height + 'px',
        }"
        data-design-tools
      />
      <div v-if="guideX !== undefined" class="guide vertical" :style="{ left: guideX + 'px' }" data-design-tools />
      <div v-if="guideY !== undefined" class="guide horizontal" :style="{ top: guideY + 'px' }" data-design-tools />
      <div v-if="exitOpen || themeOpen" class="designer-dialog-mask" data-design-tools>
        <section class="designer-dialog" role="dialog" aria-modal="true">
          <template v-if="exitOpen"
            ><h2>{{ t('edit.exit_title') }}</h2>
            <p>{{ t('edit.exit_desc') }}</p>
            <div class="actions">
              <button :disabled="busy" @click="close('discard')">{{ t('edit.discard') }}</button
              ><button :disabled="busy" @click="close('keep')">{{ t('edit.keep_draft') }}</button
              ><button class="primary" :disabled="busy" @click="close('apply')">{{ t('edit.apply_and_exit') }}</button
              ><button @click="exitOpen = false">{{ t('edit.continue_edit') }}</button>
            </div></template
          ><template v-else
            ><h2>{{ t('edit.theme_title') }}</h2>
            <p>{{ t('edit.theme_desc') }}</p>
            <div class="actions">
              <button @click="exportTheme">{{ t('edit.copy_theme_code') }}</button
              ><button @click="resetPage()">{{ t('edit.reset_page') }}</button
              ><button @click="resetPage(true)">{{ t('edit.reset_all') }}</button
              ><button @click="defaults">{{ t('edit.restore_defaults') }}</button>
            </div>
            <textarea v-model="code" :aria-label="t('edit.theme_code_label')" :placeholder="t('edit.theme_code_placeholder')" />
            <div class="actions">
              <button class="primary" :disabled="!code.trim()" @click="importTheme">{{ t('edit.import_to_draft') }}</button
              ><button @click="themeOpen = false">{{ t('edit.back_to_edit') }}</button>
            </div></template
          >
        </section>
      </div>
    </div></Teleport
  >
</template>
<style scoped>
.design-workspace {
  position: fixed;
  inset: 0;
  z-index: 100000;
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr) 310px;
  grid-template-rows: 66px minmax(0, 1fr);
  background: var(--card-solid, #202830);
  color: var(--text);
  font:
    13px/1.5 'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
  isolation: isolate;
}
.designer-toolbar {
  grid-column: 1/-1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  z-index: 4;
  background: var(--card-solid);
}
.designer-toolbar > div {
  display: flex;
  flex-direction: column;
  margin-right: 12px;
}
.designer-toolbar small,
.help,
.side-foot,
.canvas-caption {
  color: var(--text-dim);
  font-size: 11px;
}
.spacer {
  flex: 1;
}
.designer-layers-panel,
.designer-panel {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--card-solid);
  z-index: 3;
}
.designer-layers-panel {
  border-right: 1px solid var(--border);
}
.designer-panel {
  border-left: 1px solid var(--border);
}
.side-head {
  padding: 16px;
  display: grid;
  gap: 12px;
  flex-shrink: 0;
}
.designer-layers {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 8px;
}
.layer-row {
  display: flex;
  align-items: center;
  min-height: 36px;
  flex-shrink: 0;
  border-radius: 7px;
  gap: 3px;
}
.layer-row.active,
.active {
  background: var(--accent-soft) !important;
  color: var(--text) !important;
}
.layer-row .fold {
  width: 24px;
  flex-shrink: 0;
  padding: 4px;
  border: 0;
  background: transparent;
}
.layer-row .layer-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  border: 0;
  background: transparent;
}
.side-foot {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.designer-viewport {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: color-mix(in srgb, var(--bg) 84%, #697687);
  background-image: radial-gradient(#88929d35 1px, transparent 1px);
  background-size: 16px 16px;
}
.preview-scroll {
  position: absolute;
  inset: 0;
  overflow: auto;
  padding: 20px;
  box-sizing: border-box;
}
.preview-size {
  margin: auto;
  position: relative;
  box-shadow: 0 8px 32px #0003;
}
.toolbar-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.toolbar-check input[type='checkbox'] {
  margin: 0;
  accent-color: var(--accent);
  flex-shrink: 0;
}
#design-preview-host {
  transform-origin: top left;
  position: relative;
  overflow: hidden;
  isolation: isolate;
}
.canvas-caption {
  position: absolute;
  bottom: 4px;
  left: 12px;
  pointer-events: none;
}
.property-scroll {
  padding: 16px;
  overflow: auto;
  min-height: 0;
  flex: 1;
}
.breadcrumbs {
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
}
.breadcrumbs button {
  font-size: 10px;
  max-width: 130px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.designer-panel h3 {
  font-size: 15px;
  overflow-wrap: anywhere;
  margin: 12px 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin: 12px 0;
}
.actions label {
  display: flex;
  align-items: center;
  gap: 4px;
}
.property-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
  margin-bottom: 14px;
  gap: 6px;
}
.property-tabs button {
  flex: 1;
}
.designer-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
  min-width: 0;
}
.field > span {
  display: flex;
  align-items: center;
  gap: 5px;
}
.reset {
  margin-left: auto;
  border: 0 !important;
  padding: 0 4px !important;
  background: transparent !important;
}

/* ---------- 透明度滑块行 ---------- */

.alpha-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.alpha-row input[type='range'] {
  flex: 1;
  min-width: 0;
}
.alpha-row small {
  min-width: 34px;
}

/* ---------- Range 滑块：脱离通用 input 样式，自绘 ---------- */

.design-workspace input[type='range'] {
  -webkit-appearance: none;
  appearance: none;
  box-sizing: border-box;
  width: 100%;
  height: 18px;
  margin: 0;
  padding: 0;
  border: 0; /* 覆盖通用 input 的边框 */
  border-radius: 0;
  background: transparent; /* 覆盖通用 input 的背景块 */
  cursor: pointer;
  /* 已填充百分比；未设置时退化为整条灰轨，不影响其它场景 */
  --fill: 0%;
}
.design-workspace input[type='range']::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(
    to right,
    var(--accent) 0,
    var(--accent) var(--fill),
    color-mix(in srgb, var(--text) 14%, transparent) var(--fill),
    color-mix(in srgb, var(--text) 14%, transparent) 100%
  );
}
.design-workspace input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -5px; /* (4 - 14) / 2，thumb 与轨道居中对齐 */
  border: 2px solid var(--accent);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.35);
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
}
.design-workspace input[type='range']::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--text) 14%, transparent);
}
.design-workspace input[type='range']::-moz-range-progress {
  height: 4px;
  border-radius: 2px;
  background: var(--accent);
}
.design-workspace input[type='range']::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 2px solid var(--accent);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.35);
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
}
.design-workspace input[type='range']:hover::-webkit-slider-thumb,
.design-workspace input[type='range']:focus-visible::-webkit-slider-thumb {
  transform: scale(1.15);
}
.design-workspace input[type='range']:hover::-moz-range-thumb,
.design-workspace input[type='range']:focus-visible::-moz-range-thumb {
  transform: scale(1.15);
}
.design-workspace input[type='range']:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
  border-radius: 4px;
}
.design-workspace fieldset:disabled input[type='range']::-webkit-slider-thumb {
  border-color: var(--border);
  box-shadow: none;
}

/* ---------- 颜色选择器行 ---------- */

.color-row {
  display: flex;
  gap: 5px;
  align-items: center;
}
.color-row input[type='color'] {
  width: 32px;
  min-width: 32px;
  height: 32px;
  padding: 2px;
  border-radius: 8px;
  background: var(--card-2);
  cursor: pointer;
}
.color-row input[type='color']::-webkit-color-swatch-wrapper {
  padding: 0;
}
.color-row input[type='color']::-webkit-color-swatch {
  border: 0;
  border-radius: 5px;
}
.color-row input[type='color']::-moz-color-swatch {
  border: 0;
  border-radius: 5px;
}
.color-row input:not([type='color']) {
  flex: 1;
  min-width: 0;
}

/* ---------- 通用控件样式（range / color 已在上面覆盖） ---------- */

.design-workspace button,
.design-workspace input,
.design-workspace select,
.design-workspace textarea {
  box-sizing: border-box;
  font: inherit;
  color: inherit;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card-2);
  padding: 7px 9px;
  min-width: 0;
}
.design-workspace button {
  cursor: pointer;
  white-space: nowrap;
}
.design-workspace button:hover:not(:disabled) {
  border-color: var(--accent);
}
.design-workspace button:disabled,
.design-workspace fieldset:disabled {
  opacity: 0.5;
  cursor: default;
}
.design-workspace input[type='checkbox'] {
  accent-color: var(--accent);
}
.design-workspace .primary {
  background: var(--accent);
  color: var(--on-accent);
  border-color: transparent;
  font-weight: 600;
}
.design-workspace textarea {
  width: 100%;
  min-height: 95px;
  resize: vertical;
}
.design-workspace fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.property-empty {
  color: var(--text-dim);
  padding: 30px 4px;
}
.notice {
  padding: 8px;
  border-radius: 8px;
  background: var(--accent-soft);
}
.designer-outline {
  position: fixed;
  z-index: 2;
  pointer-events: none;
  border: 2px solid var(--accent);
  box-sizing: border-box;
}
.designer-outline span {
  position: absolute;
  top: -22px;
  left: 0;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 10px;
  padding: 1px 5px;
}
.designer-outline button {
  pointer-events: auto;
  position: absolute;
  bottom: -6px;
  right: -6px;
  width: 12px;
  height: 12px;
  padding: 0;
  background: var(--accent);
  border: 2px solid white;
  cursor: nwse-resize;
}
.insertion,
.guide {
  position: fixed;
  background: var(--accent);
  pointer-events: none;
  z-index: 2;
}
.vertical {
  width: 1px;
  top: 66px;
  bottom: 0;
}
.horizontal {
  height: 1px;
  left: 230px;
  right: 310px;
}
.designer-dialog-mask {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--mask);
  backdrop-filter: blur(8px);
  z-index: 10;
}
.designer-dialog {
  width: min(570px, calc(100vw - 48px));
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: var(--card-solid);
  box-shadow: var(--shadow-lg);
}
.mobile-tabs {
  display: none;
}
@media (max-width: 1150px) {
  .design-workspace {
    grid-template-columns: minmax(0, 1fr) 290px;
  }
  .designer-layers-panel {
    display: none;
  }
  .designer-layers-panel.mobile {
    display: flex;
    grid-column: 2;
    grid-row: 2;
  }
  .designer-viewport {
    grid-column: 1;
    grid-row: 2;
  }
  .designer-panel {
    grid-column: 2;
    grid-row: 2;
  }
  .designer-layers-panel.mobile ~ .designer-panel:not(.mobile) {
    display: none;
  }
  .mobile-tabs {
    display: flex;
    gap: 8px;
    padding: 10px;
  }
  .designer-toolbar {
    gap: 10px;
    padding: 8px;
  }
  .designer-toolbar > div small {
    display: none;
  }
  .designer-toolbar strong {
    font-size: 12px;
  }
  .designer-toolbar button,
  .designer-toolbar select {
    font-size: 11px;
    padding: 6px;
  }
  .horizontal {
    left: 0;
    right: 290px;
  }
}
@media (prefers-reduced-motion: reduce) {
  * {
    scroll-behavior: auto !important;
  }
}
</style>
