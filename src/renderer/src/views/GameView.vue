<script setup lang="ts">
import { formatReleaseTime } from '@shared/releaseTime';
import { openInstanceCenter } from '../instanceCenter';
import ContentSkeleton from '../components/ContentSkeleton.vue';
import { catalogSession } from '../catalogCache';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { t } from '@renderer/i18n';
import {
  cleanupPartialInstall,
  errText,
  formatSpeed,
  getIsolationPlan,
  getSettings,
  getInstalled,
  installVersion,
  launchGame,
  listFabricApi,
  listFolders,
  listJava,
  listLoaders,
  openDir,
  openGameFolder,
  showFolderContextMenu,
  removeFolder,
  removeVersion,
  renameFolder,
  renameVersion,
  saveSettings,
  scanFolder,
  selectDir,
  setDefaultFolder,
  setDownloadFolder,
  setVersionIsolation,
  setVersionJava,
  setVersionResolution,
  updateVersionCategories,
} from '../api';
import {
  selectInstance,
  applyLaunchState,
  displayVersionName,
  fmtLastPlayed,
  isFavorite,
  progressMono,
  refreshInstalled,
  renameLastPlayed,
  sortWithFavorite,
  store,
  toast,
  toggleFavorite,
  versionIconUrl,
} from '../store';
import { instanceLaunchBusy } from '@shared/launchTracking';
import ConfirmModal from '../components/ConfirmModal.vue';
import IconPickerModal from '../components/IconPickerModal.vue';
import SelectMenu from '../components/SelectMenu.vue';
import RecordingModPicker from '../components/RecordingModPicker.vue';
import FavoriteModsPicker from '../components/FavoriteModsPicker.vue';
import UiGlyph from '../components/UiGlyph.vue';
import VersionCategoriesPanel from '../components/VersionCategoriesPanel.vue';
import {
  VERSION_CATEGORY_ALL,
  VERSION_CATEGORY_FAVORITES,
  VERSION_CATEGORY_UNCLASSIFIED,
  versionCategoryOf,
  versionMatchesCategory,
} from '@shared/versionCategories';
const favoritesReady = ref(true);
import ThumbnailPickerModal from '../components/ThumbnailPickerModal.vue';
import type {
  FabricApiVersion,
  FolderScanResult,
  GameFolder,
  GameResolution,
  GameWindowMode,
  InstallOptions,
  InstalledVersion,
  ImageFit,
  IsolationMigrationPlan,
  LoaderName,
  RemoteVersion,
  VersionCategoryAction,
} from '@shared/types';

// 列表范围独立于安装目标，保留其他页面的当前目录语义。
const allInstalled = ref<InstalledVersion[]>([]);
const installedFolder = ref('');
const installedError = ref('');
const installedLoading = ref(false);
const folderToolsOpen = ref(false);
const installedSearch = ref('');
const installedCategory = ref(VERSION_CATEGORY_ALL),
  categoryManagerOpen = ref(false),
  categoryBusy = ref(false),
  categoryError = ref('');
const categories = computed(() => store.settings?.versionCategories ?? []);
const categoryOf = (v: InstalledVersion) => versionCategoryOf(store.settings, v.folder, v.id, window.faionyx.platform);
const categoryLabel = (v: InstalledVersion) => categories.value.find((c) => c.id === categoryOf(v))?.name ?? '';
const categoryCounts = computed(() =>
  Object.fromEntries(categories.value.map((c) => [c.id, allInstalled.value.filter((v) => categoryOf(v) === c.id).length]))
);
watch(categories, (list) => {
  if (
    ![VERSION_CATEGORY_ALL, VERSION_CATEGORY_FAVORITES, VERSION_CATEGORY_UNCLASSIFIED, ...list.map((c) => c.id)].includes(
      installedCategory.value
    )
  )
    installedCategory.value = VERSION_CATEGORY_ALL;
});
async function onCategoryAction(action: VersionCategoryAction): Promise<boolean> {
  if (categoryBusy.value) return false;
  categoryBusy.value = true;
  categoryError.value = '';
  try {
    store.settings = await updateVersionCategories(action);
    if (action.type === 'remove' && installedCategory.value === action.id) installedCategory.value = VERSION_CATEGORY_UNCLASSIFIED;
    return true;
  } catch (error) {
    categoryError.value = t('games.toast.category_save_failed', { e: errText(error) });
    return false;
  } finally {
    categoryBusy.value = false;
  }
}
async function assignCategory(v: InstalledVersion, event: Event) {
  const field = event.target as HTMLSelectElement,
    categoryId = field.value;
  await onCategoryAction({ type: 'assign', target: { id: v.id, folder: v.folder }, categoryId });
  // Retain the last confirmed value on IPC/write failure, with a visible error.
  field.value = categoryOf(v);
}
let installedGeneration = 0;
async function refreshAllInstalled() {
  const generation = ++installedGeneration;
  installedLoading.value = true;
  try {
    const next = await getInstalled(true);
    if (generation === installedGeneration) {
      allInstalled.value = next;
      installedError.value = '';
    }
  } catch (e) {
    if (generation === installedGeneration) installedError.value = errText(e);
  } finally {
    if (generation === installedGeneration) installedLoading.value = false;
  }
}
watch(
  () => store.installed,
  () => {
    void refreshAllInstalled();
  }
);
watch(
  () => JSON.stringify(store.settings?.folders),
  () => {
    void refreshAllInstalled();
  }
);
const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const installedFolderOptions = computed(() => [
  { value: '', label: t('games.folder.all') },
  { value: '@current', label: t('games.folder.current') },
  ...(store.settings?.folders ?? []).map((f) => ({ value: f.path, label: `${f.name} · ${f.path}` })),
]);
watch(installedFolderOptions, (options) => {
  if (!options.some((o) => o.value === installedFolder.value)) installedFolder.value = '';
});
// ---------------- 清单加载 ----------------
const cachedCatalog = catalogSession.peek();
const manifest = ref<RemoteVersion[]>(cachedCatalog?.versions ?? []);
const loading = ref(false);
const loadError = ref('');
const staleCatalog = ref(cachedCatalog?.stale ?? false);
const checkedAt = ref(cachedCatalog?.checkedAt ?? 0);
let disposed = false;
let lastAttempt = 0;
let catalogTimer: ReturnType<typeof setInterval> | undefined;

/** Each visit starts with local instances; remote metadata is loaded only on demand. */
const tab = ref<'download' | 'installed'>('installed');
watch(tab, (value) => {
  if (value === 'download') void load();
});

// ---------------- Tab 滑动指示块（版本下载 ⇄ 已安装 平滑滑动，与导航水滴同款弹簧动效） ----------------
const gameTabs = ref<HTMLElement | null>(null);
const tabBlob = reactive({ left: 0, width: 0, on: false });
function updateTabBlob() {
  const root = gameTabs.value;
  if (!root) return;
  const active = root.querySelector<HTMLElement>(`.game-tab[data-tab="${tab.value}"]`);
  if (!active) return;
  tabBlob.left = active.offsetLeft;
  tabBlob.width = active.offsetWidth;
  tabBlob.on = true;
}
watch(tab, () => nextTick(updateTabBlob));
watch(
  () => store.installed.length,
  () => nextTick(updateTabBlob)
);
let tabBlobObserver: ResizeObserver | null = null;
onMounted(() => {
  nextTick(updateTabBlob);
  setTimeout(updateTabBlob, 200);
  tabBlobObserver = new ResizeObserver(() => updateTabBlob());
  if (gameTabs.value) tabBlobObserver.observe(gameTabs.value);
});
onUnmounted(() => {
  window.removeEventListener('resize', updateTabBlob);
  tabBlobObserver?.disconnect();
});
const tabBlobStyle = computed(() => ({
  left: tabBlob.left + 'px',
  width: tabBlob.width + 'px',
  opacity: tabBlob.on ? 1 : 0,
}));

async function load(refresh = false) {
  if (loading.value || disposed) return;
  lastAttempt = Date.now();
  loading.value = true;
  loadError.value = '';
  try {
    const result = await catalogSession.load(refresh);
    if (disposed) return;
    manifest.value = result.versions;
    staleCatalog.value = result.stale;
    checkedAt.value = result.checkedAt;
  } catch (e) {
    if (!disposed) loadError.value = errText(e);
  } finally {
    if (!disposed) loading.value = false;
  }
}
function checkCatalogOnReturn() {
  if (tab.value === 'download' && document.visibilityState === 'visible' && Date.now() - lastAttempt >= 60_000) void load();
}
onUnmounted(() => {
  disposed = true;
  clearInterval(catalogTimer);
  window.removeEventListener('focus', checkCatalogOnReturn);
  document.removeEventListener('visibilitychange', checkCatalogOnReturn);
});

// ---------------- 游戏文件夹（统一管理入口） ----------------
const folders = ref<GameFolder[]>([]);
const activeFolder = ref('');
const installFolder = computed(() => store.settings?.folders.find((folder) => folder.isDefault)?.path || activeFolder.value);
watch(
  () => store.settings?.folders,
  (value) => {
    if (value) folders.value = value;
  },
  { deep: true }
);
watch(
  () => store.settings?.activeFolder,
  (folder) => {
    if (folder && folder !== activeFolder.value) {
      activeFolder.value = folder;
      void refreshFolderScan(false);
    }
  }
);
const folderScan = ref<FolderScanResult | null>(null);
const folderBusy = ref(false);
const folderRename = reactive({ open: false, name: '', busy: false, error: '' });
const folderRemove = reactive({ open: false, busy: false });

const currentFolder = computed(() => folders.value.find((folder) => folder.path === activeFolder.value));
const folderMissingDismissed = ref(false);
const folderMissing = computed(() => folderScan.value?.structure === 'missing' && !folderMissingDismissed.value);
async function removeMissingFolder() {
  if (!activeFolder.value || folderRemove.busy) return;
  folderRemove.busy = true;
  try {
    await removeFolder(activeFolder.value);
    folderMissingDismissed.value = false;
    await loadFolderState();
    store.settings = await getSettings();
    toast(t('games.toast.missing_removed'), 'success');
  } catch (error) {
    toast(t('games.toast.missing_remove_failed', { e: errText(error) }), 'error');
  } finally {
    folderRemove.busy = false;
  }
}

async function refreshFolderScan(syncList = true) {
  if (!activeFolder.value) return;
  folderBusy.value = true;
  try {
    const result = await scanFolder(activeFolder.value);
    folderScan.value = result;
    if (syncList) {
      await refreshInstalled();
      await refreshAllInstalled();
    }
  } catch (error) {
    folderScan.value = null;
    toast(t('games.toast.scan_failed', { e: errText(error) }), 'error');
  } finally {
    folderBusy.value = false;
  }
}

async function loadFolderState() {
  try {
    const state = await listFolders();
    folders.value = state.folders;
    activeFolder.value = state.active;
    await refreshFolderScan();
  } catch (error) {
    toast(t('games.toast.folder_read_failed', { e: errText(error) }), 'error');
  }
}

