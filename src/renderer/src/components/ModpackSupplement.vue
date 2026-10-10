<script setup lang="ts">
import { ref } from 'vue';
import type { ManualModpackRequest } from '@shared/types';
import { supplyModpackFiles, openModpackFile, errText } from '../api';
import { t } from '@renderer/i18n';
const props = defineProps<{ request: ManualModpackRequest; paused?: boolean }>();
const busy = ref(false),
  message = ref('');
async function supply() {
  busy.value = true;
  message.value = '';
  try {
    const result = await supplyModpackFiles(props.request.token);
    message.value = result.rejected.length
      ? t('ms.supplied_mismatch', { accepted: result.accepted, rejected: result.rejected.join('、') })
      : t('ms.supplied_remaining', { accepted: result.accepted, remaining: result.remaining });
  } catch (error) {
    message.value = errText(error);
  } finally {
    busy.value = false;
  }
}
async function open(fileID: number) {
  try {
    await openModpackFile(props.request.token, fileID);
  } catch (error) {
    message.value = errText(error);
  }
}
</script>
<template>
  <section class="pack-supplement" data-ui="download.modpack-supplement">
    <strong>{{ t('ms.title', { count: request.files.length }) }}</strong>
    <p>{{ t('ms.desc') }}</p>
    <div class="supplement-list">
      <div v-for="file in request.files" :key="file.fileID" class="supplement-row">
        <span :title="file.fileName">{{ file.fileName }}</span>
        <button class="btn btn-ghost btn-sm" @click="open(file.fileID)">{{ t('ms.file_page') }}</button>
      </div>
    </div>
    <button class="btn btn-gold btn-sm" :disabled="busy || paused" @click="supply">
      {{ busy ? t('ms.validating') : t('ms.select_files') }}
    </button>
    <p v-if="message" role="status">{{ message }}</p>
    <small>{{ t('ms.multi_hint') }}</small>
  </section>
</template>
<style scoped>
.pack-supplement {
  padding: 14px;
  margin-top: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--card);
  font-size: 13px;
}
.pack-supplement p {
  margin: 8px 0;
  line-height: 1.5;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.pack-supplement small {
  display: block;
  margin-top: 8px;
  color: var(--text-dim);
}
.supplement-list {
  max-height: 210px;
  overflow: auto;
  overscroll-behavior: contain;
  margin: 10px 0;
}
.supplement-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 5px 0;
  border-bottom: 1px solid var(--border);
}
.supplement-row span {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
}
.supplement-row button {
  flex-shrink: 0;
}
</style>
