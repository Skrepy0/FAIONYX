<script setup lang="ts">
import { natLabel } from '@shared/voxlinkNat';
import VoxLinkModSync from './VoxLinkModSync.vue';
import VoxLinkTickets from './VoxLinkTickets.vue';
import { unreadTickets } from '../../voxlinkTickets';
import SelectMenu from '../SelectMenu.vue';
import type { InstalledVersion } from '@shared/types';
import type { ModSyncGate } from '@shared/voxlinkMods';
import VoxLinkRelatedLinks from './VoxLinkRelatedLinks.vue';
import { displayVersionName as versionLabel } from '../../store';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  DEFAULT_VOXLINK_ROOM_NAME,
  VOXLINK_ROOM_NAME_MAX,
  normalizeVoxlinkRoomName,
  isVoxlinkContentBlocked,
  VOXLINK_ROOM_BLOCKED_MESSAGE,
} from '@shared/voxlinkRoom';
import ConnectionPanel from './ConnectionPanel.vue';
import ConnectionStatus from './ConnectionStatus.vue';
import { toast, store } from '../../store';
import { copyText, getInstalled } from '../../api';
import { t } from '@renderer/i18n';

interface LobbyRoom {
  code: string;
  name: string;
  currentPlayers?: number;
  maxPlayers?: number;
  hasPassword?: boolean;
  category?: string;
  gameVersion?: string;
  loader?: string;
  clientTag?: string;
  natType?: string;
}
interface RoomInfo {
  code: string;
  name: string;
  currentPlayers: number;
  maxPlayers: number;
  isHost: boolean;
  gameVersion?: string;
  loader?: string;
}
interface Snapshot {
  pending?: boolean;
  joinedAt?: number;
  connection?: ConnStateEvent | null;
  stages?: Record<string, StageEvent>;
  state: string;
  room: RoomInfo | null;
  session: { state: string; code: string; isHost: boolean; room: RoomInfo | null };
  settings: { allowRelay: boolean; theme: string; uploadDiagnostics?: boolean };
}
/** 引擎 stage 事件（voxlink/engine.ts emitStage）：阶段条唯一数据源，禁止前端自演进度 */
interface StageEvent {
  key: 'stun' | 'punch' | 'relay' | 'host_stun' | 'host_punch' | 'turn';
  status: 'active' | 'retry' | 'ok' | 'degraded' | 'fail';
  detail: string;
  ts: number;
}
/** 引擎 conn:state 事件：phase = p2p | direct | prelay */
interface ConnStateEvent {
  phase?: string;
  status?: string;
  address?: string;
  detail?: string;
}

const instances = ref<InstalledVersion[]>([]);
const instanceKey = ref('');
const instanceOptions = computed(() =>
  instances.value
    .filter((v) => !v.failed && !v.incomplete)
    .map((v) => ({
      value: JSON.stringify([v.folder, v.id]),
      label: versionLabel(v),
      description: `${v.mcVersion} · ${v.loader || t('voxlink.panel.vanilla')} · ${v.folder}`,
    }))
);
const chosenInstance = computed(() => instances.value.find((v) => JSON.stringify([v.folder, v.id]) === instanceKey.value));
const selectedTarget = computed(() =>
  chosenInstance.value ? { id: chosenInstance.value.id, folder: chosenInstance.value.folder } : undefined
);
const pendingJoin = ref('');
const ticketsOpen = ref(false);
const gateNote = ref(''),
  signalingNote = ref('');
const natInfo = ref<{ local: string; remote: string; profile: string } | null>(null);
const state = ref<Snapshot | null>(null);
const busy = ref(false);
const error = ref('');
const leaving = ref(false),
  turnBusy = ref(false);
let uiOperation = 0;
const logs = ref<Array<{ ts: string; text: string; stage: string; level: string }>>([]);
const manualPort = ref('');
const logLevel = ref('important');
const logGroups = computed(() => {
  const groups = new Map<string, typeof logs.value>();
  for (const log of logs.value) {
    if (logLevel.value === 'important' && !['warn', 'error', 'stage'].includes(log.level)) continue;
    const rows = groups.get(log.stage) || [];
    rows.push(log);
    groups.set(log.stage, rows);
  }
  return [...groups].map(([label, rows]) => ({ label, rows }));
});
const inFlow = computed(() => joined.value || busy.value || !!state.value?.pending);
const nextStep = computed(() =>
  connected.value
    ? t('voxlink.panel.address_ready_hint')
    : isHost.value
      ? t('voxlink.panel.keep_world_open')
      : conn.value?.status === 'failed'
        ? t('voxlink.panel.relay_retry_or_leave')
        : conn.value?.phase === 'turn'
          ? t('voxlink.panel.establishing_relay')
          : t('voxlink.panel.trying_direct')
);
const LOG_GROUP_LABELS: Record<string, string> = {
  stun: t('voxlink.panel.stun'),
  host_stun: t('voxlink.panel.host_stun'),
  punch: t('voxlink.panel.punch'),
  host_punch: t('voxlink.panel.host_punch'),
  p2p: t('voxlink.panel.p2p'),
  turn: t('voxlink.panel.turn'),
  relay: t('voxlink.panel.relay'),
};
const logGroupLabel = (key: string): string => LOG_GROUP_LABELS[key] ?? key;
// 主操作区页内 Tab：创建房间 / 加入房间 / 公共大厅 分开，避免同屏拥挤
const tab = ref<'host' | 'join' | 'lobby'>('host');
function switchTab(next: 'host' | 'join' | 'lobby'): void {
  tab.value = next;
  error.value = '';
  if (next === 'lobby' && !rooms.value.length) void loadLobby();
}