async function chooseFolderPath(selected: string) {
  if (!selected || selected === installFolder.value || folderBusy.value) return;
  folderBusy.value = true;
  let committed = false;
  try {
    folders.value = await setDefaultFolder(selected);
    committed = true;
    const destination = folders.value.find((folder) => folder.isDefault)!.path;
    if (store.settings) store.settings = { ...store.settings, folders: folders.value, activeFolder: destination, gameDir: destination };
    store.settings = await getSettings();
    activeFolder.value = store.settings.activeFolder;
    store.resourceVersionId = '';
    await refreshInstalled();
    await refreshFolderScan(false);
    toast(t('games.toast.folder_changed', { name: currentFolder.value?.name ?? t('games.folder.generic_name') }), 'success');
  } catch (error) {
    toast(
      committed ? t('games.toast.folder_saved_stale', { e: errText(error) }) : t('games.toast.folder_switch_failed', { e: errText(error) }),
      committed ? 'info' : 'error'
    );
    if (!committed) await loadFolderState();
  } finally {
    folderBusy.value = false;
  }
}

async function addGameFolder() {
  let committed = false;
  try {
    const selected = await selectDir();
    if (!selected) return;
    folderBusy.value = true;
    folders.value = await setDownloadFolder(selected);
    committed = true;
    const destination = folders.value.find((folder) => folder.isDefault)!.path;
    if (store.settings) store.settings = { ...store.settings, folders: folders.value, activeFolder: destination, gameDir: destination };
    const state = await listFolders();
    folders.value = state.folders;
    activeFolder.value = state.active;
    store.settings = await getSettings();
    await refreshInstalled();
    await refreshFolderScan(false);
    const count = folderScan.value?.versions.length ?? 0;
    toast(t('games.toast.folder_added', { count: String(count) }), 'success');
  } catch (error) {
    toast(
      committed ? t('games.toast.folder_saved_stale', { e: errText(error) }) : t('games.toast.folder_add_failed', { e: errText(error) }),
      committed ? 'info' : 'error'
    );
  } finally {
    folderBusy.value = false;
  }
}

async function markCurrentDefault() {
  if (!activeFolder.value || currentFolder.value?.isDefault) return;
  folderBusy.value = true;
  let committed = false;
  try {
    folders.value = await setDefaultFolder(activeFolder.value);
    committed = true;
    const destination = folders.value.find((folder) => folder.isDefault)!.path;
    if (store.settings) store.settings = { ...store.settings, folders: folders.value, activeFolder: destination, gameDir: destination };
    store.settings = await getSettings();
    toast(t('games.toast.default_set'), 'success');
  } catch (error) {
    toast(
      committed ? t('games.toast.default_saved', { e: errText(error) }) : t('games.toast.default_failed', { e: errText(error) }),
      committed ? 'info' : 'error'
    );
  } finally {
    folderBusy.value = false;
  }
}

function openFolderRename() {
  if (!currentFolder.value) return;
  folderRename.name = currentFolder.value.name;
  folderRename.error = '';
  folderRename.open = true;
}

async function confirmFolderRename() {
  if (!activeFolder.value || folderRename.busy) return;
  folderRename.busy = true;
  folderRename.error = '';
  try {
    folders.value = await renameFolder(activeFolder.value, folderRename.name);
    folderRename.open = false;
    store.settings = await getSettings();
    toast(t('games.toast.folder_renamed'), 'success');
  } catch (error) {
    folderRename.error = errText(error);
  } finally {
    folderRename.busy = false;
  }
}

async function confirmFolderRemove() {
  if (!activeFolder.value || folderRemove.busy) return;
  folderRemove.busy = true;
  try {
    await removeFolder(activeFolder.value);
    folderRemove.open = false;
    await loadFolderState();
    store.settings = await getSettings();
    toast(t('games.toast.folder_unbound'), 'success');
  } catch (error) {
    toast(t('games.toast.folder_unbind_failed', { e: errText(error) }), 'error');
  } finally {
    folderRemove.busy = false;
  }
}

async function revealCurrentFolder() {
  if (!activeFolder.value) return;
  try {
    await openGameFolder(activeFolder.value);
  } catch (error) {
    toast(t('games.toast.open_folder_failed', { e: errText(error) }), 'error');
  }
}

onMounted(() => {
  window.addEventListener('focus', checkCatalogOnReturn);
  document.addEventListener('visibilitychange', checkCatalogOnReturn);
  catalogTimer = setInterval(() => {
    if (tab.value === 'download' && document.visibilityState === 'visible') void load();
  }, 5 * 60_000);
  void loadFolderState();
});

// ---------------- 搜索与筛选（搜索框联动顶栏 store.searchKeyword） ----------------
type TypeFilter = 'all' | 'release' | 'snapshot' | 'old';
const typeFilter = ref<TypeFilter>('release');

const typeFilters = computed<Array<{ value: TypeFilter; label: string }>>(() => [
  { value: 'release', label: t('games.filter.release') },
  { value: 'all', label: t('games.filter.all') },
  { value: 'snapshot', label: t('games.filter.snapshot') },
  { value: 'old', label: t('games.filter.old') },
]);

function typeText(kind: RemoteVersion['type']): string {
  if (kind === 'release') return t('games.type.release');
  if (kind === 'snapshot') return t('games.type.snapshot');
  if (kind === 'old_beta') return t('games.type.old_beta');
  return t('games.type.old_alpha');
}

const typeTagClass = (kind: RemoteVersion['type']) => (kind === 'release' ? 'tag-gold' : kind === 'snapshot' ? 'tag-cyan' : '');

const keyword = computed(() => store.searchKeyword.trim().toLowerCase());

function progressEta(id: string) {
  const p = versionProgress(id);
  const eta = p?.etaSeconds;
  if (eta == null || !Number.isFinite(eta) || eta <= 3) return '';
  if (eta >= 3600) return t('games.eta.hours', { value: String(Math.ceil(eta / 3600)) });
  if (eta >= 60) return t('games.eta.minutes', { value: String(Math.ceil(eta / 60)) });
  return t('games.eta.seconds', { value: String(Math.round(eta)) });
}
function versionProgress(id: string) {
  return store.installProgress[id] ?? { stage: 'version-json', progress: 0, text: t('games.progress.waiting') };
}

const filtered = computed(() =>
  manifest.value.filter((v) => {
    if (keyword.value && !v.id.toLowerCase().includes(keyword.value)) return false;
    if (typeFilter.value === 'all') return true;
    if (typeFilter.value === 'old') return v.type === 'old_beta' || v.type === 'old_alpha';
    return v.type === typeFilter.value;
  })
);

const formatDate = formatReleaseTime;
const latestRelease = computed(() => manifest.value.find((v) => v.type === 'release'));

const isInstalled = (v: RemoteVersion) => store.installed.some((i) => i.mcVersion === v.id);

// ---------------- 安装模态框 ----------------
const loaderOptions = computed<Array<{ value: '' | LoaderName; label: string }>>(() => [
  { value: '', label: t('games.install.loader_none') },
  { value: 'forge', label: 'Forge' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'neoforge', label: 'NeoForge' },
]);

const modal = reactive({
  open: false,
  version: null as RemoteVersion | null,
  loader: '' as '' | LoaderName,
  loaderVersions: [] as string[],
  loaderVersion: '',
  loadingLoaders: false,
  loadLoadersError: '',
  apiOn: true,
  apiVersions: [] as FabricApiVersion[],
  apiVersion: '',
  loadingApi: false,
  apiError: '',
  recordingMod: undefined as InstallOptions['recordingMod'],
  favoriteMods: undefined as InstallOptions['favoriteMods'],
  favoriteInstallIntent: undefined as InstallOptions['favoriteInstallIntent'],
  instanceName: '',
  instanceEdited: false,
  targetFolder: '',
});

const defaultInstanceName = computed(() => {
  const mc = modal.version?.id ?? '';
  if (!modal.loader) return mc;
  if (!modal.loaderVersion) return `${mc}-${modal.loader}`;
  if (modal.loader === 'forge') return `${mc}-forge-${modal.loaderVersion}`;
  if (modal.loader === 'neoforge') return `neoforge-${modal.loaderVersion || '?'}`;
  return `${modal.loader}-loader-${modal.loaderVersion || '?'}-${mc}`;
});

