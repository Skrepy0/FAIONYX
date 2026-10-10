<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import SkinViewer3D from './SkinViewer3D.vue';
import SkinColorPalette from './SkinColorPalette.vue';
import UiGlyph from './UiGlyph.vue';
import { loadImage, migrateLegacySkin } from '../skin-render';
import { makeBaseOpaque, paintSkinPixel, type SkinFace } from '@shared/skinPixels';
import { parseSkinHex, rememberSkinColor, rgbToSkinHex, sampleSkinBrush, skinBrushIsInvisible, skinBrushRgba } from '@shared/skinColors';
import { normalizeSkinPalettePreferences } from '@shared/skinPalettePreferences';
import type { SkinEditorPaletteSettings } from '@shared/types';
import { store, toast } from '../store';
import { errText, saveSettings } from '../api';
import { refreshSkinAfter } from '../skinRevision';
import { mergeSkinCloseIntent, type SkinCloseIntent } from '../skinEditorInteraction';
import { t } from '@renderer/i18n';
const props = defineProps<{ current?: string; variant?: 'classic' | 'slim' }>();
const emit = defineEmits<{ close: []; uploaded: [] }>();
const canvas = shallowRef(document.createElement('canvas'));
canvas.value.width = canvas.value.height = 64;
const ctx = canvas.value.getContext('2d', { willReadFrequently: true })!;
const blank = ctx.createImageData(64, 64);
makeBaseOpaque(blank.data);
for (let i = 0; i < blank.data.length; i += 4) if (blank.data[i + 3] === 255) blank.data[i] = blank.data[i + 1] = blank.data[i + 2] = 220;
ctx.putImageData(blank, 0, 0);
const viewer = ref<InstanceType<typeof SkinViewer3D>>(),
  closeButton = ref<HTMLButtonElement>(),
  fileInput = ref<HTMLInputElement>();
const variant = ref(props.variant || 'classic'),
  layer = ref<'inner' | 'outer'>('inner');
const palettePreferences = ref(normalizeSkinPalettePreferences(store.settings?.skinEditorPalette));
const color = computed({
  get: () => palettePreferences.value.color,
  set: (value) => {
    const rgb = parseSkinHex(value);
    if (rgb) palettePreferences.value.color = rgbToSkinHex(rgb);
  },
});
const alpha = computed({
  get: () => palettePreferences.value.alpha,
  set: (value) => {
    if (Number.isFinite(value)) palettePreferences.value.alpha = Math.max(0, Math.min(1, value));
  },
});
const tool = ref('brush'),
  revision = ref(0),
  dirty = ref(false),
  busy = ref(false),
  busyText = ref(''),
  finishingClose = ref(false),
  askClose = ref(false),
  uploadConfirm = ref(false);
const sampleHint = ref('');
const invisibleBrush = computed(() => ['brush', 'fill'].includes(tool.value) && skinBrushIsInvisible(alpha.value, layer.value === 'outer'));
const operationError = ref('');
const hiddenParts = ref<string[]>([]),
  undo = ref<Uint8ClampedArray[]>([]),
  redo = ref<Uint8ClampedArray[]>([]);
type CloseIntent = SkinCloseIntent<typeof store.currentView>;
const closeIntent = shallowRef<CloseIntent>();
const blocked = computed(() => busy.value || finishingClose.value || askClose.value || uploadConfirm.value);
const ownerId = crypto.randomUUID();
let disposed = false,
  paletteTimer: ReturnType<typeof setTimeout> | undefined,
  pendingPalette: SkinEditorPaletteSettings | undefined,
  paletteWrite: Promise<void> | undefined;
function flushPalette(): Promise<void> {
  if (paletteWrite) return paletteWrite;
  paletteWrite = (async () => {
    while (pendingPalette) {
      const next = pendingPalette;
      pendingPalette = undefined;
      try {
        await saveSettings({ skinEditorPalette: next });
      } catch (error) {
        toast(t('se.palette_save_failed', { error: errText(error) }), 'error');
      }
    }
  })().finally(() => {
    paletteWrite = undefined;
    window.faionyx.send('window:skinEditorPrefsPending', { ownerId, pending: !!pendingPalette });
  });
  return paletteWrite;
}
watch(
  palettePreferences,
  (value) => {
    pendingPalette = normalizeSkinPalettePreferences(value);
    window.faionyx.send('window:skinEditorPrefsPending', { ownerId, pending: true });
    if (store.settings) store.settings.skinEditorPalette = pendingPalette;
    clearTimeout(paletteTimer);
    paletteTimer = setTimeout(() => void flushPalette(), 350);
  },
  { deep: true, flush: 'sync' }
);
watch(busy, (pending) => window.faionyx.send('window:skinEditorBusy', { ownerId, pending }), { flush: 'sync' });
const parts = [
  { key: 'head', name: t('se.part_head') },
  { key: 'body', name: t('se.part_body') },
  { key: 'leftArm', name: t('se.part_left_arm') },
  { key: 'rightArm', name: t('se.part_right_arm') },
  { key: 'leftLeg', name: t('se.part_left_leg') },
  { key: 'rightLeg', name: t('se.part_right_leg') },
];
const views = [
  { name: t('se.view_front'), yaw: 0, pitch: 0 },
  { name: t('se.view_back'), yaw: Math.PI, pitch: 0 },
  { name: t('se.view_left'), yaw: Math.PI / 2, pitch: 0 },
  { name: t('se.view_right'), yaw: -Math.PI / 2, pitch: 0 },
  { name: t('se.view_top'), yaw: 0, pitch: (Math.PI * 5) / 12 },
  { name: t('se.view_bottom'), yaw: 0, pitch: (-Math.PI * 5) / 12 },
];
const selectedView = ref('');
const previewExpanded = ref(false),
  studioLight = ref(true);