// 创建房间
const roomName = ref(DEFAULT_VOXLINK_ROOM_NAME);
const roomNameInput = ref<HTMLInputElement | null>(null);
const roomNameError = ref('');
watch(roomName, () => {
  if (error.value === roomNameError.value) error.value = '';
  roomNameError.value = '';
});
const isPublic = ref(true);
// 加入房间
const joinCode = ref('');
// 大厅
const rooms = ref<LobbyRoom[]>([]);
const search = ref('');
const loadingLobby = ref(false);

/**
 * MC 手填地址：只有隧道真正建立（conn:state success）后才有值。
 * - phase=p2p：detail 中的本地代理 127.0.0.1:端口
 * - phase=direct：房主公网地址（直连探测成功才给出）
 * - phase=prelay：玩家中继本地桥 127.0.0.1:端口
 * 它是「已连接」的唯一判定，绝不因「已加入房间」而置位。
 */
const mcAddress = ref('');
const mcPhase = ref('');
const conn = ref<ConnStateEvent | null>(null);
/** 阶段事件表（key → 最新事件） */
const stageMap = ref<Record<string, StageEvent>>({});
/** 各阶段耗时（秒）：由真实事件时间戳计算 */
const stageSeconds = ref<Record<string, number>>({});
/** UDP 打洞开始时刻（真实事件 ts），驱动 20 秒后出现手动后备 */
const punchStartTs = ref(0);
const relayTried = ref(false);
const directTried = ref(false);
const nowTick = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | undefined;

const connected = computed(() => mcAddress.value !== '');
const sessionState = computed(() => state.value?.state ?? 'idle');
const joined = computed(() => sessionState.value === 'hosting' || sessionState.value === 'in_room');
const sessionClosed = computed(() => sessionState.value === 'closed');
const isHost = computed(() => !!state.value?.session?.isHost);
const punchStage = computed(() => stageMap.value[isHost.value ? 'host_punch' : 'punch']);
const stunStage = computed(() => stageMap.value[isHost.value ? 'host_stun' : 'stun']);
const relayStage = computed(() => stageMap.value.relay);
const punching = computed(
  () =>
    joined.value && !connected.value && !!punchStage.value && (punchStage.value.status === 'active' || punchStage.value.status === 'retry')
);
const punchElapsed = computed(() => (punchStartTs.value > 0 ? Math.max(0, Math.floor((nowTick.value - punchStartTs.value) / 1000)) : 0));
/** 打洞持续约 20 秒未成功 → 出现「尝试直连」「使用玩家中继」（时刻取自真实引擎事件） */
const fallbackVisible = computed(
  () => joined.value && !isHost.value && !connected.value && punchStartTs.value > 0 && nowTick.value - punchStartTs.value >= 20_000
);

/** 状态区徽标：由会话与隧道真实状态推导（文案不含「已连接」，判定以 mcAddress 为准） */
const overallTone = computed<'neutral' | 'success' | 'danger' | 'pending'>(() => {
  if (sessionClosed.value || conn.value?.status === 'failed') return 'danger';
  if (connected.value) return 'success';
  if (joined.value) return 'pending';
  return 'neutral';
});
const overallLabel = computed(() => {
  if (sessionClosed.value) return t('voxlink.panel.session_closed');
  if (conn.value?.status === 'failed') return t('voxlink.panel.connection_incomplete');
  if (connected.value) return t('voxlink.panel.tunnel_established');
  if (joined.value) return t('voxlink.panel.connecting');
  return t('voxlink.panel.not_started');
});

interface Step {
  key: string;
  label: string;
  state: 'done' | 'active' | 'pending' | 'fail' | 'degraded';
  detail?: string;
  seconds?: number;
}
const stepState = (st: StageEvent | undefined, done: boolean): 'done' | 'active' | 'pending' | 'fail' | 'degraded' => {
  if (done) return 'done';
  if (!st) return 'pending';
  if (st.status === 'ok') return 'done';
  if (st.status === 'fail') return 'fail';
  if (st.status === 'degraded') return 'degraded';
  return 'active';
};
/** 连接过程阶段条：全部由引擎真实事件（stage / conn:state / 会话状态）驱动 */
const steps = computed<Step[]>(() => {
  if (!joined.value) return [];
  const list: Step[] = [];
  list.push({
    key: 'join',
    label: isHost.value ? t('voxlink.panel.create_room') : t('voxlink.panel.join_room'),
    state: 'done',
    detail: state.value?.room?.name,
  });
  if (!isHost.value && ['turn', 'prelay'].includes(conn.value?.phase || '')) {
    const key = conn.value?.phase === 'turn' ? 'turn' : 'relay';
    list.push({
      key,
      label: key === 'turn' ? t('voxlink.panel.turn') : t('voxlink.panel.relay'),
      state: conn.value?.status === 'failed' ? 'fail' : stepState(stageMap.value[key], connected.value),
      detail: stageMap.value[key]?.detail || conn.value?.detail,
    });
    list.push({
      key: 'tunnel',
      label: t('voxlink.panel.game_address'),
      state: connected.value ? 'done' : 'pending',
      detail: connected.value ? t('voxlink.panel.address_ready') : t('voxlink.panel.relay_then_show'),
    });
    return list;
  }
  list.push({
    key: isHost.value ? 'host_stun' : 'stun',
    label: t('voxlink.panel.check_network'),
    state: stepState(stunStage.value, false),
    detail: stunStage.value?.detail,
    seconds: stageSeconds.value[isHost.value ? 'host_stun' : 'stun'],
  });
  list.push({
    key: isHost.value ? 'host_punch' : 'punch',
    label: isHost.value ? t('voxlink.panel.wait_for_friend') : t('voxlink.panel.establish_direct'),
    state: stepState(punchStage.value, connected.value && mcPhase.value === 'p2p'),
    detail: punching.value ? t('voxlink.panel.elapsed_seconds', { seconds: punchElapsed.value }) : punchStage.value?.detail,
    seconds: stageSeconds.value[isHost.value ? 'host_punch' : 'punch'],
  });
  if (!isHost.value && (relayTried.value || relayStage.value)) {
    list.push({
      key: 'relay',
      label: t('voxlink.panel.player_relay_fallback'),
      state: stepState(relayStage.value, connected.value && mcPhase.value === 'prelay'),
      detail: relayStage.value?.detail,
      seconds: stageSeconds.value.relay,
    });
  }
  if (stageMap.value.turn)
    list.push({
      key: 'turn',
      label: t('voxlink.panel.turn'),
      state: stepState(stageMap.value.turn, connected.value && mcPhase.value === 'turn'),
      detail: stageMap.value.turn.detail,
    });
  list.push({
    key: 'tunnel',
    label: isHost.value ? t('voxlink.panel.client_tunnel') : t('voxlink.panel.data_tunnel'),
    state: connected.value ? 'done' : punching.value ? 'active' : 'pending',
    detail: connected.value ? t('voxlink.panel.tunnel_established') : undefined,
  });
  return list;
});

