<script setup lang="ts">
import { langOptions, locale, setLocale, t } from '@renderer/i18n';
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import UpdateDialogShell from '../components/UpdateDialogShell.vue';
const ThirdPartyNotices = defineAsyncComponent(() => import('../components/ThirdPartyNotices.vue'));
import {
  addCustomJava,
  applyLocalUpdate,
  applyPendingUpdate,
  cancelJavaScan,
  checkUpdate,
  errText,
  getPendingUpdate,
  getSettings,
  getSystemInfo,
  getUpdateState,
  hideJava,
  installPlugin,
  listJava,
  listPlugins,
  listUpdateReleases,
  onProgress,
  openPluginsDir,
  pickAddJava,
  pickLocalUpdateFile,
  refreshJava,
  removePlugin,
  restoreUpdateBackup,
  selectDir,
  setDownloadFolder,
  setPluginEnabled,
} from '../api';
import { enterEditMode, store, toast } from '../store';
import { DEFAULT_CUSTOM_THEME, THEME_PRESETS } from '@shared/types';
import { autoMemoryMB } from '@shared/memory';
import MemoryOrganizer from '../components/MemoryOrganizer.vue';
import type { LocalUpdateCheck, PluginInfo, ReleaseInfo, Settings, ThemeName, UpdateStateInfo } from '@shared/types';
import { useMotion } from '../motion';
const { systemReduced } = useMotion();
import { usePlatformUpdate } from '../composables/usePlatformUpdate';
const { systemInstaller, installAction, updateReadyMessage } = usePlatformUpdate();
const systemMotionHelp = computed(() => {
  if (window.faionyx.platform === 'darwin') return t('settings.motion.help.darwin');
  if (window.faionyx.platform === 'win32') return t('settings.motion.help.win32');
  return t('settings.motion.help.other');
});
import HomeLayoutEditor from '../components/HomeLayoutEditor.vue';
import SelectMenu from '../components/SelectMenu.vue';
import {
  settingsCatalog,
  settingsCategories,
  settingsScopes,
  scopeOfCategory,
  searchSettings,
  type SettingsCategory,
  type SettingsScope,
} from '@shared/settingsCatalog';
import { updateSettings } from '../settingsUpdates';
import { refreshInstalled } from '../store';

const page = ref<HTMLElement | null>(null);
/** 精确输入框自动聚焦 */
const vFocus = { mounted: (el: HTMLElement) => el.focus() };
const settingsQuery = ref('');
const searchMatches = computed(() => searchSettings(settingsQuery.value));
const savedCategory = sessionStorage.getItem('faionyx.settings.category');
const category = ref<SettingsCategory>(settingsCategories.find((c) => c.id === savedCategory)?.id ?? 'appearance');
const scope = computed(() => scopeOfCategory(category.value));
const visibleCategories = computed(() => settingsCategories.filter((c) => c.scope === scope.value));
const lastCategories: Record<SettingsScope, SettingsCategory> = { launcher: 'appearance', game: 'game' };
lastCategories[scope.value] = category.value;
function selectScope(id: SettingsScope) {
  void selectCategory(lastCategories[id]);
}
const positions = new Map<string, number>();
let navigation = 0;
function scroller() {
  return page.value?.querySelector<HTMLElement>('.settings-body');
}
async function selectCategory(id: SettingsCategory) {
  const ticket = ++navigation;
  const scroll = scroller();
  positions.set(category.value, scroll?.scrollTop ?? 0);
  category.value = id;
  lastCategories[scopeOfCategory(id)] = id;
  settingsQuery.value = '';
  sessionStorage.setItem('faionyx.settings.category', id);
  await nextTick();
  if (ticket === navigation && scroll)
    scroll.scrollTop = Math.min(positions.get(id) ?? 0, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
}
async function jumpSetting(id: string) {
  const item = settingsCatalog.find((item) => item.id === id);
  if (!item) return;
  await selectCategory(item.category);
  const target = page.value?.querySelector<HTMLElement>('[data-section="' + id + '"]');
  if (!target) return;
  if (target.tagName === 'DETAILS') (target as HTMLDetailsElement).open = true;
  // Reveal only the path to the result, never expand every advanced setting below it.
  for (let parent = target.parentElement; parent && parent !== scroller(); parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
  }
  await nextTick();
  target.setAttribute('tabindex', '-1');
  const body = scroller();
  if (body) body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
  target.focus({ preventScroll: true });
}
async function revealSection() {
  if (!store.settings || !store.settingsSection) return;
  const id = store.settingsSection;
  store.settingsSection = '';
  await jumpSetting(id);
}
onMounted(revealSection);
watch([() => store.settingsSection, () => !!store.settings], revealSection, { flush: 'post' });

// ---------------- 保存 ----------------
async function save(patch: Partial<Settings>) {
  try {
    await updateSettings(patch);
  } catch (e) {
    toast(t('settings.toast.save_failed', { e: errText(e) }), 'error');
  }
}

const windowFitBusy = ref(false);
async function changeWindowFit(event: Event) {
  if (windowFitBusy.value) return;
  const input = event.target as HTMLInputElement;
  windowFitBusy.value = true;
  try {
    await updateSettings({ uiWindowAutoFit: input.checked });
  } catch (error) {
    toast(t('settings.toast.window_fit_failed', { e: errText(error) }), 'error');
  } finally {
    windowFitBusy.value = false;
    input.checked = store.settings?.uiWindowAutoFit === true;
  }
}

const defaultDownloadFolder = computed(
  () => store.settings?.folders.find((folder) => folder.isDefault)?.path || store.settings?.activeFolder || store.settings?.gameDir || ''
);
const windowSizeBusy = ref(false);
const canRememberWindow = window.faionyx.platform === 'win32';
async function toggleWindowSize(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!store.settings || windowSizeBusy.value) return;
  windowSizeBusy.value = true;
  try {
    await updateSettings({ rememberGameWindowSize: input.checked });
  } catch (error) {
    toast(t('settings.toast.window_size_failed', { e: errText(error) }), 'error');
  } finally {
    windowSizeBusy.value = false;
    input.checked = store.settings?.rememberGameWindowSize === true;
  }
}
const downloadFolderBusy = ref(false);
const downloadFolderError = ref('');
async function applyDownloadFolder(folder: string) {
  if (!folder || downloadFolderBusy.value) return;
  downloadFolderBusy.value = true;
  downloadFolderError.value = '';
  let committed = false;
  try {
    const folders = await setDownloadFolder(folder);
    committed = true;
    const selected = folders.find((item) => item.isDefault)!.path;
    if (store.settings) store.settings = { ...store.settings, folders, activeFolder: selected, gameDir: selected };
    store.settings = await getSettings();
    store.resourceVersionId = '';
    await refreshInstalled();
    toast(t('settings.toast.download_changed'), 'success');
  } catch (error) {
    downloadFolderError.value = committed
      ? t('settings.toast.download_saved_stale', { e: errText(error) })
      : t('settings.toast.download_change_failed', { e: errText(error) });
  } finally {
    downloadFolderBusy.value = false;
  }
}
async function chooseNewDownloadFolder() {
  if (downloadFolderBusy.value) return;
  downloadFolderBusy.value = true;
  downloadFolderError.value = '';
  try {
    const selected = await selectDir();
    downloadFolderBusy.value = false;
    if (selected) await applyDownloadFolder(selected);
  } catch (error) {
    downloadFolderError.value = t('settings.toast.pick_folder_failed', { e: errText(error) });
  } finally {
    downloadFolderBusy.value = false;
  }
}
function reloadLauncher() {
  window.location.reload();
}
// ---------------- 关于与更新 ----------------
const appVersion = __APP_VERSION__;
const showLicenses = ref(false);
const updateCheckState = ref<'idle' | 'checking' | 'latest' | 'failed'>('idle');
let lastManualCheck = 0;

async function onCheckUpdate() {
  const now = Date.now();
  if (now - lastManualCheck < 5 * 60_000 && updateCheckState.value === 'latest') {
    toast(t('settings.toast.update_checked_recently'), 'info');
    return;
  }
  lastManualCheck = now;
  updateCheckState.value = 'checking';
  try {
    const r = await checkUpdate(true);
    if (r.ok && r.hasUpdate && r.release) {
      updateCheckState.value = 'idle';
      store.updatePrompt = { release: r.release, rollback: false };
    } else if (r.ok) {
      updateCheckState.value = 'latest';
    } else {
      updateCheckState.value = 'failed';
      toast(t('settings.toast.update_check_failed'), 'error');
    }
  } catch {
    updateCheckState.value = 'failed';
    toast(t('settings.toast.update_check_failed'), 'error');
  }
}

const updateSource = computed(() => store.settings?.updateSource ?? 'auto');
function onUpdateSourceChange(e: Event) {
  void save({ updateSource: (e.target as HTMLSelectElement).value as Settings['updateSource'] });
}
function onUpdateMirrorChange(e: Event) {
  void save({ updateMirrorUrl: (e.target as HTMLInputElement).value.trim() });
}

