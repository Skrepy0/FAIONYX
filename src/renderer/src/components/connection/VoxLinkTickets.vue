<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import UpdateDialogShell from '../UpdateDialogShell.vue';
import ConfirmModal from '../ConfirmModal.vue';
import type { TicketFileGrant, TicketResult, VoxTicketDetail } from '@shared/voxlinkTickets';
import { ticketSummaries, loadTickets } from '../../voxlinkTickets';
import { t } from '@renderer/i18n';

const emit = defineEmits<{ close: [] }>();
const detail = ref<VoxTicketDetail | null>(null),
  creating = ref(false),
  description = ref(''),
  text = ref(''),
  files = ref<TicketFileGrant[]>([]);
const busy = ref(false),
  error = ref(''),
  progress = ref(''),
  retryAt = ref(0),
  now = ref(Date.now()),
  page = ref(0),
  messagePage = ref(0),
  confirmDelete = ref(false);

const rows = computed(() => ticketSummaries.value.slice(page.value * 6, page.value * 6 + 6)),
  pages = computed(() => Math.max(1, Math.ceil(ticketSummaries.value.length / 6)));
const messages = computed(() => detail.value?.messages.slice(messagePage.value * 5, messagePage.value * 5 + 5) || []),
  messagePages = computed(() => Math.max(1, Math.ceil((detail.value?.messages.length || 0) / 5)));
const ownLast = computed(() => (detail.value ? [...detail.value.messages].reverse().find((m) => m.from !== 'admin' && m.id) : undefined));
const waitSeconds = computed(() => Math.max(0, Math.ceil((retryAt.value - now.value) / 1000)));

let operation = '',
  epoch = 0,
  off: () => void = () => {},
  timer: ReturnType<typeof setInterval>;

const time = (ms: number) => new Date(ms).toLocaleString();

