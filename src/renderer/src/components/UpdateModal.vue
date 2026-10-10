<script setup lang="ts">
/**
 * 启动器更新弹窗：发现新版本 / 下载中 / 下载完成 三态。
 */
import { computed, ref } from 'vue';
import UpdateDialogShell from './UpdateDialogShell.vue';
import type { ReleaseInfo } from '@shared/types';
import { QQ_GROUP_HINT } from '@shared/branding';
import { renderMarkdownLite } from '../markdownLite';
import { usePlatformUpdate } from '../composables/usePlatformUpdate';
import { t } from '@renderer/i18n';
const { systemInstaller, installAction, installExplanation } = usePlatformUpdate();

const props = defineProps<{
  release: ReleaseInfo;
  currentVersion: string;
  /** found=发现新版本；downloading=下载中；done=下载完成待安装 */
  state: 'found' | 'downloading' | 'done';
  /** 下载进度 0-1 与速度文本（downloading 态） */
  percent?: number;
  speedText?: string;
  bytesText?: string;
  etaText?: string;
  /** 低速提示（30s<100KB/s 出现一次） */
  slowHint?: boolean;
  /** 回退模式（文案微调） */
  rollback?: boolean;
}>();

const emit = defineEmits<{
  (e: 'updateNow'): void;
  (e: 'later'): void;
  (e: 'skip'): void;
  (e: 'cancelDownload'): void;
  (e: 'installNow'): void;
  (e: 'close'): void;
}>();