const contentElement = ref<HTMLElement>(),
  toolRailHeight = ref(300);
let contentResize: ResizeObserver | undefined;
onMounted(() => {
  contentResize = new ResizeObserver(() => {
    const el = contentElement.value;
    if (el) toolRailHeight.value = Math.max(40, el.clientHeight - parseFloat(getComputedStyle(el).paddingBottom || '0'));
  });
  if (contentElement.value) contentResize.observe(contentElement.value);
});
const drawingTools = [
  { key: 'brush', name: t('se.tool_brush'), shortcut: 'B' },
  { key: 'erase', name: t('se.tool_erase'), shortcut: 'E' },
  { key: 'pick', name: t('se.tool_pick'), shortcut: 'I' },
  { key: 'fill', name: t('se.tool_fill'), shortcut: 'G' },
];
function toggleLighting() {
  if (!blocked.value) {
    endGesture();
    studioLight.value = !studioLight.value;
    viewer.value?.setLighting(studioLight.value);
  }
}
function togglePreview() {
  if (!blocked.value) {
    endGesture();
    previewExpanded.value = !previewExpanded.value;
  }
}
const isOffline = computed(() => store.selectedAccount?.type === 'offline');
const canApplySkin = computed(() => isOffline.value || store.selectedAccount?.type === 'microsoft');
const uploadTarget = shallowRef<{ id: string; username: string; type: string; variant: 'classic' | 'slim' }>();
const uploadState = computed(() =>
  isOffline.value
    ? t('se.apply_to_offline')
    : store.selectedAccount?.type === 'microsoft'
      ? t('se.upload_to', { username: store.selectedAccount.username })
      : t('se.select_account')
);
let snapshot: Uint8ClampedArray | undefined, last: { x: number; y: number; key: string } | undefined;
const pixels = () => ctx.getImageData(0, 0, 64, 64);
const canEdit = () => !disposed && !blocked.value;
function changed() {
  revision.value++;
  dirty.value = true;
}
function commit() {
  const current = pixels().data;
  if (snapshot && snapshot.some((v, i) => v !== current[i])) {
    undo.value.push(snapshot);
    if (undo.value.length > 80) undo.value.shift();
    redo.value = [];
    changed();
  }
  snapshot = undefined;
  last = undefined;
}
function endGesture() {
  viewer.value?.finishGesture();
  commit();
}
function stroke(active: boolean) {
  if (!active) {
    commit();
    return;
  }
  if (canEdit()) {
    snapshot = pixels().data;
    last = undefined;
    selectedView.value = '';
  }
}
function paint(x: number, y: number, face: SkinFace) {
  if (!canEdit()) return;
  const image = pixels(),
    i = (y * 64 + x) * 4;
  if (tool.value === 'pick') {
    const sample = sampleSkinBrush(image.data.slice(i, i + 4), layer.value === 'outer');
    if (!sample) {
      sampleHint.value = t('se.transparent_pixel');
      return;
    }
    color.value = sample.color;
    if (layer.value === 'outer') alpha.value = sample.alpha;
    sampleHint.value = '';
    return;
  }
  const before = new Uint8ClampedArray(image.data);
  const value =
    tool.value === 'erase'
      ? layer.value === 'outer'
        ? [0, 0, 0, 0]
        : [255, 255, 255, 255]
      : skinBrushRgba(color.value, alpha.value, layer.value === 'outer');
  if (!value) return;
  const key = JSON.stringify(face);
  if (tool.value === 'fill') paintSkinPixel(image.data, x, y, value, face, true);
  else {
    const steps = last?.key === key ? Math.max(Math.abs(x - last.x), Math.abs(y - last.y)) : 0;
    for (let s = 0; s <= steps; s++)
      paintSkinPixel(
        image.data,
        steps ? Math.round(last!.x + ((x - last!.x) * s) / steps) : x,
        steps ? Math.round(last!.y + ((y - last!.y) * s) / steps) : y,
        value,
        face
      );
  }
  last = { x, y, key };
  ctx.putImageData(image, 0, 0);
  revision.value++;
  const rendered = pixels().data;
  if (before.some((v, index) => v !== rendered[index])) {
    dirty.value = true;
    if (tool.value !== 'erase' && palettePreferences.value.recent[0] !== color.value)
      palettePreferences.value.recent = rememberSkinColor(palettePreferences.value.recent, color.value);
  }
}
function history(back: boolean) {
  if (!canEdit()) return;
  endGesture();
  const from = back ? undo.value : redo.value,
    to = back ? redo.value : undo.value,
    next = from.pop();
  if (!next) return;
  to.push(pixels().data);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(next), 64, 64), 0, 0);
  changed();
}
async function replaceImage(src: string) {
  const raw = await loadImage(src);
  if (disposed || finishingClose.value) return;
  if (raw.width !== 64 || ![32, 64].includes(raw.height)) throw Error(t('se.invalid_skin_size'));
  const image = migrateLegacySkin(raw);
  snapshot = pixels().data;
  ctx.clearRect(0, 0, 64, 64);
  ctx.drawImage(image, 0, 0);
  const result = pixels();
  makeBaseOpaque(result.data);
  ctx.putImageData(result, 0, 0);
  commit();
  revision.value++;
}
function beginOperation(text: string) {
  endGesture();
  operationError.value = '';
  busyText.value = text;
  busy.value = true;
}
function finishOperation() {
  busy.value = false;
  busyText.value = '';
  if (!disposed) processClose();
}
function failOperation(error: unknown) {
  operationError.value = errText(error);
  toast(operationError.value, 'error');
}
async function importImage(src: string) {
  if (!canEdit()) return;
  beginOperation(t('se.reading_skin'));
  try {
    await replaceImage(src);
  } catch (error) {
    failOperation(error);
  } finally {
    finishOperation();
  }
}
async function choose(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file || !canEdit()) {
    input.value = '';
    return;
  }
  beginOperation(t('se.reading_skin'));
  try {
    if (file.size > 200000) throw Error(t('se.skin_too_large'));
    const src = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(Error(t('se.skin_read_failed')));
      reader.readAsDataURL(file);
    });
    await replaceImage(src);
  } catch (error) {
    failOperation(error);
  } finally {
    input.value = '';
    finishOperation();
  }
}
function newSkin() {
  if (canEdit()) {
    endGesture();
    operationError.value = '';
    snapshot = pixels().data;
    ctx.putImageData(blank, 0, 0);
    commit();
    revision.value++;
  }
}
async function save() {
  if (busy.value || finishingClose.value || disposed) return false;
  beginOperation(t('se.saving_skin'));
  try {
    const saved = await window.faionyx.invoke('skin:editorSave', canvas.value.toDataURL('image/png'));
    if (saved) {
      dirty.value = false;
      toast(t('se.skin_saved'), 'success');
    }
    return !!saved;
  } catch (error) {
    failOperation(error);
    return false;
  } finally {
    finishOperation();
  }
}
function openUpload() {
  if (canEdit() && canApplySkin.value && store.selectedAccount) {
    endGesture();
    operationError.value = '';
    uploadTarget.value = {
      id: store.selectedAccount.id,
      username: store.selectedAccount.username,
      type: store.selectedAccount.type,
      variant: variant.value,
    };
    uploadConfirm.value = true;
  }
}
async function upload() {
  if (busy.value || finishingClose.value || disposed) return;
  const target = uploadTarget.value;
  if (!target || target.id !== store.selectedAccount?.id) {
    uploadConfirm.value = false;
    failOperation(Error(t('se.account_changed')));
    return;
  }
  const local = target.type === 'offline';
  beginOperation(local ? t('se.applying_local') : t('se.uploading_skin'));
  try {
    await refreshSkinAfter(window.faionyx.invoke('skin:editorUpload', canvas.value.toDataURL('image/png'), target.variant, target.id));
    uploadConfirm.value = false;
    if (local) dirty.value = false;
    emit('uploaded');
    toast(local ? t('se.applied_to_offline', { username: target.username }) : t('se.skin_uploaded'), 'success');
  } catch (error) {
    failOperation(error);
  } finally {
    finishOperation();
  }
}
watch(
  () => store.selectedAccount?.id,
  () => {
    if (!busy.value) {
      uploadConfirm.value = false;
      uploadTarget.value = undefined;
    }
  }
);
function requestClose(intent: CloseIntent = { kind: 'editor' }) {
  if (disposed) return;
  closeIntent.value = mergeSkinCloseIntent(closeIntent.value, intent);
  if (finishingClose.value) return;
  endGesture();
  uploadConfirm.value = false;
  processClose();
}
function processClose() {
  if (!closeIntent.value || busy.value || finishingClose.value || disposed) return;
  if (dirty.value) askClose.value = true;
  else void finishClose();
}
function cancelClose() {
  if (finishingClose.value) return;
  askClose.value = false;
  closeIntent.value = undefined;
  void nextTick(() => closeButton.value?.focus({ preventScroll: true }));
}
function cancelUpload() {
  if (busy.value) requestClose();
  else {
    uploadConfirm.value = false;
    void nextTick(() => closeButton.value?.focus({ preventScroll: true }));
  }
}
async function finishClose() {
  if (finishingClose.value || busy.value || disposed) return;
  endGesture();
  finishingClose.value = true;
  askClose.value = false;
  uploadConfirm.value = false;
  clearTimeout(paletteTimer);
  await flushPalette();
  const intent = closeIntent.value;
  closeIntent.value = undefined;
  dirty.value = false;
  window.faionyx.send('window:skinEditorDirty', false);
  emit('close');
  if (intent?.kind === 'quit') window.faionyx.send('window:skinEditorQuit');
  else if (intent?.kind === 'window') window.faionyx.send('window:close');
  else if (intent?.kind === 'navigate') store.currentView = intent.destination;
}
async function saveClose() {
  if ((await save()) && closeIntent.value) await finishClose();
}
function selectView(view: (typeof views)[number]) {
  if (!blocked.value) {
    endGesture();
    selectedView.value = view.name;
    viewer.value?.view(view.yaw, view.pitch);
  }
}
function resetView() {
  if (!blocked.value) {
    endGesture();
    selectedView.value = '';
    viewer.value?.resetView();
  }
}
function togglePart(key: string) {
  if (!blocked.value) {
    endGesture();
    hiddenParts.value = hiddenParts.value.includes(key) ? hiddenParts.value.filter((v) => v !== key) : [...hiddenParts.value, key];
  }
}
function keys(event: KeyboardEvent) {
  if (event.isComposing || event.defaultPrevented) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (askClose.value || (busy.value && closeIntent.value)) cancelClose();
    else if (uploadConfirm.value) cancelUpload();
    else if (previewExpanded.value) previewExpanded.value = false;
    else requestClose();
    return;
  }
  const target = event.target as HTMLElement;
  if (target?.closest('input,textarea,select') || target?.isContentEditable || blocked.value) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'z') {
    event.preventDefault();
    history(!event.shiftKey);
  } else if ((event.ctrlKey || event.metaKey) && key === 's') {
    event.preventDefault();
    void save();
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && ['b', 'e', 'i', 'g'].includes(key)) {
    event.preventDefault();
    tool.value = ({ b: 'brush', e: 'erase', i: 'pick', g: 'fill' } as Record<string, string>)[key];
  }
}
watch([tool, color, alpha], () => viewer.value?.finishGesture(), { flush: 'sync' });
watch(
  [tool, color, alpha, layer],
  () => {
    sampleHint.value = '';
  },
  { flush: 'sync' }
);
let restoringView = false;
watch(
  () => store.currentView,
  (next, old) => {
    if (restoringView || next === old || !(dirty.value || busy.value || finishingClose.value)) return;
    restoringView = true;
    store.currentView = old;
    restoringView = false;
    requestClose({ kind: 'navigate', destination: next });
  },
  { flush: 'sync' }
);
watch(dirty, (value) => window.faionyx.send('window:skinEditorDirty', value), { flush: 'sync' });
const offClose = window.faionyx.on('window:skinEditorClose', (data: any) =>
  requestClose({ kind: data?.quit === true ? 'quit' : 'window' })
);
onBeforeUnmount(() => {
  endGesture();
  disposed = true;
  contentResize?.disconnect();
  clearTimeout(paletteTimer);
  void flushPalette();
  offClose();
  window.faionyx.send('window:skinEditorDirty', false);
  window.faionyx.send('window:skinEditorBusy', { ownerId, pending: false });
});
</script>

