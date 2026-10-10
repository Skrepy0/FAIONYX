<script setup lang="ts">
import ContentSkeleton from '../components/ContentSkeleton.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { communityDownload, communityFiles, communitySearch, errText, getManifest, getModTargets } from '../api';
import { store, toast, selectedInstance, selectInstance, displayVersionName as versionLabel } from '../store';
import { instanceKey } from '@shared/modCompatibility';
import { communityFileMatchesInstance, usesCommunityLoader } from '@shared/communityPolicy';
import { mcmodSearchUrl } from '@shared/communityLinks';
import SelectMenu from '../components/SelectMenu.vue';
import CommunityVersionFilter from '../components/CommunityVersionFilter.vue';
import { readCommunitySession, saveCommunitySession } from '../communitySession';
const previousSession = readCommunitySession();
import MarqueeText from '../components/MarqueeText.vue';
import ModInstallDialog from '../components/ModInstallDialog.vue';
import CommunityFavorites from '../components/CommunityFavorites.vue';
import CommunityModDetails from '../components/CommunityModDetails.vue';
import { favorites, favoriteBusy, loadFavorites, toggleProject } from '../modFavorites';
onMounted(() => void loadFavorites());
import type { CommunityFile, CommunityKind, CommunityProjectReference, CommunityResult, CommunitySource, LoaderName } from '@shared/types';
import type { InstalledVersion } from '@shared/types';
import { t, locale } from '@renderer/i18n';

// ---------------- 资源外链（源页面 + MC 百科介绍） ----------------
/** CurseForge 的 URL 分类段（按当前搜索分类推断） */
const CF_KIND_SEGMENT: Record<CommunityKind, string> = {
  mod: 'mc-mods',
  modpack: 'modpacks',
  resourcepack: 'texture-packs',
  shader: 'shaders',
  datapack: 'data-packs',
};

/** 资源的源站网页链接（Modrinth/CurseForge） */
function sourceUrl(r: CommunityProjectReference, kind: CommunityKind = query.kind): string {
  if (r.source === 'modrinth') return `https://modrinth.com/project/${r.slug || r.projectId}`;
  return `https://www.curseforge.com/minecraft/${CF_KIND_SEGMENT[kind] ?? 'mc-mods'}/${r.slug || r.projectId}`;
}

function openMcmod(item: CommunityProjectReference) {
  const url = mcmodSearchUrl({ ...item, slug: item.slug ?? '' });
  if (url) openExternal(url);
  else toast(t('community.toast.no_english_name'), 'error');
}

function openExternal(url: string) {
  window.open(url, '_blank');
}
const currentInstance = selectedInstance;
const allTargets = ref<InstalledVersion[]>([]);
const modRequest = ref<{ target: InstalledVersion; input: { file: CommunityFile } } | null>(null);
const detailProject = ref<CommunityProjectReference | null>(null);
const communityTab = ref<'browse' | 'favorites'>(previousSession?.tab ?? 'browse');
const favoriteSearch = ref(previousSession?.favoriteSearch ?? '');
watch(communityTab, (tab) => {
  if (tab === 'browse') void nextTick(updateKindBlob);
});
function sectionKeyboard(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  communityTab.value =
    event.key === 'Home' ? 'browse' : event.key === 'End' ? 'favorites' : communityTab.value === 'browse' ? 'favorites' : 'browse';
  void nextTick(() => document.querySelector<HTMLElement>(`[data-ui="community:${communityTab.value}"]`)?.focus());
}

// ---------------- 搜索条件 ----------------
const PAGE_SIZE = 20;

const kindTabs = computed<Array<{ value: CommunityKind; label: string }>>(() => [
  { value: 'mod', label: t('community.kind.mod') },
  { value: 'modpack', label: t('community.kind.modpack') },
  { value: 'resourcepack', label: t('community.kind.resourcepack') },
  { value: 'shader', label: t('community.kind.shader') },
  { value: 'datapack', label: t('community.kind.datapack') },
]);

/** 类型筛选胶囊滑动指示块（与导航水滴/游戏 Tab 同款弹簧动效） */
const kindCapsules = ref<HTMLElement | null>(null);
const kindBlob = reactive({ left: 0, top: 0, width: 0, height: 0, on: false });
function updateKindBlob() {
  const root = kindCapsules.value;
  if (!root) return;
  const active = root.querySelector<HTMLElement>(`.capsule[data-kind="${query.kind}"]`);
  if (!active) return;
  kindBlob.left = active.offsetLeft;
  kindBlob.top = active.offsetTop;
  kindBlob.width = active.offsetWidth;
  kindBlob.height = active.offsetHeight;
  kindBlob.on = true;
}
// 字体、主题及换行会改变胶囊尺寸，分类切换以外也需要重算。
let kindBlobObserver: ResizeObserver | null = null;
onMounted(() => {
  nextTick(updateKindBlob);
  setTimeout(updateKindBlob, 200);
  kindBlobObserver = new ResizeObserver(() => updateKindBlob());
  watch(
    kindCapsules,
    (el) => {
      kindBlobObserver?.disconnect();
      if (el) kindBlobObserver?.observe(el);
    },
    { immediate: true }
  );
  // 主题切换改变配色/字体度量 → 重算
  watch(
    () => store.settings?.theme,
    () => nextTick(() => setTimeout(updateKindBlob, 60))
  );
});
onUnmounted(() => kindBlobObserver?.disconnect());
const kindBlobStyle = computed(() => ({
  left: kindBlob.left + 'px',
  top: kindBlob.top + 'px',
  width: kindBlob.width + 'px',
  height: kindBlob.height + 'px',
  opacity: kindBlob.on ? 1 : 0,
}));

const sourceOptions = computed<Array<{ value: 'all' | CommunitySource; label: string }>>(() => [
  { value: 'all', label: t('community.source.all') },
  { value: 'modrinth', label: 'Modrinth' },
  { value: 'curseforge', label: 'CurseForge' },
]);

const loaderOptions = computed<Array<{ value: '' | LoaderName; label: string }>>(() => [
  { value: '', label: t('community.loader.all') },
  { value: 'forge', label: 'Forge' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'neoforge', label: 'NeoForge' },
]);