// 版本回退
const rollback = ref<{ open: boolean; loading: boolean; list: ReleaseInfo[]; selected: string }>({
  open: false,
  loading: false,
  list: [],
  selected: '',
});
async function openRollback() {
  rollback.value.open = true;
  rollback.value.loading = true;
  try {
    rollback.value.list = (await listUpdateReleases()).filter((r) => r.version !== appVersion);
    if (!rollback.value.list.length) toast(t('settings.toast.rollback_empty'), 'info');
  } catch (e) {
    toast(t('settings.toast.rollback_fetch_failed', { e: errText(e) }), 'error');
  } finally {
    rollback.value.loading = false;
  }
}
function confirmRollback() {
  const release = rollback.value.list.find((r) => r.version === rollback.value.selected);
  rollback.value.open = false;
  if (!release) return;
  store.updatePrompt = { release, rollback: true };
}
function releaseSummary(body: string): string {
  const first =
    (body || '')
      .split(/\r?\n/)
      .map((s) => s.replace(/^(?:#+|[-*])\s*/, '').trim())
      .filter((s) => s && !/^FAIONYX\s+v?[\d.]+$/i.test(s))[0] ?? '';
  return first.length > 60 ? first.slice(0, 60) + '…' : first;
}
function releaseDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 还原到更新前的版本
const updateState = ref<UpdateStateInfo | null>(null);
const restoringBackup = ref(false);
// 已就绪待安装的更新（下次启动时应用，也可立即安装）
const pendingUpdate = ref<{ release: ReleaseInfo; file: string } | null>(null);
async function refreshUpdateState() {
  try {
    updateState.value = await getUpdateState();
  } catch {
    updateState.value = null;
  }
  try {
    pendingUpdate.value = await getPendingUpdate();
  } catch {
    pendingUpdate.value = null;
  }
}
async function onRestoreBackup() {
  if (!updateState.value) return;
  restoringBackup.value = true;
  try {
    await restoreUpdateBackup();
    restoringBackup.value = false;
    await refreshUpdateState();
    toast(t('settings.toast.backup_ready'), 'success');
  } catch (e) {
    restoringBackup.value = false;
    toast(t('settings.toast.backup_failed', { e: errText(e) }), 'error');
  }
}
async function onApplyPending() {
  try {
    await applyPendingUpdate();
    toast(updateReadyMessage(), 'success');
  } catch (e) {
    toast(t('settings.toast.install_failed', { e: errText(e) }), 'error');
  }
}

// 从本地文件安装更新
const localUpdate = ref<{ check: LocalUpdateCheck; confirming: boolean } | null>(null);
async function onPickLocalUpdate() {
  try {
    const check = await pickLocalUpdateFile();
    if (!check) return;
    localUpdate.value = { check, confirming: true };
  } catch (e) {
    toast(t('settings.toast.local_verify_failed', { e: errText(e) }), 'error');
  }
}
async function confirmLocalUpdate() {
  const lu = localUpdate.value;
  if (!lu) return;
  localUpdate.value = null;
  try {
    await applyLocalUpdate(lu.check);
    await refreshUpdateState();
    toast(updateReadyMessage(t('settings.toast.local_ready')), 'success');
  } catch (e) {
    toast(t('settings.toast.local_install_failed', { e: errText(e) }), 'error');
  }
}

onMounted(refreshUpdateState);

// ---------------- 功能管理 ----------------
const featureToggles = computed(() => [
  { key: 'mods', label: t('settings.features.mods') },
  { key: 'packs', label: t('settings.features.packs') },
  { key: 'shaders', label: t('settings.features.shaders') },
  { key: 'recordings', label: t('settings.features.recordings') },
  { key: 'bridge', label: t('settings.features.bridge') },
  { key: 'servers', label: t('settings.features.servers') },
  { key: 'friends', label: t('settings.features.friends') },
  { key: 'keys', label: t('settings.features.keys') },
  { key: 'skins', label: t('settings.features.skins') },
  { key: 'community', label: t('settings.features.community') },
]);

function onToggleFeature(key: string, enabled: boolean) {
  const cur = store.settings?.disabledFeatures ?? [];
  const next = enabled ? cur.filter((k) => k !== key) : [...new Set([...cur, key])];
  void save({ disabledFeatures: next });
}

// ---------------- 主题 ----------------
const themeOptions = computed(() => {
  const customColors = store.settings?.custom.colors ?? DEFAULT_CUSTOM_THEME.colors;
  const named = (key: Exclude<ThemeName, 'custom'>) => ({ key, ...THEME_PRESETS[key] });
  return [
    named('transparent'),
    named('blue-white'),
    named('black-orange'),
    named('black-pink'),
    named('white-pink'),
    {
      key: 'custom' as const,
      labelKey: t('settings.theme.custom.label'),
      descriptionKey: t('settings.theme.custom.desc'),
      colors: customColors,
    },
  ];
});

function chooseTheme(theme: ThemeName, _label: string) {
  void save({ theme });
}

// ---------------- Java 列表 ----------------
const javas = ref<Awaited<ReturnType<typeof listJava>>>([]);
const javaLoading = ref(true);
const javaError = ref('');
const javaRefreshing = ref(false);
const javaCancelling = ref(false);
const javaScanText = ref('');
const javaScanProgress = ref(0);
const javaAdding = ref(false);
const javaCustomInput = ref('');
const javaAddError = ref('');

async function onRefreshJava(refresh = true, announce = true) {
  if (javaRefreshing.value) {
    javaCancelling.value = true;
    try {
      const cancelled = await cancelJavaScan();
      if (!cancelled) toast(t('settings.toast.scan_done'), 'info');
    } catch (e) {
      toast(t('settings.toast.scan_cancel_failed', { e: errText(e) }), 'error');
    } finally {
      javaCancelling.value = false;
    }
    return;
  }
  javaRefreshing.value = true;
  javaScanText.value = t('settings.toast.java_scan_preparing');
  javaScanProgress.value = 0;
  try {
    javas.value = await refreshJava(refresh);
    if (announce) toast(t('settings.toast.java_scan_done'), 'success');
  } catch (e) {
    const message = errText(e);
    const cancelled = /cancel|abort/i.test(message);
    toast(
      cancelled ? t('settings.toast.java_scan_cancelled') : t('settings.toast.java_scan_failed', { e: message }),
      cancelled ? 'info' : 'error'
    );
  } finally {
    javaRefreshing.value = false;
    javaCancelling.value = false;
  }
}

async function onAddJava() {
  if (javaAdding.value) return;
  javaAdding.value = true;
  javaAddError.value = '';
  try {
    const p = javaCustomInput.value.trim();
    if (p) {
      await addCustomJava(p);
      javaCustomInput.value = '';
      javas.value = await listJava();
    } else {
      const list = await pickAddJava();
      if (!list) return;
      javas.value = list;
    }
    toast(t('settings.toast.java_added'), 'success');
  } catch (e) {
    javaAddError.value = errText(e);
  } finally {
    javaAdding.value = false;
  }
}

async function onHideJava(p: string) {
  try {
    await hideJava(p);
    javas.value = await listJava();
  } catch (e) {
    toast(t('settings.toast.operation_failed', { e: errText(e) }), 'error');
  }
}

onMounted(async () => {
  try {
    javas.value = await listJava();
  } catch (e) {
    javaError.value = errText(e);
  } finally {
    javaLoading.value = false;
  }
  void onRefreshJava(false, false);
});

const stopJavaProgress = onProgress((event) => {
  if (event.stage !== 'java-scan') return;
  javaScanText.value = event.text;
  javaScanProgress.value = Math.max(0, Math.min(1, event.overall ?? event.progress));
});
onUnmounted(stopJavaProgress);

const javaLabel = (j: { major: number; path: string; version: string; architecture?: string }) =>
  t('settings.java.label', {
    major: String(j.major),
    version: j.version,
    arch: j.architecture ?? t('settings.java.vendor_unknown'),
    path: j.path,
  });

// ---------------- 内存分配（自动/手动） ----------------
const MEM_MIN = 1024;
const MEM_STEP = 512;
const SYS_RESERVE_MB = 1024;
const memMax = ref(16384);
const memTotal = ref(0);
const memFree = ref(0);
const fmtMem = (mb: number) =>
  mb % 1024 === 0
    ? t('settings.memory.fmt_gb', { g: String(mb / 1024) })
    : t('settings.memory.fmt_mb_gb', { mb: String(mb), gb: (mb / 1024).toFixed(2) });

async function refreshSystemInfo(): Promise<void> {
  try {
    const info = await getSystemInfo();
    memTotal.value = info.totalMemMB;
    memFree.value = info.freeMemMB;
    memMax.value = Math.max(MEM_MIN, Math.floor((info.freeMemMB - SYS_RESERVE_MB) / MEM_STEP) * MEM_STEP);
    const s = store.settings;
    if (s && s.memoryMB > info.totalMemMB) {
      s.memoryMB = info.totalMemMB;
      void save({ memoryMB: info.totalMemMB });
    }
  } catch {
    /* 读不到就保持保守上限 */
  }
}
onMounted(refreshSystemInfo);

const memoryAuto = computed(() => store.settings?.memoryAuto === true);
function onMemoryAutoChange(on: boolean): void {
  store.settings!.memoryAuto = on;
  void save({ memoryAuto: on });
}
const autoMemMB = computed(() => autoMemoryMB(memTotal.value || 16384));
const autoMemoryText = computed(() => (memTotal.value ? fmtMem(autoMemMB.value) : t('settings.memory.auto_placeholder')));

const memoryOverFree = computed(() => {
  const mb = store.settings?.memoryMB ?? 0;
  return memFree.value > 0 && mb > memFree.value;
});

const memoryMaxText = computed(() => fmtMem(memMax.value));
const memoryText = computed(() => {
  if (memoryAuto.value) return t('settings.memory.auto_value', { value: fmtMem(autoMemMB.value) });
  if (memPreview.value != null) return fmtMem(Math.round(memPreview.value / MEM_STEP) * MEM_STEP);
  return fmtMem(store.settings?.memoryMB ?? 0);
});
const memoryInfoText = computed(() =>
  memTotal.value
    ? t('settings.memory.info_used', {
        used: fmtMem(Math.max(0, memTotal.value - memFree.value)),
        free: fmtMem(memFree.value),
        total: fmtMem(memTotal.value),
      })
    : t('settings.memory.info_loading')
);

// ---------------- 自定义内存滑块 ----------------
const memTrack = ref<HTMLElement | null>(null);
const memDragging = ref(false);
const memPreview = ref<number | null>(null);
const memBaseline = ref<{ max: number; span: number } | null>(null);

const memScaleMax = computed(() => memBaseline.value?.max ?? memMax.value);
const memScaleSpan = computed(() => memBaseline.value?.span ?? Math.max(memMax.value, MEM_MIN + MEM_STEP) - MEM_MIN);

function memRawFromClientX(clientX: number): number {
  const track = memTrack.value;
  if (!track) return store.settings?.memoryMB ?? MEM_MIN;
  const rect = track.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return MEM_MIN + ratio * memScaleSpan.value;
}

function onMemThumbDown(e: PointerEvent) {
  e.preventDefault();
  e.stopPropagation();
  memDragging.value = true;
  const max = memMax.value;
  memBaseline.value = { max, span: Math.max(max, MEM_MIN + MEM_STEP) - MEM_MIN };
  memPreview.value = store.settings?.memoryMB ?? MEM_MIN;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
}
function onMemPointerMove(e: PointerEvent) {
  if (!memDragging.value) return;
  memPreview.value = memRawFromClientX(e.clientX);
}
function onMemPointerUp() {
  if (!memDragging.value) return;
  memDragging.value = false;
  const raw = memPreview.value ?? store.settings?.memoryMB ?? MEM_MIN;
  const frozenMax = memBaseline.value?.max ?? memMax.value;
  memPreview.value = null;
  memBaseline.value = null;
  const v = Math.max(MEM_MIN, Math.min(Math.round(raw / MEM_STEP) * MEM_STEP, frozenMax));
  if (store.settings) {
    store.settings.memoryMB = v;
    void save({ memoryMB: v });
  }
  void refreshSystemInfo();
}

/** 数值输入（GB，支持 0.25 精度）；失焦/回车保存 */
const memoryInputGB = ref('');
const memoryEditing = ref(false);
function startMemoryEdit() {
  memoryInputGB.value = String(((store.settings?.memoryMB ?? MEM_MIN) / 1024).toFixed(2)).replace(/\.?0+$/, '');
  memoryEditing.value = true;
}
function commitMemoryEdit() {
  const gb = Number(memoryInputGB.value);
  memoryEditing.value = false;
  if (!Number.isFinite(gb) || gb <= 0) return;
  const mb = Math.round(Math.max(MEM_MIN / 1024, Math.min(gb, memMax.value / 1024)) * 1024);
  if (store.settings) {
    store.settings.memoryMB = mb;
    void save({ memoryMB: mb });
  }
}

const memFillPct = computed(() => {
  const mb = memPreview.value ?? store.settings?.memoryMB ?? MEM_MIN;
  return Math.max(0, Math.min(100, ((mb - MEM_MIN) / memScaleSpan.value) * 100));
});

// ---------------- 分辨率 ----------------
const resolutionError = ref('');

function saveResolution() {
  const s = store.settings;
  if (!s) return;
  const width = Number(s.resolution.width);
  const height = Number(s.resolution.height);
  if (!Number.isInteger(width) || width < 854 || width > 7680) {
    resolutionError.value = t('settings.resolution.error_width');
    return;
  }
  if (!Number.isInteger(height) || height < 480 || height > 4320) {
    resolutionError.value = t('settings.resolution.error_height');
    return;
  }
  resolutionError.value = '';
  s.resolution.fullscreen = s.resolution.mode === 'fullscreen';
  void save({ resolution: { ...s.resolution } });
}

// ---------------- 插件系统 ----------------
const plugins = ref<PluginInfo[]>([]);
const pluginBusy = ref(false);
const pluginDirty = ref(false);
const pluginConfirmRemove = ref('');

onMounted(async () => {
  try {
    plugins.value = await listPlugins();
  } catch {
    /* 插件列表失败不阻塞设置页 */
  }
});

async function onInstallPlugin() {
  if (pluginBusy.value) return;
  pluginBusy.value = true;
  try {
    const before = plugins.value.length;
    plugins.value = await installPlugin();
    if (plugins.value.length > before) {
      pluginDirty.value = true;
      toast(t('settings.toast.plugin_installed'), 'success');
    }
  } catch (e) {
    toast(t('settings.toast.plugin_install_failed', { e: errText(e) }), 'error');
  } finally {
    pluginBusy.value = false;
  }
}

async function onTogglePlugin(p: PluginInfo, enabled: boolean) {
  try {
    plugins.value = await setPluginEnabled(p.id, enabled);
    pluginDirty.value = true;
  } catch (e) {
    toast(t('settings.toast.operation_failed', { e: errText(e) }), 'error');
  }
}

async function onRemovePlugin(p: PluginInfo) {
  if (pluginConfirmRemove.value !== p.id) {
    pluginConfirmRemove.value = p.id;
    setTimeout(() => {
      if (pluginConfirmRemove.value === p.id) pluginConfirmRemove.value = '';
    }, 3000);
    return;
  }
  pluginConfirmRemove.value = '';
  try {
    plugins.value = await removePlugin(p.id);
    pluginDirty.value = true;
    toast(t('settings.toast.plugin_removed', { name: p.name }), 'success');
  } catch (e) {
    toast(t('settings.toast.plugin_remove_failed', { e: errText(e) }), 'error');
  }
}
</script>

<template>
  <div data-ui="SettingsView:bf6b46a9d4d6" ref="page" class="page settings-page">
    <div data-ui="SettingsView:4348bca0a0cd" class="page-head">
      <h1 data-ui="SettingsView:23c5aeacd581" class="page-title">{{ t('settings.title') }}</h1>
    </div>

    <div data-ui="SettingsView:821acd5b45d3" class="settings-navigation">
      <label data-ui="SettingsView:213f2c95d295" class="settings-search"
        ><input
          data-ui="SettingsView:a49601b2b97e"
          v-model="settingsQuery"
          class="input"
          type="search"
          :placeholder="t('settings.search_placeholder')"
          :aria-label="t('settings.search_aria')"
          @keydown.esc="settingsQuery = ''"
      /></label>
      <nav class="settings-scopes" :aria-label="t('settings.scope_aria')">
        <button
          v-for="item in settingsScopes"
          :key="item.id"
          class="btn btn-ghost"
          :aria-current="scope === item.id ? 'page' : undefined"
          @click="selectScope(item.id)"
        >
          {{ t(item.label) }}
        </button>
      </nav>
      <nav data-ui="SettingsView:59cf14ccb4be" class="settings-categories" :aria-label="t('settings.category_aria')">
        <button
          data-ui="SettingsView:68ab6a2985c0"
          v-for="item in visibleCategories"
          :key="item.id"
          class="btn btn-ghost"
          :aria-current="category === item.id ? 'page' : undefined"
          @click="selectCategory(item.id)"
        >
          {{ t(item.label) }}
        </button>
      </nav>
      <div
        data-ui="SettingsView:9e789d8ad646"
        v-if="settingsQuery.trim()"
        class="settings-search-results"
        role="region"
        :aria-label="t('settings.search_results_aria')"
      >
        <p data-ui="SettingsView:4c05037c5017" v-if="!searchMatches.length" class="muted">
          {{ t('settings.search_no_match') }}
        </p>
        <button
          data-ui="SettingsView:5bdb3d2f1359"
          v-for="item in searchMatches"
          :key="item.id"
          class="btn btn-ghost"
          @click="jumpSetting(item.id)"
        >
          <strong data-ui="SettingsView:32a83676fd73">{{ t(item.name) }}</strong
          ><span class="muted"
            >{{ t(settingsScopes.find((s) => s.id === scopeOfCategory(item.category))?.label ?? 'settings.scope.launcher') }} ·
            {{ t(settingsCategories.find((c) => c.id === item.category)?.label ?? 'settings.scope.launcher') }} →</span
          >
        </button>
      </div>
    </div>
    <div class="settings-body" tabindex="0" :aria-label="t('settings.body_aria')">
      <div data-ui="SettingsView:a82a0d33446b" v-if="!store.settings" class="card empty">
        <span class="spin"></span>
        <span>{{ t('settings.loading') }}</span>
      </div>

      <template v-else>
        <!-- 外观主题 -->
        <details
          data-ui="SettingsView:24e434dcfefc"
          v-show="category === 'appearance'"
          data-section="theme"
          class="card group collapse"
          open
        >
          <summary class="collapse-head">
            <h3 class="group-title">{{ t('settings.theme.title') }}</h3>
            <span class="collapse-arrow" aria-hidden="true"></span>
          </summary>
          <div class="collapse-body">
            <div data-ui="SettingsView:98eed5eaae97" class="theme-options">
              <button
                data-ui="SettingsView:ae1494b5d771"
                v-for="theme in themeOptions"
                :key="theme.key"
                class="theme-option"
                :class="{ active: store.settings.theme === theme.key }"
                :title="t(theme.descriptionKey)"
                @click="chooseTheme(theme.key, t(theme.labelKey))"
              >
                <span
                  data-ui="SettingsView:ff8e35becbf3"
                  class="theme-preview"
                  :class="{ 'preview-custom': theme.key === 'custom', 'preview-transparent': theme.key === 'transparent' }"
                  :style="{ background: theme.colors.bg }"
                >
                  <span
                    data-ui="SettingsView:202a66a2a038"
                    class="tp-side"
                    :style="{
                      background: theme.colors.sidebarBg,
                      borderRight: '1px solid ' + theme.colors.border,
                    }"
                  >
                    <span data-ui="SettingsView:f9ad546443d3" class="tp-dot" :style="{ background: theme.colors.accent }"></span>
                  </span>
                  <span data-ui="SettingsView:a397f44260a9" class="tp-main">
                    <span
                      data-ui="SettingsView:e0b92057c385"
                      class="tp-top"
                      :style="{
                        background: theme.colors.card,
                        borderBottom: '1px solid ' + theme.colors.border,
                      }"
                    ></span>
                    <span data-ui="SettingsView:b2cf2e01e30e" class="tp-body">
                      <span
                        data-ui="SettingsView:d9c43308480c"
                        class="tp-block"
                        :style="{
                          background: theme.colors.card,
                          border: '1px solid ' + theme.colors.border,
                        }"
                      ></span>
                      <span data-ui="SettingsView:fb0c4f0c22dd" class="tp-btn" :style="{ background: theme.colors.accent }"></span>
                    </span>
                  </span>
                  <span data-ui="SettingsView:bb37f5272e76" v-if="theme.key === 'custom'" class="tp-custom-grad"></span>
                  <svg
                    v-if="theme.key === 'custom'"
                    class="tp-palette"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.04 10 9c0 3.31-2.69 6-6 6h-1.77c-.28 0-.5.22-.5.5 0 .12.05.23.13.33.41.47.64 1.06.64 1.67A2.5 2.5 0 0 1 12 22Z"
                    />
                    <circle cx="7.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
                    <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
                    <circle cx="16.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
                  </svg>
                  <svg
                    v-if="store.settings.theme === theme.key"
                    class="tp-check"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
                <span data-ui="SettingsView:6e56a2fb3976" class="theme-label">{{ t(theme.labelKey) }}</span>
              </button>
            </div>
            <div class="theme-tools">
              <p class="muted group-hint">{{ t('settings.theme.hint') }}</p>
              <button data-ui="SettingsView:16e9da51c37b" class="btn personalize-btn" @click="enterEditMode">
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
                  <path d="M1 14h6M9 8h6M17 16h6" />
                </svg>
                {{ t('settings.theme.customize') }}
              </button>
            </div>
          </div>
        </details>

        <!-- 功能管理 -->
        <details
          data-ui="SettingsView:12f88af0d6bb"
          v-show="category === 'features'"
          data-section="features"
          class="card group collapse"
          open
        >
          <summary class="collapse-head">
            <h3 class="group-title">{{ t('settings.features.title') }}</h3>
            <span class="collapse-arrow" aria-hidden="true"></span>
          </summary>
          <div class="collapse-body feature-grid">
            <p class="muted group-hint">{{ t('settings.features.hint') }}</p>
            <template v-for="f in featureToggles" :key="f.key"
              ><h4 v-if="f.key === 'mods' || f.key === 'friends'" class="feature-section-title">
                {{ f.key === 'mods' ? t('settings.features.group.resources') : t('settings.features.group.other') }}
              </h4>
              <div data-ui="SettingsView:bd3c6919b18c" class="feature-row">
                <span data-ui="SettingsView:fa3cacde91cf" class="feature-name">{{ f.label }}</span>
                <span class="switch">
                  <input
                    data-ui="SettingsView:907bb2e68f36"
                    type="checkbox"
                    :checked="!store.settings.disabledFeatures.includes(f.key)"
                    @change="onToggleFeature(f.key, ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="switch-ui"></span>
                </span></div
            ></template>
          </div>
        </details>

        <div data-ui="SettingsView:9816c9c5870a" class="background-settings" v-show="category === 'appearance'">
          <HomeLayoutEditor />
        </div>

        <!-- UI 窗口自适应 -->
        <div
          v-if="store.settings && category === 'appearance'"
          class="card group group-inline setting-target"
          data-section="ui-window-fit"
          tabindex="-1"
        >
          <div>
            <h3 class="group-title">{{ t('settings.window_fit.title') }}</h3>
            <p class="muted">{{ t('settings.window_fit.desc1') }}</p>
            <p class="muted">{{ t('settings.window_fit.desc2') }}</p>
          </div>
          <label class="switch"
            ><input
              type="checkbox"
              :aria-label="t('settings.window_fit.aria')"
              :checked="store.settings.uiWindowAutoFit === true"
              :disabled="windowFitBusy"
              @change="changeWindowFit" /><span class="switch-ui"
          /></label>
        </div>

        <!-- 减少动态效果 -->
        <div
          data-ui="SettingsView:0683ad7389b1"
          v-if="store.settings && category === 'appearance'"
          class="card group group-inline setting-target"
          data-section="motion"
          tabindex="-1"
        >
          <div>
            <h3 class="group-title">{{ t('settings.motion.title') }}</h3>
            <p data-ui="SettingsView:53f72432b671" class="muted">{{ t('settings.motion.desc') }}</p>
            <p v-if="systemReduced" class="muted" role="status">{{ t('settings.motion.system_off') }} {{ systemMotionHelp }}</p>
          </div>
          <label class="switch"
            ><input
              data-ui="SettingsView:35ef39b7e9bc"
              type="checkbox"
              :aria-label="t('settings.motion.aria')"
              :checked="store.settings.reduceMotion === true"
              @change="save({ reduceMotion: ($event.target as HTMLInputElement).checked })" /><span
              data-ui="SettingsView:4490d3e5d395"
              class="switch-ui"
          /></label>
        </div>

        <!-- 语言 -->
        <div
          v-if="store.settings && category === 'appearance'"
          class="card group group-inline setting-target"
          data-section="language"
          tabindex="-1"
        >
          <div class="setting-item setting-item-lang">
            <div class="setting-item-info">
              <svg
                class="setting-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <div class="setting-text">
                <label class="setting-label">{{ t('settings.language') }}</label>
                <p class="setting-desc">{{ t('settings.language.desc') }}</p>
              </div>
            </div>
            <div class="setting-control">
              <SelectMenu :options="langOptions" :model-value="locale" @change="setLocale" />
            </div>
          </div>
        </div>

        <!-- 默认下载位置 -->
        <div
          v-show="category === 'downloads'"
          data-section="installation"
          data-ui="download-location:settings"
          class="card group directory-setting"
        >
          <h3 class="group-title">{{ t('settings.download.title') }}</h3>
          <p class="muted group-hint">{{ t('settings.download.desc') }}</p>
          <div class="dir-row download-location-row">
            <SelectMenu
              class="download-location-select"
              :model-value="defaultDownloadFolder"
              :options="
                store.settings.folders.map((folder) => ({
                  value: folder.path,
                  label: folder.name + (folder.isDefault ? t('settings.download.folder_default') : ''),
                }))
              "
              :disabled="downloadFolderBusy"
              @change="applyDownloadFolder"
            />
            <button
              class="btn btn-gold dir-btn"
              data-ui="download-location:change"
              :disabled="downloadFolderBusy"
              @click="chooseNewDownloadFolder"
            >
              {{ downloadFolderBusy ? t('settings.download.changing') : t('settings.download.change') }}
            </button>
            <button
              class="btn btn-ghost dir-btn"
              data-ui="download-location:manage"
              :disabled="downloadFolderBusy"
              @click="store.currentView = 'game'"
            >
              {{ t('settings.download.manage') }}
            </button>
          </div>
          <input
            data-ui="download-location:path"
            class="input mono download-location-path"
            :value="defaultDownloadFolder"
            readonly
            :aria-label="t('settings.download.path_aria')"
            :title="defaultDownloadFolder"
          />
          <p class="muted group-hint">{{ t('settings.download.after_change') }}</p>
          <p v-if="downloadFolderError" class="error" role="alert" data-ui="download-location:error">{{ downloadFolderError }}</p>
        </div>

        <!-- 下载 -->
        <div data-ui="SettingsView:9df9d3d48082" v-show="category === 'downloads'" class="settings-grid">
          <details
            data-ui="SettingsView:d0490715189c"
            class="card group collapse setting-target"
            data-section="downloads"
            tabindex="-1"
            open
          >
            <summary class="collapse-head">
              <h3 class="group-title">{{ t('settings.downloads.title') }}</h3>
              <span class="collapse-arrow" aria-hidden="true"></span>
            </summary>
            <div class="collapse-body">
              <div
                data-ui="SettingsView:95f82195a3e7"
                v-show="category === 'downloads'"
                data-section="mirror"
                class="download-mirror-group"
              >
                <div class="download-mirror-options">
                  <h3 class="group-title">{{ t('settings.downloads.mirror_title') }}</h3>
                  <div data-ui="SettingsView:7039ff11fe3c" class="mirror-options">
                    <label
                      data-ui="SettingsView:3dd4d470872e"
                      class="mirror-option"
                      :class="{ active: store.settings.mirror === 'official' }"
                    >
                      <input
                        data-ui="SettingsView:2f522f16f088"
                        v-model="store.settings.mirror"
                        type="radio"
                        value="official"
                        @change="save({ mirror: 'official' })"
                      />
                      <span>{{ t('settings.downloads.mirror_official') }}</span>
                    </label>
                    <label
                      data-ui="SettingsView:4948cbbe2972"
                      class="mirror-option"
                      :class="{ active: store.settings.mirror === 'bmclapi' }"
                    >
                      <input
                        data-ui="SettingsView:6cf3093424b7"
                        v-model="store.settings.mirror"
                        type="radio"
                        value="bmclapi"
                        @change="save({ mirror: 'bmclapi' })"
                      />
                      <span>{{ t('settings.downloads.mirror_bmclapi') }}</span>
                    </label>
                  </div>
                </div>
              </div>

              <label class="download-setting"
                >{{ t('settings.downloads.threads') }}
                <input
                  data-ui="SettingsView:0975603bb2e6"
                  class="input"
                  type="number"
                  min="1"
                  max="64"
                  :value="store.settings.downloadThreads"
                  @change="save({ downloadThreads: Number(($event.target as HTMLInputElement).value) })"
                />
              </label>
              <label class="download-setting"
                >{{ t('settings.downloads.speed') }}
                <input
                  data-ui="SettingsView:f6bb60f3451f"
                  class="input"
                  type="number"
                  min="0"
                  max="1048576"
                  :value="store.settings.downloadSpeedKBps"
                  @change="save({ downloadSpeedKBps: Number(($event.target as HTMLInputElement).value) })"
                />
              </label>
              <p class="muted group-hint">{{ t('settings.downloads.limit_hint') }}</p>
              <details data-ui="SettingsView:d03dfc867050" class="advanced-setting">
                <summary data-ui="SettingsView:98629fe42230">{{ t('settings.downloads.cf_advanced') }}</summary>
                <label data-ui="SettingsView:5d8857a9ab59" class="download-setting download-setting-col">
                  <span
                    >{{ t('settings.downloads.cf_key_label')
                    }}<small data-ui="SettingsView:a100ae255935" class="muted">{{ t('settings.downloads.cf_key_optional') }}</small></span
                  >
                  <input
                    data-ui="SettingsView:bb44d7c926e9"
                    class="input mono"
                    type="password"
                    :value="store.settings.curseforgeApiKey ?? ''"
                    :placeholder="t('settings.downloads.cf_key_placeholder')"
                    @change="save({ curseforgeApiKey: ($event.target as HTMLInputElement).value.trim() })"
                  />
                </label>
                <p class="muted group-hint">
                  {{ t('settings.downloads.cf_hint_before')
                  }}<a
                    data-ui="SettingsView:b8eb49f2eba5"
                    class="upd-link"
                    href="https://console.curseforge.com/"
                    target="_blank"
                    rel="noreferrer"
                    >console.curseforge.com</a
                  >{{ t('settings.downloads.cf_hint_after') }}
                </p>
              </details>
            </div>
          </details>
        </div>

        <!-- 默认版本隔离 -->
        <div
          data-ui="SettingsView:72c1d8b58f43"
          v-show="category === 'directories'"
          data-section="isolation"
          class="card group group-inline"
        >
          <div>
            <h3 class="group-title">{{ t('settings.isolation.title') }}</h3>
            <p class="muted group-hint">{{ t('settings.isolation.desc') }}</p>
          </div>
          <label class="switch">
            <input
              data-ui="SettingsView:7af59c7c71ed"
              type="checkbox"
              :checked="store.settings.defaultIsolation"
              @change="save({ defaultIsolation: ($event.target as HTMLInputElement).checked })"
            />
            <span class="switch-ui"></span>
          </label>
        </div>

        <!-- 内存 + Java -->
        <div v-show="category === 'game'" class="runtime-grid">
          <details data-ui="SettingsView:af57e3969b2b" class="card group collapse setting-target" data-section="memory" tabindex="-1" open>
            <summary class="collapse-head">
              <h3 class="group-title">{{ t('settings.memory.title') }}</h3>
              <span class="collapse-arrow" aria-hidden="true"></span>
            </summary>
            <div class="collapse-body">
              <div data-ui="SettingsView:c72d10bfcf7d" class="memory-auto-row">
                <span class="java-auto-text">
                  <span class="java-auto-title">{{ t('settings.memory.auto_title') }}</span>
                  <span class="muted java-auto-desc">{{ t('settings.memory.auto_desc', { value: autoMemoryText }) }}</span>
                </span>
                <label class="switch">
                  <input
                    data-ui="SettingsView:acfa8cbaf083"
                    :checked="memoryAuto"
                    type="checkbox"
                    @change="onMemoryAutoChange(($event.target as HTMLInputElement).checked)"
                  />
                  <span class="switch-ui"></span>
                </label>
              </div>
              <template v-if="!memoryAuto">
                <div data-ui="SettingsView:cbb53c3f809e" class="memory-row">
                  <div
                    data-ui="SettingsView:2a2d1473539f"
                    ref="memTrack"
                    class="mem-slider"
                    @pointermove="onMemPointerMove"
                    @pointerup="onMemPointerUp"
                    @pointercancel="onMemPointerUp"
                  >
                    <div data-ui="SettingsView:e74d81b4804a" class="mem-slider-track"></div>
                    <div data-ui="SettingsView:91a09abfe5b0" class="mem-slider-fill" :style="{ width: memFillPct + '%' }"></div>
                    <div
                      data-ui="SettingsView:9f6291a873d4"
                      class="mem-slider-thumb"
                      :class="{ dragging: memDragging }"
                      :style="{ left: memFillPct + '%' }"
                      @pointerdown="onMemThumbDown"
                      @pointermove="onMemPointerMove"
                      @pointerup="onMemPointerUp"
                      @pointercancel="onMemPointerUp"
                    ></div>
                  </div>
                  <input
                    data-ui="SettingsView:ff586c53928a"
                    v-if="memoryEditing"
                    v-model="memoryInputGB"
                    class="input memory-input"
                    type="number"
                    :min="MEM_MIN / 1024"
                    :max="memMax / 1024"
                    step="0.25"
                    @keydown.enter="commitMemoryEdit"
                    @keydown.esc="memoryEditing = false"
                    @blur="commitMemoryEdit"
                    v-focus
                  />
                  <span
                    data-ui="SettingsView:5c63bc2aa86a"
                    v-else
                    class="memory-value"
                    :title="t('settings.memory.value_title')"
                    @click="startMemoryEdit"
                    >{{ memoryText }}</span
                  >
                </div>
                <p class="muted group-hint">{{ t('settings.memory.slider_hint') }}</p>
                <p data-ui="SettingsView:9377cfb85e03" v-if="memoryOverFree" class="memory-warn">
                  {{ t('settings.memory.over_free') }}
                </p>
              </template>
              <p data-ui="SettingsView:8cff89231775" class="muted memory-info">
                {{ memoryInfoText }}
                <button data-ui="SettingsView:87a00792aa4a" class="memory-refresh" type="button" @click="refreshSystemInfo">
                  {{ t('settings.memory.refresh') }}
                </button>
              </p>
              <MemoryOrganizer @refresh="refreshSystemInfo" />
            </div>
          </details>

          <details data-ui="SettingsView:b128c0a66c1b" class="card group collapse setting-target" data-section="java" tabindex="-1" open>
            <summary class="collapse-head">
              <h3 class="group-title">{{ t('settings.java.title') }}</h3>
              <span class="collapse-arrow" aria-hidden="true"></span>
            </summary>
            <div class="collapse-body">
              <label data-ui="SettingsView:2937d97802dc" class="java-auto-row">
                <span class="java-auto-text">
                  <span class="java-auto-title">{{ t('settings.java.auto_title') }}</span>
                  <span class="muted java-auto-desc">{{ t('settings.java.auto_desc') }}</span>
                </span>
                <span class="switch">
                  <input
                    data-ui="SettingsView:84de310dd205"
                    type="checkbox"
                    :checked="store.settings.javaAuto"
                    @change="save({ javaAuto: ($event.target as HTMLInputElement).checked })"
                  />
                  <span class="switch-ui"></span>
                </span>
              </label>
              <div data-ui="SettingsView:033fa130c6ea" v-if="javaLoading" class="java-loading">
                <span class="spin"></span>
                <span class="muted">{{ t('settings.java.detecting') }}</span>
              </div>
              <template v-else>
                <select
                  data-ui="SettingsView:47dcfd6bb554"
                  v-model="store.settings.javaPath"
                  class="select"
                  :disabled="store.settings.javaAuto"
                  @change="save({ javaPath: store.settings!.javaPath })"
                >
                  <option value="">{{ t('settings.java.select_auto') }}</option>
                  <option v-for="j in javas" :key="j.path" :value="j.path">{{ javaLabel(j) }}</option>
                </select>
                <p data-ui="SettingsView:a4338b6dbdab" v-if="javaError" class="group-error">
                  {{ t('settings.java.detected_failed', { e: javaError }) }}
                </p>
                <p data-ui="SettingsView:b8220f037cc7" v-else-if="!javas.length" class="muted group-hint">
                  {{ t('settings.java.not_detected') }}
                </p>

                <details class="java-detected">
                  <summary>{{ t('settings.java.detected_summary', { count: String(javas.length) }) }}</summary>
                  <div data-ui="SettingsView:205e9439c186" class="java-scan-row">
                    <div data-ui="SettingsView:b5bbe482ca7a" class="java-scan-status">
                      <span class="muted">{{ t('settings.java.scan_scope') }}</span>
                      <span data-ui="SettingsView:95cdba118743" v-if="javaRefreshing" class="muted java-scan-text" :title="javaScanText">
                        {{ javaScanText }}
                      </span>
                      <div
                        data-ui="SettingsView:8b0c0b54c54f"
                        v-if="javaRefreshing"
                        class="java-scan-track"
                        :aria-label="t('settings.java.scan_aria')"
                      >
                        <span data-ui="SettingsView:ac6550af67ec" :style="{ width: `${javaScanProgress * 100}%` }"></span>
                      </div>
                    </div>
                    <button
                      data-ui="SettingsView:9df6cab1a2e9"
                      class="btn btn-ghost btn-sm"
                      :disabled="javaCancelling"
                      @click="onRefreshJava()"
                    >
                      {{
                        javaCancelling
                          ? t('settings.java.cancelling')
                          : javaRefreshing
                            ? t('settings.java.cancel_scan')
                            : t('settings.java.rescan')
                      }}
                    </button>
                  </div>

                  <div data-ui="SettingsView:6dc6e26726aa" v-if="javas.length" class="java-list">
                    <div data-ui="SettingsView:6bd22de0fe44" class="java-list-head">
                      <span class="muted">{{ t('settings.java.identified', { count: String(javas.length) }) }}</span>
                    </div>
                    <div data-ui="SettingsView:6cc4e456c280" v-for="j in javas" :key="j.path" class="java-item">
                      <span data-ui="SettingsView:b1a116a1a7bb" class="tag" :class="j.source === 'manual' ? 'tag-accent' : ''">
                        {{ j.source === 'manual' ? t('settings.java.source_manual') : t('settings.java.source_auto') }}
                      </span>
                      <span data-ui="SettingsView:5131692582d3" class="java-item-ver">Java {{ j.major }}</span>
                      <span
                        data-ui="SettingsView:7972354cc877"
                        class="muted java-item-path"
                        :title="`${j.vendor ?? t('settings.java.vendor_unknown')} · ${j.architecture ?? (j.is64Bit ? t('settings.java.arch_64') : t('settings.java.arch_32'))} · ${j.sourceDetail ?? ''}\n${j.path}`"
                      >
                        {{ j.vendor ?? t('settings.java.vendor_fallback') }} ·
                        {{ j.architecture ?? (j.is64Bit ? t('settings.java.arch_64') : t('settings.java.arch_32')) }} · {{ j.path }}
                      </span>
                      <button
                        data-ui="SettingsView:0360c51d1055"
                        class="java-item-hide"
                        :title="t('settings.java.hide_title')"
                        @click="onHideJava(j.path)"
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  <div data-ui="SettingsView:47c462c48d2f" class="java-add-row">
                    <input
                      data-ui="SettingsView:03420f9eb5b5"
                      v-model="javaCustomInput"
                      class="input mono"
                      :placeholder="t('settings.java.add_placeholder')"
                      spellcheck="false"
                      @keyup.enter="onAddJava"
                    />
                    <button data-ui="SettingsView:85975bff1446" class="btn btn-ghost" :disabled="javaAdding" @click="onAddJava">
                      {{ javaAdding ? t('settings.java.add_verifying') : t('settings.java.add') }}
                    </button>
                  </div>
                  <p data-ui="SettingsView:e6688869ed97" v-if="javaAddError" class="group-error">{{ javaAddError }}</p>
                </details>
              </template>
            </div>
          </details>

          <details data-ui="SettingsView:612d9b820913" class="card group" data-section="jvm">
            <summary data-ui="SettingsView:3cc49dcec409" class="group-title">{{ t('settings.jvm.title') }}</summary>
            <input
              data-ui="SettingsView:cce61f7d8c4e"
              v-model="store.settings.jvmArgs"
              class="input mono"
              :placeholder="t('settings.jvm.placeholder')"
              @change="save({ jvmArgs: store.settings!.jvmArgs })"
            />
            <p class="muted group-hint">{{ t('settings.jvm.hint') }}</p>
          </details>
        </div>

        <!-- 分辨率 -->
        <div data-ui="SettingsView:a1da38f817b5" v-show="category === 'display'" class="settings-grid">
          <div data-ui="SettingsView:5265f547a736" class="card group" data-section="resolution">
            <h3 class="group-title">{{ t('settings.resolution.title') }}</h3>
            <div data-ui="SettingsView:7e472ba8461b" class="resolution-row">
              <div class="res-field">
                <span class="muted res-label">{{ t('settings.resolution.width') }}</span>
                <input
                  data-ui="SettingsView:a5f1bf93348f"
                  v-model.number="store.settings.resolution.width"
                  type="number"
                  class="input"
                  min="854"
                  max="7680"
                  :disabled="store.settings.resolution.mode !== 'windowed'"
                  @change="saveResolution"
                />
              </div>
              <span data-ui="SettingsView:bc7a0e5ae260" class="muted res-x">×</span>
              <div class="res-field">
                <span class="muted res-label">{{ t('settings.resolution.height') }}</span>
                <input
                  data-ui="SettingsView:c9736d13ba36"
                  v-model.number="store.settings.resolution.height"
                  type="number"
                  class="input"
                  min="480"
                  max="4320"
                  :disabled="store.settings.resolution.mode !== 'windowed'"
                  @change="saveResolution"
                />
              </div>
            </div>
            <div data-ui="SettingsView:f3d214648a71" class="resolution-mode">
              <span class="muted res-label">{{ t('settings.resolution.mode') }}</span>
              <select data-ui="SettingsView:6e8bb36bb0de" v-model="store.settings.resolution.mode" class="select" @change="saveResolution">
                <option value="windowed">{{ t('settings.resolution.mode_windowed') }}</option>
                <option value="maximized">{{ t('settings.resolution.mode_maximized') }}</option>
                <option value="fullscreen">{{ t('settings.resolution.mode_fullscreen') }}</option>
                <option value="launcher">{{ t('settings.resolution.mode_launcher') }}</option>
              </select>
            </div>
            <p data-ui="SettingsView:2f107fd117d3" v-if="resolutionError" class="group-error">{{ resolutionError }}</p>
            <p v-else class="muted group-hint">{{ t('settings.resolution.hint') }}</p>
            <div class="remember-window-row">
              <div>
                <strong>{{ t('settings.resolution.remember') }}</strong>
                <p class="muted group-hint">{{ t('settings.resolution.remember_desc') }}</p>
              </div>
              <label class="switch"
                ><input
                  type="checkbox"
                  :aria-label="t('settings.resolution.remember_aria')"
                  :checked="store.settings.rememberGameWindowSize === true"
                  :disabled="windowSizeBusy || !canRememberWindow"
                  @change="toggleWindowSize" /><span class="switch-ui"></span
              ></label>
            </div>
            <p v-if="!canRememberWindow" class="muted group-hint">{{ t('settings.resolution.win_only') }}</p>
          </div>
        </div>

        <!-- 启动 -->
        <div data-ui="SettingsView:35d4b384db5b" v-show="category === 'general'" data-section="launch" class="settings-grid">
          <div class="card group group-inline">
            <div>
              <h3 class="group-title">{{ t('settings.launch.close_after_title') }}</h3>
              <p class="muted group-hint">{{ t('settings.launch.close_after_desc') }}</p>
            </div>
            <label class="switch">
              <input
                data-ui="SettingsView:f2f1ffcd2e84"
                v-model="store.settings.closeAfterLaunch"
                type="checkbox"
                @change="save({ closeAfterLaunch: store.settings!.closeAfterLaunch })"
              />
              <span class="switch-ui"></span>
            </label>
          </div>
          <div class="card group group-inline">
            <div>
              <h3 class="group-title">{{ t('settings.launch.proxy_title') }}</h3>
              <p class="muted group-hint">{{ t('settings.launch.proxy_desc') }}</p>
            </div>
            <label class="switch">
              <input
                data-ui="SettingsView:41ae714db129"
                :checked="store.settings.msUseProxy === true"
                type="checkbox"
                @change="save({ msUseProxy: ($event.target as HTMLInputElement).checked })"
              />
              <span class="switch-ui"></span>
            </label>
          </div>
        </div>

        <!-- 关于与更新 -->
        <details data-ui="SettingsView:7f23eec9c558" v-show="category === 'about'" class="card group collapse" open data-section="update">
          <summary class="collapse-head">
            <h3 class="group-title">{{ t('settings.about.title') }}</h3>
            <span class="collapse-arrow" aria-hidden="true"></span>
          </summary>
          <div class="collapse-body">
            <div class="upd-row">
              <span class="upd-label">{{ t('settings.about.current_version') }}</span>
              <span data-ui="SettingsView:7f2b62d69ce5" class="upd-value">v{{ appVersion }}</span>
              <button data-ui="SettingsView:e3f1fccf0c78" class="btn btn-ghost btn-sm" @click="showLicenses = true">
                {{ t('settings.about.licenses') }}
              </button>
              <ThirdPartyNotices v-if="showLicenses" @dismiss="showLicenses = false" />
              <button
                data-ui="SettingsView:2d10e8cc0926"
                class="btn btn-ghost btn-sm"
                :disabled="updateCheckState === 'checking'"
                @click="onCheckUpdate"
              >
                <span data-ui="SettingsView:bb9654fb7775" v-if="updateCheckState === 'checking'" class="spin"></span>
                {{ updateCheckState === 'checking' ? t('settings.about.checking') : t('settings.about.check') }}
              </button>
              <span data-ui="SettingsView:cd41281572d3" v-if="updateCheckState === 'latest'" class="upd-latest">
                {{ t('settings.about.up_to_date') }}
              </span>
            </div>
            <div data-ui="SettingsView:203842d2f6d4" v-if="updateCheckState === 'failed'" class="upd-row upd-failed-row">
              <span data-ui="SettingsView:5ae61f0d3e62" class="upd-failed-text">{{ t('settings.about.check_failed') }}</span>
              <button data-ui="SettingsView:c30ef48b6984" class="btn btn-ghost btn-sm" @click="onCheckUpdate">
                {{ t('settings.about.retry') }}
              </button>
            </div>
            <div class="upd-row">
              <span class="upd-label">{{ t('settings.about.auto_install') }}</span>
              <label class="switch">
                <input
                  data-ui="SettingsView:bc540ac861a7"
                  :checked="store.settings.autoUpdate !== false"
                  type="checkbox"
                  @change="save({ autoUpdate: ($event.target as HTMLInputElement).checked })"
                />
                <span class="switch-ui"></span>
              </label>
              <span data-ui="SettingsView:94871aad1da8" class="muted upd-auto-hint">{{
                systemInstaller ? t('settings.about.auto_hint_system') : t('settings.about.auto_hint_default')
              }}</span>
            </div>
            <div data-ui="SettingsView:1c8ad9d5ad0b" v-if="pendingUpdate" class="upd-row upd-pending-row">
              <span data-ui="SettingsView:0447f8159ad6" class="upd-pending-text">{{
                updateReadyMessage(t('settings.about.pending_ready', { version: pendingUpdate.release.version }))
              }}</span>
              <button data-ui="SettingsView:5bd17b41383a" class="btn btn-gold btn-sm" @click="onApplyPending">{{ installAction }}</button>
            </div>
            <div class="upd-row">
              <span class="upd-label">{{ t('settings.about.update_source') }}</span>
              <select data-ui="SettingsView:c67695800552" class="select upd-source" :value="updateSource" @change="onUpdateSourceChange">
                <option value="auto">{{ t('settings.about.source_auto') }}</option>
                <option value="direct">{{ t('settings.about.source_direct') }}</option>
                <option value="mirror">{{ t('settings.about.source_mirror') }}</option>
              </select>
            </div>
            <div data-ui="SettingsView:c63358a8e469" v-if="updateSource !== 'direct'" class="upd-row">
              <span class="upd-label">{{ t('settings.about.custom_mirror') }}</span>
              <input
                data-ui="SettingsView:573dec07c5b6"
                class="input mono upd-mirror"
                :value="store.settings.updateMirrorUrl ?? ''"
                :placeholder="t('settings.about.custom_mirror_placeholder')"
                @change="onUpdateMirrorChange"
              />
            </div>
            <details class="update-maintenance">
              <summary>{{ t('settings.about.maintenance') }}</summary>
              <div data-ui="SettingsView:bb7974b118ee" class="upd-row upd-actions-row">
                <button data-ui="SettingsView:3752063389f8" class="btn btn-ghost btn-sm" @click="openRollback">
                  {{ t('settings.about.rollback') }}
                </button>
                <button
                  data-ui="SettingsView:a671c86452da"
                  v-if="updateState"
                  class="btn btn-ghost btn-sm"
                  :disabled="restoringBackup"
                  @click="onRestoreBackup"
                >
                  {{ t('settings.about.restore_backup', { version: updateState.backupVersion }) }}
                </button>
                <button data-ui="SettingsView:c7a44c22390c" class="btn btn-ghost btn-sm" @click="onPickLocalUpdate">
                  {{ t('settings.about.install_local') }}
                </button>
              </div>
            </details>
            <p class="muted group-hint">{{ t('settings.about.releases_hint') }}</p>
          </div>
        </details>

        <!-- 插件系统 -->
        <details
          data-ui="SettingsView:034daafb11ff"
          v-show="category === 'features'"
          data-section="plugins"
          class="card group collapse"
          open
        >
          <summary class="collapse-head">
            <h3 class="group-title">{{ t('settings.plugins.title') }}</h3>
            <span class="collapse-arrow" aria-hidden="true"></span>
          </summary>
          <div class="collapse-body">
            <p class="muted group-hint">{{ t('settings.plugins.hint') }}</p>
            <div data-ui="SettingsView:3610ad90128d" v-if="plugins.length" class="plugin-list">
              <div data-ui="SettingsView:f0df70c46e6e" v-for="p in plugins" :key="p.id" class="plugin-row">
                <div data-ui="SettingsView:f0ef3e1815ac" class="plugin-info">
                  <span data-ui="SettingsView:2654f6c0658e" class="plugin-name">
                    {{ p.name }}
                    <span data-ui="SettingsView:ed121d4fcf9e" v-if="p.version" class="muted">v{{ p.version }}</span>
                  </span>
                  <span data-ui="SettingsView:2651a76d5a4b" class="muted plugin-meta">{{
                    [p.author, p.description].filter(Boolean).join(' · ') || p.id
                  }}</span>
                </div>
                <button
                  data-ui="SettingsView:4b6726b9ed78"
                  class="btn btn-sm"
                  :class="pluginConfirmRemove === p.id ? 'btn-danger' : 'btn-ghost'"
                  @click="onRemovePlugin(p)"
                >
                  {{ pluginConfirmRemove === p.id ? t('settings.plugins.remove_trash') : t('settings.plugins.remove') }}
                </button>
                <label
                  data-ui="SettingsView:1df38fea5b7b"
                  class="switch"
                  :title="p.enabled ? t('settings.plugins.disable_title') : t('settings.plugins.enable_title')"
                >
                  <input
                    data-ui="SettingsView:e7c877c0882e"
                    type="checkbox"
                    :checked="p.enabled"
                    @change="onTogglePlugin(p, ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="switch-ui"></span>
                </label>
              </div>
            </div>
            <p v-else class="muted group-hint">{{ t('settings.plugins.empty') }}</p>
            <div data-ui="SettingsView:70c23a4a8b21" class="plugin-actions">
              <button data-ui="SettingsView:2efffb3d4610" class="btn btn-ghost btn-sm" :disabled="pluginBusy" @click="onInstallPlugin">
                <span data-ui="SettingsView:f506d1f658b6" v-if="pluginBusy" class="spin"></span>
                {{ t('settings.plugins.install') }}
              </button>
              <button data-ui="SettingsView:5032f71dc65d" class="btn btn-ghost btn-sm" @click="openPluginsDir">
                {{ t('settings.plugins.open_dir') }}
              </button>
              <button
                data-ui="SettingsView:ede794e781ff"
                v-if="pluginDirty"
                class="btn btn-gold btn-sm"
                @click="
                  ($event.target as HTMLButtonElement).blur();
                  reloadLauncher();
                "
              >
                {{ t('settings.plugins.reload') }}
              </button>
            </div>
          </div>
        </details>
      </template>
    </div>

    <!-- 版本回退 -->
    <UpdateDialogShell v-if="rollback.open" :label="t('settings.rollback.title')" @dismiss="rollback.open = false">
      <template #header>
        <div class="upd-modal-head">
          <h3 class="upd-modal-title">{{ t('settings.rollback.title') }}</h3>
          <button data-ui="SettingsView:606774134bae" class="icon-btn" :title="t('settings.rollback.close')" @click="rollback.open = false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <p data-ui="SettingsView:f683c36eb3d1" class="upd-modal-subtitle muted">
          {{ t('settings.rollback.subtitle', { current: appVersion }) }}
        </p>
      </template>
      <p data-ui="SettingsView:e60d0b9f406f" class="upd-risk">{{ t('settings.rollback.risk') }}</p>
      <div data-ui="SettingsView:057bbe26b76d" v-if="rollback.loading" class="empty"><span class="spin"></span></div>
      <div data-ui="SettingsView:5fc7aa4d0d0b" v-else class="upd-release-list">
        <label
          data-ui="SettingsView:75b890b63a58"
          v-for="r in rollback.list"
          :key="r.version"
          class="upd-release-item"
          :class="{ selected: rollback.selected === r.version }"
        >
          <input data-ui="SettingsView:839c64939132" v-model="rollback.selected" type="radio" name="rollback-version" :value="r.version" />
          <span data-ui="SettingsView:147be114439d" class="upd-release-main">
            <span data-ui="SettingsView:472e50c1be99" class="upd-release-ver">v{{ r.version }}</span>
            <span data-ui="SettingsView:f2396c2f4962" class="muted upd-release-date">{{ releaseDate(r.publishedAt) }}</span>
            <span data-ui="SettingsView:b10e6198b84f" v-if="releaseSummary(r.body)" class="muted upd-release-summary">{{
              releaseSummary(r.body)
            }}</span>
          </span>
        </label>
        <div data-ui="SettingsView:b683a5ef98a2" v-if="!rollback.list.length" class="empty">
          <span>{{ t('settings.rollback.empty') }}</span>
        </div>
      </div>
      <template #footer
        ><div class="upd-modal-actions">
          <button data-ui="SettingsView:64d5b7c61143" class="btn btn-ghost" @click="rollback.open = false">
            {{ t('settings.rollback.cancel') }}
          </button>
          <button data-ui="SettingsView:8a817c12df3a" class="btn btn-gold" :disabled="!rollback.selected" @click="confirmRollback">
            {{ t('settings.rollback.confirm') }}
          </button>
        </div></template
      >
    </UpdateDialogShell>

    <!-- 本地文件安装更新确认 -->
    <UpdateDialogShell v-if="localUpdate?.confirming" :label="t('settings.local_update.title')" @dismiss="localUpdate = null">
      <template #header>
        <div class="upd-modal-head">
          <h3 class="upd-modal-title">{{ t('settings.local_update.title') }}</h3>
          <button
            data-ui="SettingsView:7162c61cf755"
            class="icon-btn"
            :title="t('settings.local_update.close')"
            @click="localUpdate = null"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </template>
      <p data-ui="SettingsView:d8da86ab7cbc" class="upd-local-file">
        {{ localUpdate.check.fileName }} · {{ (localUpdate.check.fileSize / 1048576).toFixed(1) }} MB
      </p>
      <div class="upd-local-check">
        <span>{{ t('settings.local_update.version_check') }}</span>
        <span data-ui="SettingsView:152ca71f54e0" v-if="localUpdate.check.versionOk" class="upd-ok">{{
          t('settings.local_update.version_ok', { version: localUpdate.check.version ?? '', current: appVersion })
        }}</span>
        <span v-else class="upd-warn"
          >⚠
          {{
            localUpdate.check.version
              ? t('settings.local_update.version_low', { version: localUpdate.check.version, current: appVersion })
              : t('settings.local_update.version_unknown')
          }}{{ t('settings.local_update.version_warn_suffix') }}</span
        >
      </div>
      <div class="upd-local-check">
        <span>{{ t('settings.local_update.checksum_check') }}</span>
        <span data-ui="SettingsView:9df9b415ad42" v-if="localUpdate.check.sha256 === 'match'" class="upd-ok">{{
          t('settings.local_update.checksum_ok')
        }}</span>
        <span data-ui="SettingsView:5b6de8db67a7" v-else-if="localUpdate.check.sha256 === 'mismatch'" class="upd-warn">{{
          t('settings.local_update.checksum_mismatch', { detail: localUpdate.check.detail ?? '' })
        }}</span>
        <span v-else class="upd-warn">{{ t('settings.local_update.checksum_offline') }}</span>
      </div>
      <template #footer
        ><div class="upd-modal-actions">
          <button data-ui="SettingsView:3ccc5837a1e1" class="btn btn-ghost" @click="localUpdate = null">
            {{ t('settings.local_update.cancel') }}
          </button>
          <button
            data-ui="SettingsView:1b671fb6ec3e"
            class="btn"
            :class="localUpdate.check.versionOk && localUpdate.check.sha256 === 'match' ? 'btn-gold' : 'btn-danger'"
            @click="confirmLocalUpdate"
          >
            {{ t('settings.local_update.confirm') }}
          </button>
        </div></template
      >
    </UpdateDialogShell>
  </div>