let offEvent: (() => void) | undefined;

/** 消敏：远程地址/中继节点地址不写入日志（本地 127.0.0.1:端口 除外，那是用户要填的） */
function sanitizeLog(text: string): string {
  return text
    .replace(/(\d{1,3}\.){3}\d{1,3}:\d+/g, (m) => (m.startsWith('127.0.0.1') ? m : '***:***'))
    .replace(/(\d{1,3}\.){3}\d{1,3}/g, (m) => (m === '127.0.0.1' ? m : '***'));
}

function pushLog(text: string, level = 'info', stage = conn.value?.phase || '准备'): void {
  const d = new Date();
  const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  logs.value.push({ ts, text: sanitizeLog(text), level, stage });
  if (logs.value.length > 300) logs.value.shift();
}

const logViewport = ref<HTMLElement | null>(null);
function scrollLogBottom(): void {
  const el = logViewport.value;
  if (el) el.scrollTop = el.scrollHeight;
}
async function copyLogs(): Promise<void> {
  const text = logs.value.map((l) => `[${l.ts}] ${l.text}`).join('\n');
  toast((await copyText(text)) ? t('common.copied') : t('common.copy_failed'), 'info');
}

function resetConn(): void {
  mcAddress.value = '';
  mcPhase.value = '';
  conn.value = null;
  stageMap.value = {};
  stageSeconds.value = {};
  punchStartTs.value = 0;
  relayTried.value = false;
  directTried.value = false;
  natInfo.value = null;
}

function onStage(s: StageEvent): void {
  const prev = stageMap.value[s.key];
  if ((s.status === 'active' || s.status === 'retry') && !prev) stageSeconds.value = { ...stageSeconds.value, [s.key]: 0 };
  if (s.status === 'ok' && prev && (prev.status === 'active' || prev.status === 'retry')) {
    const sec = Math.max(1, Math.round((s.ts - prev.ts) / 1000));
    stageSeconds.value = { ...stageSeconds.value, [s.key]: sec };
  }
  stageMap.value = { ...stageMap.value, [s.key]: s };
  if (s.key === 'punch' && s.status === 'active' && !punchStartTs.value) punchStartTs.value = s.ts;
  if (s.key === 'relay' && s.status === 'active') relayTried.value = true;
  pushLog(s.detail, s.status === 'fail' ? 'error' : s.status === 'retry' ? 'warn' : 'stage', s.key);
}

function onConnState(d: ConnStateEvent): void {
  const changed = conn.value?.phase !== d.phase || (d.status === 'trying' && conn.value?.status !== 'trying');
  if (changed) {
    stageMap.value = {};
    stageSeconds.value = {};
  }
  conn.value = d;
  mcAddress.value = d.status === 'success' ? (d.address || '').trim() : '';
  mcPhase.value = d.status === 'success' ? d.phase || '' : '';
  if (d.status === 'trying') {
    directTried.value = d.phase === 'direct';
    relayTried.value = d.phase === 'prelay';
  }
  if (d.status === 'failed')
    pushLog(d.detail || t('voxlink.panel.connection_incomplete'), 'error', d.phase || t('voxlink.panel.connection'));
}

function onEvent(payload: { type: string; data: unknown }): void {
  if (payload.type === 'state') {
    applySnapshot(payload.data as Snapshot);
    return;
  }
  if (payload.type === 'log') {
    const d = payload.data as { level: string; msg: string };
    if (d?.msg) pushLog(d.msg, d.level);
    return;
  }
  if (payload.type === 'stage') {
    onStage(payload.data as StageEvent);
    return;
  }
  if (payload.type === 'conn:state') {
    onConnState(payload.data as ConnStateEvent);
    return;
  }
  if (payload.type === 'mods:download-result')
    toast(String((payload.data as { message?: string })?.message || t('voxlink.panel.mods_downloaded_restart')), 'info');
  if (payload.type === 'mods:gate') gateNote.value = String((payload.data as { message?: string })?.message || '');
  if (payload.type === 'signaling:degraded') signalingNote.value = String((payload.data as { message?: string })?.message || '');
  if (payload.type === 'signaling:recovered') signalingNote.value = '';
  if (payload.type === 'nat:state') natInfo.value = payload.data as typeof natInfo.value;
  if (payload.type === 'bridge') pushLog(`[bridge] ${JSON.stringify(payload.data)}`);
}

async function call<T>(channel: string, payload?: unknown): Promise<T | undefined> {
  try {
    return (await window.faionyx.invoke(channel, payload)) as T;
  } catch (e) {
    error.value = (e as Error).message?.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') ?? t('common.operation_failed');
    return undefined;
  }
}

