<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { t } from '@renderer/i18n';

const props = withDefaults(
  defineProps<{
    label?: string;
    rows?: number;
    retry?: boolean;
    /** 超过此毫秒数仍未结束，显示"仍在等待"提示 */
    slowAfterMs?: number;
  }>(),
  {
    label: () => t('common.loading'),
    rows: 5,
    retry: false,
    slowAfterMs: 8000,
  }
);

defineEmits<{ retry: [] }>();

const slow = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

onMounted(() => {
  timer = setTimeout(() => {
    slow.value = true;
  }, props.slowAfterMs);
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="content-skeleton">
    <!-- Only this row carries live region semantics to avoid aria-busy vs status conflict -->
    <p class="skeleton-status" role="status" aria-live="polite">
      <span class="muted">{{ label }}</span>
      <template v-if="slow">
        <span class="muted skeleton-slow">{{ t('common.skeleton_loading') }}</span>
        <button v-if="retry" type="button" class="btn btn-ghost btn-sm" @click="$emit('retry')">{{ t('common.reread') }}</button>
      </template>
    </p>

    <ul class="skeleton-list" aria-hidden="true">
      <li v-for="row in rows" :key="row" class="skeleton-row"><i /><span /><b /></li>
    </ul>
  </div>
</template>

<style scoped>
.content-skeleton {
  display: grid;
  gap: 12px;
  /* 左右留白，与卡片内其它内容对齐 */
  padding: 16px var(--space-4, 16px);
}

.skeleton-status {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  min-height: 20px;
  font-size: var(--text-sm, 13px);
  /* 与骨架首行图标的左缘对齐，视觉上再"缩进一档" */
  padding-left: 2px;
}

.skeleton-slow {
  animation: skeleton-slow-in 200ms ease-out;
}
@keyframes skeleton-slow-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.skeleton-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}

.skeleton-row {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 48px;
}

/* 骨架块：统一底色 + 内嵌微光 */
.skeleton-row > * {
  position: relative;
  overflow: hidden;
  background: color-mix(in srgb, var(--text) 8%, var(--card));
  border-radius: var(--radius-sm, 6px);
}

/* 斜向微光扫过；用 nth-child 制造轻微错位，避免整块同步"喘" */
.skeleton-row > *::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--text) 14%, transparent) 50%, transparent 80%);
  transform: translateX(-100%);
  animation: skeleton-shimmer 1.4s linear infinite;
}
.skeleton-row > *:nth-child(2)::after {
  animation-delay: 0.08s;
}
.skeleton-row > *:nth-child(3)::after {
  animation-delay: 0.16s;
}

.skeleton-row i {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 50%; /* 圆形头像，与真实列表一致 */
}

.skeleton-row span {
  flex: 1;
  min-width: 0;
  height: 18px;
  max-width: 65%;
}

.skeleton-row b {
  margin-left: auto;
  width: 76px;
  height: 32px;
  flex-shrink: 0;
}

@keyframes skeleton-shimmer {
  to {
    transform: translateX(100%);
  }
}

/* 无障碍：关闭动画，保留静态灰块 */
@media (prefers-reduced-motion: reduce) {
  .skeleton-row > *::after {
    animation: none;
    transform: none;
    background: none;
  }
}
</style>