</template>

<style scoped>
.settings-navigation {
  position: sticky;
  top: 0;
  z-index: 15;
  padding: 12px;
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-solid);
}
.settings-search {
  display: flex;
  align-items: center;
  gap: 12px;
}
.settings-search > span {
  white-space: nowrap;
  font-weight: 600;
}
.settings-search input {
  flex: 1;
  min-width: 0;
}
.settings-categories {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.settings-categories [aria-current] {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: transparent;
}
.settings-search-results {
  display: grid;
  max-height: 40vh;
  overflow: auto;
  gap: 8px;
  padding-top: 12px;
}
.settings-search-results button {
  justify-content: space-between;
  white-space: normal;
  text-align: left;
}
.settings-page [data-section] {
  scroll-margin-top: 150px;
}
.settings-page [data-section]:focus {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.settings-page .group {
  margin-bottom: 0;
}
@media (max-width: 800px) {
  .settings-navigation {
    position: relative;
  }
  .settings-search {
    align-items: stretch;
    flex-direction: column;
  }
  .settings-page [data-section] {
    scroll-margin-top: 16px;
  }
}

/* 关于与更新 */
.upd-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  flex-wrap: wrap;
}
.upd-label {
  width: 84px;
  flex-shrink: 0;
  font-size: var(--text-sm);
  color: var(--text-dim);
}
.upd-value {
  font-weight: 650;
}
.upd-latest {
  color: var(--accent-2);
  font-size: var(--text-sm);
}
.upd-source {
  min-width: 220px;
}
.upd-mirror {
  flex: 1;
  min-width: 240px;
  font-size: var(--text-xs);
}
.upd-actions-row {
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.upd-auto-hint {
  font-size: var(--text-xs);
}
.upd-pending-row {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}
.upd-pending-text {
  font-size: var(--text-sm);
  font-weight: 600;
}
.upd-failed-row {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 26%, transparent);
}
.upd-failed-text {
  font-size: var(--text-xs);
  color: var(--danger);
}
/* 回退/本地安装弹窗 */
.upd-modal-subtitle {
  margin: 10px 0 0;
  font-size: 12px;
}
.upd-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}
.upd-modal-title {
  margin: 0;
  font-size: 22px;
  line-height: 1.4;
}
.upd-risk {
  margin: 0 0 18px;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  font-weight: 500;
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 26%, transparent);
  color: var(--danger);
}
.upd-release-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.upd-release-item {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding: 16px;
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}
.upd-release-item:hover {
  border-color: var(--accent-deep);
}
.upd-release-item.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.upd-release-item input {
  margin-top: 5px;
  accent-color: var(--accent);
  flex-shrink: 0;
}
.upd-release-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}
.upd-release-ver {
  font-weight: 650;
}
.upd-release-date {
  font-size: var(--text-xs);
}
.upd-release-summary {
  font-size: var(--text-xs);
  flex-basis: 100%;
}
.upd-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.upd-local-file {
  margin: 0;
  font-weight: 600;
  font-size: var(--text-sm);
  word-break: break-all;
}
.upd-local-check {
  display: flex;
  gap: var(--space-3);
  font-size: var(--text-sm);
  align-items: baseline;
  margin-top: 16px;
}
.upd-local-check > span:first-child {
  width: 72px;
  flex-shrink: 0;
  color: var(--text-dim);
}
.upd-ok {
  color: var(--accent-2);
}
.upd-warn {
  color: var(--danger);
}
.plugin-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.plugin-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--row-h);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.plugin-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.plugin-name {
  font-weight: 600;
}
.plugin-meta {
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.download-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
}
.download-setting .input {
  width: 160px;
}
.download-setting-col {
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.download-setting-col .input {
  width: 100%;
}
.download-setting-col small {
  font-weight: 400;
}
.upd-link {
  color: var(--accent-2);
}
.setting-target {
  scroll-margin-top: var(--space-5);
}
.setting-target:focus {
  outline: 2px solid var(--accent);
  outline-offset: var(--space-1);
}
.page {
  display: flex;
  flex-direction: column;
  gap: var(--sec-gap);
  max-width: 760px;
  margin: 0 auto;
}

/* 小卡片两两成行（顺序横向向下），窄窗口自动换行堆叠 */
.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: var(--card-gap);
  align-items: stretch;
}
.settings-grid > .card {
  min-width: 0;
}