<template>
  <Teleport to="body">
    <div class="modal-mask skin-editor-mask" @keydown="keys">
      <section
        class="modal skin-editor"
        role="dialog"
        aria-modal="true"
        :aria-label="t('se.editor_aria')"
        :inert="finishingClose || askClose || uploadConfirm"
      >
        <header class="editor-header">
          <div>
            <h2>{{ t('se.editor_title') }}</h2>
            <p class="muted">64 × 64 {{ t('se.pixels') }} · {{ dirty ? t('se.unsaved_changes') : t('se.saved') }}</p>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="icon-btn editor-close"
            :disabled="finishingClose"
            @click="requestClose()"
            :aria-label="t('se.close_editor_aria')"
            data-modal-dismiss
          >
            <UiGlyph name="close" />
          </button>
        </header>
        <div
          ref="contentElement"
          class="editor-content"
          :style="{ '--editor-tool-max-height': `${toolRailHeight}px` }"
          :class="{ 'preview-expanded': previewExpanded }"
          :inert="busy"
        >
          <nav class="editor-tool-rail" :aria-label="t('se.tools_aria')">
            <button
              v-for="item in drawingTools"
              :key="item.key"
              class="editor-tool"
              :class="{ selected: tool === item.key }"
              :aria-pressed="tool === item.key"
              :title="`${item.name} (${item.shortcut})`"
              :disabled="blocked"
              @click="tool = item.key"
            >
              <UiGlyph :name="item.key" :size="24" /><span>{{ item.name }}</span>
            </button>
            <span class="tool-rail-divider"></span>
            <button class="editor-tool" :disabled="blocked || !undo.length" @click="history(true)" :title="t('se.undo') + ' (Ctrl+Z)'">
              <UiGlyph name="undo" :size="24" /><span>{{ t('se.undo') }}</span>
            </button>
            <button
              class="editor-tool"
              :disabled="blocked || !redo.length"
              @click="history(false)"
              :title="t('se.redo') + ' (Ctrl+Shift+Z)'"
            >
              <UiGlyph name="redo" :size="24" /><span>{{ t('se.redo') }}</span>
            </button>
          </nav>
          <div class="editor-model">
            <div class="editor-preview">
              <SkinViewer3D
                ref="viewer"
                :edit-canvas="canvas"
                :revision="revision"
                :variant="variant"
                edit-mode="draw"
                :edit-disabled="blocked"
                :layer="layer"
                :hidden-parts="hiddenParts"
                paused
                animation="idle"
                @stroke="stroke"
                @pixel="paint"
                @gap="last = undefined"
                @rotate="selectedView = ''"
              />
              <button
                class="icon-btn preview-light"
                :aria-pressed="studioLight"
                :aria-label="t('se.toggle_lighting_aria')"
                :title="t('se.toggle_lighting')"
                :disabled="blocked"
                @click="toggleLighting"
              >
                <UiGlyph name="sun" />
              </button>
              <div class="preview-camera">
                <button
                  class="icon-btn"
                  :aria-pressed="previewExpanded"
                  :aria-label="previewExpanded ? t('se.restore_layout_aria') : t('se.expand_preview_aria')"
                  :title="previewExpanded ? t('se.restore_layout') : t('se.expand_preview')"
                  :disabled="blocked"
                  @click="togglePreview"
                >
                  <UiGlyph name="expand" />
                </button>
                <div class="preview-zoom">
                  <button class="icon-btn" :aria-label="t('se.zoom_in_aria')" :disabled="blocked" @click="viewer?.zoomBy(1.2)">+</button
                  ><button class="icon-btn" :aria-label="t('se.zoom_out_aria')" :disabled="blocked" @click="viewer?.zoomBy(1 / 1.2)">
                    −
                  </button>
                </div>
              </div>
              <p class="editor-pointer-help muted">{{ t('se.pointer_help') }}</p>
            </div>
            <div class="editor-controls editor-view-controls" role="group" :aria-label="t('se.quick_view_aria')">
              <span class="control-label">{{ t('se.view_label') }}</span>
              <div class="tools view-tools">
                <button
                  v-for="view in views"
                  :key="view.name"
                  class="btn btn-ghost"
                  :class="{ selected: selectedView === view.name }"
                  :aria-pressed="selectedView === view.name"
                  @click="selectView(view)"
                >
                  <UiGlyph name="cube" /><span>{{ view.name }}</span></button
                ><button class="btn btn-ghost" @click="resetView">
                  <UiGlyph name="cube" /><span>{{ t('se.reset_view') }}</span>
                </button>
              </div>
            </div>
            <div class="editor-controls editor-part-controls" role="group" :aria-label="t('se.parts_aria')">
              <div class="control-heading">
                <span class="control-label">{{ t('se.parts_label') }}</span
                ><button class="btn btn-ghost btn-sm editor-show-all" :disabled="!hiddenParts.length" @click="hiddenParts = []">
                  {{ t('se.show_all') }}
                </button>
              </div>
              <div class="tools part-tools">
                <button
                  v-for="part in parts"
                  :key="part.key"
                  class="btn btn-ghost"
                  :class="{ selected: !hiddenParts.includes(part.key) }"
                  :aria-pressed="!hiddenParts.includes(part.key)"
                  @click="togglePart(part.key)"
                >
                  {{ part.name }}
                </button>
              </div>
              <p v-if="hiddenParts.length === parts.length" class="muted editor-empty-parts" role="status">
                {{ t('se.all_parts_hidden') }}
              </p>
            </div>
          </div>
          <aside :aria-label="t('se.tools_colors_aria')">
            <div class="tools file-tools">
              <button class="btn" @click="newSkin"><UiGlyph name="file" />{{ t('se.new') }}</button
              ><button class="btn" @click="fileInput?.click()"><UiGlyph name="image" />{{ t('se.import_png') }}</button
              ><input ref="fileInput" class="file-input" type="file" accept="image/png" @change="choose" /><button
                class="btn"
                :disabled="!current"
                @click="current && importImage(current)"
              >
                <UiGlyph name="folder" />{{ t('se.read_current') }}
              </button>
            </div>
            <div class="editor-options">
              <label
                >{{ t('se.model')
                }}<select v-model="variant" :aria-label="t('se.skin_model_aria')">
                  <option value="classic">{{ t('se.classic_model_option') }}</option>
                  <option value="slim">{{ t('se.slim_model_option') }}</option>
                </select></label
              ><label
                >{{ t('se.layer')
                }}<select v-model="layer" :aria-label="t('se.skin_layer_aria')">
                  <option value="inner">{{ t('se.inner_layer_option') }}</option>
                  <option value="outer">{{ t('se.outer_layer_option') }}</option>
                </select></label
              >
            </div>
            <SkinColorPalette
              v-model:color="color"
              v-model:alpha="alpha"
              :alpha-enabled="layer === 'outer'"
              :custom="palettePreferences.custom"
              :recent="palettePreferences.recent"
              @update:custom="palettePreferences.custom = $event"
            />
            <p v-if="sampleHint" class="editor-sample-hint muted" role="status">{{ sampleHint }}</p>
            <div v-if="invisibleBrush" class="editor-zero-alpha" role="status">
              <span>{{ t('se.current_brush_alpha', { alpha: Math.round(alpha * 1000) / 10 }) }}</span
              ><button
                class="btn btn-ghost btn-sm"
                :disabled="blocked"
                @click="
                  endGesture();
                  alpha = 1;
                "
              >
                {{ t('se.restore_opaque') }}
              </button>
            </div>
          </aside>
        </div>
        <footer class="editor-footer">
          <button class="btn btn-ghost editor-upload" :disabled="blocked || !canApplySkin" @click="openUpload">
            <UiGlyph name="upload" />{{
              isOffline
                ? t('se.apply_to_offline_btn')
                : store.selectedAccount?.type === 'microsoft'
                  ? t('se.upload_to_btn', { username: store.selectedAccount.username })
                  : t('se.apply_to_current_btn')
            }}
          </button>
          <div class="editor-footer-save">
            <button class="btn" :disabled="finishingClose" @click="requestClose()">{{ t('common.cancel') }}</button
            ><button class="btn btn-gold" :disabled="blocked" @click="save"><UiGlyph name="download" />{{ t('se.save_png') }}</button>
          </div>
          <p v-if="finishingClose || busy || isOffline || !canApplySkin" class="muted editor-operation-status" role="status">
            {{ finishingClose ? t('se.saving_palette') : busy ? busyText + (closeIntent ? t('se.close_after_busy') : '') : uploadState }}
          </p>
          <button v-if="busy && closeIntent" class="btn btn-ghost btn-sm" @click="cancelClose">{{ t('se.cancel_close') }}</button>
          <p v-if="operationError" class="editor-operation-error" role="alert">{{ operationError }}</p>
        </footer>
      </section>
    </div>
    <div v-if="askClose" class="modal-mask skin-confirm-mask" @keydown="keys">
      <section
        class="modal skin-close-dialog editor-confirm"
        role="alertdialog"
        aria-modal="true"
        :aria-label="t('se.save_changes_title')"
        aria-describedby="skin-unsaved-description"
      >
        <h2>{{ t('se.skin_not_saved') }}</h2>
        <p id="skin-unsaved-description">{{ t('se.save_or_discard') }}</p>
        <div class="modal-actions">
          <button class="btn btn-gold" :disabled="busy" @click="saveClose">{{ t('se.save_and_exit') }}</button
          ><button class="btn" :disabled="busy" @click="finishClose">{{ t('se.discard_changes') }}</button
          ><button class="btn" data-modal-initial-focus data-modal-dismiss @click="cancelClose">
            {{ busy ? t('se.cancel_close') : t('se.keep_editing') }}
          </button>
        </div>
        <p v-if="busy" class="muted" role="status">{{ busyText }}</p>
        <p v-if="operationError" class="editor-operation-error" role="alert">{{ operationError }}</p>
      </section>
    </div>
    <div v-if="uploadConfirm" class="modal-mask skin-confirm-mask" @keydown="keys">
      <section
        class="modal skin-upload-dialog editor-confirm"
        role="alertdialog"
        aria-modal="true"
        :aria-label="uploadTarget?.type === 'offline' ? t('se.confirm_apply_local') : t('se.confirm_upload')"
      >
        <h2>{{ uploadTarget?.type === 'offline' ? t('se.apply_to_offline_btn') : t('se.upload_skin') }}</h2>
        <p>
          {{ uploadTarget?.type === 'offline' ? t('se.will_save_to_offline') : t('se.will_upload_to') }} {{ uploadTarget?.username }}，{{
            uploadTarget?.variant === 'slim' ? t('se.slim_model') : t('se.classic_model')
          }}。
        </p>
        <p v-if="uploadTarget?.type === 'offline'" class="muted offline-skin-hint">
          {{ t('se.offline_skin_hint') }}
        </p>
        <div class="modal-actions">
          <button class="btn btn-gold" :disabled="busy" @click="upload">
            {{
              busy
                ? uploadTarget?.type === 'offline'
                  ? t('se.applying') + '…'
                  : t('se.uploading') + '…'
                : uploadTarget?.type === 'offline'
                  ? t('se.confirm_apply')
                  : t('se.confirm_upload_btn')
            }}</button
          ><button class="btn" data-modal-initial-focus data-modal-dismiss @click="cancelUpload">
            {{ busy ? t('se.close_after_upload') : t('common.cancel') }}
          </button>
        </div>
        <p v-if="operationError" class="editor-operation-error" role="alert">{{ operationError }}</p>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.skin-editor {
  width: min(1200px, calc(100vw - 32px));
  height: min(880px, calc(100dvh - 32px));
  max-height: calc(100dvh - 32px);
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 20px;
}
.editor-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 24px 14px;
}
.editor-header h2 {
  margin: 0;
  font-size: 24px;
}
.editor-header p {
  margin: 5px 0 0;
  font-size: 12px;
}
.editor-close {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
}
.editor-content {
  display: grid;
  grid-template-columns: 64px minmax(280px, 1.2fr) minmax(290px, 1fr);
  min-height: 0;
  flex: 1;
  overflow: hidden;
  gap: 14px;
  padding: 0 20px 16px;
}
.editor-tool-rail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  min-height: 0;
  padding: 14px 0;
}
.editor-tool {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 66px;
  border: 1px solid transparent;
  border-radius: 12px;
  color: var(--text-dim);
  background: transparent;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}