/** 完整 MC 版本列表（与游戏下载页同一数据源：远程版本清单，正式版为主） */
const manifestVersions = ref<string[]>([]);
const manifestLoading = ref(false);

async function loadManifest() {
  if (manifestVersions.value.length || manifestLoading.value) return;
  manifestLoading.value = true;
  try {
    const list = await getManifest();
    manifestVersions.value = list.filter((v) => v.type === 'release').map((v) => v.id);
  } catch {
    /* 清单失败时回退到已安装版本 */
    const set = new Set<string>();
    for (const v of store.installed) if (v.mcVersion) set.add(v.mcVersion);
    manifestVersions.value = [...set].sort().reverse();
  } finally {
    manifestLoading.value = false;
  }
}

const versionInput = ref(previousSession?.versionInput ?? '');

onMounted(() => void loadManifest());

const query = reactive({
  keyword: '',
  kind: 'mod' as CommunityKind,
  source: 'all' as 'all' | CommunitySource,
  mcVersion: currentInstance.value?.mcVersion === t('community.unknown') ? '' : (currentInstance.value?.mcVersion ?? ''),
  loader: currentInstance.value?.loader ?? ('' as '' | LoaderName),
  sort: 'relevance' as 'relevance' | 'downloads' | 'newest',
});
if (previousSession) Object.assign(query, previousSession.query);
// query 必须先初始化。过早运行 getter 会抛错，导致监听未订阅分类变化。
watch(
  () => query.kind,
  () => nextTick(updateKindBlob),
  { flush: 'post' }
);
const supportsLoader = computed(() => usesCommunityLoader(query.kind));
const usesPagination = computed(() => !supportsLoader.value);

/** 排序选项 */
const sortOptions = computed(() => [
  { value: 'relevance', label: t('community.sort.relevance') },
  { value: 'downloads', label: t('community.sort.downloads') },
  { value: 'newest', label: t('community.sort.newest') },
]);

// ---------------- 搜索与列表 ----------------
const results = ref<CommunityResult[]>(previousSession?.results ?? []);
const loading = ref(false);
const loadingMore = ref(false);
const searched = ref(previousSession?.searched ?? false); // 是否已发起过搜索（区分初始空态）
const loadError = ref(previousSession?.error ?? '');
const offset = ref(previousSession?.offset ?? 0);
const hasMore = ref(previousSession?.hasMore ?? false);
const currentPage = ref(previousSession?.page ?? 1);
const totalResults = ref(previousSession?.total ?? 0);
const searchWarnings = ref<string[]>(previousSession?.warnings ?? []);
const totalPages = computed(() => Math.max(1, Math.ceil(totalResults.value / PAGE_SIZE)));
const visiblePages = computed(() => {
  const start = Math.max(1, Math.min(currentPage.value - 2, totalPages.value - 4));
  return Array.from({ length: Math.min(5, totalPages.value) }, (_, i) => start + i);
});
const listCard = ref<HTMLElement | null>(null);