async function startHost(): Promise<void> {
  if (busy.value) return;
  if (!selectedTarget.value) {
    error.value = t('voxlink.panel.select_host_instance');
    return;
  }
  error.value = '';
  roomNameError.value = '';
  let name: string;
  try {
    name = normalizeVoxlinkRoomName(roomName.value);
  } catch (e) {
    roomNameError.value = (e as Error).message;
    await nextTick();
    roomNameInput.value?.focus();
    return;
  }
  busy.value = true;
  const operation = ++uiOperation;
  try {
    const r = (await window.faionyx.invoke('voxlink:start', {
      mode: 'host',
      roomName: name,
      isPublic: isPublic.value,
      target: selectedTarget.value,
      hostPort: manualPort.value.trim() ? Number(manualPort.value) : undefined,
    })) as { ok: boolean };
    if (r?.ok) {
      resetConn();
      await status();
    }
  } catch (e) {
    if (operation !== uiOperation) return;
    if (isVoxlinkContentBlocked(e)) {
      roomNameError.value = VOXLINK_ROOM_BLOCKED_MESSAGE;
      error.value = roomNameError.value;
    } else {
      error.value =
        (e as Error).message?.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') ?? t('voxlink.panel.create_room_failed');
    }
  } finally {
    if (operation === uiOperation) busy.value = false;
    if (roomNameError.value) {
      await nextTick();
      roomNameInput.value?.focus();
    }
  }
}
async function startJoin(code: string): Promise<void> {
  const c = code.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(c)) {
    error.value = t('voxlink.panel.room_code_format');
    return;
  }
  if (busy.value) return;
  pendingJoin.value = c;
}
async function joinAfterMods(gate: ModSyncGate): Promise<void> {
  gateNote.value = {
    MANIFEST: t('voxlink.panel.gate_manifest'),
    UNSUPPORTED: t('voxlink.panel.gate_unsupported'),
    EMPTY: t('voxlink.panel.gate_empty'),
    NOT_READY: t('voxlink.panel.gate_not_ready'),
    BYPASSED: t('voxlink.panel.gate_bypassed'),
  }[gate];
  const c = pendingJoin.value;
  pendingJoin.value = '';
  const operation = ++uiOperation;
  busy.value = true;
  error.value = '';
  resetConn();
  const r = await call<{ ok: boolean }>('voxlink:start', { mode: 'join', code: c, target: selectedTarget.value });
  if (operation !== uiOperation) return;
  if (r?.ok) await status();
  busy.value = false;
}
async function stop(): Promise<void> {
  if (leaving.value) return;
  ++uiOperation;
  leaving.value = true;
  try {
    await call('voxlink:stop', busy.value ? t('voxlink.panel.user_cancel_join') : t('voxlink.panel.user_leave_room'));
    resetConn();
    await status();
  } finally {
    leaving.value = false;
    busy.value = false;
    turnBusy.value = false;
  }
}
async function useTurn() {
  if (turnBusy.value) return;
  turnBusy.value = true;
  error.value = '';
  try {
    await call('voxlink:useTurnRelay');
  } finally {
    turnBusy.value = false;
  }
}
function applySnapshot(s: Snapshot) {
  state.value = s;
  if (s.state === 'idle' || s.state === 'closed') {
    resetConn();
    return;
  }
  if (s.joinedAt) punchStartTs.value = s.joinedAt;
  if (s.connection) onConnState(s.connection);
  else {
    mcAddress.value = '';
    mcPhase.value = '';
    conn.value = null;
  }
  stageMap.value = s.stages || {};
}
async function status(): Promise<void> {
  const s = await call<Snapshot>('voxlink:status');
  if (s) applySnapshot(s);
}
async function loadLobby(): Promise<void> {
  loadingLobby.value = true;
  const r = await call<{ rooms: LobbyRoom[] }>('voxlink:lobby', { search: search.value || undefined, size: 50 });
  if (r) rooms.value = r.rooms ?? [];
  loadingLobby.value = false;
}
async function toggleDiagnostics(): Promise<void> {
  const result = await call<{ uploadDiagnostics: boolean }>('voxlink:settings', {
    uploadDiagnostics: !state.value?.settings.uploadDiagnostics,
  });
  if (state.value && result) state.value.settings.uploadDiagnostics = result.uploadDiagnostics;
}
async function toggleRelay(): Promise<void> {
  if (!state.value) return;
  const allowRelay = await call<{ allowRelay: boolean }>('voxlink:settings', { allowRelay: !state.value.settings.allowRelay });
  if (allowRelay) state.value.settings.allowRelay = allowRelay.allowRelay;
}
/** 手动后备 1：直连探测（app-desktop TryDirect） */
async function tryDirect(): Promise<void> {
  if (directTried.value) return;
  const r = await call<{ ok: boolean; err?: string }>('voxlink:tryDirect');
  if (r && !r.ok) error.value = r.err ?? t('voxlink.panel.direct_probe_failed');
  directTried.value = true;
}
/** 手动后备 2：玩家中继（app-desktop UsePlayerRelay） */
async function useRelay(): Promise<void> {
  if (relayTried.value) return;
  const r = await call<{ ok: boolean; err?: string }>('voxlink:usePlayerRelay');
  if (r && !r.ok) error.value = r.err ?? t('voxlink.panel.player_relay_failed');
  relayTried.value = true;
}
async function copy(value?: string | null): Promise<void> {
  if (value) toast((await copyText(value)) ? t('common.copied') : t('common.copy_failed'), 'info');
}