.group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--card-pad);
}
.group-title {
  font-size: var(--text-sm);
  font-weight: 700;
  margin: 0;
  line-height: 1.5;
}
.group-hint {
  font-size: var(--text-xs);
  margin: 0;
  line-height: 1.6;
}
.group-error {
  font-size: var(--text-xs);
  margin: 0;
  color: var(--danger);
}
.group-inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

/* PCL 式折叠卡片：折叠态 = 标题行（行高）+ 右侧箭头；展开态内容统一内边距 */
.collapse {
  padding: 0;
}
.collapse-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--row-h);
  padding: var(--space-2) var(--card-pad);
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.collapse-head::-webkit-details-marker {
  display: none;
}
.collapse-head:hover .group-title {
  color: var(--accent-2);
}
.collapse-arrow {
  width: 7px;
  height: 7px;
  border-right: 2px solid var(--text-dim);
  border-bottom: 2px solid var(--text-dim);
  /* 折叠态：箭头朝上（PCL 折叠卡片右上箭头） */
  transform: rotate(-45deg);
  transition: transform 0.18s ease;
  flex-shrink: 0;
}
.collapse[open] > .collapse-head .collapse-arrow {
  /* 展开态：箭头朝下 */
  transform: rotate(45deg);
}
.collapse-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--card-pad) var(--card-pad);
  border-top: 1px solid var(--border);
}

