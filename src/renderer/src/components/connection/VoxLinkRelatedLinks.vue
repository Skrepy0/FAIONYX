<script setup lang="ts">
import { ref } from 'vue';
import { VOXLINK_LINKS } from '@shared/voxlinkLinks';
import UpdateDialogShell from '../UpdateDialogShell.vue';
import { t } from '@renderer/i18n';
const open = ref(false);
</script>
<template>
  <div data-ui="voxlink:related-links">
    <button class="btn btn-ghost" @click="open = true">{{ t('voxlink.related_links') }} ↗</button>
    <UpdateDialogShell v-if="open" :label="t('voxlink.related_links_shell')" @dismiss="open = false">
      <template #header
        ><h2>VoxLink · {{ t('voxlink.related_links') }}</h2>
        <p class="muted">{{ t('voxlink.links_description') }}</p></template
      >
      <nav class="links-list" :aria-label="t('voxlink.related_links_list')">
        <a v-for="link in VOXLINK_LINKS" :key="link.label" :href="link.url" target="_blank" rel="noopener noreferrer"
          ><strong>{{ link.label }} <span aria-hidden="true">↗</span></strong
          ><small>{{ link.url }}</small></a
        >
      </nav>
      <template #footer
        ><button class="btn btn-gold" @click="open = false">{{ t('common.close') }}</button></template
      >
    </UpdateDialogShell>
  </div>
</template>
<style scoped>
.links-list {
  display: grid;
  gap: 10px;
}
.links-list a {
  display: grid;
  gap: 5px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--card-2);
  color: var(--text);
  text-decoration: none;
  transition: background 0.18s;
}
.links-list a:hover {
  background: color-mix(in srgb, var(--accent) 15%, var(--card-2));
}
.links-list strong {
  display: flex;
  justify-content: space-between;
}
.links-list small {
  color: var(--text-dim);
  overflow-wrap: anywhere;
  font-size: 12px;
}
</style>