onMounted(async () => {
  offEvent = window.faionyx.on('voxlink:event', (payload) => onEvent(payload as { type: string; data: unknown }));
  await status();
  try {
    instances.value = await getInstalled(true);
    instanceKey.value = JSON.stringify([store.settings?.activeFolder, store.resourceVersionId]);
    if (!chosenInstance.value) instanceKey.value = instanceOptions.value[0]?.value || '';
  } catch {}
  if (sessionState.value === 'idle') await loadLobby();
  // 仅用于把真实事件的耗时换算成秒，不是进度动画
  tickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  offEvent?.();
  if (tickTimer) clearInterval(tickTimer);
});
</script>

<template>
  <div data-ui="VoxLinkPanel:8921adf51a40" class="voxlink-page">
    <header data-ui="VoxLinkPanel:e2b25d0f5bce" class="vox-toolbar">
      <p class="connection-muted">{{ inFlow ? t('voxlink.panel.keep_page_open') : t('voxlink.panel.select_instance_first') }}</p>
      <VoxLinkRelatedLinks />
      <button class="btn btn-ghost" @click="ticketsOpen = true">
        {{ t('voxlink.panel.my_tickets') }}{{ unreadTickets ? ' · ' + unreadTickets + ' ' + t('voxlink.panel.unread') : '' }}
      </button>
    </header>
    <p data-ui="VoxLinkPanel:e56ab4ac207d" v-if="error" class="connection-error vox-alert" role="alert">{{ error }}</p>
    <p v-if="gateNote" class="connection-muted vox-alert" role="status">{{ gateNote }}</p>
    <p v-if="signalingNote" class="connection-error vox-alert" role="status">{{ signalingNote }}</p>
    <p v-if="natInfo" class="connection-muted">
      {{ t('voxlink.panel.local') }} {{ natInfo.local }} · {{ t('voxlink.panel.remote_peer') }} {{ natInfo.remote }} ·
      {{ t('voxlink.panel.punch_profile') }} {{ natInfo.profile }}
    </p>
    <p data-ui="VoxLinkPanel:5878cb7ab6d6" v-if="sessionClosed" class="connection-error vox-alert">{{ t('voxlink.panel.room_ended') }}</p>

    <ConnectionPanel
      v-if="inFlow"
      :title="
        connected
          ? t('voxlink.panel.connected_success')
          : conn?.status === 'failed'
            ? t('voxlink.panel.connection_not_complete')
            : isHost
              ? t('voxlink.panel.room_ready')
              : t('voxlink.panel.connecting_friend')
      "
      :subtitle="nextStep"
    >
      <template #action><ConnectionStatus :tone="overallTone" :label="overallLabel" /></template>
      <div data-ui="VoxLinkPanel:8a8b1646a130" v-if="connected && !isHost" class="address-hero" aria-live="polite">
        <span class="connection-eyebrow">{{ t('voxlink.panel.paste_in_game') }}</span>
        <div data-ui="VoxLinkPanel:1e326a7f81c7" class="address-line">
          <code>{{ mcAddress }}</code
          ><button data-ui="VoxLinkPanel:2d6cdb019744" class="btn btn-gold" @click="copy(mcAddress)">
            {{ t('voxlink.panel.copy_address') }}
          </button>
        </div>
        <p>
          {{ t('voxlink.panel.enter_game') }} → <strong>{{ t('voxlink.panel.multiplayer') }}</strong> →
          <strong>{{ t('voxlink.panel.direct_connect') }}</strong>
        </p>
        <small>{{ t('voxlink.panel.paste_then_join') }}</small>
      </div>
      <div data-ui="VoxLinkPanel:3a1b6ce6032b" v-if="state?.session.code" class="room-strip">
        <div>
          <small>{{ isHost ? t('voxlink.panel.send_code_to_friend') : t('voxlink.panel.current_room') }}</small
          ><strong>{{ state?.room?.name }}</strong>
        </div>
        <div data-ui="VoxLinkPanel:68825fcf4f61" class="room-code">
          <code>{{ state.session.code }}</code
          ><button data-ui="VoxLinkPanel:aa75ef3e2b10" class="btn btn-ghost" @click="copy(state.session.code)">
            {{ t('voxlink.panel.copy_room_code') }}
          </button>
        </div>
      </div>
      <ol
        data-ui="VoxLinkPanel:5a726f736537"
        v-if="steps.length && !connected"
        class="stage-bar"
        :aria-label="t('voxlink.panel.connection_progress')"
      >
        <li data-ui="VoxLinkPanel:d2fc189fa8df" v-for="(step, i) in steps" :key="step.key" class="stage-item" :class="step.state">
          <span data-ui="VoxLinkPanel:e622b7bd540c" class="stage-dot">{{ step.state === 'done' ? '✓' : i + 1 }}</span
          ><span data-ui="VoxLinkPanel:1fd8eb27a14d" class="stage-copy"
            ><strong>{{ step.label }}</strong
            ><small>{{ step.detail || '{{ t('voxlink.panel.waiting_previous') }}' }}</small></span
          >
        </li>
      </ol>
      <div data-ui="VoxLinkPanel:9d884c39eb5e" v-if="busy && !joined" class="flow-wait" role="status">
        {{ tab === 'host' ? t('voxlink.panel.checking_and_creating') : t('voxlink.panel.joining_room_dot') }}
      </div>
      <p data-ui="VoxLinkPanel:bec7ac0062f5" v-if="conn?.detail && !connected" class="connection-muted" role="status">{{ conn.detail }}</p>
      <div data-ui="VoxLinkPanel:da26e461034b" v-if="fallbackVisible" class="manual-relay">
        <div>
          <strong>{{ t('voxlink.panel.relay_option') }}</strong>
          <p class="connection-muted">{{ t('voxlink.panel.direct_tried_n_secs', { elapsed: punchElapsed }) }}</p>
        </div>
        <button
          data-ui="VoxLinkPanel:9e5bb2ba94c8"
          class="btn btn-gold"
          :disabled="turnBusy || stageMap.turn?.status === 'active'"
          @click="useTurn"
        >
          {{
            turnBusy || stageMap.turn?.status === 'active'
              ? t('voxlink.panel.establishing_relay_dot')
              : conn?.phase === 'turn' && conn?.status === 'failed'
                ? t('voxlink.panel.retry_turn_relay')
                : t('voxlink.panel.use_turn_relay')
          }}
        </button>
        <button
          data-ui="VoxLinkPanel:abe294d0cda1"
          class="btn btn-ghost"
          :disabled="relayTried || turnBusy || stageMap.turn?.status === 'active'"
          @click="useRelay"
        >
          {{ t('voxlink.panel.use_player_relay') }}
        </button>
      </div>
      <div class="connection-actions">
        <button data-ui="VoxLinkPanel:6bdf448cf61f" class="btn btn-ghost" :disabled="leaving" @click="stop">
          {{
            leaving
              ? t('voxlink.panel.leaving')
              : joined
                ? isHost
                  ? t('voxlink.panel.close_room')
                  : t('voxlink.panel.leave_room')
                : t('voxlink.panel.cancel_connection')
          }}
        </button>
      </div>
    </ConnectionPanel>

    <ConnectionPanel v-else class="vox-workspace" :title="t('voxlink.panel.game_and_room')">
      <label class="connection-field"
        >{{ t('voxlink.panel.game_instance')
        }}<SelectMenu
          v-model="instanceKey"
          :options="instanceOptions"
          :disabled="!!pendingJoin"
          :placeholder="t('voxlink.panel.select_game_instance')"
        /><small>{{ t('voxlink.panel.mods_shared_instance') }}</small></label
      >
      <div data-ui="VoxLinkPanel:a4a4e47d1972" class="connect-tabs" role="tablist" :aria-label="t('voxlink.panel.connection_entry')">
        <button
          data-ui="VoxLinkPanel:bb11948caa5b"
          v-for="item in ['host', 'join', 'lobby'] as const"
          :key="item"
          class="connect-tab"
          :class="{ active: tab === item }"
          role="tab"
          :aria-selected="tab === item"
          @click="switchTab(item)"
        >
          {{
            item === 'host'
              ? t('voxlink.panel.create_room')
              : item === 'join'
                ? t('voxlink.panel.join_room')
                : t('voxlink.panel.public_lobby')
          }}
        </button>
      </div>
      <div key="host" v-if="tab === 'host'" class="tab-body host-form">
        <div data-ui="VoxLinkPanel:b8dcf152db46" class="entry-tip">
          <p>
            <strong>{{ t('voxlink.panel.invite_friend_steps') }}</strong
            ><br />1. {{ t('voxlink.panel.step_1_launch_world') }}<br />2. {{ t('voxlink.panel.step_2_open_lan') }}<br />3.
            {{ t('voxlink.panel.step_3_create_send_code') }}
          </p>
        </div>
        <label class="connection-field"
          >{{ t('voxlink.panel.room_name')
          }}<input
            data-ui="VoxLinkPanel:75532f9b2f0f"
            ref="roomNameInput"
            v-model="roomName"
            class="input"
            :maxlength="VOXLINK_ROOM_NAME_MAX"
            :placeholder="t('voxlink.panel.name_your_adventure')"
            :aria-invalid="!!roomNameError"
          /><small data-ui="VoxLinkPanel:3f72715e277c" v-if="roomNameError" class="connection-error" role="alert">{{
            roomNameError
          }}</small></label
        >
        <label class="connection-toggle"
          ><span
            >{{ t('voxlink.panel.show_in_public') }}<small>{{ t('voxlink.panel.public_hint') }}</small></span
          ><input data-ui="VoxLinkPanel:0388be29ae36" v-model="isPublic" type="checkbox" /><span
            class="connection-toggle-track"
            aria-hidden="true"
          ></span
        ></label>
        <details data-ui="VoxLinkPanel:ec950898b711" class="connection-details">
          <summary>{{ t('voxlink.panel.no_game_detected') }}</summary>
          <label class="connection-field"
            >{{ t('voxlink.panel.lan_port')
            }}<input
              data-ui="VoxLinkPanel:766e671e24eb"
              v-model="manualPort"
              class="input"
              type="number"
              min="1"
              max="65535"
              :placeholder="t('voxlink.panel.leave_blank_auto')"
            /><small>{{ t('voxlink.panel.check_chat_hint') }}</small></label
          >
        </details>
        <div class="connection-actions">
          <button data-ui="VoxLinkPanel:21d65137d940" class="btn btn-gold" @click="startHost">
            {{ t('voxlink.panel.create_room') }} →
          </button>
        </div>
      </div>
      <div data-ui="VoxLinkPanel:d5e1a4fcbada" key="join" v-else-if="tab === 'join'" class="tab-body">
        <label class="connection-field"
          >{{ t('voxlink.panel.friend_room_code')
          }}<input
            data-ui="VoxLinkPanel:252ad3055684"
            v-model="joinCode"
            class="input room-input"
            maxlength="6"
            :placeholder="t('voxlink.panel.input_6_char_code')"
            @keydown.enter="startJoin(joinCode)"
        /></label>
        <p class="connection-muted">{{ t('voxlink.panel.check_mods_before_join') }}</p>
        <div class="connection-actions">
          <button
            data-ui="VoxLinkPanel:5efd9b881c4e"
            class="btn btn-gold"
            :disabled="joinCode.trim().length !== 6"
            @click="startJoin(joinCode)"
          >
            {{ t('voxlink.panel.join_room') }} →
          </button>
        </div>
      </div>
      <div data-ui="VoxLinkPanel:5dc76e918969" key="lobby" v-else-if="tab === 'lobby'" class="tab-body">
        <div data-ui="VoxLinkPanel:5f0b077855e1" class="lobby-bar">
          <label data-ui="VoxLinkPanel:7a9c6cad1211" class="connection-field lobby-search"
            >{{ t('voxlink.panel.discover_rooms')
            }}<input
              data-ui="VoxLinkPanel:b708e83ac19a"
              v-model="search"
              class="input"
              :placeholder="t('voxlink.panel.search_room_name')"
              @keydown.enter="loadLobby" /></label
          ><button data-ui="VoxLinkPanel:016a2518dbf1" class="btn btn-ghost" :disabled="loadingLobby" @click="loadLobby">
            {{ loadingLobby ? '{{ t('voxlink.panel.refreshing') }}' : '{{ t('voxlink.panel.refresh_lobby') }}' }}
          </button>
        </div>
        <p data-ui="VoxLinkPanel:e312b633a89b" v-if="!rooms.length" class="connection-muted">
          {{ loadingLobby ? '{{ t('voxlink.panel.searching_public') }}' : '{{ t('voxlink.panel.no_public_rooms') }}' }}
        </p>
        <ul data-ui="VoxLinkPanel:23ebb3082754" v-else class="lobby-list">
          <li data-ui="VoxLinkPanel:84d06265d7c7" v-for="room in rooms" :key="room.code" class="lobby-item">
            <div data-ui="VoxLinkPanel:69f9a9318d00" class="lobby-main">
              <span class="connection-eyebrow">{{ room.category || '一起游玩' }}</span
              ><strong>{{ room.name }}</strong
              ><small
                >{{ [room.gameVersion, room.loader].filter(Boolean).join(' · ') || '版本未标注' }} ·
                {{ natLabel('UNKNOWN', room.natType) }}</small
              ><span data-ui="VoxLinkPanel:f8116c66cc88" v-if="room.clientTag === 'faionyx'" class="faionyx-badge">FAIONYX 房间</span>
            </div>
            <div data-ui="VoxLinkPanel:1040c97a6114" class="lobby-side">
              <span data-ui="VoxLinkPanel:9d3841267bb7" class="connection-muted"
                >{{ room.currentPlayers ?? '?' }}/{{ room.maxPlayers ?? '?' }} 人</span
              ><button data-ui="VoxLinkPanel:446640f4241c" class="btn btn-gold" @click="startJoin(room.code)">加入 →</button>
            </div>
          </li>
        </ul>
      </div>
    </ConnectionPanel>
    <VoxLinkModSync v-if="pendingJoin" :code="pendingJoin" :target="selectedTarget" @join="joinAfterMods" @dismiss="pendingJoin = ''" />
    <VoxLinkTickets v-if="ticketsOpen" @close="ticketsOpen = false" />
    <details data-ui="VoxLinkPanel:6110025709f6" class="connection-details reference-details">
      <summary>联机设置</summary>
      <div data-ui="VoxLinkPanel:00597c7aef0f" class="connection-detail-content">
        <label class="connection-toggle"
          ><span>协助其他玩家中继<small>允许使用玩家中继。TURN 始终由你主动点击，不会自动启用。</small></span
          ><input
            data-ui="VoxLinkPanel:87677ed49b2c"
            type="checkbox"
            :checked="state?.settings.allowRelay ?? true"
            :disabled="joined"
            @change="toggleRelay" /><span class="connection-toggle-track" aria-hidden="true"></span></label
        ><label class="connection-toggle"
          ><span>发送联机故障诊断<small>向 VoxLink 上传脱敏的联机日志，帮助排查连接问题。</small></span
          ><input
            data-ui="VoxLinkPanel:1db3b2b22cc9"
            type="checkbox"
            :checked="state?.settings.uploadDiagnostics ?? false"
            @change="toggleDiagnostics" /><span class="connection-toggle-track" aria-hidden="true"></span
        ></label>
      </div>
    </details>
    <details data-ui="VoxLinkPanel:4df65d02a080" v-for="group in logGroups" :key="group.label" class="log-group">
      <summary>{{ logGroupLabel(group.label) }} · {{ group.rows.length }} 条</summary>
      <div data-ui="VoxLinkPanel:1325cce1cc38" class="connection-log-viewport">
        <p data-ui="VoxLinkPanel:ec5b6c9228e1" v-for="(log, i) in group.rows" :key="i" class="connection-log-line" :class="log.level">
          <span data-ui="VoxLinkPanel:a0bb180b19af" class="log-ts">{{ log.ts }}</span>
          <span data-ui="VoxLinkPanel:688da0e690b8" class="log-level">{{
            log.level === 'error' ? '错误' : log.level === 'warn' ? '提醒' : log.level === 'stage' ? '阶段' : '详细'
          }}</span>
          {{ log.text }}
        </p>
      </div>
    </details>
  </div>
