<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ProjectionEntry, ProjectionFormat, ProjectionAnalysis, ProjectionChoices } from '@shared/projections';
import SelectMenu from './SelectMenu.vue';
import { errText } from '../api';
import { toast } from '../store';
import { t } from '@renderer/i18n';
const props = defineProps<{ entry: ProjectionEntry }>(),
  emit = defineEmits<{ close: []; done: [] }>();
const format = ref<ProjectionFormat>(props.entry.kind),
  version = ref(''),
  versions = ref<{ version: string; supported: boolean }[]>([]),
  analysis = ref<ProjectionAnalysis>(),
  choices = ref<ProjectionChoices>({}),
  busy = ref(false),
  error = ref(''),
  output = ref('');
let generation = 0,
  disposed = false;
const ready = computed(
  () => !!analysis.value && !analysis.value.unsupported && analysis.value.differences.every((d) => !!choices.value[d.key])
);
function invalidate() {
  generation++;
  if (analysis.value) void window.faionyx.invoke('projections:discardAnalysis', analysis.value.id);
  analysis.value = undefined;
  choices.value = {};
  error.value = '';
  output.value = '';
}
watch([format, version], invalidate);
async function analyze() {
  if (busy.value) return;
  invalidate();
  const request = ++generation;
  busy.value = true;
  try {
    const next = (await window.faionyx.invoke(
      'projections:analyze',
      props.entry.id,
      format.value,
      version.value || undefined
    )) as ProjectionAnalysis;
    if (disposed || request !== generation) {
      void window.faionyx.invoke('projections:discardAnalysis', next.id);
      return;
    }
    analysis.value = next;
  } catch (e) {
    if (!disposed && request === generation) error.value = errText(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function convert() {
  if (!ready.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = (await window.faionyx.invoke('projections:convert', analysis.value!.id, JSON.parse(JSON.stringify(choices.value)))) as {
      path: string;
      name: string;
    };
    output.value = result.path;
    analysis.value = undefined;
    emit('done');
    toast(t('pc.converted_toast'), 'success');
  } catch (e) {
    error.value = errText(e);
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  try {
    versions.value = (await window.faionyx.invoke('projections:versions')) as typeof versions.value;
  } catch (e) {
    error.value = errText(e);
  }
});
onUnmounted(() => {
  disposed = true;
  invalidate();
});
</script>
<template>
  <Teleport to="body"
    ><div class="modal-mask" @keydown.esc="!busy && emit('close')">
      <section class="modal conversion" role="dialog" aria-modal="true" :aria-label="t('pc.title')">
        <header>
          <h2>{{ t('pc.title') }}</h2>
          <button class="btn btn-ghost" :disabled="busy" :aria-label="t('pc.close')" @click="emit('close')">×</button>
        </header>
        <p class="muted">{{ entry.name }} · {{ t('pc.keep_original') }}</p>
        <div class="targets">
          <label
            >{{ t('pc.target_format')
            }}<SelectMenu
              v-model="format"
              :disabled="busy"
              :options="['litematic', 'schem', 'schematic', 'nbt'].map((v) => ({ value: v, label: '.' + v }))" /></label
          ><label
            >{{ t('pc.target_version')
            }}<SelectMenu
              v-model="version"
              :disabled="busy"
              :options="[
                { value: '', label: t('pc.keep_version') },
                ...versions.map((v) => ({ value: v.version, label: v.version + (v.supported ? '' : ' · ' + t('pc.not_supported')) })),
              ]"
          /></label>
        </div>
        <button class="btn btn-gold" :disabled="busy" @click="analyze">{{ busy ? t('pc.analyzing') : t('pc.analyze') }}</button>
        <p class="muted">{{ t('pc.task_center_hint') }}</p>
        <p v-if="error" class="failed" role="alert">{{ error }}</p>
        <template v-if="analysis"
          ><p v-if="analysis.unsupported" class="failed" role="alert">{{ analysis.unsupported }}</p>
          <template v-else
            ><p>{{ t('pc.blocks_diffs', { blocks: analysis.blocks, diffs: analysis.differences.length }) }}</p>
            <div v-for="d in analysis.differences" :key="d.key" class="difference">
              <strong>{{ d.description }}</strong
              ><span class="muted">{{ t('pc.count_label', { count: d.count }) }}</span
              ><label v-if="d.discardOnly"
                ><input
                  type="checkbox"
                  :checked="choices[d.key] === 'discard'"
                  @change="choices[d.key] = ($event.target as HTMLInputElement).checked ? 'discard' : ''"
                />{{ t('pc.discard_confirm') }}</label
              ><template v-else
                ><SelectMenu
                  :model-value="choices[d.key] === 'discard' ? 'discard' : choices[d.key] ? 'replace' : ''"
                  :options="[
                    { value: '', label: t('pc.choose_action') },
                    { value: 'discard', label: t('pc.discard_air') },
                    { value: 'replace', label: t('pc.manual_replace') },
                  ]"
                  @update:model-value="choices[d.key] = $event === 'replace' ? d.replacement || 'minecraft:air' : $event" /><input
                  v-if="choices[d.key] && choices[d.key] !== 'discard'"
                  v-model="choices[d.key]"
                  class="input"
                  :aria-label="t('pc.replace_state')"
                  :placeholder="t('pc.replace_placeholder')"
              /></template>
            </div>
            <button class="btn btn-gold" :disabled="!ready || busy" @click="convert">{{ t('pc.confirm_generate') }}</button></template
          ></template
        >
        <p v-if="output" role="status" class="output">{{ t('pc.output_label', { path: output }) }}<br />{{ t('pc.output_hint') }}</p>
      </section>
    </div></Teleport
  >
</template>
<style scoped>
.conversion {
  width: min(760px, 92vw);
  max-height: 90vh;
  overflow: auto;
  padding: 24px;
}
.conversion header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.conversion h2 {
  margin: 0;
}
.targets {
  display: grid;
  grid-template-columns: 1fr 1.5fr;
  gap: 16px;
  margin: 16px 0;
}
.targets label {
  display: grid;
  gap: 8px;
}
.difference {
  display: grid;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding: 14px 0;
  overflow-wrap: anywhere;
}
.conversion > .btn {
  margin-top: 16px;
}
.failed {
  color: var(--danger, #e05260);
}
.output {
  overflow-wrap: anywhere;
  line-height: 1.7;
}
@media (max-width: 650px) {
  .targets {
    grid-template-columns: 1fr;
  }
}
</style>