function release() {
  if (files.value.length)
    void window.faionyx.invoke(
      'voxlink:tickets:release',
      files.value.map((f) => f.id)
    );
  files.value = [];
}
function close() {
  if (busy.value) return;
  release();
  emit('close');
}
function back() {
  if (busy.value) return;
  release();
  detail.value = null;
  creating.value = false;
  error.value = '';
  text.value = '';
  messagePage.value = 0;
}
function newTicket() {
  back();
  creating.value = true;
}
async function perform<T>(channel: string, payload: Record<string, unknown>): Promise<T | undefined> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  progress.value = '';
  operation = crypto.randomUUID();
  const current = ++epoch;
  try {
    const result = (await window.faionyx.invoke(channel, { ...payload, operation })) as TicketResult<T>;
    if (current !== epoch) return;
    if (result.ok) return result.value;
    error.value = result.message;
    if (result.retryAt) retryAt.value = result.retryAt;
  } catch (e) {
    if (current === epoch) error.value = (e as Error).message;
  } finally {
    if (current === epoch) {
      busy.value = false;
      operation = '';
    }
  }
}
async function open(id: string) {
  const value = await perform<VoxTicketDetail>('voxlink:tickets:detail', { id });
  if (value) {
    release();
    detail.value = value;
    creating.value = false;
    messagePage.value = messagePages.value - 1;
    await loadTickets();
  }
}
async function choose() {
  if (busy.value) return;
  try {
    const picked = (await window.faionyx.invoke('voxlink:tickets:pick')) as TicketFileGrant[];
    if (files.value.length + picked.length > 10 || files.value.concat(picked).reduce((n, f) => n + f.size, 0) > 500 * 1048576) {
      void window.faionyx.invoke(
        'voxlink:tickets:release',
        picked.map((f) => f.id)
      );
      error.value = t('voxlink.tickets.error_too_many_files');
      return;
    }
    files.value.push(...picked);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
function removeFile(file: TicketFileGrant) {
  void window.faionyx.invoke('voxlink:tickets:release', [file.id]);
  files.value = files.value.filter((f) => f.id !== file.id);
}
async function submit() {
  if (waitSeconds.value) return;
  const value = await perform<{ id: string }>('voxlink:tickets:submit', {
    description: description.value,
    attachments: files.value.map((f) => f.id),
  });
  if (value) {
    files.value = [];
    description.value = '';
    await loadTickets();
    await open(value.id);
  }
}
async function reply() {
  if (!detail.value || waitSeconds.value) return;
  const id = detail.value.id,
    value = await perform<{ id: string }>('voxlink:tickets:reply', { id, text: text.value, attachments: files.value.map((f) => f.id) });
  if (value) {
    files.value = [];
    text.value = '';
    await open(id);
  }
}
async function retract() {
  if (!detail.value || !ownLast.value?.id) return;
  const id = detail.value.id,
    result = await perform('voxlink:tickets:retract', { id, msg: ownLast.value.id });
  if (result) await open(id);
}
async function remove() {
  confirmDelete.value = false;
  if (!detail.value) return;
  const result = await perform('voxlink:tickets:delete', { id: detail.value.id });
  if (result) {
    back();
    await loadTickets();
    page.value = Math.min(page.value, pages.value - 1);
  }
}
function cancel() {
  if (operation) void window.faionyx.invoke('voxlink:tickets:cancel', operation);
}

onMounted(() => {
  void loadTickets();
  timer = setInterval(() => (now.value = Date.now()), 1000);
  off = window.faionyx.on('voxlink:tickets:progress', (value) => {
    const p = value as { operation: string; bytes: number; total: number };
    if (p.operation === operation) progress.value = `${(p.bytes / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB`;
  });
});
onUnmounted(() => {
  cancel();
  ++epoch;
  clearInterval(timer);
  off();
  release();
});
</script>

<template>
  <UpdateDialogShell :label="t('voxlink.tickets.shell_label')" @dismiss="close">
    <template #header>
      <div class="ticket-head">
        <h2>
          {{
            creating
              ? t('voxlink.tickets.submit_ticket')
              : detail
                ? t('voxlink.tickets.ticket_detail').replace('{id}', detail.id)
                : t('voxlink.tickets.my_tickets')
          }}
        </h2>
        <span v-if="!creating && !detail && ticketSummaries.length" class="ticket-count">{{ ticketSummaries.length }}</span>
        <button class="ticket-close" type="button" :disabled="busy" :aria-label="t('voxlink.tickets.close_ticket')" @click="close">
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </template>

    <!-- 统一状态条：error / busy / wait 共用一处视觉 -->
    <div v-if="error || busy || waitSeconds" class="ticket-status" :class="error ? 'is-error' : busy ? 'is-busy' : 'is-wait'" role="status">
      <span class="status-dot" aria-hidden="true"></span>
      <span class="status-text">
        <template v-if="error">{{ error }}</template>
        <template v-else-if="busy">{{
          progress ? t('voxlink.tickets.uploading') + ' ' + progress : t('voxlink.tickets.processing_request')
        }}</template>
        <template v-else-if="waitSeconds">{{ t('voxlink.tickets.wait_seconds', { seconds: waitSeconds }) }}</template>
      </span>
    </div>

    <!-- 列表页 -->
    <template v-if="!creating && !detail">
      <p class="ticket-hint">{{ t('voxlink.tickets.description_hint') }}</p>

      <div v-if="!ticketSummaries.length && !busy" class="ticket-empty">
        <svg
          viewBox="0 0 24 24"
          width="34"
          height="34"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4Z" />
        </svg>
        <p>{{ t('voxlink.tickets.no_tickets') }}</p>
      </div>

      <div v-else class="ticket-list">
        <button v-for="ticket in rows" :key="ticket.id" class="ticket-row" :disabled="busy" @click="open(ticket.id)">
          <span class="ticket-id">#{{ ticket.id }}</span>
          <span class="ticket-state" :class="{ 'is-unread': ticket.hasUnread, 'is-replied': !ticket.hasUnread && ticket.replyCount }">
            <i class="dot" aria-hidden="true"></i>
            <template v-if="ticket.hasUnread">{{ t('voxlink.tickets.has_unread') }}</template>
            <template v-else-if="ticket.replyCount">{{ t('voxlink.tickets.viewed') }}</template>
            <template v-else>{{ t('voxlink.tickets.waiting_reply') }}</template>
          </span>
          <time class="ticket-time">{{ time(ticket.lastTimeMs || ticket.timeMs) }}</time>
        </button>
      </div>

      <nav v-if="pages > 1" class="ticket-pages" aria-label="tickets">
        <button class="btn btn-ghost btn-sm" :disabled="busy || page === 0" @click="page--">{{ t('voxlink.tickets.prev_page') }}</button>
        <span class="page-indicator">{{ page + 1 }} / {{ pages }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="busy || page + 1 >= pages" @click="page++">
          {{ t('voxlink.tickets.next_page') }}
        </button>
      </nav>
    </template>

    <!-- 创建页 -->
    <template v-else-if="creating">
      <label class="ticket-field">
        <span class="field-label">{{ t('voxlink.tickets.issue_description') }}</span>
        <span class="field-input">
          <textarea
            v-model="description"
            class="input"
            maxlength="10000"
            rows="8"
            :disabled="busy"
            :placeholder="t('voxlink.tickets.placeholder_describe_issue')"
          />
          <small class="field-counter">{{ description.length }}/10000</small>
        </span>
      </label>
    </template>

    <!-- 详情页 -->
    <template v-else-if="detail">
      <div class="ticket-detail-meta">
        <span>{{ t('voxlink.tickets.ticket_detail').replace('{id}', detail.id) }}</span>
        <time>{{ time(detail.timeMs) }}</time>
      </div>

      <article class="ticket-message me">
        <header class="bubble-head">
          <span class="bubble-author">{{ t('voxlink.tickets.me_first_submission') }}</span>
        </header>
        <p>{{ detail.description }}</p>
        <ul v-if="detail.attachments.length" class="bubble-files">
          <li v-for="file in detail.attachments" :key="file.name">
            <span class="bubble-file-name">{{ file.name }}</span>
            <span class="bubble-file-size">{{ (file.size / 1048576).toFixed(1) }} MB</span>
          </li>
        </ul>
      </article>

      <article
        v-for="(message, index) in messages"
        :key="message.id || index"
        class="ticket-message"
        :class="message.from === 'admin' ? 'admin' : 'me'"
      >
        <header class="bubble-head">
          <span class="bubble-author">{{
            message.from === 'admin' ? t('voxlink.tickets.voxlink_reply') : t('voxlink.tickets.my_followup')
          }}</span>
          <time class="bubble-time">{{ time(message.timeMs) }}</time>
        </header>
        <p>{{ message.text }}</p>
        <ul v-if="message.attachments.length" class="bubble-files">
          <li v-for="file in message.attachments" :key="file.name">
            <span class="bubble-file-name">{{ file.name }}</span>
            <span class="bubble-file-size">{{ (file.size / 1048576).toFixed(1) }} MB</span>
          </li>
        </ul>
      </article>

      <nav v-if="messagePages > 1" class="ticket-pages" aria-label="messages">
        <button class="btn btn-ghost btn-sm" :disabled="busy || messagePage === 0" @click="messagePage--">
          {{ t('voxlink.tickets.earlier_messages') }}
        </button>
        <span class="page-indicator">{{ messagePage + 1 }} / {{ messagePages }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="busy || messagePage + 1 >= messagePages" @click="messagePage++">
          {{ t('voxlink.tickets.newer_messages') }}
        </button>
      </nav>

      <label class="ticket-field">
        <span class="field-label">{{ t('voxlink.tickets.supplementary_question') }}</span>
        <span class="field-input">
          <textarea v-model="text" class="input" maxlength="2000" rows="3" :disabled="busy || detail.deleted" />
          <small class="field-counter">{{ text.length }}/2000 · {{ detail.messages.length }}/200 {{ t('voxlink.tickets.messages') }}</small>
        </span>
      </label>
    </template>

    <!-- 附件选择（创建页 + 详情页共用） -->
    <template v-if="creating || detail">
      <ul v-if="files.length" class="ticket-files">
        <li v-for="file in files" :key="file.id" class="ticket-file-chip">
          <span class="chip-name" :title="file.name">{{ file.name }}</span>
          <span class="chip-size">{{ (file.size / 1048576).toFixed(1) }} MB</span>
          <button
            class="chip-remove"
            type="button"
            :disabled="busy"
            :aria-label="t('voxlink.tickets.remove_attachment').replace('{name}', file.name)"
            @click="removeFile(file)"
          >
            ×
          </button>
        </li>
      </ul>
      <div class="ticket-attach-row">
        <button class="btn btn-ghost btn-sm" :disabled="busy || files.length >= 10" @click="choose">
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.6 15.6a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          {{ t('voxlink.tickets.choose_attachment') }}
        </button>
        <small class="connection-muted">{{ t('voxlink.tickets.attachment_limit_hint') }}</small>
      </div>
    </template>

    <template #footer>
      <div class="ticket-footer">
        <button v-if="busy" class="btn" @click="cancel">{{ t('voxlink.tickets.cancel_request') }}</button>
        <template v-else>
          <button class="btn btn-ghost" @click="creating || detail ? back() : close()">
            {{ creating || detail ? t('voxlink.tickets.back_list') : t('voxlink.tickets.close') }}
          </button>
          <button v-if="detail" class="btn btn-ghost" @click="confirmDelete = true">
            {{ t('voxlink.tickets.delete_ticket') }}
          </button>
          <button v-if="detail" class="btn btn-ghost" :disabled="!ownLast?.id" @click="retract">
            {{ t('voxlink.tickets.retract_last_followup') }}
          </button>
          <button
            v-if="detail"
            class="btn btn-gold"
            :disabled="!!waitSeconds || detail.deleted || detail.messages.length >= 200 || (!text.trim() && !files.length)"
            @click="reply"
          >
            {{ t('voxlink.tickets.send_followup') }}
          </button>
          <button v-else-if="creating" class="btn btn-gold" :disabled="!!waitSeconds || !description.trim()" @click="submit">
            {{ t('voxlink.tickets.submit_ticket') }}
          </button>
          <button v-else class="btn btn-gold" @click="newTicket">{{ t('voxlink.tickets.new_ticket') }}</button>
        </template>
      </div>
    </template>
  </UpdateDialogShell>

  <ConfirmModal
    :open="confirmDelete"
    :title="t('voxlink.tickets.delete_confirm_title')"
    :message="t('voxlink.tickets.delete_confirm_message')"
    :confirm-text="t('voxlink.tickets.delete')"
    @confirm="remove"
    @cancel="confirmDelete = false"
  />
</template>

<style scoped>
/* ---------------- 头部（标题左，关闭右上） ---------------- */
.ticket-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  width: 100%;
}
.ticket-head h2 {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ticket-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 22px;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-2);
  font-size: var(--text-xs);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.ticket-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  margin-left: auto; /* 顶到最右 */
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.ticket-close:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}
.ticket-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ticket-close:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---------------- 状态条（合并 error / busy / wait） ---------------- */
.ticket-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 9px 12px;
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.ticket-status .status-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.ticket-status .status-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.ticket-status.is-error {
  background: var(--danger-soft);
  color: var(--danger);
  border: 1px solid var(--danger-border);
}
.ticket-status.is-error .status-dot {
  background: var(--danger);
}
.ticket-status.is-busy {
  background: var(--accent-soft);
  color: var(--accent-2);
}
.ticket-status.is-busy .status-dot {
  background: var(--accent);
  animation: ticket-pulse 1.2s ease-in-out infinite;
}
.ticket-status.is-wait {
  background: var(--card-2);
  color: var(--text-dim);
}
.ticket-status.is-wait .status-dot {
  background: var(--text-dim);
  opacity: 0.6;
}
@keyframes ticket-pulse {
  0%,
  100% {
    opacity: 0.4;
    transform: scale(0.9);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
  }
}

/* ---------------- 提示 / 空态 ---------------- */
.ticket-hint {
  margin: 0 0 var(--space-3);
  color: var(--text-dim);
  font-size: var(--text-xs);
  line-height: 1.7;
}
.ticket-empty {
  display: grid;
  place-items: center;
  gap: var(--space-3);
  padding: var(--space-7) var(--space-4);
  color: var(--text-dim);
  text-align: center;
}
.ticket-empty svg {
  opacity: 0.45;
}
.ticket-empty p {
  margin: 0;
  font-size: var(--text-sm);
}

/* ---------------- 工单列表 ---------------- */
.ticket-list {
  display: grid;
  gap: var(--space-2);
}
.ticket-row {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 4px var(--space-3);
  text-align: left;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  color: var(--text);
  font: inherit;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}
.ticket-row:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--hover);
}
.ticket-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ticket-row .ticket-id {
  font-weight: 650;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}
