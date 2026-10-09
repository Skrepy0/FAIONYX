import { ref } from 'vue';
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';
import { store } from '@renderer/store';
import { saveSettings } from '@renderer/api';

const messages: Record<string, Record<string, string>> = {
  'zh-CN': zhCN as Record<string, string>,
  'en-US': enUS as Record<string, string>,
};
export const locale = ref('zh-CN');
export function t(key: string, params?: Record<string, string | number>) {
  const dict = messages[locale.value] ?? messages['zh-CN'];
  let s = dict[key] ?? messages['zh-CN'][key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) s = s.replace(`{${k}}`, String(v));
  return s;
}
export function setLocale(lang: string) {
  locale.value = lang;
  void saveSettings({ locale: lang })
    .then((s) => {
      store.settings = s;
    })
    .catch(() => undefined);
}
export const $t = t;
