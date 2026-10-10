// src/shared/locales/flatten.ts
/** 递归打平 locale JSON：{ a: { b: 'x' } } → { 'a.b': 'x' }；跳过 `_name`。 */
export function flattenLocale(obj: Record<string, unknown>, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    if (key === '_name') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenLocale(value as Record<string, unknown>, path, out);
    } else if (value != null) {
      out[path] = String(value);
    }
  }
  return out;
}