const instanceError = computed(() => {
  const n = (modal.instanceEdited ? modal.instanceName : defaultInstanceName.value).trim();
  if (!n) return t('games.instance_name.empty');
  if (n.length > 64) return t('games.instance_name.too_long');
  if (/[\\/:*?"<>|]/.test(n)) return t('games.instance_name.invalid_chars');
  if (/^[.\s]|[.\s]$/.test(n)) return t('games.instance_name.whitespace');
  if (allInstalled.value.some((v) => v.id === n && v.folder === modal.targetFolder)) return t('games.instance_name.exists', { name: n });
  return '';
});

const effectiveInstanceName = computed(() => (modal.instanceEdited ? modal.instanceName.trim() : defaultInstanceName.value));

function openInstall(v: RemoteVersion) {
  modal.open = true;
  modal.version = v;
  modal.loader = '';
  modal.loaderVersions = [];
  modal.loaderVersion = '';
  modal.loadingLoaders = false;
  modal.loadLoadersError = '';
  modal.apiOn = true;
  modal.apiVersions = [];
  modal.apiVersion = '';
  modal.loadingApi = false;
  modal.apiError = '';
  modal.recordingMod = undefined;
  modal.favoriteMods = undefined;
  modal.favoriteInstallIntent = undefined;
  favoritesReady.value = true;
  modal.instanceName = '';
  modal.instanceEdited = false;
  modal.targetFolder = installFolder.value;
}

const apiRetry = ref(0);
watch(
  () => [modal.open, modal.loader, modal.version?.id, apiRetry.value] as const,
  async ([open, loader, mcVersion], _previous, onCleanup) => {
    let stale = false;
    onCleanup(() => {
      stale = true;
    });
    modal.loaderVersions = [];
    modal.loaderVersion = '';
    modal.loadLoadersError = '';
    modal.apiVersions = [];
    modal.apiVersion = '';
    modal.apiError = '';
    modal.loadingLoaders = false;
    modal.loadingApi = false;
    if (!open || !loader || !mcVersion) return;
    modal.loadingLoaders = true;
    modal.loadingApi = loader === 'fabric';
    try {
      const list = await listLoaders(loader, mcVersion);
      if (stale) return;
      modal.loaderVersions = list;
      modal.loaderVersion = list[0] ?? '';
      if (!list.length) modal.loadLoadersError = t('games.install.loader_no_version');
    } catch (e) {
      if (stale) return;
      modal.loadLoadersError = t('games.install.loader_failed', { e: errText(e) });
    } finally {
      if (!stale) modal.loadingLoaders = false;
    }
    if (loader === 'fabric' && !stale) {
      try {
        const list = await listFabricApi(mcVersion);
        if (stale) return;
        modal.apiVersions = list;
        modal.apiVersion = list[0]?.version ?? '';
        if (!list.length) modal.apiError = t('games.install.fabric_api_no_version');
      } catch (e) {
        if (stale) return;
        modal.apiError = t('games.install.fabric_api_failed', { e: errText(e) });
      } finally {
        if (!stale) modal.loadingApi = false;
      }
    }
  }
);

const canConfirm = computed(
  () =>
    !!modal.version &&
    !modal.loadingLoaders &&
    (modal.loader === '' || !!modal.loaderVersion) &&
    (modal.loader !== 'fabric' || !modal.apiOn || (!modal.loadingApi && !modal.apiError && !!modal.apiVersion)) &&
    favoritesReady.value &&
    (!modal.recordingMod || (!!modal.loader && !!modal.recordingMod.fileId)) &&
    !instanceError.value
);

async function confirmInstall() {
  const v = modal.version;
  if (!v || !canConfirm.value || store.installing.has(v.id)) return;
  const opts: InstallOptions = modal.loader
    ? {
        loader: modal.loader,
        recordingMod: modal.recordingMod,
        favoriteMods: modal.favoriteMods,
        favoriteInstallIntent: modal.favoriteInstallIntent,
        loaderVersion: modal.loaderVersion || undefined,
        fabricApi: modal.loader === 'fabric' && modal.apiOn && modal.apiVersion ? modal.apiVersion : undefined,
        instanceName: effectiveInstanceName.value || undefined,
      }
    : {
        instanceName: effectiveInstanceName.value || undefined,
        favoriteMods: modal.favoriteMods,
        favoriteInstallIntent: modal.favoriteInstallIntent,
      };
  modal.open = false;
  store.installing.add(v.id);
  toast(t('games.toast.download_started', { id: v.id }), 'info');
  try {
    await installVersion(v.id, opts, modal.targetFolder);
  } catch (e) {
    store.installing.delete(v.id);
    toast(t('games.toast.install_failed', { e: errText(e) }), 'error');
  }
}

// ---------------- 已安装区 ----------------
const removeModal = reactive({
  open: false,
  target: null as InstalledVersion | null,
  busy: false,
});

async function onConfirmRemove() {
  const v = removeModal.target;
  if (!v || removeModal.busy) return;
  removeModal.busy = true;
  try {
    await removeVersion(v.id, v.folder);
    await refreshInstalled();
    removeModal.open = false;
    toast(t('games.toast.removed', { id: v.id }), 'success');
  } catch (e) {
    toast(t('games.toast.remove_failed', { e: errText(e) }), 'error');
  } finally {
    removeModal.busy = false;
  }
}

async function onCleanup(id: string, folder: string) {
  try {
    await cleanupPartialInstall(id, folder);
    await refreshInstalled();
    toast(t('games.toast.cleanup_ok'), 'success');
  } catch (e) {
    toast(t('games.toast.cleanup_failed', { e: errText(e) }), 'error');
  }
}

async function openVersionFolder(v: InstalledVersion) {
  try {
    await openDir('versions/' + v.id, v.folder);
  } catch (e) {
    toast(t('games.toast.open_folder_failed', { e: errText(e) }), 'error');
  }
}

async function launchVersion(v: InstalledVersion) {
  await selectInstance(v.id, v.folder);
  const folder = v.folder ?? store.settings?.activeFolder ?? store.settings?.gameDir;
  if (instanceLaunchBusy(store.launchStates, v.id, folder)) return;
  applyLaunchState({ status: 'launching', text: t('games.toast.launching'), versionId: v.id, folder });
  try {
    await launchGame(v.id, undefined, v.folder);
  } catch (e) {
    applyLaunchState({ status: 'error', text: errText(e), versionId: v.id, folder });
    toast(t('games.toast.launch_failed', { e: errText(e) }), 'error');
  }
}

// ---------------- 版本隔离开关 ----------------
const isoBusy = ref<string | null>(null);
const isolationModal = reactive<{
  open: boolean;
  target: InstalledVersion | null;
  plan: IsolationMigrationPlan | null;
  busy: boolean;
  error: string;
}>({ open: false, target: null, plan: null, busy: false, error: '' });

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function closeIsolationModal() {
  if (isolationModal.busy) return;
  isoBusy.value = null;
  isolationModal.open = false;
  isolationModal.target = null;
  isolationModal.plan = null;
  isolationModal.error = '';
}

// ---------------- 管理快捷菜单 ----------------
const manageMenu = reactive({ id: '', folder: '', top: 0, left: 0 });
const menuVersion = computed(() => allInstalled.value.find((v) => v.id === manageMenu.id && v.folder === manageMenu.folder));
const loaderLabel = (v: InstalledVersion) =>
  v.loader
    ? `${({ fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' } as Record<string, string>)[v.loader] || v.loader} ${v.loaderVersion || ''}`.trim()
    : t('games.instance.meta.vanilla');
let menuTrigger: HTMLElement | null = null;
function closeManageMenu() {
  manageMenu.id = '';
  menuTrigger?.focus();
}
function trapMenuFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const items = [
    ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'
    ),
  ];
  const edge = event.shiftKey ? items[0] : items[items.length - 1];
  if (document.activeElement === edge) {
    event.preventDefault();
    (event.shiftKey ? items[items.length - 1] : items[0])?.focus();
  }
}

async function onToggleMirror() {
  const next = store.settings?.mirror === 'bmclapi' ? 'official' : 'bmclapi';
  try {
    await saveSettings({ mirror: next });
    store.settings = await getSettings();
    toast(next === 'bmclapi' ? t('games.toast.mirror_bmclapi') : t('games.toast.mirror_official'), 'success');
    void load(true);
  } catch (e) {
    toast(t('games.toast.mirror_failed', { e: errText(e) }), 'error');
  }
}

function onRetry(versionId: string, folder = activeFolder.value) {
  store.failedInstalls.delete(versionId);
  store.installing.add(versionId);
  toast(t('games.toast.retry_started', { id: versionId }), 'info');
  void installVersion(versionId, {}, folder).catch((e) => {
    store.installing.delete(versionId);
    toast(t('games.toast.install_failed', { e: errText(e) }), 'error');
  });
}

const installingVersions = computed(() => [...store.installing]);

const folderShortName = (p: string): string => {
  const norm = (v: string) => v.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const hit = store.settings?.folders.find((f) => norm(f.path) === norm(p));
  if (hit?.name?.trim()) return hit.name.trim();
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
};

const scopedInstalled = computed(() =>
  allInstalled.value
    .filter(
      (v) =>
        !installedFolder.value ||
        folderKey(v.folder) === folderKey(installedFolder.value === '@current' ? activeFolder.value : installedFolder.value)
    )
    .filter((v) =>
      `${displayVersionName(v)} ${v.mcVersion || ''} ${v.loader || ''} ${folderShortName(v.folder)}`
        .toLowerCase()
        .includes(installedSearch.value.trim().toLowerCase())
    )
);
const sortedInstalled = computed(() =>
  sortWithFavorite(
    scopedInstalled.value.filter((v) => versionMatchesCategory(installedCategory.value, categoryOf(v), isFavorite(v.id, v.folder)))
  )
);
const categoryFilters = computed(() => [
  { id: VERSION_CATEGORY_ALL, name: t('games.category.all'), count: scopedInstalled.value.length },
  {
    id: VERSION_CATEGORY_FAVORITES,
    name: t('games.category.favorites'),
    count: scopedInstalled.value.filter((v) => isFavorite(v.id, v.folder)).length,
  },
  {
    id: VERSION_CATEGORY_UNCLASSIFIED,
    name: t('games.category.unclassified'),
    count: scopedInstalled.value.filter((v) => !categoryOf(v)).length,
  },
  ...categories.value.map((c) => ({ ...c, count: scopedInstalled.value.filter((v) => categoryOf(v) === c.id).length })),
]);

function openManageMenu(e: MouseEvent, id: string, folder: string) {
  if (manageMenu.id === id && manageMenu.folder === folder) {
    manageMenu.id = '';
    return;
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menuTrigger = e.currentTarget as HTMLElement;
  manageMenu.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 520));
  manageMenu.left = Math.max(8, r.right - 290);
  manageMenu.id = id;
  manageMenu.folder = folder;
  void nextTick(() => document.querySelector<HTMLElement>('.instance-more-menu button')?.focus());
}

async function goManage(view: 'mods' | 'packs' | 'shaders') {
  const { id, folder } = manageMenu;
  await selectInstance(id, folder);
  store.resourceVersionId = id;
  manageMenu.id = '';
  store.currentView = view;
}

// ---------------- 实例重命名 ----------------
const renameModal = reactive({ open: false, id: '', folder: '', name: '', error: '', busy: false });

// ---------------- 实例图标 ----------------
const iconModal = reactive({ open: false, id: '', folder: '', current: '' });

function openIconPicker(id: string, folder = manageMenu.folder) {
  iconModal.folder = folder;
  iconModal.id = id;
  iconModal.current = allInstalled.value.find((v) => v.id === id && v.folder === folder)?.icon ?? '';
  iconModal.open = true;
  manageMenu.id = '';
}

// ---------------- 首页启动卡缩略图 ----------------
const thumbnailModal = reactive({
  open: false,
  id: '',
  folder: '',
  current: '',
  fit: 'crop' as ImageFit,
});

function openThumbnailPicker(id: string, folder = manageMenu.folder) {
  const version = allInstalled.value.find((item) => item.id === id && item.folder === folder);
  thumbnailModal.folder = folder;
  thumbnailModal.id = id;
  thumbnailModal.current = version?.thumbnail ?? '';
  thumbnailModal.fit = version?.thumbnailFit ?? 'crop';
  thumbnailModal.open = true;
  manageMenu.id = '';
}

// ---------------- 指定 Java ----------------
const javaModal = reactive({
  open: false,
  id: '',
  folder: '',
  value: '',
  list: [] as Awaited<ReturnType<typeof listJava>>,
  busy: false,
});

async function openJavaModal() {
  javaModal.folder = manageMenu.folder;
  javaModal.id = manageMenu.id;
  manageMenu.id = '';
  javaModal.busy = true;
  javaModal.open = true;
  try {
    javaModal.list = await listJava();
    const cur = allInstalled.value.find((v) => v.id === javaModal.id && v.folder === javaModal.folder);
    javaModal.value = cur?.javaPath ?? '';
  } catch (e) {
    toast(t('games.toast.java_read_failed', { e: errText(e) }), 'error');
  } finally {
    javaModal.busy = false;
  }
}

async function onConfirmJava() {
  try {
    await setVersionJava(javaModal.id, javaModal.value, false, javaModal.folder);
    await refreshInstalled();
    javaModal.open = false;
    toast(javaModal.value ? t('games.toast.java_set') : t('games.toast.java_auto'), 'success');
  } catch (e) {
    toast(t('games.toast.java_set_failed', { e: errText(e) }), 'error');
  }
}

// ---------------- 实例窗口设置 ----------------
const resolutionModal = reactive({
  open: false,
  id: '',
  folder: '',
  mode: 'inherit' as 'inherit' | GameWindowMode,
  width: 854,
  height: 480,
  error: '',
  busy: false,
});

function openResolutionModal() {
  resolutionModal.folder = manageMenu.folder;
  resolutionModal.id = manageMenu.id;
  manageMenu.id = '';
  const current = allInstalled.value.find((version) => version.id === resolutionModal.id && version.folder === resolutionModal.folder);
  const fallback = store.settings?.resolution;
  resolutionModal.mode = current?.resolution?.mode ?? 'inherit';
  resolutionModal.width = current?.resolution?.width ?? fallback?.width ?? 854;
  resolutionModal.height = current?.resolution?.height ?? fallback?.height ?? 480;
  resolutionModal.error = '';
  resolutionModal.open = true;
}

