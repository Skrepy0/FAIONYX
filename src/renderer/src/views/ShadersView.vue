<script setup lang="ts">
import FileManager from '../components/FileManager.vue';
import { t } from '@renderer/i18n';

const icon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
</script>

<template>
  <FileManager
    :title="t('files.shaders.title')"
    rel="shaderpacks"
    :open-label="t('files.shaders.open_folder')"
    :empty-text="t('files.shaders.empty')"
    :icon="icon"
  />
</template>