/* 功能开关行 */
.feature-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 40px;
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--border);
}
.feature-row:last-child {
  border-bottom: none;
}
.feature-name {
  font-size: var(--text-sm);
}

/* Java 列表 */
.java-list {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.java-scan-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
}
.java-scan-status {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-xs);
}
.java-scan-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.java-scan-track {
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--border);
}
.java-scan-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.15s ease;
}
.java-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  background: var(--card-2);
  font-size: var(--text-xs);
}
.java-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--row-h);
  padding: var(--space-1) var(--space-3);
  border-top: 1px solid var(--border);
  font-size: var(--text-sm);
}
.java-item-ver {
  font-weight: 600;
  flex-shrink: 0;
}
.java-item-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Consolas, monospace;
  font-size: var(--text-xs);
}
.java-item-hide {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: var(--text-md);
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
}
.java-item-hide:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.java-add-row {
  display: flex;
  gap: var(--space-2);
}
.java-auto-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  cursor: pointer;
}
.java-auto-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.java-auto-title {
  font-size: var(--text-sm);
  font-weight: 600;
}
.java-auto-desc {
  font-size: var(--text-xs);
  line-height: 1.6;
}
.select:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* 主题选择 */
.theme-options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-3);
}
.theme-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  cursor: pointer;
}
.theme-preview {
  position: relative;
  display: flex;
  width: 150px;
  height: 84px;
  border-radius: var(--radius-md);
  border: 1.5px solid var(--border);
  overflow: hidden;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    transform 0.12s ease;
}
.theme-option:hover .theme-preview {
  transform: translateY(-1px);
  border-color: var(--border-strong);
}
.theme-option.active .theme-preview {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.theme-option:active .theme-preview {
  transform: scale(0.98);
}
.theme-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
  font-size: var(--text-sm);
  color: var(--text-dim);
  transition: color 0.16s ease;
  white-space: nowrap;
}

