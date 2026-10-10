<script setup lang="ts">
import { ref, watch } from 'vue';
import { errText, resetVersionThumbnail, setVersionThumbnailFit, uploadVersionThumbnail } from '../api';
import { refreshInstalled, toast } from '../store';
import { managedImageUrl } from '../managedAssets';
import { t } from '@renderer/i18n';
import type { ImageFit } from '@shared/types';

const props = defineProps<{
  open: boolean;
  folder?: string;
  versionId: string;
  currentPath: string;
  currentFit: ImageFit;
}>();
const emit = defineEmits<{ close: [] }>();

const imagePath = ref('');
const fit = ref<ImageFit>('crop');
const busy = ref(false);
const previewFailed = ref(false);
const fitOptions: Array<{ value: ImageFit; label: string }> = [
  { value: 'fill', label: t('tp.fill') },
  { value: 'fit', label: t('tp.fit') },
  { value: 'crop', label: t('tp.crop') },
];

watch(
  () => [props.open, props.currentPath, props.currentFit] as const,
  ([open, currentPath, currentFit]) => {
    if (!open) return;
    imagePath.value = currentPath;
    fit.value = currentFit;
    previewFailed.value = false;
  },
  { immediate: true }
);

function objectFit(value: ImageFit): 'fill' | 'contain' | 'cover' {
  return value === 'fill' ? 'fill' : value === 'fit' ? 'contain' : 'cover';
}

async function importImage() {
  if (busy.value) return;
  busy.value = true;
  try {
    const imported = await uploadVersionThumbnail(props.versionId, props.folder);
    if (!imported) return;
    imagePath.value = imported;
    previewFailed.value = false;
    await refreshInstalled();
    toast(t('tp.thumb_updated'), 'success');
  } catch (error) {
    toast(t('tp.import_failed') + errText(error), 'error');
  } finally {
    busy.value = false;
  }
}

async function chooseFit(value: ImageFit) {
  if (!imagePath.value || busy.value) return;
  busy.value = true;
  try {
    await setVersionThumbnailFit(props.versionId, value, props.folder);
    fit.value = value;
    await refreshInstalled();
  } catch (error) {
    toast(t('tp.save_fit_failed') + errText(error), 'error');
  } finally {
    busy.value = false;
  }
}

async function resetImage() {
  if (busy.value) return;
  busy.value = true;
  try {
    await resetVersionThumbnail(props.versionId, props.folder);
    imagePath.value = '';
    previewFailed.value = false;
    await refreshInstalled();
    toast(t('tp.reset_done'), 'success');
  } catch (error) {
    toast(t('tp.reset_failed') + errText(error), 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @pointerdown.self="emit('close')">
      <div class="modal thumbnail-modal">
        <div class="thumbnail-head">
          <div>
            <h3 class="modal-title">{{ t('tp.title') }} · {{ versionId }}</h3>
            <p class="modal-label">{{ t('tp.instance_first') }}</p>
          </div>
          <button class="icon-btn" :aria-label="t('common.close')" @click="emit('close')">×</button>
        </div>

        <div v-if="imagePath && !previewFailed" class="thumbnail-preview">
          <img
            :src="managedImageUrl(imagePath)"
            :style="{ objectFit: objectFit(fit) }"
            alt="{{ t('tp.preview_alt') }}"
            @error="previewFailed = true"
          />
        </div>
        <div v-else class="thumbnail-preview thumbnail-empty">
          {{ previewFailed ? t('tp.image_unavailable') : t('tp.following_global') }}
        </div>

        <div class="thumbnail-actions">
          <button class="btn btn-gold" :disabled="busy" @click="importImage">
            {{ busy ? t('tp.processing') : t('tp.import') }}
          </button>
          <button class="btn btn-ghost" :disabled="busy || !imagePath" @click="resetImage">{{ t('tp.reset_default') }}</button>
        </div>

        <div class="thumbnail-fit">
          <span class="muted">{{ t('tp.fit_label') }}</span>
          <div class="thumbnail-fit-options">
            <button
              v-for="option in fitOptions"
              :key="option.value"
              class="capsule"
              :class="{ active: fit === option.value }"
              :disabled="busy || !imagePath"
              @click="chooseFit(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <p class="thumbnail-note muted">{{ t('tp.thumb_note') }}</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.thumbnail-modal {
  width: min(600px, calc(100vw - 48px));
}
.modal-title {
  font-size: var(--text-lg);
  font-weight: 700;
  margin: 0 0 var(--space-1);
}
.modal-label {
  font-size: var(--text-sm);
  color: var(--text-dim);
  margin: 0;
}
.thumbnail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}
.thumbnail-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 7;
  margin: var(--space-4) 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.thumbnail-preview img {
  width: 100%;
  height: 100%;
}
.thumbnail-empty {
  padding: var(--space-5);
  color: var(--text-dim);
  font-size: var(--text-sm);
  text-align: center;
}
.thumbnail-actions,
.thumbnail-fit,
.thumbnail-fit-options {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.thumbnail-actions {
  margin-bottom: var(--space-2);
}
.thumbnail-fit {
  justify-content: space-between;
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.thumbnail-note {
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  line-height: 1.55;
}
</style>
