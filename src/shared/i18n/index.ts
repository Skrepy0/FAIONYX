/**
 * 共享层 i18n 核心：主进程 / 渲染层 / 闪屏共用同一份词条与回退规则。
 * 渲染层通过 @renderer/i18n 包装成响应式 ref；主进程按持久化设置调用 setCurrentLocale。
 */
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

export type LocaleId = 'zh-CN' | 'en-US';

export const LOCALE_IDS: readonly LocaleId[] = ['zh-CN', 'en-US'];
export const FALLBACK_LOCALE: LocaleId = 'zh-CN';

const messages: Record<LocaleId, Record<string, string>> = {
  'zh-CN': zhCN as unknown as Record<string, string>,
  'en-US': enUS as unknown as Record<string, string>,
};

export function normalizeLocale(value: unknown): LocaleId {
  return value === 'en-US' ? 'en-US' : 'zh-CN';
}

let current: LocaleId = FALLBACK_LOCALE;

export function currentLocale(): LocaleId {
  return current;
}

export function setCurrentLocale(value: unknown): LocaleId {
  current = normalizeLocale(value);
  return current;
}

/** 取词：当前语言 → 回退语言 → 键名本身；{name} 占位由 params 替换。 */
export function translate(key: string, params?: Record<string, string | number>): string {
  const dict = messages[current] ?? messages[FALLBACK_LOCALE];
  let s = (dict[key] ?? messages[FALLBACK_LOCALE][key] ?? key) as string;
  for (const [k, v] of Object.entries(params ?? {})) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function hasKey(key: string): boolean {
  return Boolean(messages[current]?.[key] ?? messages[FALLBACK_LOCALE][key]);
}
