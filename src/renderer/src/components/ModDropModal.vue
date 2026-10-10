<script setup lang="ts">
/**
 * MOD 拖入即装：解析结果确认 + 版本匹配 + 四分支处理
 * 流程：静默解析 → 匹配本地版本 → 有匹配（选版本装入）/ 无匹配（自动或自定义下载后装入）
 */
import { computed, reactive, ref, watch } from 'vue';
import ModInstallDialog from './ModInstallDialog.vue';
import MarqueeText from './MarqueeText.vue';
import { errText, installVersion, onInstallDone, parseMods, getModTargets } from '../api';
import { selectInstance, selectedInstance, displayVersionName, refreshInstalled, store, toast } from '../store';
import { t } from '@renderer/i18n';
import {
  matchesVersionRange as matchRange,
  modMatchesInstance as modMatchesVersion,
  instanceKey,
  modMismatchReasons,
} from '@shared/modCompatibility';
import type { InstalledVersion, LoaderName, ModInfo } from '@shared/types';

const props = defineProps<{
  open: boolean;
  files: string[];
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

// ---------------- 状态 ----------------
const parsing = ref(false);
const allTargets = ref<InstalledVersion[]>([]);
const scanErrors = ref<string[]>([]);
let scanGeneration = 0;
const mods = ref<ModInfo[]>([]);
const selectedVersion = ref('');
function syncDropSelection() {
  const t = allTargets.value.find((v) => instanceKey(v) === selectedVersion.value);
  if (t) void selectInstance(t.id, t.folder);
}
const installing = ref(false);
const modRequest = ref<{ target: InstalledVersion; input: { paths: string[] } } | null>(null);

/** 解析成功的有效 MOD */
const validMods = computed(() => mods.value.filter((m) => !m.error));
/** 解析失败（非 MOD/损坏） */
const failedMods = computed(() => mods.value.filter((m) => !!m.error));
const mismatchDetails = computed(() =>
  allTargets.value.map((v) => ({
    v,
    reasons: validMods.value.flatMap((m) => modMismatchReasons(m, v).map((reason) => `${m.name || m.id}：${reason}`)),
  }))
);

/** 每个 MOD 匹配到的版本 id 集合 */
const matchMap = computed(() => {
  const map: Record<string, string[]> = {};
  for (const m of validMods.value) {
    map[m.filePath] = allTargets.value.filter((v) => modMatchesVersion(m, v)).map(instanceKey);
  }
  return map;
});

/** 所有有效 MOD 的版本交集（可同时装入全部 MOD 的版本） */
const commonVersions = computed(() => {
  if (!validMods.value.length) return [];
  return allTargets.value.filter((v) => validMods.value.every((m) => modMatchesVersion(m, v)));
});

/** 无交集时退而求其次：能装最多 MOD 的版本（含兼容状态标记） */
const bestEffortVersions = computed(() => {
  if (commonVersions.value.length) return [];
  const scored = allTargets.value
    .map((v) => ({
      v,
      ok: validMods.value.filter((m) => modMatchesVersion(m, v)),
      bad: validMods.value.filter((m) => !modMatchesVersion(m, v)),
    }))
    .filter((x) => x.ok.length > 0)
    .sort((a, b) => b.ok.length - a.ok.length);
  return scored;
});

type Branch = 'parse' | 'matched' | 'partial' | 'none';
const branch = computed<Branch>(() => {
  if (parsing.value) return 'parse';
  if (!validMods.value.length) return 'none';
  if (commonVersions.value.length) return 'matched';
  if (bestEffortVersions.value.length) return 'partial';
  return 'none';
});

const LOADER_TAG: Record<LoaderName, string> = {
  forge: 'Forge',
  neoforge: 'NeoForge',
  fabric: 'Fabric',
  quilt: 'Quilt',
};

// ---------------- 打开时解析 ----------------
watch(
  () => props.open,
  async (open) => {
    const generation = ++scanGeneration;
    if (!open) return;
    mods.value = [];
    parsing.value = true;
    try {
      const [parsed, scanned] = await Promise.all([parseMods(props.files), getModTargets()]);
      if (generation !== scanGeneration) return;
      mods.value = parsed;
      allTargets.value = scanned.versions;
      scanErrors.value = scanned.errors;
      // 默认选中交集第一个
      const first =
        commonVersions.value.find((v) => selectedInstance.value && instanceKey(v) === instanceKey(selectedInstance.value)) ??
        commonVersions.value[0] ??
        bestEffortVersions.value[0]?.v;
      selectedVersion.value = first ? instanceKey(first) : '';
    } catch (e) {
      toast(t('mdf.identify_failed', { error: errText(e) }), 'error');
      emit('close');
    } finally {
      if (generation === scanGeneration) parsing.value = false;
    }
  }
);

// ---------------- 分支动作 ----------------
async function onInstallSelected() {
  const selected = allTargets.value.find((v) => instanceKey(v) === selectedVersion.value);
  if (!selected || installing.value) return;
  const vid = selected.id;
  // 部分匹配分支下只装入兼容的 MOD
  const targets = validMods.value.filter((m) =>
    branch.value === 'matched' ? true : bestEffortVersions.value.find((x) => instanceKey(x.v) === selectedVersion.value)?.ok.includes(m)
  );
  if (!targets.length) {
    toast(t('mdf.version_incompatible'), 'error');
    return;
  }
  modRequest.value = { target: selected, input: { paths: targets.map((m) => m.filePath) } };
}

/** 「下载新版本」：跳游戏版本页，提示装完后再装入 */
function onDownloadNew() {
  emit('close');
  store.currentView = 'game';
  toast(t('mdf.install_after_version'), 'info');
}

/** 「自动下载最新兼容版本」：取 MOD 支持的最高 release + 多数派加载器，走现有下载链路；
 *  下载完成后自动把本次 MOD 装入新版本，用户只剩按下启动 */
const autoState = reactive({ busy: false });
async function onAutoDownload() {
  if (autoState.busy) return;
  autoState.busy = true;
  try {
    // 多数派加载器
    const loaderCount = new Map<LoaderName, number>();
    for (const m of validMods.value) {
      if (m.loader) loaderCount.set(m.loader, (loaderCount.get(m.loader) ?? 0) + 1);
    }
    const loader = [...loaderCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (validMods.value.some((m) => m.loader !== loader)) throw new Error(t('mdf.loader_mismatch'));
    if (!loader) throw new Error(t('mdf.no_loader'));
    const { getManifest } = await import('../api');
    const manifest = await getManifest();
    const releases = manifest.filter((v) => v.type === 'release');
    const target = releases.find((v) => validMods.value.every((m) => !m.loader || matchRange(m.mcRange, v.id)));
    if (!target) throw new Error(t('mdf.no_compatible_release'));
    const { listLoaders } = await import('../api');
    const loaderVersions = await listLoaders(loader, target.id);
    if (!loaderVersions.length) throw new Error(t('mdf.no_loader_version', { loader: LOADER_TAG[loader], mc: target.id }));
    const loaderVersion = loaderVersions.find((lv) => validMods.value.every((m) => !m.loaderRange || matchRange(m.loaderRange, lv)));
    if (!loaderVersion) throw new Error(t('mdf.no_loader_match'));
    // Fabric 模组自动携带最新 Fabric API（绝大多数 Fabric MOD 需要）
    let fabricApi: string | undefined;
    if (loader === 'fabric') {
      try {
        const { listFabricApi } = await import('../api');
        const apiList = await listFabricApi(target.id);
        fabricApi = apiList[0]?.version;
      } catch {
        /* API 获取失败不阻断，安装时仍可手动补装 */
      }
    }
    const filePaths = validMods.value.map((m) => m.filePath);
    const destinationFolder =
      store.settings?.folders.find((folder) => folder.isDefault)?.path || store.settings?.activeFolder || store.settings?.gameDir || '';
    emit('close');
    toast(
      t('mdf.auto_download_start', {
        mc: target.id,
        loader: LOADER_TAG[loader],
        loaderVersion,
        fabricApi: fabricApi ? ' + Fabric API' : '',
        count: String(filePaths.length),
      }),
      'info'
    );
    store.installing.add(target.id);
    // 一次性监听：该版本装好后自动装入 MOD（按请求的 versionId 匹配，避免响应其他安装任务）
    const off = onInstallDone((r) => {
      if (r.versionId !== target.id) return;
      off();
      if (!r.ok) {
        toast(t('mdf.version_install_failed'), 'error');
        return;
      }
      void autoInstallMods(filePaths, r.installedId, destinationFolder);
    });
    try {
      await installVersion(target.id, { loader, loaderVersion, fabricApi }, destinationFolder);
    } catch (e) {
      off();
      throw e;
    }
  } catch (e) {
    toast(t('mdf.auto_download_failed', { error: errText(e) }), 'error');
  } finally {
    autoState.busy = false;
  }
}

/** 版本下载完成后自动装入 MOD：installedId 优先，缺失时按 MC 版本 + 加载器兜底定位实例 */
async function autoInstallMods(filePaths: string[], installedId: string | undefined, folder: string) {
  try {
    await refreshInstalled();
    const scanned = await getModTargets();
    const v = scanned.versions.find((v) => v.id === installedId && v.folder === folder);
    if (!v) throw new Error(t('mdf.instance_not_found'));
    modRequest.value = { target: v, input: { paths: filePaths } };
  } catch (e) {
    toast(t('mdf.auto_install_failed', { error: errText(e) }), 'error');
  }
}

function onCustomDownload() {
  onDownloadNew();
}

const modCompatOf = (m: ModInfo): string[] => matchMap.value[m.filePath] ?? [];
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @pointerdown.self="emit('close')">
      <div class="modal moddrop-modal">
        <h3 class="modal-title">{{ t('mdf.title') }}</h3>

        <!-- Parsing -->
        <div v-if="parsing" class="parse-loading">
          <span class="spin"></span>
          <span class="muted">{{ t('mdf.identifying') }}</span>
        </div>

        <template v-else>
          <div v-if="scanErrors.length" class="none-hint">
            {{ t('mdf.scan_incomplete') }}
            <div v-for="error in scanErrors" :key="error">{{ error }}</div>
          </div>
          <!-- Identified results list -->
          <div class="mod-list">
            <div v-for="m in mods" :key="m.filePath + m.fileName" class="mod-row" :class="{ failed: !!m.error }">
              <img v-if="m.iconDataUrl" class="mod-icon" :src="m.iconDataUrl" alt="" />
              <span v-else class="mod-icon mod-icon-empty">{{ (m.name || m.fileName).charAt(0) }}</span>
              <div class="mod-meta">
                <div class="mod-title-row">
                  <MarqueeText class="mod-name" :text="m.name || m.fileName" />
                  <MarqueeText v-if="m.version" class="muted" :text="'v' + m.version" />
                  <span v-if="m.loader" class="tag">{{ LOADER_TAG[m.loader] }}</span>
                </div>
                <div class="mod-sub muted">
                  <template v-if="m.error">⚠ {{ m.error }}</template>
                  <template v-else>
                    <span v-if="m.mcRange">MC {{ m.mcRange }}</span>
                    <span v-if="m.loaderRange"> · Loader {{ m.loaderRange }}</span>
                    <span v-if="m.dependencies.length"> · {{ t('mdf.dependencies', { deps: m.dependencies.join(', ') }) }}</span>
                    <span v-if="!m.error && branch !== 'none'" :class="modCompatOf(m).length ? 'compat-ok' : 'compat-bad'">
                      {{
                        modCompatOf(m).length
                          ? ` · ${t('mdf.match_local', { count: String(modCompatOf(m).length) })}`
                          : ` · ${t('mdf.no_match_version')}`
                      }}
                    </span>
                  </template>
                </div>
              </div>
            </div>
          </div>

          <!-- All matched -->
          <template v-if="branch === 'matched'">
            <p class="modal-label">
              {{ t('mdf.select_version', { count: String(commonVersions.length), mods: String(validMods.length) }) }}
            </p>
            <div class="ver-list">
              <label
                v-for="v in commonVersions"
                :key="instanceKey(v)"
                class="ver-option"
                :class="{ active: selectedVersion === instanceKey(v) }"
              >
                <input v-model="selectedVersion" @change="syncDropSelection" type="radio" :value="instanceKey(v)" />
                <span class="ver-name"
                  >{{ displayVersionName(v)
                  }}<small
                    >{{ v.mcVersion }} · {{ v.loader }} {{ v.loaderVersion || t('mdf.unknown_version') }}<br />{{ v.folder }}</small
                  ></span
                >
                <span v-if="v.isolated" class="tag">{{ t('common.isolated') }}</span>
              </label>
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost" @click="emit('close')">{{ t('common.cancel') }}</button>
              <button class="btn btn-ghost" @click="onDownloadNew">{{ t('mdf.download_new') }}</button>
              <button class="btn btn-gold" :disabled="installing" @click="onInstallSelected">
                {{ installing ? t('mdf.installing') : t('mdf.install_selected') }}
              </button>
            </div>
          </template>

          <!-- Partial match -->
          <template v-else-if="branch === 'partial'">
            <p class="modal-label">{{ t('mdf.no_full_match') }}</p>
            <div class="ver-list">
              <label
                v-for="x in bestEffortVersions"
                :key="instanceKey(x.v)"
                class="ver-option"
                :class="{ active: selectedVersion === instanceKey(x.v) }"
              >
                <input v-model="selectedVersion" type="radio" :value="instanceKey(x.v)" />
                <span class="ver-name"
                  >{{ displayVersionName(x.v)
                  }}<small
                    >{{ x.v.mcVersion }} · {{ x.v.loader }} {{ x.v.loaderVersion || t('mdf.unknown_version') }}<br />{{ x.v.folder }}</small
                  ></span
                >
                <span class="muted">{{ t('mdf.can_install', { ok: String(x.ok.length), total: String(validMods.length) }) }}</span>
              </label>
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost" @click="emit('close')">{{ t('common.cancel') }}</button>
              <button class="btn btn-ghost" @click="onDownloadNew">{{ t('mdf.download_new') }}</button>
              <button class="btn btn-gold" :disabled="installing" @click="onInstallSelected">
                {{ installing ? t('mdf.installing') : t('mdf.install_compatible') }}
              </button>
            </div>
          </template>

          <!-- No match at all -->
          <template v-else-if="branch === 'none'">
            <div class="none-hint">
              <p>
                {{ scanErrors.length ? t('mdf.scan_errors_first') : t('mdf.scanned_all', { count: String(allTargets.length) }) }}
              </p>
              <details v-if="allTargets.length">
                <summary>{{ t('mdf.view_match_reasons') }}</summary>
                <div v-for="item in mismatchDetails" :key="instanceKey(item.v)" class="mismatch-item">
                  <strong>{{ displayVersionName(item.v) }}</strong
                  ><small>{{ item.v.folder }}</small>
                  <p v-for="reason in item.reasons" :key="reason">{{ reason }}</p>
                </div>
              </details>
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost" @click="emit('close')">{{ t('common.cancel') }}</button>
              <button class="btn btn-ghost" @click="onCustomDownload">{{ t('mdf.custom_download') }}</button>
              <button v-if="validMods.length && !scanErrors.length" class="btn btn-gold" :disabled="autoState.busy" @click="onAutoDownload">
                {{ autoState.busy ? t('mdf.analyzing') : t('mdf.auto_download') }}
              </button>
            </div>
          </template>

          <!-- Failed file summary -->
          <div v-if="failedMods.length" class="failed-summary muted">
            {{ t('mdf.failed_files', { count: String(failedMods.length) }) }}
          </div>
        </template>
      </div>
    </div>
  </Teleport>
  <ModInstallDialog
    v-if="modRequest"
    :target="modRequest.target"
    :input="modRequest.input"
    @close="modRequest = null"
    @installed="
      modRequest = null;
      emit('close');
    "
  />
</template>

<style scoped>
.mismatch-item {
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.mismatch-item small {
  display: block;
  opacity: 0.75;
  font-size: var(--text-xs);
}
.mismatch-item p {
  margin: var(--space-1) 0;
  font-size: var(--text-xs);
}
.mismatch-item strong {
  font-size: var(--text-sm);
}
summary {
  cursor: pointer;
  padding: var(--space-2) 0;
  font-size: var(--text-sm);
}
.moddrop-modal {
  width: 520px;
  max-height: 82vh;
  overflow-y: auto;
}
.modal-title {
  font-size: var(--text-lg);
  font-weight: 700;
  margin: 0 0 var(--space-4);
}
.parse-loading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-5) 0;
  justify-content: center;
}
.mod-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
  max-height: 300px;
  overflow-y: auto;
}
.mod-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--row-h);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.mod-row.failed {
  border-color: var(--danger-border);
  background: var(--danger-soft);
}
.mod-icon {
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  object-fit: contain;
  image-rendering: pixelated;
}
.mod-icon-empty {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
  font-size: var(--text-md);
}
.mod-meta {
  min-width: 0;
  flex: 1;
}
.mod-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.mod-name {
  font-size: var(--text-sm);
  font-weight: 700;
  word-break: break-all;
}
.mod-sub {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  line-height: 1.5;
  word-break: break-all;
}
.compat-ok {
  color: var(--ok);
}
.compat-bad {
  color: var(--danger);
}
.ver-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 200px;
  overflow-y: auto;
}
.ver-option {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--row-h);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}
.ver-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.ver-option input {
  accent-color: var(--accent);
}
.ver-name small {
  display: block;
  font-weight: 400;
  font-size: var(--text-xs);
  color: var(--text-dim);
  margin-top: var(--space-1);
}
.ver-name {
  flex: 1;
  font-size: var(--text-sm);
  font-weight: 600;
  word-break: break-all;
}
.none-hint {
  padding: var(--space-3) var(--space-4);
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
  color: var(--text-dim);
  font-size: var(--text-sm);
  line-height: 1.7;
  margin-bottom: var(--space-1);
}
.failed-summary {
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  line-height: 1.6;
}
.modal-label {
  font-size: var(--text-sm);
  color: var(--text-dim);
  margin: var(--space-3) 0 var(--space-2);
}
</style>
