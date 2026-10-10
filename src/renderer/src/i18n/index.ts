import { ref, watch } from 'vue';
import { translate, setCurrentLocale, normalizeLocale, type LocaleId } from '@shared/i18n';
import { store } from '@renderer/store';
import { saveSettings } from '@renderer/api';

export { LOCALE_IDS, FALLBACK_LOCALE, normalizeLocale, hasKey } from '@shared/i18n';
export type { LocaleId } from '@shared/i18n';

export const locale = ref<LocaleId>('zh-CN');
// 渲染层 ref 是唯一真源，同步给共享层，主进程文案（toast/dialog）随之切换。
watch(locale, (v) => setCurrentLocale(v), { immediate: true });
export function t(key: string, params?: Record<string, string | number>) {
  // 读取 locale 让模板 / computed 建立响应式依赖：语言切换后文案立即重算。
  void locale.value;
  return translate(key, params);
}
export function setLocale(lang: string) {
  locale.value = normalizeLocale(lang);
  setCurrentLocale(locale.value);
  void saveSettings({ locale: lang })
    .then((s) => {
      store.settings = s;
    })
    .catch(() => undefined);
}
export const $t = t;
