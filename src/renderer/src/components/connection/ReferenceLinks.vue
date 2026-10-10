<script setup lang="ts">
defineProps<{ links: { label: string; url: string }[] }>();
import { t } from '@renderer/i18n';
</script>
<template>
  <nav class="reference-links" :aria-label="t('server.related_links')" data-ui="connection:reference-links">
    <a v-for="link in links" :key="link.url" :href="link.url" target="_blank" rel="noopener noreferrer" :title="link.url">
      {{ link.label }}<span aria-hidden="true">↗</span>
    </a>
    <slot />
  </nav>
</template>