.ticket-row .ticket-state {
  display: inline-flex;
  align-items: center;
  justify-self: end;
  gap: 6px;
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.ticket-row .ticket-state .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.6;
}
.ticket-row .ticket-state.is-unread {
  color: var(--accent-2);
}
.ticket-row .ticket-state.is-unread .dot {
  background: var(--accent);
  opacity: 1;
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.ticket-row .ticket-state.is-replied {
  color: var(--ok);
}
.ticket-row .ticket-state.is-replied .dot {
  background: var(--ok);
  opacity: 1;
}
.ticket-row .ticket-time {
  grid-column: 1 / -1;
  color: var(--text-dim);
  font-size: var(--text-xs);
}

/* ---------------- 分页器 ---------------- */
.ticket-pages {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}
.page-indicator {
  min-width: 48px;
  text-align: center;
  color: var(--text-dim);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

/* ---------------- 表单字段 ---------------- */
.ticket-field {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-4) 0;
}
.field-label {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
}
.field-input {
  position: relative;
  display: block;
}
.field-input textarea {
  display: block;
  width: 100%;
  resize: vertical;
  min-height: 80px;
  padding-bottom: 26px; /* 给右下角计数留位 */
}
.field-counter {
  position: absolute;
  right: 10px;
  bottom: 8px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--card-2) 85%, transparent);
  color: var(--text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

/* ---------------- 详情页消息 ---------------- */
.ticket-detail-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.ticket-message {
  padding: 12px 14px;
  margin: var(--space-2) 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  overflow-wrap: anywhere;
}
.ticket-message p {
  margin: 6px 0 0;
  white-space: pre-wrap;
  font-size: var(--text-sm);
  line-height: 1.7;
}
.ticket-message.me {
  border-left: 3px solid color-mix(in srgb, var(--text-dim) 45%, transparent);
}
.ticket-message.admin {
  border-left: 3px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, var(--card-2));
}
.bubble-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
.bubble-author {
  font-size: var(--text-xs);
  font-weight: 600;
}
.ticket-message.admin .bubble-author {
  color: var(--accent-2);
}
.bubble-time {
  color: var(--text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.bubble-files {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 2px;
}
.bubble-files li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  color: var(--text-dim);
  font-size: 11px;
}
.bubble-file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bubble-file-size {
  flex: none;
  font-variant-numeric: tabular-nums;
}

/* ---------------- 附件 chip ---------------- */
.ticket-files {
  margin: var(--space-3) 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.ticket-file-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 4px 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-2);
  font-size: var(--text-xs);
  line-height: 1;
}
.ticket-file-chip .chip-name {
  min-width: 0;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ticket-file-chip .chip-size {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.ticket-file-chip .chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.ticket-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
  width: 100%;
}
.ticket-file-chip .chip-remove:hover:not(:disabled) {
  background: var(--danger-soft);
  color: var(--danger);
}
.ticket-file-chip .chip-remove:disabled {
  opacity: 0.5;
  cursor: default;
}
.ticket-attach-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-2);
}
.ticket-attach-row .btn svg {
  margin-right: 2px;
}
.ticket-attach-row small {
  font-size: var(--text-xs);
}
</style>
