/** Stable keys keep image selection and timing independent of bundled asset hashes. */
export const BUILTIN_LAUNCH_IMAGES = [
  { key: 'builtin:end', title: '解放末地!', file: 'end.webp' },
  { key: 'builtin:group_photo', title: '社团合影', file: 'group_photo.webp' },
  { key: 'builtin:landscape', title: '生存乐事风景', file: 'landscape.webp' },
  { key: 'builtin:rich', title: '与Jianjiazijin的合影', file: 'rich.webp' },
  { key: 'builtin:sakura', title: '月光下的樱花林', file: 'sakura.webp' },
  { key: 'builtin:sakura2', title: '月光下的樱花林2', file: 'sakura2.webp' },
  { key: 'builtin:rebuild', title: '湖南大学红楼', file: 'rebuild.webp' },
] as const;

export function isBuiltinLaunchImage(key: string): boolean {
  return BUILTIN_LAUNCH_IMAGES.some((image) => image.key === key);
}
