<script setup lang="ts">
import { ref } from 'vue';
import { store, toast } from '../store';
import { saveSettings, errText } from '../api';
import { t } from '@renderer/i18n';
import type { MemoryOrganizeResult } from '@shared/memoryOrganizer';
const emit = defineEmits<{ refresh: [] }>(),
  busy = ref(false),
  result = ref<MemoryOrganizeResult>();
const windows = window.faionyx.platform === 'win32';
async function run() {
  if (busy.value) return;
  busy.value = true;
  try {
    result.value = (await window.faionyx.invoke('memory:organize')) as MemoryOrganizeResult;
    emit('refresh');
  } catch (e) {
    toast(errText(e), 'error');
  } finally {
    busy.value = false;
  }
}
async function toggle(e: Event) {
  const on = (e.target as HTMLInputElement).checked;
  try {
    await saveSettings({ memoryOrganizeBeforeLaunch: on });
    store.settings!.memoryOrganizeBeforeLaunch = on;
  } catch (e) {
    toast(errText(e), 'error');
  }
}
</script>
<template>
  <div class="memory-organizer">
    <template v-if="windows"
      ><div class="organizer-actions">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="run">
          {{ busy ? t('common.organizing') : t('common.memory_organize') }}</button
        ><label style="display: flex; gap: 5px"
          ><input :checked="store.settings?.memoryOrganizeBeforeLaunch === true" type="checkbox" @change="toggle" /><span
            style="justify-content: center; justify-items: center"
            >{{ t('common.organize_before_launch') }}</span
          ></label
        >
      </div>
      <p class="muted">{{ t('common.organize_hint') }}</p>
      <p v-if="result" role="status">
        {{
          t('common.organize_result', {
            before: String(result.beforeMB),
            after: String(result.afterMB),
            processed: String(result.processed),
            skipped: String(result.skipped),
            seconds: (result.elapsedMs / 1000).toFixed(1),
          })
        }}
      </p>
      <details v-if="result && Object.keys(result.failures).length">
        <summary>{{ t('common.skip_reasons') }}</summary>
        <p v-for="(count, reason) in result.failures" class="muted">{{ reason }}：{{ count }}</p>
      </details></template
    >
    <p v-else class="muted">{{ t('common.memory_windows_only') }}</p>
  </div>
</template>
<style scoped>
.memory-organizer {
  border-top: 1px solid var(--border);
  margin-top: 16px;
  padding-top: 12px;
  font-size: 13px;
}
.organizer-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}
.memory-organizer p {
  line-height: 1.6;
}
</style>
