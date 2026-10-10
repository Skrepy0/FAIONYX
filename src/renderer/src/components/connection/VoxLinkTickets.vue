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
    <template #header
      ><h2>
        {{
          creating
            ? t('voxlink.tickets.submit_ticket')
            : detail
              ? t('voxlink.tickets.ticket_detail').replace('{id}', detail.id)
              : t('voxlink.tickets.my_tickets')
        }}
      </h2>
      <button class="btn btn-ghost" :disabled="busy" :aria-label="t('voxlink.tickets.close_ticket')" @click="close">×</button></template
    >
    <p v-if="error" class="connection-error" role="alert">{{ error }}</p>
    <p v-if="busy" role="status">
      {{ progress ? t('voxlink.tickets.uploading') + ' ' + progress : t('voxlink.tickets.processing_request') }}
    </p>
    <p v-if="waitSeconds" class="connection-muted" role="status">{{ t('voxlink.tickets.wait_seconds', { seconds: waitSeconds }) }}</p>
    <template v-if="!creating && !detail">
      <p class="connection-muted">{{ t('voxlink.tickets.description_hint') }}</p>
      <p v-if="!ticketSummaries.length && !busy">{{ t('voxlink.tickets.no_tickets') }}</p>
      <div class="ticket-list">
        <button v-for="ticket in rows" :key="ticket.id" class="ticket-row" :disabled="busy" @click="open(ticket.id)">
          <strong>#{{ ticket.id }}</strong
          ><span>{{
            ticket.hasUnread
              ? t('voxlink.tickets.has_unread')
              : ticket.replyCount
                ? t('voxlink.tickets.viewed')
                : t('voxlink.tickets.waiting_reply')
          }}</span
          ><small>{{ time(ticket.lastTimeMs || ticket.timeMs) }}</small>
        </button>
      </div>
      <div v-if="pages > 1" class="ticket-pages">
        <button class="btn" :disabled="busy || page === 0" @click="page--">{{ t('voxlink.tickets.prev_page') }}</button
        ><span>{{ page + 1 }}/{{ pages }}</span
        ><button class="btn" :disabled="busy || page + 1 >= pages" @click="page++">{{ t('voxlink.tickets.next_page') }}</button>
      </div>
    </template>
    <template v-else-if="creating"
      ><label class="ticket-field"
        >{{ t('voxlink.tickets.issue_description')
        }}<textarea
          v-model="description"
          class="input"
          maxlength="10000"
          rows="8"
          :disabled="busy"
          :placeholder="t('voxlink.tickets.placeholder_describe_issue')"
        /></label
      ><small class="connection-muted">{{ description.length }}/10000 {{ t('voxlink.tickets.characters') }}</small></template
    >
    <template v-else-if="detail">
      <small class="connection-muted">{{ time(detail.timeMs) }}</small>
      <article class="ticket-message">
        <strong>{{ t('voxlink.tickets.me_first_submission') }}</strong>
        <p>{{ detail.description }}</p>
        <small v-for="file in detail.attachments" :key="file.name"
          >{{ t('voxlink.tickets.attachment') }}：{{ file.name }} · {{ (file.size / 1048576).toFixed(1) }} MB</small
        >
      </article>
      <article
        v-for="(message, index) in messages"
        :key="message.id || index"
        class="ticket-message"
        :class="{ admin: message.from === 'admin' }"
      >
        <strong
          >{{ message.from === 'admin' ? t('voxlink.tickets.voxlink_reply') : t('voxlink.tickets.my_followup') }} ·
          {{ time(message.timeMs) }}</strong
        >
        <p>{{ message.text }}</p>
        <small v-for="file in message.attachments" :key="file.name"
          >{{ t('voxlink.tickets.attachment') }}：{{ file.name }} · {{ (file.size / 1048576).toFixed(1) }} MB</small
        >
      </article>
      <div v-if="messagePages > 1" class="ticket-pages">
        <button class="btn" :disabled="busy || messagePage === 0" @click="messagePage--">{{ t('voxlink.tickets.earlier_messages') }}</button
        ><span>{{ messagePage + 1 }}/{{ messagePages }}</span
        ><button class="btn" :disabled="busy || messagePage + 1 >= messagePages" @click="messagePage++">
          {{ t('voxlink.tickets.newer_messages') }}
        </button>
      </div>
      <label class="ticket-field"
        >{{ t('voxlink.tickets.supplementary_question')
        }}<textarea v-model="text" class="input" maxlength="2000" rows="3" :disabled="busy || detail.deleted" />
      </label>
      <small class="connection-muted"
        >{{ text.length }}/2000 {{ t('voxlink.tickets.characters') }} · {{ detail.messages.length }}/200
        {{ t('voxlink.tickets.messages') }}</small
      >
    </template>
    <template v-if="creating || detail">
      <ul class="ticket-files">
        <li v-for="file in files" :key="file.id">
          <span>{{ file.name }} · {{ (file.size / 1048576).toFixed(1) }} MB</span
          ><button
            class="btn btn-ghost"
            :disabled="busy"
            :aria-label="t('voxlink.tickets.remove_attachment').replace('{name}', file.name)"
            @click="removeFile(file)"
          >
            ×
          </button>
        </li>
      </ul>
      <button class="btn btn-ghost" :disabled="busy || files.length >= 10" @click="choose">
        {{ t('voxlink.tickets.choose_attachment') }}
      </button>
      <p class="connection-muted">{{ t('voxlink.tickets.attachment_limit_hint') }}</p>
    </template>
    <template #footer>
      <button v-if="busy" class="btn" @click="cancel">{{ t('voxlink.tickets.cancel_request') }}</button>
      <template v-else
        ><button class="btn btn-ghost" @click="creating || detail ? back() : close()">
          {{ creating || detail ? t('voxlink.tickets.back_list') : t('voxlink.tickets.close') }}</button
        ><button v-if="detail" class="btn btn-ghost" @click="confirmDelete = true">{{ t('voxlink.tickets.delete_ticket') }}</button
        ><button v-if="detail" class="btn" :disabled="!ownLast?.id" @click="retract">
          {{ t('voxlink.tickets.retract_last_followup') }}</button
        ><button
          v-if="detail"
          class="btn btn-gold"
          :disabled="!!waitSeconds || detail.deleted || detail.messages.length >= 200 || (!text.trim() && !files.length)"
          @click="reply"
        >
          {{ t('voxlink.tickets.send_followup') }}</button
        ><button v-else-if="creating" class="btn btn-gold" :disabled="!!waitSeconds || !description.trim()" @click="submit">
          {{ t('voxlink.tickets.submit_ticket') }}</button
        ><button v-else class="btn btn-gold" @click="newTicket">{{ t('voxlink.tickets.new_ticket') }}</button></template
      >
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
.ticket-field {
  display: grid;
  gap: 8px;
  margin: 16px 0;
}
.ticket-field textarea {
  resize: vertical;
  min-height: 80px;
}
.ticket-list {
  display: grid;
  gap: 8px;
}
.ticket-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  text-align: left;
  background: var(--card-2);
  color: var(--text);
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.ticket-row small {
  grid-column: 1/-1;
  color: var(--text-dim);
}
.ticket-pages {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin: 12px;
}
.ticket-message {
  background: var(--card-2);
  border-radius: var(--radius-md);
  padding: 14px;
  margin: 12px 0;
  overflow-wrap: anywhere;
}
.ticket-message p {
  white-space: pre-wrap;
}
.ticket-message small {
  display: block;
  color: var(--text-dim);
}
.ticket-message.admin {
  border-left: 3px solid var(--accent);
}
.ticket-files {
  padding: 0;
  list-style: none;
}
.ticket-files li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  overflow-wrap: anywhere;
}
</style>
