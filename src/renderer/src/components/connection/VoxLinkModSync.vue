<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { InstanceTarget } from '@shared/instanceCenter';
import type { ModSyncPlan, ModSyncScope, ModSyncGate, ModSyncGateResult } from '@shared/voxlinkMods';
import UpdateDialogShell from '../UpdateDialogShell.vue';
import { t } from '@renderer/i18n';
const props = defineProps<{ code: string; target?: InstanceTarget }>();
const emit = defineEmits<{ join: [gate: ModSyncGate]; dismiss: [] }>();
const scope = ref<ModSyncScope>('required'),
  plan = ref<ModSyncPlan | null>(null);
const busy = ref(false),
  message = ref(''),
  done = ref(false),
  selected = ref<string[]>([]);
const missing = computed(() => plan.value?.rows.filter((r) => r.status === 'missing') || []);
const progress = ref('');
let offProgress: (() => void) | undefined;
let operation = '',
  epoch = 0;
onMounted(() => {
  offProgress = window.faionyx.on('voxlink:mods:progress', (value) => {
    const p = value as { operation: string; installed: number; total: number; file: string; bytes: number; fileSize: number };
    if (p.operation === operation)
      progress.value = `${p.installed}/${p.total} · ${p.file} · ${(p.bytes / 1048576).toFixed(1)}/${(p.fileSize / 1048576).toFixed(1)} MB`;
  });
});
function cancel() {
  ++epoch;
  if (operation) void window.faionyx.invoke('voxlink:mods:cancel', operation);
  operation = '';
  busy.value = false;
}
function dismiss() {
  cancel();
  emit('dismiss');
}
function cancelDownload() {
  if (operation) void window.faionyx.invoke('voxlink:mods:cancel', operation);
  message.value = t('voxlink.mods.canceling');
}
function join(gate: ModSyncGate = 'BYPASSED') {
  cancel();
  if (gate === 'BYPASSED') void window.faionyx.invoke('voxlink:mods:bypass', props.code);
  emit('join', gate);
}
async function check() {
  if (!props.target || busy.value) return;
  const current = ++epoch;
  operation = crypto.randomUUID();
  busy.value = true;
  message.value = '';
  plan.value = null;
  try {
    const result = (await window.faionyx.invoke('voxlink:mods:check', {
      operation,
      code: props.code,
      scope: scope.value,
      target: props.target,
    })) as ModSyncPlan | ModSyncGateResult;
    if (current !== epoch) return;
    if (result.gate && result.gate !== 'MANIFEST') {
      join(result.gate);
      return;
    }
    const manifest = result as ModSyncPlan;
    if (!manifest.unknownMods.length && manifest.rows.every((r) => r.status === 'installed')) {
      join('MANIFEST');
      return;
    }
    plan.value = manifest;
    selected.value = missing.value.map((r) => r.entry.sha1);
  } catch (error) {
    if (current === epoch) message.value = (error as Error).message;
  } finally {
    if (current === epoch) busy.value = false;
  }
}
async function download() {
  if (!plan.value || busy.value) return;
  const current = ++epoch;
  operation = crypto.randomUUID();
  busy.value = true;
  message.value = '';
  try {
    const result = (await window.faionyx.invoke('voxlink:mods:download', { operation, plan: plan.value.id, selected: selected.value })) as {
      message: string;
    };
    if (current !== epoch) return;
    done.value = true;
    message.value = result.message;
  } catch (error) {
    if (current === epoch) message.value = (error as Error).message;
  } finally {
    if (current === epoch) busy.value = false;
  }
}
onUnmounted(() => {
  cancel();
  offProgress?.();
});
</script>
<template>
  <UpdateDialogShell :label="t('voxlink.mods.shell_label')" @dismiss="dismiss">
    <template #header
      ><h2>{{ t('voxlink.mods.sync_mods_with_host') }}</h2>
      <button class="btn btn-ghost" :aria-label="t('common.close')" @click="dismiss">×</button></template
    >
    <p class="connection-muted">{{ t('voxlink.mods.room_label') }} {{ code }} · {{ target?.id || t('voxlink.mods.no_target_selected') }}</p>
    <p v-if="target" class="mod-path">{{ target.folder }}</p>
    <p v-if="!target">{{ t('voxlink.mods.return_select_instance') }}</p>
    <fieldset v-if="!plan" :disabled="busy" class="mod-scopes">
      <legend>{{ t('voxlink.mods.fetch_scope') }}</legend>
      <label
        ><input v-model="scope" type="radio" value="required" /> {{ t('voxlink.mods.required_mods') }}
        <small>{{ t('voxlink.mods.required_mods_hint') }}</small></label
      >
      <label
        ><input v-model="scope" type="radio" value="all" /> {{ t('voxlink.mods.all_mods') }}
        <small>{{ t('voxlink.mods.all_mods_hint') }}</small></label
      >
    </fieldset>
    <p v-if="busy" role="status">{{ plan ? t('voxlink.mods.downloading_and_verifying') : t('voxlink.mods.checking_host_manifest') }}</p>
    <p v-if="busy && progress" class="connection-muted" role="status">{{ progress }}</p>
    <template v-if="plan && !done">
      <p class="connection-muted">
        {{ t('voxlink.mods.host_env', { mcVersion: plan.mcVersion, loader: plan.loader }) }}。{{
          t('voxlink.mods.disable_or_conflict_manual')
        }}
      </p>
      <ul class="mod-rows">
        <li
          v-for="row in plan.rows"
          :key="row.entry.sha1"
          :class="{ warning: ['conflict', 'unresolved', 'disabled'].includes(row.status) }"
        >
          <input
            v-if="row.status === 'missing'"
            v-model="selected"
            type="checkbox"
            :value="row.entry.sha1"
            :disabled="busy"
            :aria-label="t('voxlink.mods.download_n', { title: row.entry.title })"
          />
          <div>
            <strong>{{ row.entry.title || row.entry.fileName }}</strong
            ><small>{{ row.entry.versionNumber }} · {{ row.reason }}</small>
          </div>
        </li>
        <li v-for="name in plan.unknownMods" :key="name" class="warning">
          <div>
            <strong>{{ name }}</strong
            ><small>{{ t('voxlink.mods.unable_identify_confirm_host') }}</small>
          </div>
        </li>
      </ul>
    </template>
    <p v-if="message" :class="done ? 'connection-muted' : 'connection-error'" role="status">{{ message }}</p>
    <template #footer>
      <button class="btn btn-ghost" @click="busy && plan ? cancelDownload() : dismiss()">
        {{ busy ? t('common.cancel') : t('common.back') }}
      </button>
      <button class="btn btn-ghost" :disabled="busy && !!plan" @click="join()">
        {{ done ? t('voxlink.mods.known_restart_continue') : busy ? t('voxlink.mods.skip_check_join') : t('voxlink.mods.join_directly') }}
      </button>
      <button v-if="!plan" class="btn btn-gold" :disabled="busy || !target" @click="check">{{ t('voxlink.mods.check_mods') }}</button>
      <button v-else-if="!done && missing.length" class="btn btn-gold" :disabled="busy || !selected.length" @click="download">
        {{ t('voxlink.mods.download_selected', { count: selected.length }) }}
      </button>
    </template>
  </UpdateDialogShell>
</template>
<style scoped>
.mod-path {
  color: var(--text-dim);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
.mod-scopes {
  display: grid;
  gap: 12px;
  border: 0;
  padding: 16px 0;
}
.mod-scopes label {
  display: flex;
  gap: 8px;
  align-items: center;
}
.mod-scopes small {
  color: var(--text-dim);
}
.mod-rows {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 8px;
}
.mod-rows li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--card-2);
  border-radius: var(--radius-md);
}
.mod-rows div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.mod-rows small {
  display: block;
  color: var(--text-dim);
  margin-top: 4px;
}
.mod-rows .warning small {
  color: var(--danger);
}
</style>