async function onConfirmResolution() {
  if (resolutionModal.busy) return;
  resolutionModal.error = '';
  let override: GameResolution | null = null;
  if (resolutionModal.mode !== 'inherit') {
    const width = Number(resolutionModal.width);
    const height = Number(resolutionModal.height);
    if (!Number.isInteger(width) || width < 854 || width > 7680) {
      resolutionModal.error = t('games.toast.resolution_window_invalid');
      return;
    }
    if (!Number.isInteger(height) || height < 480 || height > 4320) {
      resolutionModal.error = t('games.toast.resolution_height_invalid');
      return;
    }
    override = {
      width,
      height,
      mode: resolutionModal.mode,
      fullscreen: resolutionModal.mode === 'fullscreen',
    };
  }
  resolutionModal.busy = true;
  try {
    await setVersionResolution(resolutionModal.id, override, resolutionModal.folder);
    await refreshInstalled();
    resolutionModal.open = false;
    toast(override ? t('games.toast.resolution_saved') : t('games.toast.resolution_inherit'), 'success');
  } catch (error) {
    resolutionModal.error = errText(error);
  } finally {
    resolutionModal.busy = false;
  }
}

function openRename() {
  openRenameFor(manageMenu.id);
  manageMenu.id = '';
}

function openRenameFor(id: string, folder = manageMenu.folder) {
  renameModal.folder = folder;
  renameModal.id = id;
  renameModal.name = id;
  renameModal.error = '';
  renameModal.open = true;
}

async function onConfirmRename() {
  if (renameModal.busy) return;
  renameModal.busy = true;
  renameModal.error = '';
  const oldId = renameModal.id;
  const newId = renameModal.name.trim();
  try {
    await renameVersion(oldId, newId, renameModal.folder);
    store.settings = await getSettings();
    renameLastPlayed(oldId, newId);
    await refreshInstalled();
    renameModal.open = false;
    toast(t('games.toast.renamed'), 'success');
  } catch (e) {
    renameModal.error = errText(e);
  } finally {
    renameModal.busy = false;
  }
}

async function onToggleIsolation(v: InstalledVersion, event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  input.checked = !!v.isolated;
  if (isoBusy.value) return;
  isoBusy.value = v.id;
  const next = !v.isolated;
  try {
    if (next) {
      const plan = await getIsolationPlan(v.id, v.folder);
      if (plan.items.length > 0) {
        isolationModal.target = v;
        isolationModal.plan = plan;
        isolationModal.error = '';
        isolationModal.open = true;
        return;
      }
    }
    await setVersionIsolation(v.id, next, v.folder);
    await refreshInstalled();
    toast(next ? t('games.toast.isolation_on', { id: v.id }) : t('games.toast.isolation_off', { id: v.id }), 'success');
  } catch (e) {
    toast(t('games.toast.isolation_toggle_failed', { e: errText(e) }), 'error');
  } finally {
    if (!isolationModal.open) isoBusy.value = null;
  }
}

async function confirmIsolation() {
  const target = isolationModal.target;
  if (!target || isolationModal.busy) return;
  isolationModal.busy = true;
  isolationModal.error = '';
  try {
    await setVersionIsolation(target.id, true, target.folder);
    await refreshInstalled();
    isolationModal.open = false;
    toast(t('games.toast.isolation_confirmed', { id: target.id }), 'success');
  } catch (error) {
    isolationModal.error = errText(error);
  } finally {
    isolationModal.busy = false;
    isoBusy.value = null;
    if (!isolationModal.open) {
      isolationModal.target = null;
      isolationModal.plan = null;
    }
  }
}
</script>