let searchGeneration = 0;
let disposed = false;
onBeforeUnmount(() => {
  saveCommunitySession({
    query: { ...query },
    tab: communityTab.value,
    favoriteSearch: favoriteSearch.value,
    versionInput: versionInput.value,
    results: results.value,
    searched: searched.value,
    error: loadError.value,
    offset: offset.value,
    hasMore: hasMore.value,
    page: currentPage.value,
    total: totalResults.value,
    warnings: searchWarnings.value,
    scrollTop: document.querySelector<HTMLElement>('.content')?.scrollTop ?? 0,
    topKeyword: store.searchKeyword,
    interrupted: loading.value || loadingMore.value,
  });
  disposed = true;
  searchGeneration++;
  fileGeneration++;
  openGeneration++;
});
async function doSearch(reset: boolean, page = currentPage.value) {
  if (disposed) return;
  if (!reset && (loading.value || loadingMore.value)) return;
  const generation = ++searchGeneration;
  if (reset) {
    offset.value = 0;
    currentPage.value = 1;
    totalResults.value = 0;
    searchWarnings.value = [];
  }
  const paged = usesPagination.value;
  if (paged && !reset) currentPage.value = page;
  const requestedOffset = paged ? (currentPage.value - 1) * PAGE_SIZE : offset.value;
  const first = reset || paged;
  if (first) loading.value = true;
  else loadingMore.value = true;
  loadError.value = '';
  searched.value = true;
  try {
    const response = await communitySearch({
      keyword: query.keyword.trim(),
      kind: query.kind,
      source: query.source,
      mcVersion: query.mcVersion || undefined,
      loader: supportsLoader.value ? query.loader || undefined : undefined,
      sort: query.sort,
      offset: requestedOffset,
      limit: PAGE_SIZE,
    });
    if (generation !== searchGeneration) return;
    const list = response.items;
    if (first) results.value = list;
    else results.value = [...results.value, ...list];
    totalResults.value = response.total;
    searchWarnings.value = response.warnings ?? [];
    hasMore.value = requestedOffset + PAGE_SIZE < response.total;
    offset.value = requestedOffset + PAGE_SIZE;
  } catch (e) {
    if (generation !== searchGeneration) return;
    loadError.value = errText(e);
    if (!first) toast(t('community.error.load_failed', { e: loadError.value }), 'error');
  } finally {
    if (generation === searchGeneration) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

const onSearch = () => void doSearch(true);
const onLoadMore = () => void doSearch(false);
async function goToPage(page: number) {
  if (loading.value || page < 1 || page > totalPages.value || page === currentPage.value) return;
  await doSearch(false, page);
  listCard.value?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---------------- 无限滚动：列表底部哨兵进入视口即自动加载（保留按钮作兜底） ----------------
const moreSentinel = ref<HTMLElement | null>(null);
let moreObserver: IntersectionObserver | null = null;
onMounted(() => {
  moreObserver = new IntersectionObserver(
    (entries) => {
      if (
        communityTab.value === 'browse' &&
        !usesPagination.value &&
        entries.some((e) => e.isIntersecting) &&
        hasMore.value &&
        !loading.value &&
        !loadingMore.value
      ) {
        onLoadMore();
      }
    },
    { root: null, rootMargin: '240px', threshold: 0 }
  );
  watch(
    moreSentinel,
    (el) => {
      moreObserver?.disconnect();
      if (el) moreObserver?.observe(el);
    },
    { immediate: true }
  );
});
onUnmounted(() => {
  moreObserver?.disconnect();
  searchGeneration++;
  fileGeneration++;
  if (topSearchTimer) clearTimeout(topSearchTimer);
});
function useCurrentInstance() {
  query.mcVersion = currentInstance.value?.mcVersion === t('community.unknown') ? '' : (currentInstance.value?.mcVersion ?? '');
  query.loader = currentInstance.value?.loader ?? '';
  versionInput.value = query.mcVersion;
  onFilterChange();
}
versionInput.value = query.mcVersion;

/** 按具体实例筛选：选中实例即带入其 MC 版本与 Loader */
function useInstance(id: string) {
  const v = store.installed.find((x) => instanceKey(x) === id);
  if (!v) return;
  void selectInstance(v.id, v.folder);
  query.mcVersion = v.mcVersion === t('community.unknown') ? '' : v.mcVersion;
  query.loader = v.loader ?? '';
  versionInput.value = query.mcVersion;
  onFilterChange();
}

/** 切换条件后自动重新搜索 */
function onFilterChange() {
  if (communityTab.value === 'browse') void doSearch(true);
}

function onReset() {
  query.keyword = '';
  query.kind = 'mod';
  query.source = 'all';
  query.mcVersion = '';
  query.loader = '';
  query.sort = 'relevance';
  versionInput.value = '';
  void doSearch(true);
}

onMounted(async () => {
  // A route-local snapshot keeps the query, loaded pages and scroll without retaining DOM.
  const newKeyword = store.searchKeyword.trim();
  if (!previousSession || (newKeyword && newKeyword !== previousSession.topKeyword.trim())) {
    query.keyword = newKeyword;
    void doSearch(true);
  } else {
    await nextTick();
    const content = document.querySelector<HTMLElement>('.content');
    if (content) content.scrollTop = previousSession.scrollTop;
    if (previousSession.interrupted) loadError.value = t('community.status.interrupted');
  }
});

// ---------------- 顶栏搜索联动：顶栏输入防抖驱动社区搜索 ----------------
let topSearchTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => store.searchKeyword,
  (kw) => {
    if (topSearchTimer) clearTimeout(topSearchTimer);
    topSearchTimer = setTimeout(() => {
      if (communityTab.value === 'favorites') favoriteSearch.value = kw.trim();
      else {
        query.keyword = kw.trim();
        void doSearch(true);
      }
    }, 400);
  }
);

// ---------------- 列表展示 ----------------
/** 图标加载失败的项目（显示首字母占位） */
const brokenIcons = ref(new Set<string>());
const itemKey = (r: CommunityProjectReference) => `${r.source}:${r.projectId}`;
const onIconError = (r: CommunityResult) => {
  brokenIcons.value = new Set([...brokenIcons.value, itemKey(r)]);
};

/** 下载量格式化：zh-CN 用 亿/万，其余用 B/K */
const fmtDownloads = (n: number): string => {
  if (locale.value === 'zh-CN') {
    if (n >= 1e8) return (n / 1e8).toFixed(1) + t('community.downloads.billion');
    if (n >= 1e4) return (n / 1e4).toFixed(1) + t('community.downloads.myriad');
  } else {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  }
  return String(n);
};

const fmtDate = (iso: string): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US');
};

const fmtSize = (bytes: number): string => {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const releaseTagClass = (rt: CommunityFile['releaseType']) => (rt === 'beta' ? 'tag-cyan' : rt === 'alpha' ? 'tag-danger' : 'tag-gold');
const releaseText = (rt: CommunityFile['releaseType']): string => {
  if (rt === 'beta') return 'Beta';
  if (rt === 'alpha') return 'Alpha';
  return t('community.release.release');
};

// ---------------- 下载模态框 ----------------
const modal = reactive({
  open: false,
  item: null as CommunityProjectReference | null,
  kind: 'mod' as CommunityKind,
  files: [] as CommunityFile[],
  loadingFiles: false,
  filesError: '',
  fileId: '',
  versionId: '',
  mcVersion: '',
  loader: '' as LoaderName | '',
  downloading: false,
});

const isModpack = computed(() => modal.kind === 'modpack');
const selectedFile = computed(() => modal.files.find((f) => f.fileId === modal.fileId) ?? null);
const targetOptions = computed(() =>
  modal.kind === 'mod'
    ? allTargets.value.filter((v) => selectedFile.value && communityFileMatchesInstance(selectedFile.value, v))
    : store.installed
);
watch(targetOptions, (options) => {
  if (!options.some((v) => instanceKey(v) === modal.versionId)) {
    const selected = options.find((v) => v.id === currentInstance.value?.id && v.folder === currentInstance.value?.folder) ?? options[0];
    modal.versionId = selected ? instanceKey(selected) : '';
  }
});
let fileGeneration = 0,
  openGeneration = 0;
async function loadFiles() {
  if (!modal.item) return;
  const generation = ++fileGeneration,
    item = modal.item;
  modal.loadingFiles = true;
  modal.filesError = '';
  modal.files = [];
  modal.fileId = '';
  try {
    const files = await communityFiles(item.source, item.projectId, {
      kind: modal.kind,
      mcVersion: modal.mcVersion || undefined,
      loader: usesCommunityLoader(modal.kind) ? modal.loader || undefined : undefined,
    });
    if (generation !== fileGeneration || !modal.open) return;
    modal.files = files;
    modal.fileId = (files.find((f) => f.releaseType === 'release') ?? files[0])?.fileId ?? '';
    if (!files.length)
      modal.filesError = usesCommunityLoader(modal.kind)
        ? t('community.modal.no_file_with_loader')
        : t('community.modal.no_file_no_loader');
  } catch (e) {
    if (generation === fileGeneration) modal.filesError = t('community.modal.files_error', { e: errText(e) });
  } finally {
    if (generation === fileGeneration) modal.loadingFiles = false;
  }
}

async function openDownload(item: CommunityProjectReference, kind: CommunityKind = query.kind) {
  const generation = ++openGeneration;
  fileGeneration++;
  modal.open = true;
  modal.item = item;
  modal.kind = kind;
  modal.files = [];
  modal.loadingFiles = true;
  modal.filesError = '';
  modal.fileId = '';
  modal.versionId = currentInstance.value ? instanceKey(currentInstance.value) : '';
  modal.mcVersion = query.mcVersion;
  modal.loader = usesCommunityLoader(kind) ? query.loader : '';
  modal.downloading = false;
  try {
    const scanned = await getModTargets();
    if (disposed || generation !== openGeneration || !modal.open) return;
    allTargets.value = scanned.versions;
    if (scanned.errors.length) toast(t('community.toast.scan_errors', { errors: scanned.errors.join('; ') }), 'error');
    await loadFiles();
  } catch (e) {
    if (!disposed && generation === openGeneration) modal.filesError = t('community.modal.files_error', { e: errText(e) });
  } finally {
    if (generation === openGeneration) modal.loadingFiles = false;
  }
}

const canConfirm = computed(
  () => !!selectedFile.value && !modal.loadingFiles && !modal.downloading && (isModpack.value || !!modal.versionId)
);

async function confirmDownload() {
  const file = selectedFile.value;
  if (!file || !canConfirm.value) return;
  const target = targetOptions.value.find((v) => instanceKey(v) === modal.versionId);
  if (modal.kind === 'mod') {
    if (!target) return;
    modRequest.value = { target, input: { file } };
    return;
  }
  modal.downloading = true;
  try {
    const res = await communityDownload(file, {
      versionId: target?.id ?? '',
      kind: modal.kind,
    });
    modal.open = false;
    if (modal.kind === 'modpack') {
      toast(res || t('community.toast.modpack_started'), 'success');
    } else {
      toast(t('community.toast.download_saved', { path: String(res) }), 'success');
    }
  } catch (e) {
    toast(t('community.toast.download_failed', { e: errText(e) }), 'error');
  } finally {
    modal.downloading = false;
  }
}
function selectDownloadInstance() {
  const target = targetOptions.value.find((v) => instanceKey(v) === modal.versionId);
  if (target) void selectInstance(target.id, target.folder);
}
</script>

<template>
  <div data-ui="CommunityView:6e56fae5e7dd" class="page community-page" :data-design-page="query.kind">
    <!-- 标题 -->
    <div data-ui="CommunityView:9346ef73457d" class="page-head">
      <h1 data-ui="CommunityView:5476a5545de6" class="page-title">{{ t('community.title') }}</h1>
      <p data-ui="CommunityView:8ea54e89551b" class="page-sub">{{ t('community.subtitle') }}</p>
    </div>

    <div class="community-sections" role="tablist" :aria-label="t('community.section.aria')" @keydown="sectionKeyboard">
      <button
        class="community-section"
        role="tab"
        data-ui="community:browse"
        :tabindex="communityTab === 'browse' ? 0 : -1"
        :aria-selected="communityTab === 'browse'"
        :class="{ active: communityTab === 'browse' }"
        @click="communityTab = 'browse'"
      >
        {{ t('community.section.browse') }}</button
      ><button
        class="community-section"
        role="tab"
        data-ui="community:favorites"
        :tabindex="communityTab === 'favorites' ? 0 : -1"
        :aria-selected="communityTab === 'favorites'"
        :class="{ active: communityTab === 'favorites' }"
        @click="communityTab = 'favorites'"
      >
        {{ t('community.section.favorites') }} <span>{{ favorites.length }}</span>
      </button>
    </div>

    <div data-ui="CommunityView:f7acd66aeb10" class="filter-row instance-row">
      <label data-ui="CommunityView:34312978e030" class="instance-label">{{ t('community.filter.select_version') }}</label>
      <SelectMenu
        v-if="store.installed.length"
        class="filter-select instance-filter"
        :aria-label="t('community.filter.select_version_aria')"
        :model-value="currentInstance ? instanceKey(currentInstance) : ''"
        :placeholder="t('community.filter.placeholder')"
        :options="
          store.installed
            .filter((x) => !x.failed && !x.incomplete)
            .map((v) => ({
              value: instanceKey(v),
              label: versionLabel(v),
              description: [v.mcVersion, v.loader, v.folder].filter(Boolean).join(' · '),
            }))
        "
        @change="useInstance"
      />
      <button data-ui="CommunityView:49df26abb0c5" class="btn btn-ghost btn-sm" @click="useCurrentInstance">
        {{ t('community.filter.use_current') }}
      </button>
    </div>
    <CommunityFavorites
      v-if="communityTab === 'favorites'"
      :keyword="favoriteSearch"
      @download="openDownload($event, 'mod')"
      @details="detailProject = $event"
      @browse="
        communityTab = 'browse';
        query.kind = 'mod';
        onFilterChange();
      "
    />
    <template v-else>
      <!-- 搜索卡片 -->
      <div data-ui="CommunityView:5551ade589f2" class="card search-card">
        <div data-ui="CommunityView:cc7ad8d814fc" class="kind-capsules" ref="kindCapsules">
          <span data-ui="CommunityView:911176084f18" class="capsule-blob" :style="kindBlobStyle" aria-hidden="true"></span>
          <button
            data-ui="CommunityView:9275c1ee8bbc"
            v-for="tab in kindTabs"
            :key="tab.value"
            class="capsule"
            :data-kind="tab.value"
            :class="{ active: query.kind === tab.value }"
            @click="
              query.kind = tab.value;
              onFilterChange();
            "
          >
            {{ tab.label }}
          </button>
        </div>

        <div data-ui="CommunityView:d516b82f0eb8" class="search-row">
          <div class="search-input">
            <input
              data-ui="CommunityView:bc0450fd9c8f"
              v-model="query.keyword"
              class="input"
              :placeholder="query.kind === 'mod' ? t('community.search.placeholder_mod') : t('community.search.placeholder_other')"
              @keyup.enter="onSearch"
            />
            <button
              data-ui="CommunityView:ce39174e4563"
              class="search-go"
              :disabled="loading"
              :aria-label="loading ? t('community.search.searching') : t('community.search.search')"
              @click="onSearch"
            >
              <span v-if="loading" class="spin"></span>
              <svg
                v-else
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </button>
          </div>
          <button data-ui="CommunityView:15aecd36844d" class="btn btn-ghost btn-sm" :disabled="loading" @click="onReset">
            {{ t('community.search.reset') }}
          </button>
        </div>

        <div class="filter-row">
          <SelectMenu
            :aria-label="t('community.source.aria')"
            v-model="query.source"
            class="filter-select"
            :options="sourceOptions"
            @change="onFilterChange"
          />
          <CommunityVersionFilter
            v-model="query.mcVersion"
            :versions="manifestVersions"
            :loading="manifestLoading"
            @change="
              versionInput = query.mcVersion;
              onFilterChange();
            "
          />
          <SelectMenu
            :aria-label="t('community.loader.aria')"
            v-if="supportsLoader"
            v-model="query.loader"
            class="filter-select"
            :options="loaderOptions"
            @change="onFilterChange"
          />
          <SelectMenu
            :aria-label="t('community.sort.aria')"
            v-model="query.sort"
            class="filter-select"
            :options="sortOptions"
            @change="onFilterChange"
          />
        </div>
      </div>

      <!-- 结果列表 -->
      <div data-ui="CommunityView:5e55abba5e8a" ref="listCard" class="card list-card">
        <div data-ui="CommunityView:72423555b623" v-if="results.length && (loading || loadError)" class="status-strip" role="status">
          {{ loading ? t('community.status.refreshing') : t('community.status.refresh_failed', { e: loadError })
          }}<button data-ui="CommunityView:4ab4e45e43a0" v-if="loadError" class="btn btn-ghost btn-sm" @click="doSearch(true)">
            {{ t('community.status.retry') }}
          </button>
        </div>
        <p data-ui="CommunityView:fa2eef57b2fc" v-for="warning in searchWarnings" :key="warning" class="search-warning">{{ warning }}</p>
        <!-- 加载中 -->
        <ContentSkeleton
          v-if="loading && !results.length"
          :label="t('community.skeleton.searching')"
          :rows="6"
          retry
          @retry="doSearch(true)"
        />
        <!-- 错误态 -->
        <div data-ui="CommunityView:680f71022a3b" v-else-if="loadError && !results.length" class="empty">
          <span>{{ t('community.error.search_failed', { e: loadError }) }}</span>
          <button data-ui="CommunityView:dadfdac6acc0" class="btn btn-ghost btn-sm" @click="usesPagination ? doSearch(false) : onSearch()">
            {{ t('community.status.retry') }}
          </button>
        </div>
        <!-- 空态 -->
        <div data-ui="CommunityView:170233f26efe" v-else-if="!results.length" class="empty">
          <svg
            viewBox="0 0 24 24"
            width="40"
            height="40"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3a13.5 13.5 0 0 1 0 18" />
            <path d="M12 3a13.5 13.5 0 0 0 0 18" />
          </svg>
          <span>{{ searched ? t('community.empty.no_match') : t('community.empty.start') }}</span>
        </div>
        <!-- 列表 -->
        <template v-else>
          <div data-ui="CommunityView:ea58bb908a86" class="result-list" :inert="loading || !!loadError" :aria-busy="loading">
            <div data-ui="CommunityView:0d40e298da83" v-for="r in results" :key="itemKey(r)" class="result-card">
              <div data-ui="CommunityView:491b5f81c088" class="result-top">
                <div data-ui="CommunityView:00f58a1819fa" class="result-icon">
                  <img
                    data-ui="CommunityView:830997d3ecb7"
                    v-if="r.iconUrl && !brokenIcons.has(itemKey(r))"
                    :src="r.iconUrl"
                    alt=""
                    loading="lazy"
                    @error="onIconError(r)"
                  />
                  <span data-ui="CommunityView:a6c25e1efd38" v-else class="icon-placeholder">{{
                    (r.title || '?').charAt(0).toUpperCase()
                  }}</span>
                </div>
                <div data-ui="CommunityView:d33af84ab969" class="result-head">
                  <strong class="result-title" tabindex="0" :title="r.title">{{ r.title }}</strong>
                  <span data-ui="CommunityView:6f93851d6071" class="tag" :class="r.source === 'modrinth' ? 'tag-success' : 'tag-cf'">
                    {{
                      t('community.result.source_label', {
                        source: r.source === 'modrinth' ? t('community.result.source.modrinth') : t('community.result.source.curseforge'),
                      })
                    }}
                  </span>
                  <span data-ui="CommunityView:ad4b7d43f757" v-if="r.author" class="muted result-author">{{ r.author }}</span>
                </div>
              </div>
              <p data-ui="CommunityView:2c1a48d38ee1" class="result-desc" :title="r.description">
                {{ r.description || t('community.result.no_desc') }}
              </p>
              <div data-ui="CommunityView:b2d346eb1503" class="result-meta muted">
                <span>{{ t('community.result.downloads', { value: fmtDownloads(r.downloads) }) }}</span>
                <span data-ui="CommunityView:e69c45508563" class="meta-dot">·</span>
                <span>{{ t('community.result.updated_at', { date: fmtDate(r.updatedAt) }) }}</span>
              </div>
              <div data-ui="CommunityView:9195d6b103b6" class="result-foot">
                <div data-ui="CommunityView:22746f0aa9cd" class="result-links">
                  <button
                    data-ui="CommunityView:7c3533e67ba3"
                    class="icon-btn"
                    :title="
                      t('community.result.view_source_title', {
                        source: r.source === 'modrinth' ? t('community.result.source.modrinth') : t('community.result.source.curseforge'),
                      })
                    "
                    @click="openExternal(sourceUrl(r))"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <path d="M15 3h6v6" />
                      <path d="M10 14 21 3" />
                    </svg>
                  </button>
                  <button
                    data-ui="CommunityView:0c667bb024b0"
                    class="icon-btn"
                    :title="t('community.result.mcmod_title')"
                    @click="openMcmod(r)"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
                    </svg>
                  </button>
                  <button
                    v-if="query.kind === 'mod'"
                    class="icon-btn result-favorite"
                    :class="{ active: favorites.some((f) => f.key === itemKey(r)) }"
                    :aria-label="
                      favorites.some((f) => f.key === itemKey(r))
                        ? t('community.result.favorite.aria_remove', { title: r.title })
                        : t('community.result.favorite.aria_add', { title: r.title })
                    "
                    :aria-pressed="favorites.some((f) => f.key === itemKey(r))"
                    :title="
                      favorites.some((f) => f.key === itemKey(r))
                        ? t('community.result.favorite.title_remove')
                        : t('community.result.favorite.title_add')
                    "
                    :disabled="favoriteBusy.has(itemKey(r))"
                    @click.stop="toggleProject(r.source, r.projectId, r.title, r.iconUrl)"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      :fill="favorites.some((f) => f.key === itemKey(r)) ? 'currentColor' : 'none'"
                      stroke="currentColor"
                      stroke-width="1.7"
                      stroke-linejoin="round"
                    >
                      <path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z" />
                    </svg>
                  </button>
                </div>
                <button data-ui="CommunityView:6d17d47c8729" class="btn btn-gold btn-sm result-dl" @click="openDownload(r)">
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
                    <path d="M12 3v11" />
                    <path d="m7 10 5 5 5-5" />
                    <path d="M4 21h16" />
                  </svg>
                  {{ t('community.result.download') }}
                </button>
              </div>
            </div>
          </div>
          <!-- 无限滚动哨兵：进入视口自动加载更多（按钮保留作兜底） -->
          <div
            data-ui="CommunityView:1833f0867a9c"
            v-if="!usesPagination && hasMore && !loading && !loadError"
            ref="moreSentinel"
            class="more-sentinel"
          ></div>
          <!-- 加载更多 -->
          <div data-ui="CommunityView:c18472307641" v-if="!usesPagination && hasMore" class="more-row">
            <button data-ui="CommunityView:165371e35396" class="btn btn-ghost" :disabled="loadingMore" @click="onLoadMore">
              <span data-ui="CommunityView:6fa61ac3821a" v-if="loadingMore" class="spin"></span>
              {{ loadingMore ? t('community.more.loading') : t('community.more.load') }}
            </button>
          </div>
        </template>
        <nav
          data-ui="CommunityView:d47a3ad6ba73"
          v-if="usesPagination && searched && totalPages > 1"
          class="pagination"
          :aria-label="t('community.pagination.aria')"
        >
          <span class="muted">{{
            t('community.pagination.summary', {
              total: String(totalResults),
              page: String(currentPage),
              pages: String(totalPages),
            })
          }}</span>
          <button
            data-ui="CommunityView:391d4872befc"
            class="btn btn-ghost btn-sm"
            :disabled="loading || currentPage <= 1"
            @click="goToPage(currentPage - 1)"
          >
            {{ t('community.pagination.prev') }}
          </button>
          <button
            data-ui="CommunityView:79ac33e57fdc"
            v-for="page in visiblePages"
            :key="page"
            class="btn btn-sm"
            :class="page === currentPage ? 'btn-gold' : 'btn-ghost'"
            :aria-current="page === currentPage ? 'page' : undefined"
            :disabled="loading"
            @click="goToPage(page)"
          >
            {{ page }}
          </button>
          <button
            data-ui="CommunityView:2f9290893a14"
            class="btn btn-ghost btn-sm"
            :disabled="loading || currentPage >= totalPages"
            @click="goToPage(currentPage + 1)"
          >
            {{ t('community.pagination.next') }}
          </button>
        </nav>
      </div>
    </template>
    <!-- 下载模态框 -->
    <Teleport to="body">
      <div
        data-ui="CommunityView:ef88acc39749"
        v-if="modal.open"
        class="modal-mask"
        @pointerdown.self="!modal.downloading && (modal.open = false)"
      >
        <div data-ui="CommunityView:6904c547ed30" class="modal download-modal">
          <h3 data-ui="CommunityView:7b81ed690844" class="modal-title">
            <MarqueeText :text="t('community.modal.title_prefix', { title: modal.item?.title ?? '' })" />
          </h3>
          <div data-ui="CommunityView:a84b1e456827" v-if="modal.item" class="modal-links">
            <button
              v-if="modal.kind === 'mod'"
              class="btn btn-ghost btn-sm"
              :disabled="favoriteBusy.has(itemKey(modal.item))"
              :aria-pressed="favorites.some((f) => f.key === itemKey(modal.item!))"
              @click="toggleProject(modal.item.source, modal.item.projectId, modal.item.title, modal.item.iconUrl)"
            >
              {{
                favorites.some((f) => f.key === itemKey(modal.item!))
                  ? t('community.modal.favorite.added')
                  : t('community.modal.favorite.add')
              }}
            </button>
            <button
              data-ui="CommunityView:6fabba70cd3a"
              class="btn btn-ghost btn-sm"
              @click="openExternal(sourceUrl(modal.item, modal.kind))"
            >
              {{ modal.item.source === 'modrinth' ? t('community.modal.source.modrinth') : t('community.modal.source.curseforge') }}
            </button>
            <button data-ui="CommunityView:03eb0c52ad3e" class="btn btn-ghost btn-sm" @click="openMcmod(modal.item)">
              {{ t('community.modal.mcmod') }}
            </button>
          </div>
          <div class="filter-row">
            <label data-ui="CommunityView:9b7baa1d1a72" class="modal-field"
              >{{ t('community.modal.mc_version')
              }}<input
                data-ui="CommunityView:75b46121b566"
                v-model="modal.mcVersion"
                class="input"
                list="mod-minecraft-versions"
                :placeholder="t('community.modal.all_versions')"
                @change="loadFiles"
            /></label>
            <label data-ui="CommunityView:73416dae43e4" v-if="usesCommunityLoader(modal.kind)" class="modal-field"
              >{{ t('community.modal.loader') }}<SelectMenu v-model="modal.loader" :options="loaderOptions" @change="loadFiles"
            /></label>
            <datalist data-ui="CommunityView:3ea5bc9c8890" id="mod-minecraft-versions">
              <option v-for="v in manifestVersions" :key="v" :value="v" />
            </datalist>
          </div>

          <p class="modal-label">{{ t('community.modal.files_label') }}</p>
          <div data-ui="CommunityView:8f95d8f66a15" v-if="modal.loadingFiles" class="files-loading">
            <span data-ui="CommunityView:8941adbc1d4f" class="spin"></span>
            <span class="muted">{{ t('community.modal.files_loading') }}</span>
          </div>
          <template v-else>
            <div data-ui="CommunityView:db1154820afe" v-if="modal.files.length" class="file-list">
              <button
                data-ui="CommunityView:ceffac990295"
                v-for="f in modal.files"
                :key="f.fileId"
                class="file-row"
                :class="{ active: modal.fileId === f.fileId }"
                @click="modal.fileId = f.fileId"
              >
                <span data-ui="CommunityView:05bff2e14ac9" class="file-main">
                  <span data-ui="CommunityView:3906a840cd50" class="file-name" :title="f.fileName">{{ f.fileName }}</span>
                  <span data-ui="CommunityView:a7eecc7757d6" class="file-sub"
                    >{{ t('community.modal.file_version', { version: f.version }) }} ·
                    {{ t('community.modal.file_mc', { versions: f.gameVersions.join(' / ') })
                    }}<template v-if="usesCommunityLoader(modal.kind) && f.loaders.length"> · {{ f.loaders.join(' / ') }}</template></span
                  >
                </span>
                <span data-ui="CommunityView:9584cb689677" class="file-side">
                  <span data-ui="CommunityView:44e7a728a5f3" class="tag" :class="releaseTagClass(f.releaseType)">{{
                    releaseText(f.releaseType)
                  }}</span>
                  <span data-ui="CommunityView:32e67d25368a" class="muted file-meta">{{ fmtDate(f.date) }} · {{ fmtSize(f.size) }}</span>
                </span>
              </button>
            </div>
            <p data-ui="CommunityView:579adeba801a" v-if="modal.filesError" class="files-error">{{ modal.filesError }}</p>
          </template>

          <!-- 目标版本（整合包安装即新实例，无需选择） -->
          <template v-if="!isModpack">
            <p class="modal-label">{{ t('community.modal.target_label') }}</p>
            <SelectMenu
              v-if="targetOptions.length"
              v-model="modal.versionId"
              :options="
                targetOptions.map((v) => ({
                  value: instanceKey(v),
                  label: v.id + ' · ' + v.mcVersion + ' / ' + (v.loader || 'Vanilla') + ' · ' + v.folder,
                }))
              "
              @change="selectDownloadInstance"
            />
            <p data-ui="CommunityView:ab12acbb18fe" v-else class="files-error">
              {{ t('community.modal.no_compatible') }}
            </p>
          </template>
          <p data-ui="CommunityView:a8e08b82f315" v-else class="muted pack-tip">{{ t('community.modal.pack_tip') }}</p>

          <div data-ui="CommunityView:2356b94bbc0d" class="modal-actions">
            <button data-ui="CommunityView:989d28842ec5" class="btn btn-ghost" :disabled="modal.downloading" @click="modal.open = false">
              {{ t('community.modal.cancel') }}
            </button>
            <button data-ui="CommunityView:cade5c4fc83a" class="btn btn-gold" :disabled="!canConfirm" @click="confirmDownload">
              <span data-ui="CommunityView:d3c64175bb8e" v-if="modal.downloading" class="spin"></span>
              {{ modal.downloading ? t('community.modal.downloading') : t('community.modal.confirm') }}
            </button>
          </div>
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
        modal.open = false;
      "
    />
    <CommunityModDetails
      v-if="detailProject"
      :reference="detailProject"
      @close="detailProject = null"
      @download="
        detailProject = null;
        openDownload($event, 'mod');
      "
    />
  </div>
</template>

<style scoped>
/* 样式未改动，沿用原文件 */
.community-sections {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px;
  background: var(--card-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  align-self: flex-start;
}
.community-section {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 36px;
  border: 0;
  border-radius: var(--radius-sm);
  padding: 0 16px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    background 160ms,
    color 160ms;
}
.community-section.active {
  background: var(--accent-soft);
  color: var(--accent-2);
  font-weight: 600;
}
.community-section span {
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  background: var(--card);
  border-radius: 6px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.community-section:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.instance-row {
  align-items: baseline;
}
.instance-label {
  align-self: baseline;
  line-height: 1.4;
  white-space: nowrap;
}
.page {
  display: flex;
  flex-direction: column;
  gap: var(--sec-gap);
  max-width: 940px;
  margin: 0 auto;
}

.search-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.search-row {
  display: flex;
  gap: var(--space-3);
  align-items: center;
}

.search-input {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
}

.search-input .input {
  flex: 1;
  min-width: 0;
  padding-right: 40px;
}

.search-go {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: calc(var(--radius-sm, 6px) - 1px);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition:
    background 140ms ease,
    color 140ms ease;
}

.search-go:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text);
}

.search-go:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.search-go:disabled {
  cursor: default;
  color: var(--text-dim);
  opacity: 0.7;
}

.kind-capsules {
  position: relative;
  display: flex;
  gap: 2px;
  flex-wrap: wrap;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-2);
  width: fit-content;
}
.capsule-blob {
  position: absolute;
  border-radius: 999px;
  background: var(--accent-grad);
  box-shadow: 0 2px 8px var(--accent-soft);
  transition:
    left var(--motion-normal) var(--ease-out),
    top var(--motion-normal) var(--ease-out),
    width var(--motion-normal) var(--ease-out),
    height 0.32s ease,
    opacity 0.15s ease;
  pointer-events: none;
  z-index: 0;
}
.capsule {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: calc(var(--ctl-h) - 6px);
  padding: 0 var(--space-4);
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--text-sm);
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.2s ease;
}
.capsule:hover {
  color: var(--text);
}
.capsule.active {
  color: var(--on-accent);
  font-weight: 600;
}

