import { BUILTIN_LAUNCH_IMAGES } from '@shared/launchImages';
import end from './assets/launch/end.webp';
import group_photo from './assets/launch/group_photo.webp';
import landscape from './assets/launch/landscape.webp';
import rich from './assets/launch/rich.webp';
import sakura from './assets/launch/sakura.webp';
import sakura2 from './assets/launch/sakura2.webp';
import rebuild from './assets/launch/rebuild.webp';

const sources = {
  'end.webp': end,
  'group_photo.webp': group_photo,
  'landscape.webp': landscape,
  'rich.webp': rich,
  'sakura.webp': sakura,
  'sakura2.webp': sakura2,
  'rebuild.webp': rebuild,
};
export const builtInLaunchImages = BUILTIN_LAUNCH_IMAGES.map((image) => ({ ...image, src: sources[image.file] }));
