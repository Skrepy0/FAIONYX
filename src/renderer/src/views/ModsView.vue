<script setup lang="ts">
import { computed } from 'vue';
import { t } from '@renderer/i18n';
import FileManager from '../components/FileManager.vue';

const icon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>';
const title = computed(() => t('files.mods.title'));
const openLabel = computed(() => t('files.mods.open_folder'));
const emptyText = computed(() => t('files.mods.empty'));
</script>

<template>
  <FileManager :title="title" rel="mods" :open-label="openLabel" :empty-text="emptyText" :icon="icon" />
</template>