const bodyHtml = computed(() =>
  renderMarkdownLite(
    (props.release.body || '').replace(/^\s*(?:#{1,4}\s*)?FAIONYX\s+v?[\d.]+\s*(?:\r?\n|$)/i, '').trim() || t('um.no_notes')
  )
);
const dateText = computed(() => {
  const d = new Date(props.release.publishedAt);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
});
const sizeText = computed(() => {
  const s = props.release.assetSize;
  if (!s) return '';
  return s >= 1048576 ? `${(s / 1048576).toFixed(1)} MB` : `${Math.round(s / 1024)} KB`;
});
</script>

<template>
  <UpdateDialogShell
    :label="rollback ? t('um.rollback_label') : t('um.update_label')"
    @dismiss="state === 'found' ? emit('later') : state === 'done' ? emit('close') : undefined"
  >
    <template #header>
      <div class="upd-head">
        <div>
          <p class="upd-eyebrow">FAIONYX · {{ rollback ? t('um.rollback') : t('um.software_update') }}</p>
          <h3 class="upd-title">
            {{
              state === 'found'
                ? rollback
                  ? t('um.rollback_to')
                  : t('um.new_version')
                : state === 'downloading'
                  ? t('um.downloading')
                  : t('um.ready_install')
            }}
            v{{ release.version }}
          </h3>
        </div>
        <button
          v-if="state !== 'downloading'"
          class="icon-btn"
          :aria-label="state === 'found' ? t('um.later') : t('um.close')"
          @click="state === 'found' ? emit('later') : emit('close')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="upd-meta">
        <span>{{ t('um.current') }} v{{ currentVersion }}</span
        ><span v-if="dateText">{{ dateText }}</span
        ><span v-if="sizeText">{{ sizeText }}</span>
      </div>
    </template>
    <template v-if="state === 'found'">
      <p v-if="rollback" class="upd-slow">
        {{ systemInstaller ? t('um.rollback_warn_installer') : t('um.rollback_warn_backup') }}
      </p>
      <h4 class="upd-section-title">{{ rollback ? t('um.this_version_notes') : t('um.update_notes') }}</h4>
      <div class="upd-body" v-html="bodyHtml"></div>
    </template>
    <template v-else-if="state === 'downloading'">
      <div class="upd-download-status">
        <strong>{{ Math.round((percent ?? 0) * 100) }}%</strong><span class="muted">{{ speedText }}</span>
      </div>
      <div
        class="upd-progress"
        role="progressbar"
        :aria-label="t('um.download_progress')"
        :aria-valuenow="Math.round((percent ?? 0) * 100)"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="upd-progress-bar" :style="{ width: Math.max(0, Math.min(100, Math.round((percent ?? 0) * 100))) + '%' }"></div>
      </div>
      <p class="upd-meta">
        <span>{{ bytesText }}</span
        ><span>{{ etaText }}</span>
      </p>
      <p class="muted upd-note">{{ t('um.download_center_note') }}</p>
      <p v-if="slowHint" class="upd-slow">{{ t('um.slow_hint') }}</p>
    </template>
    <p v-else class="upd-done-text">{{ installExplanation }}</p>
    <details v-if="state !== 'done'" class="upd-help" :open="slowHint || undefined">
      <p class="muted">{{ t('um.shortcut_note') }}</p>
    </details>
    <template #footer>
      <div class="upd-actions">
        <template v-if="state === 'found'"
          ><button v-if="!rollback" class="upd-skip" @click="emit('skip')">{{ t('um.skip_version') }}</button>
          <div class="upd-actions-right">
            <button class="btn btn-ghost" @click="emit('later')">{{ t('um.later') }}</button
            ><button class="btn btn-gold" @click="emit('updateNow')">{{ rollback ? t('um.confirm_rollback') : t('um.update_now') }}</button>
          </div></template
        >
        <div v-else-if="state === 'downloading'" class="upd-actions-right">
          <button class="btn btn-ghost" @click="emit('cancelDownload')">{{ t('um.cancel_download') }}</button>
        </div>
        <div v-else class="upd-actions-right">
          <button class="btn btn-ghost" @click="emit('close')">{{ t('um.later_short') }}</button
          ><button class="btn btn-gold" @click="emit('installNow')">{{ installAction }}</button>
        </div>
      </div>
    </template>
  </UpdateDialogShell>
</template>

<style scoped>
.upd-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.upd-eyebrow {
  font-size: 12px;
  color: var(--text-dim);
  margin: 0 0 6px;
}
.upd-title {
  margin: 0;
  font-size: 22px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.upd-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.upd-section-title {
  font-size: 13px;
  color: var(--text-dim);
  margin: 0 0 10px;
}
.upd-body {
  font-size: 14px;
  line-height: 1.8;
}
.upd-body :deep(h4) {
  margin: 16px 0 8px;
  font-size: 14px;
}
.upd-body :deep(ul) {
  margin: 0;
  padding-left: 20px;
}
.upd-body :deep(li) {
  margin: 8px 0;
  padding-left: 2px;
}
.upd-body :deep(p) {
  margin: 8px 0;
}
.upd-body :deep(code) {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--hover);
  font-size: 12px;
}
.upd-body :deep(a) {
  color: var(--accent-2);
}
.upd-help {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.upd-help summary {
  cursor: pointer;
  color: var(--text-dim);
  width: fit-content;
}
.upd-help p {
  margin: 12px 0;
}
.upd-qq-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.upd-slow {
  padding: 12px 14px;
  margin: 0 0 18px;
  border-radius: 10px;
  font-size: 13px;
  background: var(--danger-soft);
  color: var(--danger);
  border: 1px solid var(--danger-border);
}
.upd-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.upd-actions-right {
  display: flex;
  gap: 10px;
  margin-left: auto;
  flex-wrap: wrap;
}
.upd-skip {
  border: 0;
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 8px 0;
}
.upd-skip:hover {
  color: var(--text);
}
.upd-progress {
  height: 8px;
  border-radius: 99px;
  background: var(--hover);
  overflow: hidden;
  margin: 14px 0;
}
.upd-progress-bar {
  height: 100%;
  border-radius: 99px;
  background: var(--accent-grad);
  transition: width var(--motion-normal) var(--ease-out);
}
.upd-download-status {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-variant-numeric: tabular-nums;
}
.upd-download-status strong {
  font-size: 28px;
}
.upd-note {
  font-size: 12px;
  margin-top: 18px;
}
.upd-done-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.8;
}
</style>
