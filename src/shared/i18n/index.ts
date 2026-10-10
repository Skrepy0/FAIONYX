/**
 * 共享层 i18n 核心：主进程 / 渲染层 / 闪屏共用同一份词条与回退规则。  
 * 语言列表与词条由 `locales/index.ts`（脚本生成）提供；  
 * 新增语言只需往 locales/ 里丢一个 JSON，然后跑一次生成脚本。  
 *
 * 运行时覆盖层（runtimeOverrides）：供插件通过 loadLocale() 注入/覆盖词条，  
 * 不改动生成文件，叠加在 MESSAGES 之上，优先级高于内置词条。  
 */
import { FALLBACK_LOCALE, LOCALE_IDS, LOCALE_NAMES, MESSAGES, type LocaleId } from './locales';

export type { LocaleId };
export { FALLBACK_LOCALE, LOCALE_IDS, LOCALE_NAMES };

/** 判断值是否是已注册的语言。 */
export function isLocaleId(value: unknown): value is LocaleId {
  return typeof value === 'string' && (LOCALE_IDS as readonly string[]).includes(value);
}

/** 未注册的值一律回退到 fallback，避免脏数据把界面搞成 key 裸奔。 */
export function normalizeLocale(value: unknown): LocaleId {
  return isLocaleId(value) ? value : FALLBACK_LOCALE;
}

let current: LocaleId = FALLBACK_LOCALE;

export function currentLocale(): LocaleId {
  return current;
}

/** 主进程 / 闪屏用：读持久化设置后调一次即可；渲染层不用手动调。 */
export function setCurrentLocale(value: unknown): LocaleId | string {
  current = (isKnownLocale(value) ? (value as string) : normalizeLocale(value)) as LocaleId;
  return current;
}

// ---------------- 插件运行时覆盖层 ----------------

/** key 允许任意字符串（插件可注册 LOCALE_IDS 之外的全新语言），value 为扁平词条表。 */
const runtimeOverrides: Partial<Record<string, Record<string, string>>> = {};

/** 每次注入成功自增，供渲染层做响应式依赖，驱动 t() 重新求值。 */
let revision = 0;

export function localeRevision(): number {
  return revision;
}
const pluginLocaleNames: Record<string, string> = {};
export function flattenDeep(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> | null {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sub = flattenDeep(v, key, out);
      if (!sub) return null; // 嵌套里有数组之类非法值，整体判失败
    } else if (typeof v === 'string') {
      out[key] = v;
    } else {
      return null; // 叶子值既不是字符串也不是对象（比如数字/布尔），判失败
    }
  }
  return out;
}
/**
 * @param displayName 可选，插件给这个语言 id 起的展示名（下拉框里显示的文字）。  
 *                    同一 id 多次调用，以最后一次传入的非空 displayName 为准。  
 */
export function mergeLocaleMessages(id: string, dict: Record<string, string>, displayName?: string): boolean {
  if (!id || typeof dict !== 'object' || dict === null) return false;
  runtimeOverrides[id] = { ...(runtimeOverrides[id] ?? {}), ...dict };
  if (displayName) pluginLocaleNames[id] = displayName;
  else pluginLocaleNames[id] = dict['_name'];
  revision++;
  return true;
}

/** 内置语言名 + 插件注册语言名的合并结果，按需暴露给渲染层拼 langOptions。 */
export function allLocaleNames(): Record<string, string> {
  return { ...LOCALE_NAMES, ...pluginLocaleNames };
}

/** 内置语言 id + 插件注册语言 id 的合并列表，顺序：内置在前，插件新增在后。 */
export function allLocaleIds(): string[] {
  return [...LOCALE_IDS, ...Object.keys(pluginLocaleNames).filter((id) => !(LOCALE_IDS as readonly string[]).includes(id))];
}

/** 取词：运行时覆盖 → 当前语言 → 回退语言 → 键名本身；{name} 占位由 params 替换。 */
export function translate(key: string, params?: Record<string, string | number>): string {
  const base = MESSAGES[current] ?? MESSAGES[FALLBACK_LOCALE];
  const overlay = runtimeOverrides[current];
  let s = overlay?.[key] ?? base[key] ?? MESSAGES[FALLBACK_LOCALE][key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function hasKey(key: string): boolean {
  return Boolean(runtimeOverrides[current]?.[key] ?? MESSAGES[current]?.[key] ?? MESSAGES[FALLBACK_LOCALE][key]);
}
/** 内置语言 + 插件通过 mergeLocaleMessages 注册的语言，都算合法可切换语言。 */
export function isKnownLocale(value: unknown): value is string {
  return typeof value === 'string' && allLocaleIds().includes(value);
}
