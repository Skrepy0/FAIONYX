<script setup lang="ts">
// Fixed-layout personalized background and launch-card image management.
import { builtInLaunchImages } from '../launchImages';
import ConfirmModal from './ConfirmModal.vue';
import { computed, nextTick, ref, onMounted, onUnmounted } from 'vue';
import { reorderGallery } from '@shared/galleryOrder';
import { carouselImages, carouselKeys, activeCarouselKeys, carouselDuration, MAX_CAROUSEL_IMAGES } from '@shared/appearancePolicy';
import { updateSettings } from '../settingsUpdates';
import { errText, getSystemInfo, importBackground, importBackgroundMulti, importLaunchThumbnail, resetBackground } from '../api';
import { store, toast } from '../store';
import { t } from '@renderer/i18n';
import { managedImageUrl } from '../managedAssets';
import type { BackgroundSettings, ImageFit, Settings } from '@shared/types';

const reducedTransparency = ref(false);
function refreshNativeMaterial() {
  if (window.faionyx.platform !== 'darwin') return;
  void getSystemInfo()
    .then((info) => {
      reducedTransparency.value = info.reducedTransparency === true;
    })
    .catch(() => {});
}
onMounted(() => {
  refreshNativeMaterial();
  window.addEventListener('focus', refreshNativeMaterial);
});
onUnmounted(() => window.removeEventListener('focus', refreshNativeMaterial));

function save(patch: Partial<Settings>) {
  void updateSettings(patch).catch((e) => toast(t('hle.save_failed') + errText(e), 'error'));
}

// ---------------- Background ----------------
const bgModes = [
  { value: 'none', label: t('hle.bg_system') },
  { value: 'color', label: t('hle.bg_color') },
  { value: 'image', label: t('hle.bg_image') },
] as const;
const fitModes: Array<{ value: ImageFit; label: string }> = [
  { value: 'fill', label: t('hle.fit_fill') },
  { value: 'fit', label: t('hle.fit_fit') },
  { value: 'crop', label: t('hle.fit_crop') },
];
const importingBackground = ref(false);
const importingThumbnail = ref(false);
const backgroundPreviewFailed = ref(false);
const images = computed(() => carouselImages(store.settings?.launchThumbnail));
const slides = computed(() =>
  carouselKeys(store.settings?.launchThumbnail).map((key) => {
    const bundled = builtInLaunchImages.find((image) => image.key === key);
    return {
      key,
      src: bundled?.src ?? managedImageUrl(key),
      title: bundled ? t(bundled.title) : `${t('hle.custom_image')} ${images.value.indexOf(key) + 1}`,
      builtin: !!bundled,
    };
  })
);
const activeSlides = computed(() => new Set(activeCarouselKeys(store.settings?.launchThumbnail)));
const removeThumbnail = ref<string | null>(null);
const removingThumbnail = ref(false);
const brokenThumbnailPreviews = ref(new Set<string>());
const draggingImage = ref('');
const dropImage = ref('');
const reorderAnnouncement = ref('');
function setSlidesEnabled(keys: string[], enabled: boolean) {
  if (!store.settings) return;
  const disabled = new Set(store.settings.launchThumbnail.disabled ?? []);
  for (const key of keys) enabled ? disabled.delete(key) : disabled.add(key);
  save({ launchThumbnail: { ...store.settings.launchThumbnail, disabled: [...disabled] } });
}
async function deleteThumbnail() {
  if (!store.settings || !removeThumbnail.value || removingThumbnail.value) return;
  removingThumbnail.value = true;
  const next = images.value.filter((image) => image !== removeThumbnail.value);
  try {
    await updateSettings({ launchThumbnail: { ...store.settings.launchThumbnail, images: next, image: next[0] ?? '' } });
    removeThumbnail.value = null;
  } catch (e) {
    toast(t('hle.remove_failed') + errText(e), 'error');
  } finally {
    removingThumbnail.value = false;
  }
}
function moveImage(index: number, direction: number) {
  if (!store.settings) return;
  const next = slides.value.map((image) => image.key);
  const target = index + direction;
  if (target < 0 || target >= next.length) return;
  reorderImage(next[index], next[target]);
}
function reorderImage(from: string, to: string) {
  if (!store.settings || from === to) return;
  const keys = slides.value.map((image) => image.key);
  if (!keys.includes(from) || !keys.includes(to)) return;
  const order = reorderGallery(keys, from, to);
  save({ launchThumbnail: { ...store.settings.launchThumbnail, order } });
  reorderAnnouncement.value = `${slides.value.find((image) => image.key === from)?.title}${t('hle.moved_to')} ${order.indexOf(from) + 1} ${t('hle.position')}`;
}
function startImageDrag(event: DragEvent, key: string) {
  draggingImage.value = key;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-faionyx-gallery', key);
  }
}
function dropImageDrag(event: DragEvent, key: string) {
  const from = draggingImage.value;
  if (from && event.dataTransfer?.getData('application/x-faionyx-gallery') === from) reorderImage(from, key);
  draggingImage.value = '';
  dropImage.value = '';
}
function reorderImageKeyboard(event: KeyboardEvent, key: string) {
  const keys = slides.value.map((image) => image.key),
    index = keys.indexOf(key);
  const target =
    event.key === 'ArrowUp'
      ? index - 1
      : event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? keys.length - 1
            : -1;
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (target < 0 || target >= keys.length) return;
  reorderImage(key, keys[target]);
  void nextTick(() =>
    [...document.querySelectorAll<HTMLElement>('.carousel-drag-handle')].find((handle) => handle.dataset.key === key)?.focus()
  );
}
function setDuration(value: string, image?: string) {
  if (!store.settings) return;
  const current = store.settings.launchThumbnail;
  const seconds = carouselDuration(Number(value));
  save({
    launchThumbnail: image
      ? { ...current, durations: { ...current.durations, [image]: seconds } }
      : { ...current, intervalSeconds: seconds },
  });
}