<template>
  <div class="page" :data-design-page="tab">
    <!-- 标题 -->
    <div class="page-head">
      <h1 class="page-title">{{ t('games.title') }}</h1>
      <p class="page-sub">{{ t('games.subtitle') }}</p>
    </div>

    <div class="game-tabs" ref="gameTabs">
      <span class="game-tabs-blob" :style="tabBlobStyle" aria-hidden="true"></span>
      <button class="game-tab" data-tab="download" :class="{ active: tab === 'download' }" @click="tab = 'download'">
        {{ t('games.tab.download') }}
      </button>
      <button class="game-tab" data-tab="installed" :class="{ active: tab === 'installed' }" @click="tab = 'installed'">
        <template v-if="allInstalled.length">{{ t('games.tab.installed_count', { count: String(allInstalled.length) }) }}</template>
        <template v-else>{{ t('games.tab.installed') }}</template>
      </button>
    </div>

    <!-- 安装目标与下方列表筛选独立。 -->
    <section class="card folder-manager" data-ui="games:folders" @contextmenu.prevent="showFolderContextMenu(activeFolder)">
      <div class="folder-manager-main">
        <div class="folder-select-wrap">
          <span class="folder-caption">{{ t('games.folder.default_download') }}</span>
          <SelectMenu
            class="folder-select"
            :model-value="installFolder"
            :options="
              folders.map((f) => ({
                value: f.path,
                label: f.name + (f.isDefault ? t('games.folder.folder_default') : ''),
              }))
            "
            :disabled="folderBusy || !folders.length"
            @change="chooseFolderPath"
          />
          <span class="muted folder-current-path" data-ui="download-location:game-path" :title="installFolder">{{ installFolder }}</span>
        </div>
        <button
          class="btn btn-ghost btn-sm folder-tools-trigger"
          :aria-expanded="folderToolsOpen"
          @click="folderToolsOpen = !folderToolsOpen"
        >
          {{ t('games.folder.manage') }} <span class="muted">{{ folders.length }}</span>
        </button>
      </div>
      <div v-if="folderToolsOpen" class="folder-manager-actions" @keydown.esc="folderToolsOpen = false">
        <p class="muted folder-managed-path" :title="activeFolder">
          {{ t('games.folder.managing', { name: currentFolder?.name || t('games.folder.generic_name'), path: activeFolder }) }}
        </p>
        <button class="btn btn-ghost btn-sm" :disabled="folderBusy" @click="addGameFolder">{{ t('games.folder.change') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="folderBusy" @click="refreshFolderScan()">
          <span v-if="folderBusy" class="spin"></span>
          {{ folderBusy ? t('games.folder.scanning') : t('games.folder.refresh') }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="!activeFolder" @click="revealCurrentFolder">{{ t('games.folder.open') }}</button>
        <button class="btn btn-ghost btn-sm" :disabled="!currentFolder" @click="openFolderRename">
          {{ t('games.folder.rename') }}
        </button>
        <button
          v-if="currentFolder && !currentFolder.isDefault"
          class="btn btn-ghost btn-sm"
          :disabled="folderBusy"
          @click="markCurrentDefault"
        >
          {{ t('games.folder.mark_default') }}
        </button>
        <button
          class="btn btn-danger btn-sm"
          :disabled="folderBusy || folders.length <= 1"
          :title="t('games.folder.unbind_title')"
          @click="folderRemove.open = true"
        >
          {{ t('games.folder.unbind') }}
        </button>
      </div>
      <div v-if="folderMissing && currentFolder" class="folder-missing-card" role="alert">
        <div class="folder-missing-text">
          <strong>{{ t('games.folder.missing_title') }}</strong>
          <span class="muted">{{ t('games.folder.missing_desc', { name: currentFolder.name, path: currentFolder.path }) }}</span>
        </div>
        <div class="folder-missing-actions">
          <button class="btn btn-danger btn-sm" :disabled="folderRemove.busy" @click="removeMissingFolder">
            {{ t('games.folder.remove_binding') }}
          </button>
          <button class="btn btn-ghost btn-sm" @click="folderMissingDismissed = true">{{ t('games.folder.later') }}</button>
        </div>
      </div>
      <p class="muted folder-location-hint">
        {{ t('games.folder.hint')
        }}<button
          class="btn btn-ghost btn-sm"
          @click="
            store.settingsSection = 'installation';
            store.currentView = 'settings';
          "
        >
          {{ t('games.folder.download_settings') }}
        </button>
      </p>
      <p v-if="folderScan?.errors.length" class="folder-scan-error" role="status">{{ folderScan.errors[0] }}</p>
    </section>

    <div v-if="tab === 'download'" class="game-controls">
      <div v-if="tab === 'download'" class="toolbar">
        <div class="tool-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input v-model="store.searchKeyword" :placeholder="t('games.toolbar.search_placeholder')" />
        </div>

        <div class="filter-capsules">
          <button
            v-for="f in typeFilters"
            :key="f.value"
            class="capsule"
            :class="{ active: typeFilter === f.value }"
            @click="typeFilter = f.value"
          >
            {{ f.label }}
          </button>
        </div>

        <button class="btn btn-ghost tool-refresh" :disabled="loading" @click="load(true)">
          <span v-if="loading" class="spin"></span>
          <svg
            v-else
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          {{ loading ? t('games.toolbar.refreshing') : t('games.toolbar.refresh') }}
        </button>

        <button
          class="tag mirror-toggle"
          :class="store.settings?.mirror === 'bmclapi' ? 'tag-cyan' : ''"
          :title="
            store.settings?.mirror === 'bmclapi'
              ? t('games.toolbar.mirror_switch_to_official')
              : t('games.toolbar.mirror_switch_to_bmclapi')
          "
          @click="onToggleMirror"
        >
          {{ store.settings?.mirror === 'bmclapi' ? t('games.toolbar.mirror_bmclapi') : t('games.toolbar.mirror_official') }}
        </button>
      </div>
    </div>

    <div v-if="tab === 'download'" class="catalog-status muted" role="status" data-ui="game.catalog-status">
      <span v-if="staleCatalog || loadError">{{ loadError || t('games.catalog.stale') }}</span>
      <span v-else>{{ loading ? t('games.catalog.checking') : t('games.catalog.auto') }}</span>
      <span
        >{{ t('games.catalog.local_time')
        }}<span v-if="checkedAt">{{ t('games.catalog.last_check', { time: formatDate(new Date(checkedAt).toISOString()) }) }}</span></span
      >
    </div>
    <div v-if="tab === 'download' && latestRelease && !keyword" class="card latest-release" data-ui="game.latest-release">
      <div>
        <span class="tag tag-gold">{{ t('games.latest.title') }}</span
        ><strong>{{ latestRelease.id }}</strong>
        <time :datetime="latestRelease.releaseTime">{{
          t('games.latest.published', { date: formatDate(latestRelease.releaseTime) })
        }}</time>
      </div>
      <button class="btn btn-gold" :disabled="store.installing.has(latestRelease.id)" @click="openInstall(latestRelease)">
        {{
          store.installing.has(latestRelease.id)
            ? t('games.list.downloading')
            : isInstalled(latestRelease)
              ? t('games.list.reinstall')
              : t('games.list.install')
        }}
      </button>
    </div>
    <!-- 版本列表 -->
    <div v-if="tab === 'download'" class="card list-card">
      <ContentSkeleton v-if="loading && !manifest.length" :label="t('games.list.loading')" />
      <div v-else-if="loadError && !manifest.length" class="empty">
        <span>{{ t('games.list.load_failed', { e: loadError }) }}</span>
        <button class="btn btn-ghost btn-sm" @click="load(true)">{{ t('games.installed.retry') }}</button>
      </div>
      <div v-else-if="!filtered.length" class="empty">
        <span>{{ keyword || typeFilter !== 'all' ? t('games.list.no_match') : t('games.list.empty') }}</span>
      </div>
      <div v-else class="version-list">
        <div v-for="v in filtered" :key="v.id" class="version-row">
          <div class="version-info">
            <span class="version-id">{{ v.id }}</span>
            <span class="tag" :class="typeTagClass(v.type)">{{ typeText(v.type) }}</span>
            <time class="muted version-date" :datetime="v.releaseTime" :title="t('games.catalog.local_time')">{{
              formatDate(v.releaseTime)
            }}</time>
          </div>
          <div class="version-actions">
            <div v-if="store.installing.has(v.id) && versionProgress(v.id)" class="row-progress">
              <div class="row-bar">
                <div class="row-bar-fill" :style="{ width: Math.round(progressMono(versionProgress(v.id)) * 100) + '%' }"></div>
              </div>
              <span class="muted row-progress-text">
                {{ Math.round(progressMono(versionProgress(v.id)) * 100) }}%
                {{ versionProgress(v.id).speed ? '· ' + formatSpeed(versionProgress(v.id).speed) : '' }}
                {{ progressEta(v.id) ? '· ' + progressEta(v.id) : '' }}
                {{ versionProgress(v.id).source ? '· ' + versionProgress(v.id).source : '' }}
              </span>
            </div>
            <span v-if="isInstalled(v)" class="tag tag-success">{{ t('games.list.installed_tag') }}</span>
            <button class="btn btn-sm btn-ghost" :disabled="store.installing.has(v.id)" @click="openInstall(v)">
              {{
                store.installing.has(v.id)
                  ? t('games.list.downloading')
                  : isInstalled(v)
                    ? t('games.list.reinstall')
                    : t('games.list.install')
              }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <!-- 已安装区 -->
    <div v-else class="card installed-card">
      <div v-if="installingVersions.length" class="installing-block">
        <div v-for="id in installingVersions" :key="id" class="installed-row installing-row">
          <div class="inst-names">
            <span class="version-id">{{ id }}</span>
            <span class="muted">{{ t('games.installed.installing') }}</span>
          </div>
          <div v-if="versionProgress(id)" class="row-progress">
            <div class="row-bar">
              <div class="row-bar-fill" :style="{ width: Math.round(progressMono(versionProgress(id)) * 100) + '%' }"></div>
            </div>
            <span class="muted row-progress-text">
              {{ Math.round(progressMono(versionProgress(id)) * 100) }}%
              {{ versionProgress(id).speed ? '· ' + formatSpeed(versionProgress(id).speed) : '' }}
            </span>
          </div>
        </div>
      </div>

      <div
        v-for="id in [...store.failedInstalls].filter((x) => !installingVersions.includes(x))"
        :key="'fail-' + id"
        class="installed-row failed-row"
      >
        <div class="inst-names">
          <span class="version-id">{{ id }}</span>
          <span class="muted">{{ t('games.installed.failed') }}</span>
        </div>
        <button class="btn btn-ghost btn-sm installed-folder row-actions" @click="onRetry(id)">
          {{ t('games.installed.retry') }}
        </button>
      </div>

      <div class="installed-scope" data-ui="games:installed-scope">
        <span class="muted">{{ t('games.installed.scope') }}</span>
        <SelectMenu v-model="installedFolder" :options="installedFolderOptions" :aria-label="t('games.installed.scope_aria')" />
        <label class="installed-search"
          ><input
            v-model="installedSearch"
            class="input"
            :aria-label="t('games.installed.search_placeholder')"
            :placeholder="t('games.installed.search_placeholder')"
        /></label>
        <span class="muted scope-count">{{ t('games.installed.count', { count: String(sortedInstalled.length) }) }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="installedLoading" @click="refreshAllInstalled">
          {{ installedLoading ? t('games.installed.refreshing') : t('games.installed.refresh') }}
        </button>
      </div>
      <p v-if="installedError" class="error" role="alert">{{ installedError }}</p>
      <div class="version-category-bar" data-ui="games:category-filters">
        <div class="version-category-filters" role="group" :aria-label="t('games.installed.category_aria')">
          <button
            v-for="category in categoryFilters"
            :key="category.id"
            class="btn btn-ghost btn-sm"
            :class="{ active: installedCategory === category.id }"
            :aria-pressed="installedCategory === category.id"
            :data-category="category.id"
            @click="installedCategory = category.id"
          >
            {{ category.name }} <span class="category-count">{{ category.count }}</span>
          </button>
        </div>
        <button
          class="btn btn-ghost btn-sm"
          data-ui="games:categories-manage"
          :disabled="categoryBusy"
          @click="
            categoryError = '';
            categoryManagerOpen = true;
          "
        >
          {{ t('games.installed.manage_categories') }}
        </button>
      </div>
      <p v-if="categoryError && !categoryManagerOpen" class="error" role="alert">{{ categoryError }}</p>
      <div v-if="!sortedInstalled.length && !installingVersions.length" class="empty installed-empty">
        <span>{{
          installedLoading
            ? t('games.installed.empty_loading')
            : installedCategory === VERSION_CATEGORY_FAVORITES
              ? t('games.installed.empty_favorites')
              : installedCategory !== VERSION_CATEGORY_ALL
                ? t('games.installed.empty_category')
                : installedSearch
                  ? t('games.installed.empty_search')
                  : t('games.installed.empty')
        }}</span>
        <button
          v-if="installedCategory !== VERSION_CATEGORY_ALL"
          class="btn btn-ghost btn-sm"
          @click="installedCategory = VERSION_CATEGORY_ALL"
        >
          {{ t('games.installed.view_all') }}
        </button>
        <button v-else class="btn btn-gold btn-sm" @click="tab = 'download'">{{ t('games.installed.go_download') }}</button>
      </div>
      <div v-else class="installed-list">
        <div
          v-for="v in sortedInstalled"
          :key="v.folder + '/' + v.id"
          class="installed-row"
          @contextmenu.prevent="showFolderContextMenu(v.folder, v.id)"
        >
          <button
            class="fav-btn"
            :class="{ on: isFavorite(v.id, v.folder) }"
            :title="isFavorite(v.id, v.folder) ? t('games.instance.favorite_remove') : t('games.instance.favorite_add')"
            :aria-label="
              isFavorite(v.id, v.folder)
                ? t('games.instance.favorite_aria_remove', { name: displayVersionName(v) })
                : t('games.instance.favorite_aria_add', { name: displayVersionName(v) })
            "
            :aria-pressed="isFavorite(v.id, v.folder)"
            @click="toggleFavorite(v.id, v.folder)"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
              <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" />
            </svg>
          </button>
          <button class="inst-icon" :title="t('games.instance.change_icon')" @click="openIconPicker(v.id, v.folder)">
            <img v-if="versionIconUrl(v)" :src="versionIconUrl(v)" alt="" />
            <svg
              v-else
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 8 12 3 3 8v8l9 5 9-5Z" />
              <path d="m3 8 9 5 9-5" />
              <path d="M12 13v8" />
            </svg>
          </button>
          <div class="inst-names">
            <button
              class="version-id instance-name"
              :title="t('games.instance.rename_title', { name: displayVersionName(v) })"
              @click="openRenameFor(v.id, v.folder)"
            >
              {{ displayVersionName(v) }}
            </button>
            <div class="instance-meta">
              <span>{{ v.mcVersion || t('games.instance.meta.mc_unknown') }}</span
              ><span>{{ loaderLabel(v) }}</span>
              <span class="instance-directory" :title="v.folder">{{ folderShortName(v.folder) }}</span>
              <span v-if="categoryLabel(v)" class="instance-category" :title="categoryLabel(v)">{{ categoryLabel(v) }}</span>
              <span :title="v.gameDirectory || v.folder">{{ v.isolated ? t('games.instance.isolated') : t('games.instance.shared') }}</span>
              <span v-if="v.incomplete" class="error">{{ t('games.instance.incomplete') }}</span
              ><span v-else-if="v.failed" class="error">{{ t('games.instance.failed') }}</span>
              <span v-else-if="v.modpackName" :title="v.modpackName">{{ t('games.instance.modpack') }}</span>
            </div>
          </div>
          <div class="instance-commands">
            <div class="row-actions">
              <button class="btn btn-ghost btn-sm" @click="openInstanceCenter(v)">{{ t('games.instance.manage') }}</button>
              <button
                v-if="v.incomplete"
                class="btn btn-ghost btn-sm installed-launch"
                :disabled="store.installing.has(v.id)"
                @click="onRetry(v.id, v.folder)"
              >
                {{ t('games.instance.continue_download') }}
              </button>
              <button
                v-else
                class="btn btn-ghost btn-sm installed-launch"
                :disabled="
                  v.failed ||
                  instanceLaunchBusy(store.launchStates, v.id, v.folder ?? store.settings?.activeFolder ?? store.settings?.gameDir)
                "
                :title="v.failed ? t('games.instance.launch_disabled') : t('games.instance.launch_title', { name: displayVersionName(v) })"
                @click="launchVersion(v)"
              >
                {{ instanceLaunchBusy(store.launchStates, v.id, v.folder) ? t('games.instance.launching') : t('games.instance.launch') }}
              </button>
              <button
                class="btn btn-ghost btn-sm instance-more"
                :aria-label="t('games.instance.more_aria', { name: displayVersionName(v) })"
                :aria-expanded="manageMenu.id === v.id && manageMenu.folder === v.folder"
                @click="openManageMenu($event, v.id, v.folder)"
              >
                ⋯
              </button>
            </div>
            <span class="muted played-text">{{ t('games.instance.last_played', { time: fmtLastPlayed(store.lastPlayed[v.id]) }) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 管理快捷菜单 -->
    <Teleport to="body">
      <div v-if="manageMenu.id" class="menu-overlay" @click="manageMenu.id = ''"></div>
      <div
        v-if="manageMenu.id"
        class="float-menu instance-more-menu"
        role="dialog"
        aria-modal="true"
        :aria-label="t('games.menu.aria')"
        @keydown.esc.stop="closeManageMenu"
        @keydown="trapMenuFocus"
        :style="{ top: manageMenu.top + 'px', left: manageMenu.left + 'px', maxHeight: `calc(100vh - ${manageMenu.top + 12}px)` }"
      >
        <div v-if="menuVersion" class="instance-technical" tabindex="0">
          <strong>{{ displayVersionName(menuVersion) }}</strong
          ><span>{{ t('games.menu.id', { id: menuVersion.id }) }}</span
          ><span>{{ t('games.menu.bound_folder', { path: menuVersion.folder }) }}</span
          ><span>{{ t('games.menu.game_folder', { path: menuVersion.gameDirectory || menuVersion.folder }) }}</span>
        </div>
        <button
          v-if="menuVersion"
          class="menu-item"
          @click="
            openVersionFolder(menuVersion);
            closeManageMenu();
          "
        >
          {{ t('games.menu.open_folder') }}
        </button>
        <button
          v-if="menuVersion"
          class="menu-item"
          @click="
            openInstanceCenter(menuVersion);
            closeManageMenu();
          "
        >
          {{ t('games.menu.settings') }}
        </button>
        <label v-if="menuVersion" class="instance-category-field"
          >{{ t('games.menu.category_label')
          }}<select
            class="select"
            data-ui="games:instance-category"
            :aria-label="t('games.menu.category_aria', { name: displayVersionName(menuVersion) })"
            :value="categoryOf(menuVersion)"
            :disabled="categoryBusy"
            @change="assignCategory(menuVersion, $event)"
          >
            <option value="">{{ t('games.category.unclassified') }}</option>
            <option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option>
          </select></label
        >
        <p v-if="categoryError" class="error instance-category-error" role="alert">{{ categoryError }}</p>
        <label v-if="menuVersion && !menuVersion.modpackName && !menuVersion.incomplete && !menuVersion.failed" class="menu-item"
          ><input
            type="checkbox"
            :checked="!!menuVersion.isolated"
            :disabled="isoBusy === menuVersion.id"
            @change="onToggleIsolation(menuVersion, $event)"
          />{{ t('games.menu.isolation') }}</label
        >
        <button class="menu-item" @click="goManage('mods')">
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 8 12 3 3 8v8l9 5 9-5Z" />
            <path d="m3 8 9 5 9-5" />
            <path d="M12 13v8" />
          </svg>
          {{ t('games.menu.mods') }}
        </button>
        <button class="menu-item" @click="goManage('packs')">
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>
          {{ t('games.menu.packs') }}
        </button>
        <button class="menu-item" @click="goManage('shaders')">
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
          {{ t('games.menu.shaders') }}
        </button>
        <button class="menu-item" @click="openRename">
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            <path d="m15 5 4 4" />
          </svg>
          {{ t('games.menu.rename') }}
        </button>
        <button class="menu-item" @click="openIconPicker(manageMenu.id)">
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
          </svg>
          {{ t('games.menu.change_icon') }}
        </button>
        <button class="menu-item" @click="openThumbnailPicker(manageMenu.id)">
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="m3 16 5-5 4 4 3-3 6 6" />
            <circle cx="16.5" cy="8.5" r="1.5" />
          </svg>
          {{ t('games.menu.thumbnail') }}
        </button>
        <button class="menu-item" @click="openJavaModal">
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 8h1a3 3 0 0 1 0 6h-1M3 8h15v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <path d="M7 12h6M7 15h4" />
          </svg>
          {{ t('games.menu.java') }}
        </button>
        <button class="menu-item" @click="openResolutionModal">
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="4" width="18" height="14" rx="2" />
            <path d="M8 21h8M12 18v3" />
          </svg>
          {{ t('games.menu.window') }}
        </button>
        <div class="menu-danger-zone" v-if="menuVersion">
          <button
            v-if="menuVersion.failed"
            class="menu-item error"
            @click="
              onCleanup(menuVersion.id, menuVersion.folder);
              closeManageMenu();
            "
          >
            {{ t('games.menu.cleanup') }}
          </button>
          <button
            v-else
            class="menu-item error"
            @click="
              removeModal.target = menuVersion;
              removeModal.open = true;
              closeManageMenu();
            "
          >
            {{ t('games.menu.delete') }}
          </button>
        </div>
      </div>
    </Teleport>

    <VersionCategoriesPanel
      :open="categoryManagerOpen"
      :categories="categories"
      :counts="categoryCounts"
      :busy="categoryBusy"
      :error="categoryError"
      @close="categoryManagerOpen = false"
      @action="onCategoryAction"
    />

    <!-- 实例窗口设置 -->
    <Teleport to="body">
      <div v-if="resolutionModal.open" class="modal-mask" @pointerdown.self="resolutionModal.open = false">
        <div class="modal">
          <h3 class="modal-title">{{ t('games.modal.resolution_title', { id: resolutionModal.id }) }}</h3>
          <p class="modal-label">{{ t('games.modal.resolution_desc') }}</p>
          <select v-model="resolutionModal.mode" class="select">
            <option value="inherit">{{ t('games.modal.resolution_inherit') }}</option>
            <option value="windowed">{{ t('games.modal.resolution_windowed') }}</option>
            <option value="maximized">{{ t('games.modal.resolution_maximized') }}</option>
            <option value="fullscreen">{{ t('games.modal.resolution_fullscreen') }}</option>
          </select>
          <div class="instance-resolution-size">
            <label>
              <span class="muted">{{ t('games.modal.resolution_width') }}</span>
              <input
                v-model.number="resolutionModal.width"
                class="input"
                type="number"
                min="854"
                max="7680"
                :disabled="resolutionModal.mode !== 'windowed'"
              />
            </label>
            <span class="muted">×</span>
            <label>
              <span class="muted">{{ t('games.modal.resolution_height') }}</span>
              <input
                v-model.number="resolutionModal.height"
                class="input"
                type="number"
                min="480"
                max="4320"
                :disabled="resolutionModal.mode !== 'windowed'"
              />
            </label>
          </div>
          <p class="muted instance-resolution-tip">{{ t('games.modal.resolution_tip') }}</p>
          <p v-if="resolutionModal.error" class="loaders-error">{{ resolutionModal.error }}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" :disabled="resolutionModal.busy" @click="resolutionModal.open = false">
              {{ t('games.modal.cancel') }}
            </button>
            <button class="btn btn-gold" :disabled="resolutionModal.busy" @click="onConfirmResolution">
              {{ resolutionModal.busy ? t('games.modal.resolution_saving') : t('games.modal.resolution_save') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 指定 Java 弹窗 -->
    <Teleport to="body">
      <div v-if="javaModal.open" class="modal-mask" @pointerdown.self="javaModal.open = false">
        <div class="modal">
          <h3 class="modal-title">{{ t('games.modal.java_title', { id: javaModal.id }) }}</h3>
          <p class="modal-label">{{ t('games.modal.java_desc') }}</p>
          <div v-if="javaModal.busy" class="loaders-loading">
            <span class="spin"></span><span class="muted">{{ t('games.modal.java_loading') }}</span>
          </div>
          <template v-else>
            <select v-model="javaModal.value" class="select">
              <option value="">{{ t('games.modal.java_auto') }}</option>
              <option v-for="j in javaModal.list" :key="j.path" :value="j.path">
                {{
                  t('games.modal.java_entry', {
                    major: String(j.major),
                    source: j.source === 'manual' ? t('games.modal.java_source_manual') : t('games.modal.java_source_auto'),
                    path: j.path,
                  })
                }}
              </option>
            </select>
          </template>
          <div class="modal-actions">
            <button class="btn btn-ghost" @click="javaModal.open = false">{{ t('games.modal.cancel') }}</button>
            <button class="btn btn-gold" @click="onConfirmJava">{{ t('games.modal.java_ok') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 实例重命名弹窗 -->
    <Teleport to="body">
      <div v-if="renameModal.open" class="modal-mask" @pointerdown.self="renameModal.open = false">
        <div class="modal">
          <h3 class="modal-title">{{ t('games.modal.rename_title') }}</h3>
          <p class="modal-label">{{ t('games.modal.rename_desc') }}</p>
          <input v-model="renameModal.name" class="input mono" spellcheck="false" @keyup.enter="onConfirmRename" />
          <p v-if="renameModal.error" class="loaders-error">{{ renameModal.error }}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" @click="renameModal.open = false">{{ t('games.modal.cancel') }}</button>
            <button class="btn btn-gold" :disabled="renameModal.busy" @click="onConfirmRename">
              {{ renameModal.busy ? t('games.modal.rename_busy') : t('games.modal.rename_confirm') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 实例图标选择弹窗 -->
    <IconPickerModal
      :open="iconModal.open"
      :version-id="iconModal.id"
      :folder="iconModal.folder"
      :current-icon="iconModal.current"
      @close="iconModal.open = false"
    />

    <ThumbnailPickerModal
      :open="thumbnailModal.open"
      :version-id="thumbnailModal.id"
      :folder="thumbnailModal.folder"
      :current-path="thumbnailModal.current"
      :current-fit="thumbnailModal.fit"
      @close="thumbnailModal.open = false"
    />

    <!-- 游戏文件夹显示名称 -->
    <Teleport to="body">
      <div v-if="folderRename.open" class="modal-mask" @pointerdown.self="folderRename.open = false">
        <div class="modal">
          <h3 class="modal-title">{{ t('games.modal.folder_rename_title') }}</h3>
          <p class="modal-label">{{ t('games.modal.folder_rename_desc') }}</p>
          <input v-model="folderRename.name" class="input" maxlength="64" autofocus @keyup.enter="confirmFolderRename" />
          <p v-if="folderRename.error" class="loaders-error">{{ folderRename.error }}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" @click="folderRename.open = false">{{ t('games.modal.cancel') }}</button>
            <button class="btn btn-gold" :disabled="folderRename.busy" @click="confirmFolderRename">
              {{ folderRename.busy ? t('games.modal.folder_rename_saving') : t('games.modal.folder_rename_save') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <ConfirmModal
      :open="folderRemove.open"
      :title="t('games.confirm.folder_unbind_title')"
      :message="
        t('games.confirm.folder_unbind_message', {
          name: currentFolder?.name ?? '',
          path: activeFolder,
        })
      "
      :busy="folderRemove.busy"
      @cancel="folderRemove.open = false"
      @confirm="confirmFolderRemove"
    />

    <!-- 开启隔离前展示精确迁移范围 -->
    <Teleport to="body">
      <div v-if="isolationModal.open && isolationModal.plan" class="modal-mask" @pointerdown.self="closeIsolationModal">
        <div class="modal isolation-modal">
          <h3 class="modal-title">{{ t('games.iso.title', { id: isolationModal.target?.id ?? '' }) }}</h3>
          <p class="modal-label isolation-intro">{{ t('games.iso.intro') }}</p>
          <div class="isolation-paths">
            <span>{{ t('games.iso.source') }}</span
            ><code>{{ isolationModal.plan.source }}</code> <span>{{ t('games.iso.destination') }}</span
            ><code>{{ isolationModal.plan.destination }}</code>
          </div>
          <div class="isolation-summary">
            {{
              t('games.iso.summary', {
                items: String(isolationModal.plan.items.length),
                files: String(isolationModal.plan.totalFiles),
                size: fmtBytes(isolationModal.plan.totalBytes),
              })
            }}
          </div>
          <div class="isolation-items">
            <div v-for="item in isolationModal.plan.items" :key="item.name" class="isolation-item">
              <div>
                <strong>{{ item.name }}</strong>
                <span class="muted">{{
                  t('games.iso.item_detail', {
                    kind: item.kind === 'directory' ? t('games.iso.item_folder') : t('games.iso.item_file'),
                    files: String(item.files),
                    size: fmtBytes(item.bytes),
                  })
                }}</span>
              </div>
              <span v-if="isolationModal.plan.conflicts.includes(item.name)" class="tag tag-gold">{{ t('games.iso.conflict') }}</span>
              <span v-else class="tag">{{ t('games.iso.will_copy') }}</span>
            </div>
          </div>
          <p v-if="isolationModal.error" class="loaders-error">{{ isolationModal.error }}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" :disabled="isolationModal.busy" @click="closeIsolationModal">
              {{ t('games.modal.cancel') }}
            </button>
            <button class="btn btn-gold" :disabled="isolationModal.busy" @click="confirmIsolation">
              {{ isolationModal.busy ? t('games.iso.migrating') : t('games.iso.confirm') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 删除版本二次确认 -->
    <ConfirmModal
      :open="removeModal.open"
      :title="t('games.confirm.remove_title')"
      :message="t('games.confirm.remove_message', { id: removeModal.target?.id ?? '' })"
      :busy="removeModal.busy"
      @cancel="removeModal.open = false"
      @confirm="onConfirmRemove"
    />

    <!-- 安装模态框 -->
    <Teleport to="body">
      <div v-if="modal.open" class="modal-mask" @pointerdown.self="modal.open = false">
        <div
          class="modal game-install-modal"
          role="dialog"
          aria-modal="true"
          :aria-label="t('games.install.aria', { id: modal.version?.id ?? '' })"
        >
          <header class="install-header">
            <h3 class="modal-title">{{ t('games.install.title', { id: modal.version?.id ?? '' }) }}</h3>
            <button class="icon-btn" :aria-label="t('games.install.close')" data-modal-dismiss @click="modal.open = false">
              <UiGlyph name="close" />
            </button>
          </header>
          <p class="install-location muted" data-ui="download-location:install-target">
            <template v-if="modal.targetFolder">{{ t('games.install.target', { path: modal.targetFolder }) }}</template>
          </p>
          <div class="install-content">
            <p class="modal-label">{{ t('games.install.loader_label') }}</p>
            <div class="loader-options">
              <button
                v-for="opt in loaderOptions"
                :key="opt.value"
                class="loader-option"
                :class="{ active: modal.loader === opt.value }"
                :aria-pressed="modal.loader === opt.value"
                @click="modal.loader = opt.value"
              >
                <UiGlyph :name="opt.value || 'none'" :size="23" />{{ opt.label }}
              </button>
            </div>

            <template v-if="modal.loader">
              <p class="modal-label">{{ t('games.install.loader_version_label') }}</p>
              <div v-if="modal.loadingLoaders" class="loaders-loading" data-ui="install:loader-loading">
                <span class="spin"></span>
                <span class="muted">{{ t('games.install.loader_loading', { loader: modal.loader }) }}</span>
              </div>
              <template v-else>
                <select v-if="modal.loaderVersions.length" v-model="modal.loaderVersion" class="select" data-ui="install:loader-version">
                  <option v-for="lv in modal.loaderVersions" :key="lv" :value="lv">{{ lv }}</option>
                </select>
                <p v-if="modal.loadLoadersError" class="loaders-error" data-ui="install:loader-error">{{ modal.loadLoadersError }}</p>
              </template>

              <template v-if="modal.loader === 'fabric'">
                <label class="check-option fapi-head"
                  ><input v-model="modal.apiOn" type="checkbox" data-ui="install:fabric-api" /><span
                    ><strong>{{ t('games.install.fabric_api_title') }}</strong
                    ><small>{{ t('games.install.fabric_api_desc') }}</small></span
                  ></label
                >
                <template v-if="modal.apiOn">
                  <div v-if="modal.loadingApi" class="loaders-loading">
                    <span class="spin"></span>
                    <span class="muted">{{ t('games.install.fabric_api_loading') }}</span>
                  </div>
                  <template v-else>
                    <select v-if="modal.apiVersions.length" v-model="modal.apiVersion" class="select">
                      <option v-for="a in modal.apiVersions" :key="a.version" :value="a.version">
                        {{ a.version }}{{ a.date ? `（${formatDate(a.date)}）` : '' }}
                      </option>
                    </select>
                    <p v-if="modal.apiError" class="loaders-error">{{ modal.apiError }}</p>
                    <button v-if="modal.apiError" class="btn btn-ghost btn-sm" @click="apiRetry++">
                      {{ t('games.install.fabric_api_retry') }}
                    </button>
                    <p class="muted fapi-tip">
                      {{ modal.apiError ? t('games.install.fabric_api_tip_error') : t('games.install.fabric_api_tip_ok') }}
                    </p>
                  </template>
                </template>
              </template>
            </template>

            <RecordingModPicker v-model="modal.recordingMod" :mc="modal.version?.id || ''" :loader="modal.loader" />
            <FavoriteModsPicker
              v-model="modal.favoriteMods"
              v-model:intent="modal.favoriteInstallIntent"
              :mc="modal.version?.id || ''"
              :loader="modal.loader"
              @ready="favoritesReady = $event"
            />

            <p class="modal-label">{{ t('games.install.instance_label') }}</p>
            <input
              v-model="modal.instanceName"
              class="input mono"
              :placeholder="defaultInstanceName"
              spellcheck="false"
              @input="modal.instanceEdited = true"
            />
            <p v-if="instanceError" class="loaders-error">{{ instanceError }}</p>
            <p v-else class="muted inst-hint">
              {{ t('games.install.instance_hint', { name: effectiveInstanceName }) }}
            </p>
          </div>
          <footer class="modal-actions install-footer">
            <button class="btn btn-ghost" @click="modal.open = false">{{ t('games.modal.cancel') }}</button>
            <button class="btn btn-gold" :disabled="!canConfirm" @click="confirmInstall">
              <UiGlyph name="download" />{{ t('games.install.confirm') }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.version-category-bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.version-category-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.version-category-filters button {
  max-width: 100%;
  overflow-wrap: anywhere;
  white-space: normal;
}
.version-category-filters button.active {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--accent);
}
.category-count {
  opacity: 0.75;
  margin-left: 3px;
}
.instance-category {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
}
.instance-category-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  font-size: 13px;
}
.instance-category-field select {
  width: 100%;
  min-width: 0;
}
.instance-category-error {
  padding: 0 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .version-category-bar {
    flex-wrap: wrap;
  }
  .version-category-bar > button {
    margin-left: auto;
  }
}
.install-location {
  margin: 0;
  padding: 4px 24px 10px;
  overflow-wrap: anywhere;
  flex-shrink: 0;
  font-size: var(--text-sm);
}
.folder-location-hint {
  margin: var(--space-2) 0 0;
  line-height: 1.6;
}
.folder-managed-path {
  flex-basis: 100%;
  margin: 0;
  overflow-wrap: anywhere;
  font-size: var(--text-sm);
}
.game-install-modal {
  width: min(620px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-radius: 20px;
}
.install-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 24px 8px;
  flex-shrink: 0;
}
.install-header .modal-title {
  font-size: 26px;
  margin: 0;
}
.install-content {
  padding: 0 24px 20px;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
}
.install-footer {
  padding: 16px 24px;
  margin: 0 !important;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.install-footer .btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 42px;
  min-width: 116px;
  border-radius: 12px;
}
.game-install-modal .loader-options {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}
.game-install-modal .loader-option {
  flex-direction: column;
  gap: 6px;
  height: 72px;
  border-radius: 14px;
  padding: 10px 6px;
  font-size: 13px;
}
.game-install-modal .loader-option.active {
  box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 12%, transparent);
}
.game-install-modal .modal-label {
  font-size: 14px;
  margin: 20px 0 10px;
}
.game-install-modal .input,
.game-install-modal .select {
  min-height: 42px;
  border-radius: 12px;
  width: 100%;
}
.game-install-modal .fapi-head {
  justify-content: flex-start;
  align-items: flex-start;
  margin-top: 18px;
}
.game-install-modal .inst-hint {
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.game-install-modal :deep(.select-menu-btn) {
  min-height: 42px;
  border-radius: 12px;
}
.game-install-modal :deep(.recording-picker .modal-label) {
  font-size: 14px;
}
.game-install-modal .loaders-error {
  padding: 9px 12px;
  background: var(--danger-soft);
  border-radius: 9px;
  line-height: 1.5;
}
.game-install-modal .fapi-tip {
  line-height: 1.6;
}
@media (max-width: 520px) {
  .install-header {
    padding: 16px;
  }
  .install-header .modal-title {
    font-size: 22px;
  }
  .install-content {
    padding: 0 16px 16px;
  }
  .install-footer {
    padding: 12px 16px;
  }
  .game-install-modal .loader-options {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .game-install-modal .loader-option {
    height: 62px;
  }
}
.folder-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.folder-summary strong {
  display: flex;
  gap: 10px;
  align-items: center;
}
.folder-summary > .muted {
  font-size: 12px;
}
.installed-scope {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 0 20px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}
.installed-scope > div:first-child {
  flex: 1;
  min-width: 240px;
}
.installed-scope p {
  font-size: 12px;
  margin: 6px 0 0;
}
.installed-scope :deep(.select-menu-btn) {
  min-width: 220px;
  max-width: 420px;
  flex: 1;
}
.inst-path {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.catalog-status {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  margin-bottom: 12px;
}
.latest-release {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px;
  margin-bottom: 16px;
}
.latest-release > div {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  min-width: 0;
}
.latest-release strong {
  font-size: 24px;
}
.latest-release time {
  color: var(--text-dim);
  font-size: 13px;
}
.latest-release > button {
  flex-shrink: 0;
}

.page {
  display: flex;
  flex-direction: column;
  gap: var(--sec-gap);
  max-width: 940px;
  margin: 0 auto;
}

/* 游戏文件夹统一管理 */
.folder-manager {
  scroll-margin-top: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--card-pad);
}
.folder-manager-main {
  display: flex;
  align-items: flex-end;
  gap: var(--space-4);
}
.folder-shortcuts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.folder-select-wrap {
  display: grid;
  grid-template-columns: minmax(210px, 320px);
  gap: var(--space-2);
  min-width: 0;
}
.folder-caption {
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.folder-select {
  width: 100%;
}
.folder-current-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Consolas, monospace;
  font-size: var(--text-xs);
}
.folder-manager-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  flex: 1;
  flex-wrap: wrap;
}
/* 失效文件夹提示卡 */
.folder-missing-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  margin-top: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  flex-wrap: wrap;
}
.folder-missing-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.folder-missing-text strong {
  color: var(--danger);
  font-size: var(--text-sm);
}
.folder-missing-text .muted {
  font-size: var(--text-xs);
}
.folder-missing-actions {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}

.folder-scan-state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.folder-state-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--ok);
}
.folder-scan-state.warning .folder-state-dot {
  background: #e6a23c;
}
.folder-scan-state.error .folder-state-dot {
  background: var(--danger);
}
.folder-scan-error {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--danger);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 1120px) {
  .folder-manager-main {
    align-items: stretch;
    flex-direction: column;
  }
  .folder-select-wrap {
    grid-template-columns: minmax(0, 1fr);
  }
  .folder-manager-actions {
    justify-content: flex-start;
  }
}

/* 控制行：Tab 分段 + 工具（同一行，窄窗口自动换行） */
.game-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3) var(--space-4);
}
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  flex: 1 1 320px;
  min-width: 260px;
  justify-content: flex-end;
}
.tool-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 180px;
  height: var(--ctl-h);
  padding: 0 var(--space-3);
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card-2);
  color: var(--text-dim);
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}
.tool-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.tool-search svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.tool-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: var(--text-sm);
  font-family: inherit;
}
.tool-search input::placeholder {
  color: var(--text-dim);
  opacity: 0.75;
}

.filter-capsules {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.capsule {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--ctl-h);
  padding: 0 var(--space-4);
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card-2);
  color: var(--text-dim);
  font-size: var(--text-sm);
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    color 0.15s ease;
}
.capsule:hover {
  color: var(--text);
}
.capsule.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-2);
}
.tool-refresh {
  flex-shrink: 0;
}

/* 列表 */
.list-card {
  padding: var(--space-2);
}
.version-list {
  /* 不再限制高度——整页单条外滚动，消灭内层嵌套滚动 */
  display: flex;
  flex-direction: column;
}
.version-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--row-h);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  transition: background 0.15s ease;
}
.version-row:hover {
  background: var(--card-2);
}
.version-info {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.version-id {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.version-id.editable {
  cursor: pointer;
  border-bottom: 1px dashed transparent;
  transition:
    color 0.15s ease,
    border-color 0.15s ease;
}
.version-id.editable:hover {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
/* 实例图标按钮 */
.inst-icon {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card-2);
  color: var(--text-dim);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    transform 0.12s ease;
}
.inst-icon:hover {
  border-color: var(--accent);
  transform: scale(1.05);
}
.inst-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.version-date {
  font-size: var(--text-xs);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.version-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
}
.row-progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.row-bar {
  width: 90px;
  height: 6px;
  border-radius: 999px;
  background: var(--card-2);
  border: 1px solid var(--border);
  overflow: hidden;
}
.row-bar-fill {
  height: 100%;
  background: var(--accent-grad);
  transition: width 0.25s ease;
}
.row-progress-text {
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 已安装 */
.installed-empty {
  padding: var(--space-5);
}
.installed-list {
  display: flex;
  flex-direction: column;
}
.installed-row {
  display: flex;
  /* 名称和路径完整占据首行，标签与操作区位于下一行。 */
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--row-h);
  padding: var(--space-2) var(--space-1);
  border-radius: var(--radius-md);
  border-bottom: 1px solid var(--border);
}
.installed-row:hover {
  background: var(--hover);
}
.installed-row:last-child {
  border-bottom: none;
}
/* 实例名称（主名 + 技术 id 副标）：信息区可收缩，超长省略号（完整名在 tooltip） */
.inst-names {
  display: flex;
  flex: 1 1 calc(100% - 110px);
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  min-width: 0;
  flex-wrap: wrap;
}
.inst-sub {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  font-family: ui-monospace, Consolas, monospace;
  word-break: break-all;
}
.inst-names .version-id {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 元信息区（标签）：可收缩，省略号兜底，不挤压操作区 */
.installed-row > .tag {
  max-width: 200px;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.iso-switch {
  flex-shrink: 0;
  white-space: nowrap;
}
.mirror-toggle {
  cursor: pointer;
  user-select: none;
  transition:
    transform 0.12s ease,
    filter 0.15s ease;
}
.mirror-toggle:hover {
  filter: brightness(1.15);
}
.mirror-toggle:active {
  transform: scale(0.96);
}

/* 顶部 Tab 分段 */
.game-tabs {
  position: relative;
  display: inline-flex;
  gap: var(--space-1);
  padding: var(--space-1);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-2);
  flex-shrink: 0;
}
/* Indicator follows the active tab without spring overshoot. */
.game-tabs-blob {
  position: absolute;
  top: var(--space-1);
  bottom: var(--space-1);
  border-radius: 999px;
  background: var(--accent-grad);
  box-shadow: 0 2px 8px var(--accent-soft);
  transition:
    left var(--motion-normal) var(--ease-out),
    width var(--motion-normal) var(--ease-out),
    opacity 0.15s ease;
  pointer-events: none;
  z-index: 0;
}
.game-tab {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--space-5);
  height: var(--ctl-h);
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--text-sm);
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.2s ease;
}
.game-tab:hover {
  color: var(--text);
}
.game-tab.active {
  color: var(--on-accent);
}

/* 安装中/失败行 */
.installing-block {
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--space-1);
}
.failed-row .installed-folder {
  margin-left: auto;
}
.played-text {
  font-size: var(--text-xs);
  /* 元信息区可收缩省略，不再用 auto 外边距推右（操作区统一由 .row-actions 钉右） */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 行内操作区：隔离/文件夹/管理/启动/删除统一容器，钉右且永不换行 */
.row-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
  margin-left: auto;
}

/* 收藏星标按钮与分组标题 */
.fav-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    transform 0.12s ease;
}
.fav-btn:hover {
  color: var(--accent);
  background: var(--accent-soft);
}
.fav-btn.on {
  color: #f5b301;
}
.fav-btn:active {
  transform: scale(0.9);
}
.fav-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-1) var(--space-1);
  font-size: var(--text-xs);
  font-weight: 700;
  color: #f5b301;
}

