/** Stable keys keep image selection and timing independent of bundled asset hashes.
 *  title 为 i18n 键（launchimages.title.*），由调用方通过 t() 取显示名。 */
export const BUILTIN_LAUNCH_IMAGES = [
  { key: 'builtin:end', title: 'launchimages.title.end', file: 'end.webp' },
  { key: 'builtin:group_photo', title: 'launchimages.title.group_photo', file: 'group_photo.webp' },
  { key: 'builtin:landscape', title: 'launchimages.title.landscape', file: 'landscape.webp' },
  { key: 'builtin:rich', title: 'launchimages.title.rich', file: 'rich.webp' },
  { key: 'builtin:sakura', title: 'launchimages.title.sakura', file: 'sakura.webp' },
  { key: 'builtin:sakura2', title: 'launchimages.title.sakura2', file: 'sakura2.webp' },
  { key: 'builtin:rebuild', title: 'launchimages.title.rebuild', file: 'rebuild.webp' },
] as const;

export function isBuiltinLaunchImage(key: string): boolean {
  return BUILTIN_LAUNCH_IMAGES.some((image) => image.key === key);
}