function fitCss(fit: ImageFit): 'fill' | 'contain' | 'cover' {
  return fit === 'fill' ? 'fill' : fit === 'fit' ? 'contain' : 'cover';
}

function setBg(patch: Partial<BackgroundSettings>) {
  if (!store.settings) return;
  save({ background: { ...store.settings.background, ...patch } });
}

async function pickImage() {
  if (importingBackground.value) return;
  importingBackground.value = true;
  try {
    const settings = await importBackground();
    if (settings) {
      store.settings = settings;
      backgroundPreviewFailed.value = false;
      toast(t('hle.bg_copied'), 'success');
    }
  } catch (e) {
    toast(t('hle.import_bg_failed') + errText(e), 'error');
  } finally {
    importingBackground.value = false;
  }
}

/** Multi-select import background images (for auto-switching): append to images array */
const importingBackgroundMulti = ref(false);
async function pickImageMulti() {
  if (importingBackgroundMulti.value) return;
  importingBackgroundMulti.value = true;
  try {
    const settings = await importBackgroundMulti();
    if (settings) {
      store.settings = settings;
      backgroundPreviewFailed.value = false;
      toast(`${t('hle.bg_added')} (${t('hle.total_images', { count: settings.background.images?.length ?? 1 })})`, 'success');
    }
  } catch (e) {
    toast(t('hle.import_bg_failed') + errText(e), 'error');
  } finally {
    importingBackgroundMulti.value = false;
  }
}

/** Background image list (for multi-image switching; falls back to single image when empty) */
const bgImageList = computed(() => {
  const bg = store.settings?.background;
  if (!bg) return [] as string[];
  return bg.images?.length ? bg.images : bg.image ? [bg.image] : [];
});
function removeBgImage(image: string) {
  if (!store.settings) return;
  const next = bgImageList.value.filter((i) => i !== image);
  backgroundPreviewFailed.value = false;
  save({ background: { ...store.settings.background, images: next, image: next[0] ?? '' } });
}

/** Switch strategy */
const switchModes = [
  { value: 'off', label: t('hle.switch_fixed') },
  { value: 'order', label: t('hle.switch_order') },
  { value: 'random', label: t('hle.switch_random') },
] as const;

async function resetBg() {
  try {
    store.settings = await resetBackground();
    backgroundPreviewFailed.value = false;
    toast(t('hle.bg_reset'), 'success');
  } catch (error) {
    toast(t('hle.reset_bg_failed') + errText(error), 'error');
  }
}

async function pickLaunchThumbnail() {
  if (importingThumbnail.value) return;
  importingThumbnail.value = true;
  try {
    const settings = await importLaunchThumbnail();
    if (settings) {
      store.settings = settings;
      toast(t('hle.launch_thumb_added'), 'success');
    }
  } catch (error) {
    toast(t('hle.import_thumb_failed') + errText(error), 'error');
  } finally {
    importingThumbnail.value = false;
  }
}