.filter-row {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}
:deep(.filter-select) {
  width: auto;
  flex: 1;
  min-width: 140px;
}

.list-card {
  padding: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
}
.pagination {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) 0 var(--space-2);
}
.search-warning {
  color: var(--text-dim);
  font-size: var(--text-xs);
  padding: var(--space-2);
}
.result-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
  gap: var(--space-3);
}
.result-list[inert] {
  opacity: 0.45;
  filter: saturate(0.55);
  cursor: progress;
  user-select: none;
  transition:
    opacity var(--motion-fast, 160ms) ease,
    filter var(--motion-fast, 160ms) ease;
  pointer-events: none;
}

.result-list[inert] .result-card:hover {
  border-color: var(--border);
  box-shadow: none;
}
.result-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  transition:
    border-color var(--motion-fast) ease,
    box-shadow var(--motion-normal) ease;
  animation: community-card-in var(--motion-enter) var(--ease-out) backwards;
}
@keyframes community-card-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.result-card:hover {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  box-shadow: var(--shadow);
}

.result-top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.result-icon {
  width: 46px;
  height: 46px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--card);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 8%, transparent);
}
.result-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.icon-placeholder {
  font-size: var(--text-lg);
  font-weight: 700;
  color: var(--text-dim);
}

.result-head {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.result-title {
  flex: 1 1 100%;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  line-height: 1.45;
  font-weight: 650;
  font-size: var(--text-md);
}
.tag-cf {
  background: color-mix(in srgb, #f97316 12%, transparent);
  color: #f97316;
}
.result-author {
  font-size: var(--text-xs);
  min-width: 0;
}
.result-desc {
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--text-dim);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: calc(var(--text-xs) * 1.6 * 2);
}
.result-meta {
  font-size: var(--text-xs);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: auto;
}
.meta-dot {
  opacity: 0.6;
}
.result-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
}
.result-links {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}
.result-favorite.active {
  color: var(--accent-2);
  background: var(--accent-soft);
}
.result-favorite:disabled {
  opacity: 0.55;
  cursor: wait;
}
.modal-links {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.result-dl {
  flex-shrink: 0;
}

.more-row {
  display: flex;
  justify-content: center;
  padding: var(--space-4) 0 var(--space-2);
}

.download-modal {
  width: min(740px, calc(100vw - 40px));
  max-height: 88vh;
  overflow-y: auto;
}
.modal-field {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.modal-title {
  font-size: var(--text-lg);
  font-weight: 700;
  margin: 0 0 var(--space-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.modal-label {
  font-size: var(--text-sm);
  color: var(--text-dim);
  margin: var(--space-4) 0 var(--space-2);
}
.files-loading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) 0;
}
.file-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 280px;
  overflow-y: auto;
  padding: var(--space-1) var(--space-1) var(--space-1) 0;
}
.file-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    background 0.16s ease,
    transform 0.16s ease,
    box-shadow 0.2s ease;
}
.file-row:hover {
  background: var(--hover);
  border-color: var(--border-strong);
  transform: translateY(-1px);
}
.file-row.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  box-shadow:
    inset 0 0 0 1px var(--accent),
    0 4px 14px var(--accent-soft);
}
.file-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 650;
  font-size: var(--text-sm);
  font-family: ui-monospace, Consolas, monospace;
}
.file-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.file-side {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.file-meta {
  font-size: var(--text-xs);
  white-space: nowrap;
}
.files-error {
  font-size: var(--text-sm);
  color: var(--danger);
  padding: var(--space-1) 0;
}
.pack-tip {
  font-size: var(--text-sm);
  margin: var(--space-4) 0 0;
}
.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-5);
}
.search-card {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.search-row {
  margin: 0;
}
.instance-row {
  margin: 0;
  padding: 0;
  justify-content: flex-end;
}
.instance-row .instance-filter {
  max-width: 420px;
}
.filter-row {
  gap: 12px;
}
.result-list {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  gap: 16px;
}
.result-card {
  box-shadow: none;
  padding: 16px;
  min-width: 0;
}
.result-title {
  font-size: 16px;
  line-height: 1.45;
  white-space: normal;
  word-break: normal;
  overflow-wrap: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  max-height: none;
  min-height: 0;
}
.result-head {
  min-width: 0;
  gap: 6px;
}
.result-desc {
  line-height: 1.6;
  min-height: 3.2em;
  -webkit-line-clamp: 2;
}
.result-head .tag {
  font-size: 11px;
  background: var(--card-2);
  color: var(--text-dim);
  border: 0;
}
.result-links .icon-btn {
  width: 34px;
  height: 34px;
}
.result-foot {
  gap: 12px;
}
.result-author {
  font-size: 12px;
}
.result-meta {
  font-size: 12px;
}
.capsule {
  border: 0 !important;
}
.capsule-blob {
  background: var(--accent-soft) !important;
  box-shadow: none !important;
}
@media (max-width: 800px) {
  .instance-row {
    flex-wrap: wrap;
  }
  .instance-row .instance-filter {
    max-width: none;
    width: 100%;
  }
  .search-card {
    padding: 12px;
  }
}
.community-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px !important;
}
.community-page > .page-head {
  margin: 0;
}
.community-page > .instance-row {
  justify-content: flex-start;
}
.community-page .search-card {
  margin: 0;
}
.community-page .kind-capsules {
  margin: 0;
  border-bottom: 1px solid var(--border);
}
.community-page .search-card .filter-row {
  margin: 0;
}
.community-page .result-title {
  font-size: 16px;
}
@media (min-width: 1450px) {
  .community-page {
    grid-template-columns: minmax(0, 1fr) minmax(360px, 1fr);
  }
  .community-page > .instance-row {
    justify-content: flex-end;
  }
  .community-page > .search-card,
  .community-page > .card,
  .community-page > .status-strip {
    grid-column: 1/-1;
  }
}

.community-page .capsule.active {
  color: var(--text);
  background: var(--accent-soft);
  text-shadow: none;
}
.status-strip {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 10px 14px;
  margin-bottom: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-2);
  color: var(--text-dim);
  font-size: var(--text-sm);
  line-height: 1.5;
}

.status-strip[role='status'] {
  border-left: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, var(--card-2));
  color: var(--text);
  animation: status-pulse 1.6s ease-in-out infinite;
}

@keyframes status-pulse {
  0%,
  100% {
    border-left-color: var(--accent);
  }
  50% {
    border-left-color: transparent;
  }
}

.status-strip .btn {
  margin-left: auto;
  flex-shrink: 0;
}
</style>