/* 版本隔离开关 */
.iso-switch {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  cursor: pointer;
}
.iso-label {
  font-size: var(--text-xs);
}
.installed-remove {
  flex-shrink: 0;
  background: transparent;
  border-color: transparent;
}
.installed-remove:hover {
  border-color: var(--danger-border);
}

@media (max-width: 1180px) {
  .installed-row {
    flex-wrap: wrap;
    gap: 8px;
    padding-block: 12px;
  }
  .inst-names {
    flex-basis: calc(100% - 100px);
  }
  .row-actions {
    margin-left: auto;
  }
  .played-text {
    flex: 1;
  }
}

/* 模态框 */
.modal-title {
  font-size: var(--text-lg);
  font-weight: 700;
  margin: 0 0 var(--space-4);
}
.modal-label {
  font-size: var(--text-sm);
  color: var(--text-dim);
  margin: var(--space-4) 0 var(--space-2);
}
.loader-options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.loader-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--space-4);
  height: var(--ctl-h);
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card-2);
  color: var(--text);
  font-size: var(--text-sm);
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    color 0.15s ease;
}
.loader-option:hover {
  border-color: var(--text-dim);
}
.loader-option.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-2);
}
.loaders-loading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
}
.loaders-error {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--danger);
}
.inst-hint {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  line-height: 1.5;
}
/* Fabric API 联动区块 */
.fapi-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
.fapi-head .modal-label {
  margin: 0;
}
.fapi-switch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  font-size: var(--text-sm);
}
.fapi-tip {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
}
.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-5);
}
.instance-resolution-size {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
.instance-resolution-size label {
  display: grid;
  flex: 1;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-xs);
}
.instance-resolution-tip {
  margin-top: var(--space-3);
  font-size: var(--text-xs);
  line-height: 1.55;
}
.isolation-modal {
  width: min(620px, calc(100vw - 40px));
}
.isolation-intro {
  line-height: 1.65;
}
.isolation-paths {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: var(--space-2) var(--space-3);
  align-items: center;
  margin-top: var(--space-4);
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.isolation-paths code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.isolation-summary {
  margin-top: var(--space-4);
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.isolation-items {
  display: grid;
  gap: var(--space-2);
  max-height: 230px;
  margin-top: var(--space-2);
  overflow: auto;
}
.isolation-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card-2);
}
.isolation-item > div {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.isolation-item strong {
  font-size: var(--text-xs);
}
.isolation-item .muted {
  font-size: var(--text-xs);
}

/* Compact instance management, using the existing theme and spacing system. */
.page {
  max-width: 1240px;
  gap: 16px;
}
.page-head {
  margin-bottom: 0;
}
.page-sub {
  margin-bottom: 0;
}
.game-tabs {
  align-self: flex-start;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--hover);
}
.game-tabs-blob {
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  box-shadow: inset 0 -2px var(--accent);
}
.game-tab {
  height: 36px;
  padding: 0 20px;
  border-radius: var(--radius-sm);
}
.game-tab.active {
  color: var(--text);
}
.folder-manager {
  padding: 12px 16px;
  gap: 8px;
  border: 0;
  box-shadow: none;
  background: color-mix(in srgb, var(--card-solid, var(--card)) 75%, transparent);
}
.folder-manager-main {
  flex-direction: row;
  align-items: center;
  gap: 16px;
}
.folder-select-wrap {
  display: grid;
  flex: 1;
  grid-template-columns: auto minmax(160px, 320px) minmax(60px, 1fr);
  align-items: center;
  gap: 12px;
}
.folder-current-path {
  max-width: 100%;
}
.folder-tools-trigger {
  flex-shrink: 0;
}
.folder-manager-actions {
  flex: initial;
  justify-content: flex-start;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.folder-scan-error {
  margin: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.installed-card {
  padding: 0 16px;
  border: 0;
  box-shadow: none;
  background: color-mix(in srgb, var(--card-solid, var(--card)) 92%, transparent);
  border-radius: var(--radius-md);
}
.installed-scope {
  padding: 12px 0;
  margin: 0;
  gap: 12px;
  flex-wrap: wrap;
}
.installed-scope > div:first-child {
  flex: initial;
  min-width: 0;
}
.installed-scope :deep(.select-menu-btn) {
  min-width: 160px;
  max-width: 260px;
}
.installed-search {
  flex: 1;
  min-width: 160px;
}
.installed-search input {
  width: 100%;
}
.scope-count {
  font-size: 12px;
  white-space: nowrap;
}
.installed-row {
  flex-wrap: nowrap;
  gap: 12px;
  padding: 12px 0;
  border-radius: 0;
  min-height: 80px;
}
.installed-row:hover,
.installed-row:focus-within {
  background: var(--hover);
}
.inst-names {
  flex: 1 1 auto;
  gap: 8px;
}
.inst-names .instance-name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  white-space: normal;
  word-break: normal;
  overflow-wrap: normal;
  text-align: left;
  font: inherit;
  font-weight: 650;
  line-height: 1.4;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--text);
  cursor: pointer;
}
.instance-name:hover {
  color: var(--accent);
}
.inst-names .instance-name:focus-visible {
  -webkit-line-clamp: unset;
}
.instance-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.4;
}
.instance-meta > span {
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.instance-meta > span.error {
  color: var(--danger);
  font-weight: 600;
}
.instance-meta > span + span::before {
  content: '·';
  margin-right: 10px;
  opacity: 0.5;
}
.instance-commands {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.instance-commands .row-actions {
  gap: 8px;
}
.instance-more {
  min-width: 32px;
  padding: 0 8px;
  font-size: 20px;
}
.installed-launch {
  min-width: 78px;
}
.installed-row:hover .installed-launch:not(:disabled),
.installed-row:focus-within .installed-launch:not(:disabled) {
  color: var(--on-accent);
  background: var(--accent-grad);
  border-color: transparent;
}
.page button:focus-visible,
.instance-more-menu :is(button, input):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.fav-btn.on {
  color: var(--accent);
}
.instance-more-menu {
  width: 290px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  background: var(--card-solid, var(--card));
}
.instance-technical {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  font-size: 12px;
  color: var(--text-dim);
  overflow-wrap: anywhere;
  border-bottom: 1px solid var(--border);
}
.instance-technical strong {
  color: var(--text);
}
.menu-danger-zone {
  border-top: 1px solid var(--border);
  margin-top: 6px;
  padding-top: 6px;
}
.menu-danger-zone .menu-item {
  color: var(--danger);
}
@media (max-width: 1100px) {
  .folder-select-wrap {
    grid-template-columns: auto minmax(160px, 1fr);
  }
  .folder-current-path {
    grid-column: 1 / -1;
  }
  .installed-scope :deep(.select-menu-btn) {
    max-width: 220px;
  }
}
@media (max-width: 850px) {
  .folder-manager-main {
    align-items: flex-start;
    gap: 8px;
  }
  .folder-select-wrap {
    grid-template-columns: minmax(0, 1fr);
  }
  .folder-current-path {
    grid-column: auto;
  }
  .installed-row {
    display: grid;
    grid-template-columns: 28px 36px minmax(0, 1fr);
    gap: 8px;
  }
  .instance-commands {
    grid-column: 3;
    align-items: flex-start;
    flex-direction: row;
    flex-wrap: wrap;
  }
  .instance-commands .row-actions {
    margin-left: 0;
  }
  .installed-card {
    padding: 0 12px;
  }
  .scope-count {
    display: none;
  }
  .installed-search {
    flex-basis: 100%;
    order: 1;
  }
}
</style>