function resetThumbnail() {
  if (!store.settings) return;
  save({
    launchThumbnail: {
      ...store.settings.launchThumbnail,
      order: carouselKeys({ ...store.settings.launchThumbnail, order: [] }),
      disabled: [],
    },
  });
}

function setLaunchFit(fit: ImageFit) {
  if (!store.settings) return;
  save({ launchThumbnail: { ...store.settings.launchThumbnail, fit } });
}
</script>

<template>
  <!-- Background -->
  <details class="card group layout-setting" data-section="background">
    <summary>
      {{ t('hle.window_bg') }} <small>{{ t('hle.window_bg_hint') }}</small>
    </summary>
    <div class="layout-setting-body">
      <div class="layout-head">
        <div>
          <h3 class="group-title group-title-tight">{{ t('hle.window_bg') }}</h3>
          <p class="muted group-hint group-hint-flush">{{ t('hle.window_bg_desc') }}</p>
        </div>
        <button data-ui="HomeLayoutEditor:457065564dba" class="btn btn-ghost btn-sm" @click="resetBg">{{ t('hle.reset_default') }}</button>
      </div>

      <p
        data-ui="HomeLayoutEditor:f6dd4302c066"
        v-if="reducedTransparency && store.settings?.background.mode === 'none'"
        class="group-hint"
        role="status"
      >
        {{ t('hle.macos_transparency') }}
      </p>
      <div data-ui="HomeLayoutEditor:05b5e9438975" class="bg-modes">
        <button
          data-ui="HomeLayoutEditor:ab1c088a4afb"
          v-for="m in bgModes"
          :key="m.value"
          class="capsule"
          :class="{ active: store.settings?.background.mode === m.value }"
          @click="setBg({ mode: m.value })"
        >
          {{ m.label }}
        </button>
      </div>

      <template v-if="store.settings?.background.mode === 'color'">
        <div class="bg-row">
          <span class="muted bg-label">{{ t('hle.bg_color_label') }}</span>
          <input
            data-ui="HomeLayoutEditor:b7f054062be4"
            type="color"
            class="color-swatch"
            :value="store.settings.background.color"
            @input="setBg({ color: ($event.target as HTMLInputElement).value })"
          />
          <span data-ui="HomeLayoutEditor:bac4082566ae" class="mono muted">{{ store.settings.background.color }}</span>
        </div>
      </template>

      <template v-if="store.settings?.background.mode === 'image'">
        <div
          data-ui="HomeLayoutEditor:559b6b5ae0d7"
          v-if="store.settings.background.image && !backgroundPreviewFailed"
          class="image-preview background-preview"
        >
          <img
            data-ui="HomeLayoutEditor:65cf8c030362"
            :src="managedImageUrl(store.settings.background.image)"
            :style="{ objectFit: fitCss(store.settings.background.fit) }"
            alt="{{ t('hle.bg_preview_alt') }}"
            @error="backgroundPreviewFailed = true"
          />
        </div>
        <div v-else class="image-preview image-preview-empty">
          {{ backgroundPreviewFailed ? t('hle.bg_unavailable') : t('hle.bg_not_imported') }}
        </div>
        <div class="bg-row">
          <span class="muted bg-label">{{ t('hle.bg_image_label') }}</span>
          <button
            data-ui="HomeLayoutEditor:600aad811fea"
            class="btn btn-ghost btn-sm"
            :disabled="importingBackground || importingBackgroundMulti"
            @click="pickImage"
          >
            {{ importingBackground ? t('hle.processing') : t('hle.import_single') }}
          </button>
          <button
            data-ui="HomeLayoutEditor:b5d9e0d6a917"
            class="btn btn-ghost btn-sm"
            :disabled="importingBackground || importingBackgroundMulti"
            @click="pickImageMulti"
          >
            {{ importingBackgroundMulti ? t('hle.processing') : t('hle.add_multi') }}
          </button>
          <span data-ui="HomeLayoutEditor:a0ee9d306678" class="muted bg-img-path" :title="store.settings.background.image">
            {{ store.settings.background.image ? t('hle.managed_by_faionyx') : t('hle.not_selected') }}
          </span>
        </div>
        <ol
          data-ui="HomeLayoutEditor:e28f1ea34df0"
          v-if="bgImageList.length > 1"
          class="carousel-list"
          :aria-label="t('hle.bg_switch_list')"
        >
          <li data-ui="HomeLayoutEditor:bcb005d78798" v-for="(image, index) in bgImageList" :key="image">
            <img :src="managedImageUrl(image)" :alt="t('hle.bg_image_n', { n: index + 1 })" />
            <span>{{ index + 1 }}</span>
            <button data-ui="HomeLayoutEditor:c50825368bbb" class="btn btn-ghost btn-sm" @click="removeBgImage(image)">
              {{ t('hle.remove') }}
            </button>
          </li>
        </ol>
        <div v-if="bgImageList.length > 1" class="bg-row">
          <span class="muted bg-label">{{ t('hle.auto_switch') }}</span>
          <div class="fit-options">
            <button
              data-ui="HomeLayoutEditor:8f06ad84f746"
              v-for="m in switchModes"
              :key="m.value"
              class="capsule"
              :class="{ active: (store.settings.background.switchMode ?? 'off') === m.value }"
              :title="
                m.value === 'off'
                  ? t('hle.switch_fixed_hint')
                  : m.value === 'order'
                    ? t('hle.switch_order_hint')
                    : t('hle.switch_random_hint')
              "
              @click="setBg({ switchMode: m.value })"
            >
              {{ m.label }}
            </button>
          </div>
        </div>
        <div v-if="bgImageList.length > 1 && (store.settings.background.switchMode ?? 'off') !== 'off'" class="bg-row">
          <span class="muted bg-label">{{ t('hle.switch_interval') }}</span>
          <input
            data-ui="HomeLayoutEditor:0d7dbca39e6b"
            type="number"
            class="input num-input"
            min="30"
            max="7200"
            step="30"
            :value="store.settings.background.switchIntervalSec ?? 300"
            @change="setBg({ switchIntervalSec: Math.max(30, Number(($event.target as HTMLInputElement).value) || 300) })"
          />
          <span class="muted">{{ t('hle.switch_interval_hint') }}</span>
        </div>
        <div class="bg-row">
          <span class="muted bg-label">{{ t('hle.fit_label') }}</span>
          <div class="fit-options">
            <button
              data-ui="HomeLayoutEditor:f6ec348fd689"
              v-for="fit in fitModes"
              :key="fit.value"
              class="capsule"
              :class="{ active: store.settings.background.fit === fit.value }"
              @click="setBg({ fit: fit.value })"
            >
              {{ fit.label }}
            </button>
          </div>
        </div>
        <div class="bg-row">
          <span class="muted bg-label">{{ t('hle.image_opacity') }}</span>
          <input
            data-ui="HomeLayoutEditor:ca782d9e2791"
            type="range"
            class="slider"
            min="0"
            max="1"
            step="0.05"
            :value="1 - store.settings.background.opacity"
            :style="{ '--fill': (1 - store.settings.background.opacity) * 100 + '%' }"
            @input="setBg({ opacity: 1 - Number(($event.target as HTMLInputElement).value) })"
          />
          <span class="muted bg-val">{{ Math.round((1 - store.settings.background.opacity) * 100) }}%</span>
        </div>
        <div class="bg-row">
          <span class="muted bg-label">{{ t('hle.image_blur') }}</span>
          <input
            data-ui="HomeLayoutEditor:48130ab6cc28"
            type="range"
            class="slider"
            min="0"
            max="40"
            step="2"
            :value="store.settings.background.blur"
            :style="{ '--fill': (store.settings.background.blur / 40) * 100 + '%' }"
            @input="setBg({ blur: Number(($event.target as HTMLInputElement).value) })"
          />
          <span class="muted bg-val">{{ store.settings.background.blur }}px</span>
        </div>
        <p data-ui="HomeLayoutEditor:c53c77f7d517" class="muted group-hint">
          {{ t('hle.opacity_blur_hint') }}
        </p>
      </template>
    </div>
  </details>

  <!-- Home launch card global thumbnail -->
  <details class="card group layout-setting" data-section="thumbnail">
    <summary>
      {{ t('hle.home_thumb') }} <span class="carousel-count">{{ activeSlides.size }} / {{ slides.length }} {{ t('hle.enabled') }}</span
      ><small>{{ t('hle.home_thumb_hint') }}</small>
    </summary>
    <div class="layout-setting-body">
      <div class="layout-head">
        <div>
          <h3 class="group-title group-title-tight">{{ t('hle.home_thumb_title') }}</h3>
          <p class="muted group-hint group-hint-flush">
            {{ t('hle.home_thumb_desc') }}
          </p>
        </div>
      </div>
      <div class="carousel-primary-controls" data-ui="carousel:primary">
        <div class="bg-row">
          <span class="muted bg-label">{{ t('hle.image_manage') }}</span>
          <button
            data-ui="HomeLayoutEditor:d9002bd65d2e"
            class="btn btn-ghost btn-sm"
            :disabled="importingThumbnail"
            @click="pickLaunchThumbnail"
          >
            {{ importingThumbnail ? t('hle.processing') : t('hle.add_image_multi') }}
          </button>
          <span data-ui="HomeLayoutEditor:6054c28ad3cc" class="muted bg-img-path">
            {{
              t('hle.selected_count', { active: activeSlides.size, total: slides.length, custom: images.length, max: MAX_CAROUSEL_IMAGES })
            }}
          </span>
        </div>
        <div class="bg-row">
          <span class="muted bg-label">{{ t('hle.fit_label') }}</span>
          <div class="fit-options">
            <button
              data-ui="HomeLayoutEditor:537b581dd0d7"
              v-for="fit in fitModes"
              :key="fit.value"
              class="capsule"
              :class="{ active: store.settings?.launchThumbnail.fit === fit.value }"
              @click="setLaunchFit(fit.value)"
            >
              {{ fit.label }}
            </button>
          </div>
        </div>
        <div class="bg-row">
          <span class="bg-label">{{ t('hle.playback_order') }}</span
          ><label class="check-option"
            ><input
              type="checkbox"
              :aria-label="t('hle.random_playback')"
              :checked="store.settings?.launchThumbnail.randomPlayback === true"
              @change="
                store.settings &&
                save({
                  launchThumbnail: { ...store.settings.launchThumbnail, randomPlayback: ($event.target as HTMLInputElement).checked },
                })
              "
            /><span
              ><strong>{{ t('hle.random_playback') }}</strong
              ><small>{{ t('hle.random_playback_hint') }}</small></span
            ></label
          >
        </div>
        <div class="bg-row carousel-default-time">
          <label data-ui="HomeLayoutEditor:dee929e66133" class="bg-label" for="carousel-default-duration">{{
            t('hle.default_duration')
          }}</label
          ><input
            data-ui="HomeLayoutEditor:c51dd8fea2e7"
            id="carousel-default-duration"
            type="number"
            min="1"
            max="120"
            step="0.5"
            class="input num-input"
            :value="carouselDuration(store.settings?.launchThumbnail.intervalSeconds)"
            @change="setDuration(($event.target as HTMLInputElement).value)"
          /><span class="muted">{{ t('hle.default_duration_hint') }}</span>
        </div>
      </div>
      <div class="carousel-selection-actions" role="group" :aria-label="t('hle.carousel_bulk')" data-ui="carousel:bulk">
        <span class="muted">{{ t('hle.bulk_select') }}</span>
        <button
          class="btn btn-ghost btn-sm"
          @click="
            setSlidesEnabled(
              slides.map((image) => image.key),
              true
            )
          "
        >
          {{ t('hle.select_all') }}
        </button>
        <button
          class="btn btn-ghost btn-sm"
          @click="
            setSlidesEnabled(
              slides.map((image) => image.key),
              false
            )
          "
        >
          {{ t('hle.select_none') }}
        </button>
        <button
          class="btn btn-ghost btn-sm"
          @click="
            setSlidesEnabled(
              builtInLaunchImages.map((image) => image.key),
              false
            )
          "
        >
          {{ t('hle.disable_builtin') }}
        </button>
        <details class="carousel-maintenance">
          <summary class="btn btn-ghost btn-sm">{{ t('hle.more_actions') }}</summary>
          <div>
            <button data-ui="HomeLayoutEditor:033eef52e2e9" class="btn btn-ghost btn-sm" @click="resetThumbnail">
              {{ t('hle.reset_order_select_all') }}
            </button>
          </div>
        </details>
        <span v-if="!activeSlides.size" class="muted" role="status">{{ t('hle.carousel_off') }}</span>
      </div>
      <p class="carousel-reorder-hint muted">{{ t('hle.drag_reorder_hint') }}</p>
      <span class="sr-only" role="status" aria-live="polite">{{ reorderAnnouncement }}</span>
      <ol data-ui="HomeLayoutEditor:78dcf55b4b19" class="carousel-list launch-carousel-list" :aria-label="t('hle.launch_order')">
        <li
          data-ui="HomeLayoutEditor:c9fcdfd782bb"
          v-for="(image, index) in slides"
          :key="image.key"
          :data-carousel-key="image.key"
          :class="{
            disabled: !activeSlides.has(image.key),
            dragging: draggingImage === image.key,
            'drop-target': draggingImage && dropImage === image.key && draggingImage !== image.key,
          }"
          @dragover.prevent="draggingImage && (dropImage = image.key)"
          @drop.prevent="dropImageDrag($event, image.key)"
        >
          <button
            class="icon-btn carousel-drag-handle"
            :data-key="image.key"
            draggable="true"
            :aria-label="t('hle.adjust_order', { title: image.title, pos: index + 1 })"
            :title="t('hle.drag_sort_hint')"
            @dragstart="startImageDrag($event, image.key)"
            @dragend="
              draggingImage = '';
              dropImage = '';
            "
            @keydown="reorderImageKeyboard($event, image.key)"
          >
            <svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
              <circle v-for="n in 6" :key="n" :cx="n % 2 ? 5 : 11" :cy="Math.ceil(n / 2) * 5" r="1.3" />
            </svg>
          </button>
          <img
            v-if="!brokenThumbnailPreviews.has(image.key)"
            :src="image.src"
            :alt="image.title"
            @error="brokenThumbnailPreviews = new Set([...brokenThumbnailPreviews, image.key])"
          />
          <span v-else class="carousel-preview-missing" :aria-label="t('hle.image_unavailable')">{{ t('hle.image_unavailable') }}</span>
          <label class="carousel-enabled"
            ><input
              type="checkbox"
              :checked="activeSlides.has(image.key)"
              :aria-label="t('hle.carousel_participate', { title: image.title })"
              @change="setSlidesEnabled([image.key], ($event.target as HTMLInputElement).checked)"
            /><span :title="image.builtin ? image.title : image.key"
              >{{ image.title }}<small>{{ image.builtin ? t('hle.builtin_image') : t('hle.custom_image') }}</small></span
            ></label
          >
          <label data-ui="HomeLayoutEditor:1b8a2f6bf653" class="slide-duration"
            >{{ t('hle.stay') }}
            <input
              data-ui="HomeLayoutEditor:b820622679f5"
              class="input"
              type="number"
              min="1"
              max="120"
              step="0.5"
              :aria-label="t('hle.stay_seconds', { title: image.title })"
              :value="
                carouselDuration(store.settings?.launchThumbnail.durations?.[image.key] ?? store.settings?.launchThumbnail.intervalSeconds)
              "
              @change="setDuration(($event.target as HTMLInputElement).value, image.key)"
            /><span>{{ t('hle.seconds') }}</span></label
          >
          <div class="carousel-row-actions">
            <button
              data-ui="HomeLayoutEditor:2b6f46e2b899"
              class="icon-btn"
              :disabled="index === 0"
              :aria-label="t('hle.move_forward', { title: image.title })"
              :title="t('hle.move_forward')"
              @click="moveImage(index, -1)"
            >
              ↑</button
            ><button
              data-ui="HomeLayoutEditor:5dd6420ad302"
              class="icon-btn"
              :disabled="index === slides.length - 1"
              :aria-label="t('hle.move_backward', { title: image.title })"
              :title="t('hle.move_backward')"
              @click="moveImage(index, 1)"
            >
              ↓</button
            ><button
              data-ui="HomeLayoutEditor:ebd5db203bf7"
              v-if="!image.builtin"
              class="icon-btn carousel-remove"
              :aria-label="t('hle.remove_file', { title: image.title })"
              :title="t('hle.remove_file')"
              @click="removeThumbnail = image.key"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
              </svg>
            </button>
          </div>
        </li>
      </ol>
    </div>
  </details>
  <ConfirmModal
    :open="!!removeThumbnail"
    :title="t('hle.remove_custom_thumb_title')"
    :message="t('hle.remove_custom_thumb_msg')"
    :confirm-text="t('hle.remove_file')"
    :busy="removingThumbnail"
    @confirm="deleteThumbnail"
    @cancel="removeThumbnail = null"
  />