.theme-option.active .theme-label {
  color: var(--accent);
  font-weight: 600;
}
/* 迷你界面：侧栏 + 顶栏 + 内容块（各主题预览固定用自身配色，不跟随当前主题） */
.tp-side {
  width: 26px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding-top: var(--space-2);
}
.tp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.tp-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.tp-top {
  height: 14px;
  flex-shrink: 0;
}
.tp-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px;
}
.tp-block {
  flex: 1;
  border-radius: 4px;
}
.tp-btn {
  height: 12px;
  flex-shrink: 0;
  border-radius: 4px;
}
.tp-check {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  padding: 3.5px;
}
/* 自定义预览：彩虹渐变色块 + 调色盘图标 */
.preview-custom {
  align-items: center;
  justify-content: center;
  background: #16161d;
}
.tp-custom-grad {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #f43f5e 0%, #f97316 25%, #eab308 45%, #22c55e 65%, #3b82f6 85%, #a855f7 100%);
  opacity: 0.85;
}
.tp-palette {
  position: relative;
  width: 30px;
  height: 30px;
  color: #ffffff;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.45));
}
/* 「个性化」入口（选中自定义主题后出现） */
.personalize-btn {
  align-self: flex-start;
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}
.personalize-btn:hover:not(:disabled) {
  filter: brightness(1.06);
  border-color: var(--accent);
  color: var(--accent);
}

