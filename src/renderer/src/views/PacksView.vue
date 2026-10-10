<script setup lang="ts">
import { computed } from 'vue';
import { t } from '@renderer/i18n';
import FileManager from '../components/FileManager.vue';

const icon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const title = computed(() => t('files.packs.title'));
const openLabel = computed(() => t('files.packs.open_folder'));
const emptyText = computed(() => t('files.packs.empty'));
</script>

<template>
  <FileManager :title="title" rel="resourcepacks" :open-label="openLabel" :empty-text="emptyText" :icon="icon" />
</template>