.editor-tool.selected {
  background: var(--accent-soft);
  color: var(--accent-2);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}
.editor-tool.selected::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 12px;
  bottom: 12px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
}
.editor-tool:hover:not(:disabled) {
  background: var(--hover);
}
.editor-tool:disabled {
  opacity: 0.4;
  cursor: default;
}
.tool-rail-divider {
  height: 1px;
  background: var(--border);
  margin: 3px 8px;
  flex-shrink: 0;
}
.editor-model {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
  scrollbar-gutter: stable;
}
.editor-preview {
  position: relative;
  flex: 1 1 0;
  min-height: 220px;
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
  background: var(--card-2);
}
.editor-model :deep(.viewer3d) {
  position: absolute;
  inset: 0;
  height: 100%;
  min-height: 0;
  background: transparent;
  border-radius: 0;
}
.editor-preview::before {
  content: '';
  position: absolute;
  bottom: 0;
  left: -25%;
  width: 150%;
  height: 35%;
  opacity: 0.24;
  transform: perspective(120px) rotateX(40deg);
  transform-origin: bottom;
  background-image: linear-gradient(var(--text-dim) 1px, transparent 1px), linear-gradient(90deg, var(--text-dim) 1px, transparent 1px);
  background-size: 32px 32px;
  pointer-events: none;
}
.preview-light {
  position: absolute;
  top: 14px;
  left: 14px;
}
.preview-camera {
  position: absolute;
  right: 14px;
  top: 14px;
  display: grid;
  gap: 8px;
}
.preview-camera > .icon-btn,
.preview-light {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  width: 36px;
  height: 36px;
}
.preview-zoom {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.preview-zoom .icon-btn {
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 0;
  font-size: 23px;
}
.preview-zoom .icon-btn + .icon-btn {
  border-top: 1px solid var(--border);
}
.editor-pointer-help {
  position: absolute;
  bottom: 9px;
  left: 12px;
  right: 12px;
  text-align: center;
  pointer-events: none;
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
}
.editor-content aside {
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  padding-right: 2px;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.file-tools {
  display: grid;
  grid-template-columns: 0.8fr 1fr 1.2fr;
  margin-bottom: 14px;
}
.file-tools .btn {
  font-size: 12px;
  padding: 8px 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.file-tools .btn:first-child {
  border-color: var(--accent);
  color: var(--accent-2);
  background: var(--accent-soft);
}
.file-tools svg {
  width: 16px;
  flex-shrink: 0;
}
.editor-options {
  display: grid;
  gap: 10px;
  margin: 0 0 16px;
  padding: 4px 10px;
}
.editor-options label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  font-weight: 600;
}
.editor-options select {
  color: var(--text);
  background: var(--card-2);
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  width: 65%;
  font: inherit;
  font-weight: 400;
}
.file-input {
  display: none;
}
.editor-controls {
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 12px;
  margin-top: 10px;
  background: var(--card-2);
  flex-shrink: 0;
}
.control-label {
  font-size: 12px;
  font-weight: 600;
}
.control-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.view-tools,
.part-tools {
  margin-top: 8px;
}
.view-tools {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}
.view-tools .btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 56px;
  font-size: 11px;
  padding: 6px 2px;
  border: 1px solid var(--border);
  border-radius: 11px;
}
.part-tools .btn {
  padding: 6px 10px;
  font-size: 12px;
  min-height: 30px;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.editor-controls .btn.selected {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text);
}
.editor-empty-parts {
  margin: 8px 0 0;
  font-size: 12px;
}
.editor-show-all {
  font-size: 11px;
  padding: 4px 8px;
}
.editor-footer {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 24px 16px;
  border-top: 1px solid var(--border);
}
.editor-footer .btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  border-radius: 12px;
}
.editor-upload {
  font-size: 12px;
  color: var(--text-dim);
}
.editor-footer-save {
  display: flex;
  gap: 10px;
  margin-left: auto;
}
.editor-footer-save .btn {
  min-width: 108px;
}
.editor-operation-status {
  flex: 1 1 100%;
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
}
.editor-operation-error {
  flex: 1 1 100%;
  margin: 0;
  max-height: 72px;
  overflow: auto;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
  color: var(--danger);
}
.preview-expanded {
  grid-template-columns: 64px minmax(0, 1fr);
}
.preview-expanded aside {
  display: none;
}
.skin-confirm-mask {
  z-index: 10001;
}
.editor-confirm {
  width: min(460px, calc(100vw - 32px));
}
.editor-confirm h2 {
  margin: 0;
  font-size: 20px;
}
.editor-confirm p {
  line-height: 1.7;
}
.editor-confirm .modal-actions {
  gap: 8px;
}
.editor-confirm .btn {
  padding: 8px 12px;
  font-size: 13px;
}
@media (max-width: 980px) {
  .editor-content {
    grid-template-columns: 54px minmax(0, 1fr);
    overflow: auto;
    gap: 12px;
  }
  .editor-tool-rail {
    grid-row: 1 / 3;
    position: sticky;
    top: 0;
    align-self: start;
    max-height: 100%;
    padding-top: 0;
    overflow: visible;
  }
  .editor-model {
    height: 450px;
    min-height: 450px;
    overflow: visible;
  }
  .editor-content aside {
    grid-column: 2;
    overflow: visible;
  }
  .editor-tool {
    min-height: 60px;
  }
  .preview-expanded .editor-model {
    height: 100%;
    min-height: 360px;
  }
  .editor-header,
  .editor-footer {
    padding: 14px 20px;
  }
  .editor-header h2 {
    font-size: 22px;
  }
  .editor-content {
    padding: 0 16px 14px;
  }
  .editor-preview {
    min-height: 200px;
  }
}
@media (max-height: 620px) and (min-width: 981px) {
  .editor-header {
    padding: 10px 20px;
  }
  .editor-header h2 {
    font-size: 20px;
  }
  .editor-header > div {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .editor-header p {
    margin: 0;
  }
  .editor-content {
    gap: 12px;
    padding-bottom: 10px;
  }
  .editor-preview {
    min-height: 160px;
  }
  .editor-tool {
    min-height: 52px;
    gap: 4px;
  }
  .editor-controls {
    padding: 8px;
    margin-top: 6px;
  }
  .view-tools .btn {
    min-height: 42px;
    font-size: 10px;
    gap: 3px;
  }
  .view-tools svg {
    width: 16px;
    height: 16px;
  }
  .editor-footer {
    padding: 8px 20px;
  }
  .editor-footer .btn {
    min-height: 32px;
  }
  .editor-footer-save .btn {
    min-width: 94px;
  }
  .editor-operation-status {
    font-size: 10px;
  }
  .editor-pointer-help {
    font-size: 10px;
  }
}
@media (max-width: 520px) {
  .editor-header,
  .editor-footer {
    padding: 12px;
  }
  .editor-content {
    padding: 0 10px 12px;
    gap: 8px;
    grid-template-columns: 46px minmax(0, 1fr);
  }
  .editor-tool {
    font-size: 11px;
    min-height: 54px;
  }
  .view-tools {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .editor-model {
    height: 470px;
    min-height: 470px;
  }
  .editor-footer .btn {
    min-height: 34px;
    font-size: 12px;
  }
  .editor-footer-save {
    gap: 6px;
  }
  .editor-footer-save .btn {
    min-width: 74px;
  }
  .editor-upload {
    width: 100%;
    justify-content: flex-start !important;
  }
  .file-tools {
    grid-template-columns: 1fr 1fr;
  }
  .file-tools .btn:last-child {
    grid-column: 1 / -1;
  }
}
@media (max-height: 620px) and (max-width: 980px) {
  .editor-header {
    padding: 8px 16px;
  }
  .editor-header h2 {
    font-size: 18px;
  }
  .editor-header > div {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .editor-header p {
    font-size: 11px;
    margin: 0;
  }
  .editor-footer {
    padding: 7px 16px;
    gap: 4px 8px;
  }
  .editor-footer .btn {
    min-height: 30px;
    font-size: 11px;
  }
  .editor-footer-save .btn {
    min-width: 86px;
  }
  .editor-operation-status {
    font-size: 10px;
  }
  .editor-content {
    padding-bottom: 10px;
  }
  .editor-model {
    height: clamp(224px, calc(100dvh - 172px), 450px);
    min-height: 224px;
  }
  .editor-preview {
    min-height: 120px;
  }
  .editor-tool {
    min-height: 42px;
    gap: 3px;
    font-size: 10px;
  }
  .editor-tool svg {
    width: 18px;
    height: 18px;
  }
  .editor-tool-rail {
    gap: 5px;
  }
  .editor-controls {
    padding: 6px 8px;
    margin-top: 6px;
  }
  .editor-view-controls {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 8px;
  }
  .view-tools {
    margin: 0;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 4px;
  }
  .view-tools .btn {
    min-height: 28px;
    font-size: 10px;
  }
  .view-tools svg {
    display: none;
  }
  .editor-part-controls {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px;
  }
  .editor-part-controls .control-heading {
    display: contents;
  }
  .editor-part-controls .control-label {
    grid-column: 1;
    grid-row: 1;
    white-space: nowrap;
  }
  .editor-show-all {
    grid-column: 3;
    grid-row: 1;
    white-space: nowrap;
    font-size: 10px;
    padding: 4px;
  }
  .part-tools {
    grid-column: 2;
    grid-row: 1;
    margin: 0;
    gap: 4px;
  }
  .part-tools .btn {
    font-size: 10px;
    min-height: 26px;
    padding: 4px 6px;
  }
  .editor-empty-parts {
    grid-column: 1 / -1;
  }
  .preview-camera {
    top: 8px;
    right: 8px;
    gap: 5px;
  }
  .preview-light {
    top: 8px;
    left: 8px;
  }
  .preview-camera > .icon-btn,
  .preview-light {
    width: 28px;
    height: 28px;
  }
  .preview-zoom .icon-btn {
    width: 26px;
    height: 26px;
  }
  .editor-pointer-help {
    font-size: 10px;
    bottom: 5px;
  }
}
</style>
<style scoped>
.editor-sample-hint {
  margin: 10px 2px;
  font-size: 12px;
  line-height: 1.6;
}
.editor-zero-alpha {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--text);
  font-size: 12px;
  line-height: 1.6;
}
.editor-zero-alpha .btn {
  margin-left: auto;
  color: var(--text);
  border: 1px solid var(--border);
  white-space: normal;
}
.skin-editor-mask {
  -webkit-app-region: no-drag;
}
.editor-close {
  position: relative;
  z-index: 1;
  -webkit-app-region: no-drag;
}
.editor-close :deep(svg) {
  pointer-events: none;
  display: block;
}
.preview-zoom {
  display: flex;
  flex-direction: column;
}
@media (max-width: 980px) {
  .editor-tool-rail {
    max-height: var(--editor-tool-max-height);
    overflow-y: auto;
  }
  .editor-model {
    height: var(--editor-tool-max-height);
    min-height: var(--editor-tool-max-height);
    overflow: auto;
  }
}
</style>