/* 目录 */
.dir-row {
  display: flex;
  gap: var(--space-3);
}
.dir-row .input {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
}
.dir-btn {
  flex-shrink: 0;
}
.download-location-row {
  flex-wrap: wrap;
  align-items: center;
}
.download-location-select {
  flex: 1 1 220px;
  min-width: 0;
}
.download-location-path {
  width: 100%;
  margin-top: var(--space-3);
  font-size: var(--text-sm);
}

/* 内存 */
.memory-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.memory-value {
  flex: none;
  /* 固定宽度：数值位数变化不得挤压/拉伸滑块轨道（双单位最坏情形「128658MB (125.64G)」容纳得下） */
  width: 172px;
  text-align: right;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--accent-2);
  cursor: text;
  border-radius: var(--radius-sm);
  padding: 2px var(--space-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.memory-value:hover {
  background: var(--hover);
}
.memory-input {
  width: 88px;
  text-align: right;
}
.memory-auto-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding-bottom: var(--space-3);
  margin-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
}
/* 自定义内存滑块：拇指拖拽，轨道不响应点击（不抢鼠标） */
.mem-slider {
  position: relative;
  flex: 1;
  height: 24px;
  touch-action: none;
}
.mem-slider-track {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 6px;
  transform: translateY(-50%);
  border-radius: 999px;
  background: var(--card-2);
  pointer-events: none;
}
.mem-slider-fill {
  position: absolute;
  left: 0;
  top: 50%;
  height: 6px;
  transform: translateY(-50%);
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent-2), var(--accent));
  pointer-events: none;
  /* 拖动中禁用过渡：否则填充追着指针值跑=前后抽搐闪现（用户实测报告） */
  transition: width 0.12s ease;
}
.mem-slider:has(.mem-slider-thumb.dragging) .mem-slider-fill {
  transition: none;
}
.mem-slider-thumb {
  position: absolute;
  top: 50%;
  width: 16px;
  height: 16px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid var(--on-accent);
  box-shadow: 0 1px 6px color-mix(in srgb, var(--accent) 45%, transparent);
  cursor: grab;
  transition: transform 0.12s ease;
}
.mem-slider-thumb:hover {
  transform: translate(-50%, -50%) scale(1.12);
}
.mem-slider-thumb.dragging {
  cursor: grabbing;
  transform: translate(-50%, -50%) scale(1.18);
}
.memory-warn {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--danger);
}
.memory-info {
  margin-top: var(--space-2);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
}
.memory-refresh {
  border: none;
  background: transparent;
  color: var(--accent-2);
  font-size: var(--text-xs);
  cursor: pointer;
  padding: 0;
}
.memory-refresh:hover {
  text-decoration: underline;
}

