<script setup lang="ts">
import type { ServerEntry, ServerPingResult, InstalledVersion } from '@shared/types';
import ConnectionPanel from './ConnectionPanel.vue';
import ConnectionStatus from './ConnectionStatus.vue';
import ServerAddress from './ServerAddress.vue';
import { privateServerText } from '@shared/serverPrivacy';
import { t } from '@renderer/i18n';
defineProps<{
  server: ServerEntry;
  ping: ServerPingResult | null;
  pending: boolean;
  busy: boolean;
  running?: boolean;
  binding: boolean;
  targets: InstalledVersion[];
  bound: string;
  missing: boolean;
  lastUsed: string;
  targetToken: (target: InstalledVersion) => string;
  targetLabel: (target: InstalledVersion) => string;
  addressRevealed: boolean;
}>();
defineEmits<{ bind: [value: string]; connect: []; refresh: []; edit: []; remove: []; relink: []; versions: []; copy: []; address: [] }>();
</script>
<template>
  <ConnectionPanel :title="t('server.connect_server')" class="server-detail">
    <template #action
      ><button class="btn btn-ghost btn-sm" :disabled="pending" @click="$emit('refresh')">
        {{ pending ? t('server.checking') : t('server.refresh') }}</button
      ><ConnectionStatus
        :tone="pending ? 'pending' : ping?.online ? 'success' : 'neutral'"
        :label="pending ? t('server.checking') : ping?.online ? t('server.online') : ping ? t('server.unreachable') : t('server.untested')"
    /></template>
    <div data-ui="ServerDetails:bcfe4bdd0062" class="server-detail-title">
      <span data-ui="ServerDetails:d5eb9cf8090b" class="server-monogram large" aria-hidden="true">{{
        privateServerText(server.name, server, addressRevealed).slice(0, 1).toUpperCase()
      }}</span>
      <div>
        <h3 data-ui="ServerDetails:30996065a917">{{ privateServerText(server.name, server, addressRevealed) }}</h3>
        <ServerAddress :address="server.address" :revealed="addressRevealed" copyable @toggle="$emit('address')" @copy="$emit('copy')" />
      </div>
    </div>
    <div data-ui="ServerDetails:8c10b252815e" v-if="ping?.motd && !pending" class="server-description" aria-live="polite">
      {{ privateServerText(ping.motd, server, addressRevealed) }}
    </div>
    <div data-ui="ServerDetails:9358a88a51a0" class="server-facts">
      <div>
        <span>{{ t('server.online_players') }}</span
        ><strong>{{ ping?.online && !pending ? privateServerText(ping.players, server, addressRevealed) : '—' }}</strong>
      </div>
      <div>
        <span>{{ t('server.latency') }}</span
        ><strong>{{ ping?.online && !pending ? ping.latencyMs + ' ms' : '—' }}</strong>
      </div>
    </div>
    <p data-ui="ServerDetails:8faafdb2bb97" v-if="ping?.online && !pending" class="connection-muted">
      {{ t('server.server_version') }}{{ privateServerText(ping.version, server, addressRevealed) }}
    </p>
    <label data-ui="ServerDetails:59f1e2f8c71a" class="connection-field"
      >{{ t('server.use_instance_to_connect')
      }}<select
        data-ui="ServerDetails:0a9558147a76"
        class="select"
        :value="bound"
        :disabled="busy || binding"
        @change="$emit('bind', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">{{ t('server.unbound_instance') }}</option>
        <option v-for="v in targets" :key="targetToken(v)" :value="targetToken(v)">
          {{ targetLabel(v) }}{{ v.isolated ? t('server.isolated') : '' }}
        </option>
      </select></label
    >
    <div data-ui="ServerDetails:49a9cb995a70" v-if="missing" class="connection-result">
      <ConnectionStatus tone="danger" :label="t('server.bound_instance_missing')" />
      <p>{{ t('server.instance_moved_or_disk_unavailable') }}</p>
      <div data-ui="ServerDetails:5a115acf33b4" class="connection-actions">
        <button data-ui="ServerDetails:cc40b80410ef" class="btn btn-ghost" @click="$emit('relink')">{{ t('server.relink') }}</button
        ><button data-ui="ServerDetails:172ad57da113" class="btn btn-ghost" @click="$emit('versions')">
          {{ t('server.go_to_versions') }}
        </button>
      </div>
    </div>
    <p data-ui="ServerDetails:d3a016071ead" v-else-if="server.candidateVersionIds?.length" class="connection-muted">
      {{ t('server.shared_directory_select_confirm') }}
    </p>
    <div data-ui="ServerDetails:1e93687b1aac" class="connection-muted">
      <p data-ui="ServerDetails:1399ead01b1a" v-if="server.minecraftVersion">
        Minecraft {{ server.minecraftVersion
        }}<span data-ui="ServerDetails:2f795b8f4707" v-if="server.loader"> · {{ server.loader }} {{ server.loaderVersion }}</span>
      </p>
      <p>{{ lastUsed }}</p>
    </div>
    <button data-ui="ServerDetails:1081b0ad3610" class="btn btn-gold server-connect" :disabled="busy || binding" @click="$emit('connect')">
      {{
        running
          ? t('server.game_running')
          : busy
            ? t('server.starting')
            : server.versionId && !missing
              ? t('server.launch_and_connect')
              : t('server.select_instance_and_connect')
      }}<span data-ui="ServerDetails:82645c79195b" aria-hidden="true">↗</span>
    </button>
    <div data-ui="ServerDetails:afa5660e1f9f" class="connection-actions server-secondary">
      <button data-ui="ServerDetails:5d680c5d54c5" class="btn btn-ghost" :disabled="busy || binding" @click="$emit('edit')">
        {{ t('server.edit_server') }}
      </button>
      <details class="server-more" @keydown.esc="($event.currentTarget as HTMLDetailsElement).open = false">
        <summary class="btn btn-ghost">{{ t('server.more') }}</summary>
        <div>
          <button class="btn btn-danger" :disabled="busy || binding" @click="$emit('remove')">{{ t('server.delete_server') }}</button>
        </div>
      </details>
    </div>
    <p data-ui="ServerDetails:571a6e757999" v-if="ping && !ping.online && !pending" class="connection-muted server-footnote">
      {{ t('server.status_check_failed_not_block') }}
    </p>
  </ConnectionPanel>
</template>

<style scoped>
.server-address {
  background: none;
  border: 0;
  color: var(--text-dim);
  font: inherit;
  font-size: 13px;
  padding: 0;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: copy;
}
.server-more {
  position: relative;
}
.server-more summary {
  list-style: none;
}
.server-more > div {
  position: absolute;
  right: 0;
  z-index: 4;
  background: var(--surface-solid);
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.server-connect {
  min-height: 44px;
}
.server-secondary {
  justify-content: flex-end;
}
.server-detail :deep(.connection-panel-head) {
  padding: 12px 20px;
}
.server-detail-title {
  gap: 12px;
}
</style>
