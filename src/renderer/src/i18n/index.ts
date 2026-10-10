import { computed, ref, watch } from 'vue';
import { translate, setCurrentLocale, normalizeLocale, localeRevision, type LocaleId, allLocaleNames, isKnownLocale } from '@shared/i18n';
import { store } from '@renderer/store';
import { saveSettings } from '@renderer/api';

export { LOCALE_IDS, FALLBACK_LOCALE, normalizeLocale, hasKey } from '@shared/i18n';
export type { LocaleId } from '@shared/i18n';

export const locale = ref<LocaleId>('zh-CN');
// 渲染层 ref 是唯一真源，同步给共享层，主进程文案（toast/dialog）随之切换。
watch(locale, (v) => setCurrentLocale(v), { immediate: true });

// 词条内容版本号：插件通过 loadLocale() 注入新词条后，调用 bumpLocaleRevision()
// 驱动这里自增，使所有依赖 t() 的模板表达式重新求值（不依赖 locale 本身是否变化）。
const revision = ref(0);
export function bumpLocaleRevision(): void {
  revision.value = localeRevision();
}

export function t(key: string, params?: Record<string, string | number>) {
  // 读取 locale / revision 让模板 / computed 建立响应式依赖：
  // 语言切换、或插件动态注入词条后，文案都会立即重算。
  void locale.value;
  void revision.value;
  return translate(key, params);
}

export function setLocale(lang: string) {
  locale.value = (isKnownLocale(lang) ? lang : normalizeLocale(lang)) as LocaleId;
  setCurrentLocale(locale.value);
  void saveSettings({ locale: lang as LocaleId })
    .then((s) => {
      store.settings = s;
    })
    .catch(() => undefined);
}

export const $t = t;
export const langOptions = computed(() => {
  void revision.value;
  const names = allLocaleNames();
  return Object.entries(names).map(([value, label]) => ({ value, label }));
});