/* 分辨率 */
.remember-window-row {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.remember-window-row > div {
  flex: 1;
  min-width: 0;
}
.remember-window-row .switch {
  flex-shrink: 0;
}
.resolution-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.res-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}
.res-label {
  font-size: var(--text-sm);
  flex-shrink: 0;
}
.res-x {
  flex-shrink: 0;
}
.resolution-mode {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
  font-size: var(--text-md);
}
.resolution-mode .select {
  min-width: 108px;
}

/* 镜像 */
.mirror-options {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.mirror-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  min-height: var(--ctl-h);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-2);
  color: var(--text);
  font-size: var(--text-sm);
  cursor: pointer;
  white-space: nowrap;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    color 0.15s ease;
}
.mirror-option input {
  display: none;
}
.mirror-option:hover {
  border-color: var(--text-dim);
}
.mirror-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-2);
}

.mono {
  font-size: var(--text-sm);
}

.java-loading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) 0;
}

/* Two scopes share compact, state-preserving category panels. */
.settings-page {
  height: 100%;
  min-height: 0;
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 340px);
  grid-template-rows: auto auto auto minmax(0, 1fr);
  gap: 10px !important;
  padding: 0 !important;
  max-width: 1080px !important;
  position: relative;
}
.settings-page > .page-head {
  grid-row: 1;
  grid-column: 1;
  margin: 0 !important;
  align-self: center;
}
.settings-navigation {
  display: contents;
}
.settings-search {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
}
.settings-scopes {
  grid-column: 1/-1;
  grid-row: 2;
  display: flex;
  gap: 6px;
}
.settings-scopes .btn {
  font-size: 15px;
  font-weight: 650;
  min-height: 38px;
  padding: 8px 18px;
  border-color: transparent;
}
.settings-scopes [aria-current] {
  background: var(--accent-soft);
  color: var(--accent-2);
}
.settings-categories {
  grid-column: 1/-1;
  grid-row: 3;
  margin: 0;
  border-bottom: 1px solid var(--border);
  padding: 0 0 8px;
  gap: 4px;
}
.settings-categories .btn {
  border: 0;
  border-radius: var(--radius-sm);
  min-height: 32px;
  padding: 6px 12px;
  font-size: 13px;
}
.settings-body {
  grid-column: 1/-1;
  grid-row: 4;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 2px 8px 20px 0;
}
.settings-body > * {
  flex-shrink: 0;
}
.settings-search-results {
  position: absolute;
  right: 0;
  top: 48px;
  z-index: 20;
  width: min(480px, 100%);
  max-height: 60vh;
  overflow: auto;
  padding: 12px;
  background: var(--surface-solid);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow);
}
.settings-page .settings-grid {
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 12px;
}
.settings-page .settings-grid > .card {
  height: auto;
}
.settings-page [data-section] {
  scroll-margin-top: 12px;
}
.settings-body .group {
  padding: 14px 18px;
}
.settings-body .collapse {
  padding: 0;
  gap: 0;
}
.settings-body .collapse-body {
  padding: 10px 18px 14px;
  gap: 8px;
}
.settings-body .collapse-head {
  min-height: 42px;
  padding: 10px 18px;
}
.settings-body .group-title {
  font-size: 15px;
  margin-bottom: 8px;
}
.settings-body .collapse-head .group-title {
  margin: 0;
}
.settings-body .group-hint {
  font-size: 12px;
  line-height: 1.6;
  margin: 6px 0;
}
.settings-body .group-inline {
  align-items: center;
  gap: 16px;
}
.settings-body .group-inline > div {
  flex: 1;
  min-width: 0;
}
.settings-body .group-inline .switch {
  flex: none;
}
.settings-body [data-section='motion'] {
  padding: 12px 18px;
  order: 1;
}
.settings-body [data-section='motion'] p {
  font-size: 12px;
  line-height: 1.6;
  margin: 0;
}
.settings-body .background-settings {
  order: 2;
  display: grid;
  gap: 12px;
}
.theme-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
  gap: 8px;
}
.theme-option {
  flex-direction: row;
  justify-content: flex-start;
  gap: 10px;
  min-height: 48px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.theme-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.theme-preview {
  width: 46px;
  height: 32px;
  flex: none;
  border-radius: 5px;
}
.theme-option:hover .theme-preview,
.theme-option:active .theme-preview {
  transform: none;
}
.theme-option.active .theme-preview {
  box-shadow: none;
}
.theme-label {
  font-size: 13px;
  white-space: nowrap;
}
.tp-side {
  width: 9px;
  padding-top: 4px;
}
.tp-dot {
  width: 4px;
  height: 4px;
}
.tp-top {
  height: 6px;
}
.tp-body {
  gap: 2px;
  padding: 3px;
}
.tp-btn {
  height: 4px;
}
.tp-check {
  width: 14px;
  height: 14px;
  top: 1px;
  right: 1px;
  padding: 2px;
}
.tp-palette {
  width: 20px;
  height: 20px;
}
.theme-tools {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.personalize-btn {
  min-height: 32px;
  padding: 5px 12px;
  margin-top: 6px;
}
.feature-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 24px;
}
.feature-grid > .group-hint,
.feature-section-title {
  grid-column: 1/-1;
}
.feature-section-title {
  margin: 8px 0 2px;
  font-size: 12px;
  color: var(--text-dim);
}
.feature-row {
  min-height: 40px;
  padding: 6px 0;
}
.runtime-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}
.runtime-grid [data-section='jvm'] {
  grid-column: 1/-1;
}
.runtime-grid .java-auto-row,
.runtime-grid .memory-auto-row {
  margin: 0 0 8px;
  padding: 10 10 10px;
  gap: 12px;
}
.runtime-grid .java-auto-title {
  font-size: 13px;
}
.runtime-grid .java-auto-desc {
  font-size: 12px;
  line-height: 1.55;
  margin-top: 4px;
}
.runtime-grid .memory-info {
  font-size: 12px;
  margin: 10px 0 0;
}
.memory-refresh {
  flex: none;
  white-space: nowrap;
}
.java-detected > summary {
  padding: 10px 0;
  color: var(--text-dim);
  font-size: 13px;
}
.runtime-grid .java-list {
  max-height: 200px;
  overflow: auto;
}
.download-mirror-group {
  margin-bottom: 10px;
}
.download-mirror-options .group-title {
  font-size: 13px;
}
.download-setting {
  min-height: 44px;
}
.advanced-setting {
  margin-top: 10px;
}
.settings-body .resolution-row {
  margin-top: 8px;
}
.settings-body .resolution-mode {
  margin-top: 10px;
}
.settings-body .upd-row {
  min-height: 38px;
  margin: 0;
  padding: 6px 0;
}
.settings-body .update-maintenance {
  margin-top: 8px;
}
.setting-item-lang {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
}
.setting-item-info {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.setting-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  color: var(--accent);
}
.setting-text {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.setting-label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text);
}
.setting-desc {
  font-size: var(--text-xs);
  color: var(--text-dim);
  margin: 0;
}
.setting-control {
  width: 180px;
  flex-shrink: 0;
}
@media (max-width: 1100px) {
  .runtime-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 800px) {
  .settings-page {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto auto minmax(0, 1fr);
  }
  .settings-search {
    grid-row: 2;
    grid-column: 1;
  }
  .settings-scopes {
    grid-row: 3;
  }
  .settings-categories {
    grid-row: 4;
  }
  .settings-body {
    grid-row: 5;
  }
  .settings-search-results {
    top: 92px;
  }
  .feature-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .theme-options {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
