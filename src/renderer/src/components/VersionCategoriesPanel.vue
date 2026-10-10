<script setup lang="ts">
import { nextTick, reactive, ref, watch } from 'vue';
import type { VersionCategory, VersionCategoryAction } from '@shared/types';
import { t } from '@renderer/i18n';

const props = defineProps<{ open: boolean; categories: VersionCategory[]; counts: Record<string, number>; busy: boolean; error: string }>();
const emit = defineEmits<{ close: []; action: [action: VersionCategoryAction] }>();
const panel = ref<HTMLElement | null>(null),
  name = ref(''),
  renaming = reactive({ id: '', name: '' }),
  deleting = ref<VersionCategory | null>(null);
let returnFocus: HTMLElement | null = null;
watch(
  () => props.open,
  async (open) => {
    if (open) {
      returnFocus = document.activeElement as HTMLElement | null;
      name.value = '';
      renaming.id = '';
      deleting.value = null;
      await nextTick();
      panel.value?.querySelector<HTMLInputElement>('input')?.focus();
    } else returnFocus?.focus();
  }
);
function close() {
  if (!props.busy) emit('close');
}
watch(deleting, async (value) => {
  await nextTick();
  if (value) panel.value?.querySelector<HTMLButtonElement>('[data-ui="games:category-delete-cancel"]')?.focus();
  else panel.value?.querySelector<HTMLInputElement>('input')?.focus();
});
function trapFocus(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    if (!props.busy) {
      if (deleting.value) deleting.value = null;
      else close();
    }
    return;
  }
  if (event.key !== 'Tab') return;
  const items = [
    ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]'),
  ];
  if (!items.length) return;
  const edge = event.shiftKey ? items[0] : items.at(-1);
  if (document.activeElement === edge) {
    event.preventDefault();
    (event.shiftKey ? items.at(-1) : items[0])?.focus();
  }
}
function create() {
  if (!props.busy && name.value.trim()) emit('action', { type: 'create', name: name.value });
}
function rename() {
  if (!props.busy && renaming.id && renaming.name.trim()) emit('action', { type: 'rename', id: renaming.id, name: renaming.name });
}
watch(
  () => props.categories,
  (categories) => {
    if (renaming.id && categories.find((c) => c.id === renaming.id)?.name === renaming.name.trim()) renaming.id = '';
    if (deleting.value && !categories.some((c) => c.id === deleting.value?.id)) deleting.value = null;
    if (name.value.trim() && categories.some((c) => c.name === name.value.trim())) name.value = '';
  }
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" data-ui="games:category-manager" @pointerdown.self="close">
      <section
        ref="panel"
        class="modal category-manager"
        :role="deleting ? 'alertdialog' : 'dialog'"
        aria-modal="true"
        aria-labelledby="version-category-title"
        @keydown="trapFocus"
      >
        <header class="category-header">
          <h3 id="version-category-title" class="modal-title">{{ deleting ? t('vcp.delete_title') : t('vcp.manage_title') }}</h3>
          <button class="btn btn-ghost" :disabled="busy" :aria-label="t('vcp.close_aria')" @click="close">×</button>
        </header>
        <div v-if="deleting" class="category-content">
          <p>{{ t('vcp.delete_hint', { name: deleting.name }) }}</p>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
        </div>
        <div v-else class="category-content">
          <p class="muted">{{ t('vcp.hint') }}</p>
          <form class="category-create" @submit.prevent="create">
            <label for="version-category-name">{{ t('vcp.new_label') }}</label>
            <div>
              <input
                id="version-category-name"
                v-model="name"
                class="input"
                maxlength="40"
                :placeholder="t('vcp.new_placeholder')"
                :disabled="busy"
              /><button class="btn btn-gold" :disabled="busy || !name.trim()">{{ t('vcp.new_btn') }}</button>
            </div>
          </form>
          <p v-if="!categories.length" class="category-empty muted">{{ t('vcp.empty_hint') }}</p>
          <ul v-else class="category-list" :aria-label="t('vcp.self_created_aria')">
            <li v-for="category in categories" :key="category.id">
              <form v-if="renaming.id === category.id" class="category-rename" @submit.prevent="rename">
                <input
                  v-model="renaming.name"
                  class="input"
                  maxlength="40"
                  :aria-label="t('vcp.rename_field_aria', { name: category.name })"
                  :disabled="busy"
                /><button class="btn btn-gold btn-sm" :disabled="busy || !renaming.name.trim() || renaming.name.trim() === category.name">
                  {{ t('vcp.save') }}</button
                ><button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="renaming.id = ''">
                  {{ t('common.cancel') }}
                </button>
              </form>
              <template v-else
                ><div class="category-name">
                  <strong>{{ category.name }}</strong
                  ><span class="muted">{{ counts[category.id] || 0 }} {{ t('vcp.instances_count') }}</span>
                </div>
                <div class="category-actions">
                  <button
                    class="btn btn-ghost btn-sm"
                    :disabled="busy"
                    :aria-label="t('vcp.rename_category_aria', { name: category.name })"
                    @click="
                      renaming.id = category.id;
                      renaming.name = category.name;
                    "
                  >
                    {{ t('vcp.rename') }}</button
                  ><button
                    class="btn btn-ghost btn-sm"
                    :disabled="busy"
                    :aria-label="t('vcp.delete_category_aria', { name: category.name })"
                    @click="deleting = category"
                  >
                    {{ t('common.remove') }}
                  </button>
                </div></template
              >
            </li>
          </ul>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
        </div>
        <footer v-if="deleting" class="modal-actions category-footer">
          <button class="btn btn-ghost" data-ui="games:category-delete-cancel" :disabled="busy" @click="deleting = null">
            {{ t('common.cancel') }}</button
          ><button
            class="btn btn-danger"
            data-ui="games:category-delete-confirm"
            :disabled="busy"
            @click="emit('action', { type: 'remove', id: deleting.id })"
          >
            {{ busy ? t('vcp.deleting') : t('vcp.delete_only') }}
          </button>
        </footer>
        <footer v-else class="modal-actions category-footer">
          <button class="btn btn-ghost" :disabled="busy" @click="close">{{ t('common.done') }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.category-manager {
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  padding: 0;
  overflow: hidden;
}
.category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 12px;
  gap: 12px;
}
.category-header .modal-title {
  margin: 0;
}
.category-content {
  overflow: auto;
  padding: 0 24px 16px;
  min-height: 0;
}
.category-content > p {
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.category-create > label {
  display: block;
  margin: 16px 0 8px;
}
.category-create > div,
.category-rename {
  display: flex;
  gap: 8px;
  align-items: center;
}
.category-create input,
.category-rename input {
  min-width: 0;
  flex: 1;
}
.category-list {
  padding: 0;
  list-style: none;
  margin: 18px 0 0;
}
.category-list > li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.category-name {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.category-name strong {
  overflow-wrap: anywhere;
}
.category-name span {
  font-size: 12px;
}
.category-actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}
.category-rename {
  width: 100%;
  flex-wrap: wrap;
}
.category-footer {
  border-top: 1px solid var(--border);
  padding: 14px 24px;
  margin: 0;
}
.category-empty {
  padding: 16px 0;
}
@media (max-width: 600px) {
  .category-header,
  .category-content {
    padding-left: 16px;
    padding-right: 16px;
  }
  .category-list > li {
    flex-wrap: wrap;
  }
  .category-rename input {
    flex-basis: 100%;
  }
}
</style>