</template>

<style scoped>
.layout-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.group-title-tight {
  margin-bottom: var(--space-1);
}
.group-hint-flush {
  margin: 0;
}
.num-input {
  width: 90px;
  flex: none;
}
/* Background */
.bg-modes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.capsule {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--ctl-h);
  padding: 0 var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  color: var(--text);
  cursor: pointer;
  font: inherit;
}
.capsule.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-2);
}
.carousel-list {
  list-style: none;
  padding: 0;
  margin: var(--space-3) 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(265px, 1fr));
  gap: var(--space-2);
}
.carousel-list li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--row-h);
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  min-width: 0;
}
.carousel-list li {
  flex-wrap: wrap;
}
.slide-duration {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
}
.slide-duration input {
  width: 65px;
  min-height: var(--ctl-h);
  padding: var(--space-1) var(--space-2);
}
.carousel-list img {
  width: 64px;
  height: 40px;
  object-fit: cover;
  border-radius: var(--radius-sm);
}
.carousel-list span {
  flex: 1;
}
.carousel-list button {
  min-width: var(--ctl-h);
  min-height: var(--ctl-h);
}
.fit-options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.image-preview {
  width: 100%;
  height: 150px;
  margin: var(--space-3) 0 var(--space-2);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-2);
}
.image-preview img {
  display: block;
  width: 100%;
  height: 100%;
}
.image-preview-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5) var(--space-4);
  color: var(--text-dim);
  font-size: var(--text-xs);
  text-align: center;
}
.launch-preview {
  aspect-ratio: 16 / 7;
  height: auto;
  max-height: 220px;
}
.bg-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--row-h);
  padding: var(--space-1) 0;
}
.bg-label {
  flex: 0 0 82px;
  font-size: var(--text-sm);
}
.bg-val {
  flex-shrink: 0;
  min-width: 44px;
  text-align: right;
  font-weight: 700;
  color: var(--accent-2);
  font-size: var(--text-xs);
}
.bg-img-path {
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.color-swatch {
  -webkit-appearance: none;
  appearance: none;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
}
.color-swatch::-webkit-color-swatch-wrapper {
  padding: 3px;
}
.color-swatch::-webkit-color-swatch {
  border: none;
  border-radius: 4px;
}
.mono {
  font-size: var(--text-xs);
}
.group + .group {
  margin-top: 0;
}
.carousel-selection-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.carousel-selection-actions .muted {
  font-size: 12px;
}
.carousel-count {
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  background: var(--accent-soft);
  color: var(--accent-2);
  white-space: nowrap;
}
.carousel-primary-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 4px 20px;
}
.carousel-primary-controls > .bg-row:first-child {
  grid-column: 1 / -1;
}
.carousel-primary-controls .bg-label {
  flex: 0 0 84px;
}
.carousel-default-time {
  flex-wrap: wrap;
}
.carousel-default-time .num-input {
  width: 72px;
}
.carousel-default-time .muted {
  font-size: 11px;
  line-height: 1.5;
}
.carousel-selection-actions {
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.carousel-maintenance {
  margin-left: auto;
  position: relative;
}
.carousel-maintenance summary {
  list-style: none;
}
.carousel-maintenance summary::-webkit-details-marker {
  display: none;
}
.carousel-maintenance > div {
  position: absolute;
  top: calc(100% + 5px);
  right: 0;
  padding: 8px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow);
  z-index: 5;
  white-space: nowrap;
}
@media (max-width: 900px) {
  .carousel-primary-controls {
    grid-template-columns: minmax(0, 1fr);
  }
}
.carousel-enabled {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 140px;
  flex: 1;
  cursor: pointer;
}
.carousel-enabled span {
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.carousel-enabled small {
  display: block;
  color: var(--text-dim);
  font-size: 11px;
}
.carousel-enabled input {
  flex: none;
  accent-color: var(--accent);
}
.launch-carousel-list li.disabled {
  background: var(--card-2);
}
.launch-carousel-list li.disabled img {
  opacity: 0.45;
}
.carousel-preview-missing {
  flex: none !important;
  display: grid;
  place-items: center;
  width: 64px;
  height: 40px;
  color: var(--text-dim);
  font-size: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.layout-setting {
  padding: 0;
}
.layout-setting > summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
}
.layout-setting > summary::after {
  content: '⌄';
  margin-left: auto;
  color: var(--text-dim);
  transition: rotate 180ms;
}
.layout-setting[open] > summary::after {
  rotate: 180deg;
}
.layout-setting > summary small {
  font-size: 12px;
  color: var(--text-dim);
  font-weight: 400;
}
.layout-setting-body {
  padding: 0 18px 14px;
}
.layout-setting .layout-head {
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.layout-setting .layout-head h3 {
  display: none;
}
.layout-setting .image-preview {
  height: 90px;
  max-width: 320px;
}
.layout-setting .bg-row {
  margin: 8px 0;
  gap: 8px;
}
.layout-setting .carousel-list {
  grid-template-columns: minmax(0, 1fr);
}
.carousel-reorder-hint {
  font-size: var(--text-xs);
  line-height: 1.65;
  margin: 12px 0 6px;
}
.launch-carousel-list {
  max-height: none;
  overflow: visible;
}
.launch-carousel-list li {
  flex-wrap: nowrap;
  gap: 12px;
  background: var(--card-2);
  transition:
    border-color 160ms,
    background 160ms;
}
.launch-carousel-list li.dragging {
  opacity: 0.55;
}
.launch-carousel-list li.drop-target {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.launch-carousel-list .carousel-drag-handle {
  flex: none;
  cursor: grab;
  color: var(--text-dim);
  min-width: 28px;
}
.carousel-drag-handle:active {
  cursor: grabbing;
}
.launch-carousel-list .carousel-enabled {
  min-width: 0;
  gap: 12px;
}
.carousel-enabled input {
  appearance: none;
  width: 18px;
  height: 18px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--card);
  cursor: pointer;
  display: grid;
  place-content: center;
}
.carousel-enabled input:checked {
  border-color: var(--accent);
  background: var(--accent);
}
.carousel-enabled input:checked::after {
  content: '';
  width: 8px;
  height: 4px;
  border: solid var(--on-accent, #fff);
  border-width: 0 0 2px 2px;
  transform: rotate(-45deg) translateY(-1px);
}
.carousel-enabled input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.launch-carousel-list .carousel-enabled span {
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.launch-carousel-list .slide-duration {
  flex: none;
  color: var(--text-dim);
  gap: 6px;
}
.slide-duration input.input {
  width: 74px;
  background: var(--card);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font: inherit;
  font-variant-numeric: tabular-nums;
}
.carousel-row-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
.launch-carousel-list .carousel-row-actions button {
  min-width: 28px;
}
.carousel-remove {
  color: var(--text-dim);
}
.carousel-remove:hover {
  color: var(--danger);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.slider {
  flex: 1;
  min-width: 120px;
  height: 20px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;

  -webkit-appearance: none;
  appearance: none;
  /* 已填充百分比；由模板通过 :style 传入 */
  --fill: 0%;
}

/* 轨道：WebKit */
.slider::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--accent) 0,
    var(--accent) var(--fill),
    color-mix(in srgb, var(--text) 12%, transparent) var(--fill),
    color-mix(in srgb, var(--text) 12%, transparent) 100%
  );
}

/* 滑块：WebKit */
.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -4px; /* (6 - 14) / 2，让 thumb 与轨道居中对齐 */
  border: 2px solid var(--accent);
  border-radius: 50%;
  background: var(--card-solid, #fff);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
  transition: transform 120ms ease;
}

.slider:hover::-webkit-slider-thumb {
  transform: scale(1.15);
}

.slider:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
  border-radius: 6px;
}

/* 轨道 + 已填充：Firefox */
.slider::-moz-range-track {
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 12%, transparent);
}

.slider::-moz-range-progress {
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
}

/* 滑块：Firefox */
.slider::-moz-range-thumb {
  width: 10px;
  height: 10px;
  border: 2px solid var(--accent);
  border-radius: 50%;
  background: var(--card-solid, #fff);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
  transition: transform 120ms ease;
}

.slider:hover::-moz-range-thumb {
  transform: scale(1.15);
}
@media (max-width: 760px) {
  .launch-carousel-list li {
    flex-wrap: wrap;
    gap: 8px;
  }
  .launch-carousel-list .carousel-enabled {
    flex: 1;
    min-width: 150px;
  }
  .launch-carousel-list .slide-duration {
    margin-left: 40px;
  }
  .carousel-row-actions {
    margin-left: auto;
  }
}
@media (max-width: 600px) {
  .layout-setting > summary {
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .layout-setting > summary small {
    flex-basis: 80%;
  }
}
</style>
