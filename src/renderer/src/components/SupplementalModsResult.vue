<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { SupplementalFailure } from '@shared/supplementalMods';
import { store, toast, refreshInstalled } from '../store';
import { errText } from '../api';
import UpdateDialogShell from './UpdateDialogShell.vue';
import { t } from '@renderer/i18n';
const pending = ref<SupplementalFailure[]>([]),
  busy = ref(false),
  error = ref(''),
  hidden = ref(false);
const off = window.faionyx.on('mods:supplementalPending', (list: SupplementalFailure[]) => {
  pending.value = list;
  hidden.value = false;
});
onMounted(async () => {
  try {
    pending.value = await window.faionyx.invoke('mods:supplementalList');
  } catch (e) {
    toast(errText(e), 'error');
  }
});
onUnmounted(off);
async function act(retry: boolean) {
  const entry = pending.value[0];
  if (!entry || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const response = await window.faionyx.invoke(retry ? 'mods:supplementalRetry' : 'mods:supplementalKeep', entry.id, retry),
      result = retry ? response.result : undefined;
    pending.value = retry ? response.pending : response;
    store.failedInstalls.delete(entry.versionId);
    store.fsRefreshTick++;
    toast(
      result
        ? t('sr.installed_result', {
            installed: result.installed,
            dependencies: result.dependencies,
            skipped: result.skipped.length,
            dir: result.modsDirectory,
          })
        : retry
          ? t('sr.install_done')
          : t('sr.keep_base_result'),
      'success'
    );
    try {
      await refreshInstalled();
    } catch (e) {
      toast(t('sr.refresh_failed', { error: errText(e) }), 'info');
    }
  } catch (e) {
    error.value = errText(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <button v-if="pending.length && hidden" class="btn btn-ghost supplemental-pending" @click="hidden = false">
    {{ t('sr.pending', { count: pending.length }) }}</button
  ><UpdateDialogShell v-if="pending.length && !hidden" :label="t('sr.title')" @dismiss="!busy && (hidden = true)"
    ><section class="supplemental-result">
      <h2>{{ t('sr.base_kept') }}</h2>
      <p>{{ t('sr.not_all_installed', { id: pending[0].target.id }) }}</p>
      <p class="failure" role="alert">{{ error || pending[0].message }}</p>
      <p class="muted">{{ t('sr.retry_hint') }}</p>
      <div class="actions">
        <button class="btn btn-gold" :disabled="busy" @click="act(true)">{{ busy ? t('sr.processing') : t('sr.retry_mods') }}</button
        ><button class="btn btn-ghost" :disabled="busy" @click="act(false)">{{ t('sr.keep_base') }}</button
        ><button class="btn btn-ghost" :disabled="busy" @click="hidden = true">{{ t('sr.later') }}</button>
      </div>
    </section></UpdateDialogShell
  >
</template>
<style scoped>
.supplemental-pending {
  position: fixed;
  bottom: 14px;
  right: 18px;
  z-index: 100;
  background: var(--card);
  border: 1px solid var(--border);
}
.supplemental-result {
  max-width: 560px;
  padding: 26px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 18px;
}
.failure {
  color: var(--danger);
  overflow-wrap: anywhere;
}
</style>
