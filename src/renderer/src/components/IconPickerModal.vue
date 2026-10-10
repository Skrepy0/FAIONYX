<script setup lang="ts">
/**
 * 实例头像选择弹窗：默认图标 / MC 生物头像网格（83 种）/ 上传自定义图片
 */
import { ref } from 'vue';
import { setVersionIcon, uploadVersionIcon, errText } from '../api';
import { refreshInstalled, toast } from '../store';
import { MOB_ICONS } from '../mobIcons';
import { t } from '@renderer/i18n';

const props = defineProps<{
  open: boolean;
  folder?: string;
  versionId: string;
  currentIcon?: string;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const busy = ref(false);

async function pick(icon: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    await setVersionIcon(props.versionId, icon, props.folder);
    await refreshInstalled();
    toast(icon ? t('ip.icon_updated') : t('ip.reset_default'), 'success');
    emit('close');
  } catch (e) {
    toast(t('ip.set_failed', { error: errText(e) }), 'error');
  } finally {
    busy.value = false;
  }
}

async function onUpload() {
  if (busy.value) return;
  busy.value = true;
  try {
    const icon = await uploadVersionIcon(props.versionId, props.folder);
    if (icon) {
      await refreshInstalled();
      toast(t('ip.custom_applied'), 'success');
      emit('close');
    }
  } catch (e) {
    toast(t('ip.upload_failed', { error: errText(e) }), 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @pointerdown.self="emit('close')">
      <div class="modal iconpick-modal">
        <h3 class="modal-title">{{ t('ip.title') }}</h3>

        <div class="iconpick-top">
          <button class="btn btn-ghost" :disabled="busy" @click="pick('')">{{ t('ip.reset_default') }}</button>
          <button class="btn btn-gold" :disabled="busy" @click="onUpload">{{ t('ip.upload_custom') }}</button>
        </div>

        <p class="modal-label">{{ t('ip.mc_mob_icons') }}</p>
        <div class="mob-grid">
          <button
            v-for="m in MOB_ICONS"
            :key="m.id"
            class="mob-cell"
            :class="{ active: currentIcon === 'mob:' + m.id }"
            :title="t(m.name)"
            :disabled="busy"
            @click="pick('mob:' + m.id)"
          >
            <img :src="`mobs/${m.id}.png`" :alt="t(m.name)" loading="lazy" />
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.iconpick-modal {
  width: 560px;
  max-height: 82vh;
  overflow-y: auto;
}
.modal-title {
  font-size: var(--text-lg);
  font-weight: 700;
  margin: 0 0 var(--space-4);
}
.iconpick-top {
  display: flex;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.iconpick-top .btn {
  flex: 1;
}
.modal-label {
  font-size: var(--text-sm);
  color: var(--text-dim);
  margin: 0 0 var(--space-2);
}
.mob-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  gap: var(--space-2);
}
.mob-cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card-2);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    transform 0.12s ease;
}
.mob-cell:hover {
  border-color: var(--accent);
  transform: scale(1.06);
}
.mob-cell.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.mob-cell img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
</style>