</template>
<style scoped>
.voxlink-page {
  display: grid;
  gap: var(--sec-gap);
  min-width: 0;
}
.vox-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.vox-toolbar h2 {
  font-size: 22px;
  margin: 7px 0;
}
.vox-toolbar p {
  margin: 0;
}
.vox-alert {
  padding: 14px 18px;
  border-radius: 12px;
  background: var(--danger-soft);
}
.tab-body {
  display: grid;
  gap: 20px;
}
.entry-tip {
  display: flex;
  align-items: center;
  gap: 15px;
  border-radius: 14px;
  padding: 14px 18px;
  background: var(--accent-soft);
}
.entry-tip > span {
  color: var(--accent);
  font-size: 22px;
  font-weight: 700;
}
.entry-tip p {
  margin: 0;
}
.room-input {
  letter-spacing: 0.18em;
  text-transform: uppercase;
  max-width: 420px;
  font-size: 22px;
}
.room-strip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  padding: 18px 22px;
  background: var(--card-2);
  border-radius: 16px;
}
.room-strip > div:first-child {
  display: grid;
  gap: 6px;
}
.room-strip small {
  color: var(--text-dim);
}
.room-code {
  display: flex;
  align-items: center;
  gap: 14px;
}
.room-code code {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.12em;
}
.address-hero {
  display: grid;
  gap: 14px;
  padding: 28px;
  border-radius: 18px;
  background: linear-gradient(125deg, var(--accent-soft), var(--card-2));
  box-shadow: inset 3px 0 var(--accent);
}
.address-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}
.address-line code {
  font-size: clamp(24px, 3vw, 38px);
  font-weight: 750;
  overflow-wrap: anywhere;
}
.address-hero p {
  margin: 0;
  font-size: 17px;
}
.address-hero small {
  color: var(--text-dim);
}
.stage-bar {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
  gap: 12px;
  margin: 8px 0;
  padding: 0;
}
.stage-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 17px 14px;
  background: var(--card-2);
  border-radius: 14px;
}
.stage-dot {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 50%;
  background: var(--card);
  color: var(--text-dim);
  font-size: 13px;
}
.stage-copy {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.stage-copy strong {
  font-size: 14px;
}
.stage-copy small {
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.6;
}
.stage-item.active {
  background: var(--accent-soft);
}
.stage-item.active .stage-dot {
  background: var(--accent);
  color: var(--on-accent);
}
.stage-item.done .stage-dot {
  color: var(--ok);
  background: var(--ok-soft);
}
.stage-item.fail .stage-dot {
  color: var(--danger);
  background: var(--danger-soft);
}
.manual-relay {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 18px;
  border-radius: 14px;
  background: var(--card-2);
}
.manual-relay > div {
  flex: 1;
  min-width: 220px;
}
.manual-relay p {
  margin: 5px 0 0;
}
.flow-wait {
  padding: 24px;
  color: var(--text-dim);
}
.lobby-bar {
  display: flex;
  align-items: flex-end;
  gap: 14px;
}
.lobby-search {
  flex: 1;
  max-width: 420px;
}
.lobby-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 16px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.lobby-item {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 22px;
  padding: 22px;
  border-radius: 18px;
  background: var(--card-2);
  box-shadow: var(--shadow);
  transition:
    background 0.2s,
    transform 0.2s;
}
.lobby-item:hover {
  background: color-mix(in srgb, var(--accent) 8%, var(--card-2));
  transform: translateY(-2px);
}
.lobby-main {
  display: grid;
  gap: 9px;
  overflow-wrap: anywhere;
}
.lobby-main strong {
  font-size: 19px;
}
.lobby-main small {
  color: var(--text-dim);
}
.lobby-side {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.faionyx-badge {
  font-size: 11px;
  color: var(--accent);
}
.reference-details,
.log-details {
  padding: 16px 20px;
}
.log-tools {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding: 12px 0;
}
.log-group {
  margin: 10px 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--card-2);
}
.log-group summary {
  cursor: pointer;
  font-size: 13px;
}
.log-ts {
  color: var(--text-dim);
  margin-right: 10px;
}
.log-level {
  font-size: 11px;
  margin-right: 8px;
  color: var(--text-dim);
}
.connection-log-line.error,
.connection-log-line.error .log-level {
  color: var(--danger);
}
.connection-log-line.warn .log-level {
  color: var(--accent);
}
@media (max-width: 900px) {
  .vox-toolbar,
  .room-strip {
    align-items: flex-start;
    flex-direction: column;
  }
  .stage-bar {
    grid-template-columns: 1fr 1fr;
  }
  .room-code code {
    font-size: 22px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .lobby-item {
    transition: none;
  }
  .lobby-item:hover {
    transform: none;
  }
}
.voxlink-page {
  gap: 12px;
}
.vox-toolbar {
  margin-bottom: 12px;
}
.vox-toolbar p {
  font-size: 13px;
}
.host-form {
  grid-template-columns: minmax(0, 2fr) minmax(200px, 1fr);
  gap: 16px 24px;
}
.host-form > * {
  grid-column: 1;
}
.host-form .entry-tip {
  grid-column: 2;
  grid-row: 1/5;
  align-self: start;
  background: transparent;
  padding: 4px 0;
  border-radius: 0;
  align-items: flex-start;
  font-size: 13px;
  line-height: 2;
}
.host-form .connection-toggle {
  padding: 10px 0;
  border: 0;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: none;
}
.host-form .connection-details {
  padding: 8px 0;
}
.connect-tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-bottom: 1px solid var(--border);
  margin: 12px 0;
}
.connect-tab {
  border: 0 !important;
  background: none !important;
  border-radius: var(--radius-sm) !important;
  padding: 8px 14px;
}
.connect-tab.active {
  background: var(--accent-soft) !important;
  color: var(--text) !important;
}
.lobby-item {
  box-shadow: none;
  border: 1px solid var(--border);
  padding: 16px;
  border-radius: var(--radius-md);
}
.lobby-item:hover {
  transform: none;
}
.lobby-main strong {
  font-size: 16px;
}
.voxlink-page .reference-details,
.voxlink-page .log-details {
  padding: 12px 0;
}
.host-form .connection-actions .btn {
  min-height: 40px;
}
@media (max-width: 1000px) {
  .host-form {
    grid-template-columns: minmax(0, 1fr);
  }
  .host-form .entry-tip {
    grid-column: 1;
    grid-row: auto;
    font-size: 12px;
  }
  .host-form .entry-tip br {
    display: none;
  }
}
</style>
