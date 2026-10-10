import { mcVersionAtLeast } from './keybindings';
import { translate as t } from './i18n';

export type GameOptionValue = number | boolean | string;
export interface GameOptionDef {
  id: string;
  /** i18n 键（gameoptions.opt.<id>），由调用方通过 t() 取显示名 */
  label: string;
  page: string;
  initial: GameOptionValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  since?: string;
  until?: string;
  /** [值, i18n 键] 对；显示名同样由调用方翻译 */
  choices?: readonly (readonly [GameOptionValue, string])[];
  encoding?: 'percent' | 'sensitivity' | 'fov' | 'text' | 'json' | 'chatOpacity' | 'chatWidth' | 'chatHeight';
}

/** 选项标题键 */
export const gameOptionLabelKey = (id: string): string => `gameoptions.opt.${id}`;
/** 选项取值键：<选项 id> + 原始值（false/true/0/1/off/fast/zh_cn…） */
export const gameOptionChoiceKey = (id: string, value: GameOptionValue): string => `gameoptions.choice.${id}.${String(value)}`;

const bool = (id: string, page: string, initial = true, since?: string): GameOptionDef => ({
  id,
  label: gameOptionLabelKey(id),
  page,
  initial,
  since,
});
const percent = (id: string, page: string, initial = 100, since?: string): GameOptionDef => ({
  id,
  label: gameOptionLabelKey(id),
  page,
  initial,
  min: 0,
  max: 100,
  step: 1,
  unit: '%',
  encoding: 'percent',
  since,
});
const integer = (id: string, page: string, initial: number, min: number, max: number, since?: string): GameOptionDef => ({
  id,
  label: gameOptionLabelKey(id),
  page,
  initial,
  min,
  max,
  step: 1,
  since,
});
const choice = (id: string, value: GameOptionValue): readonly [GameOptionValue, string] => [value, gameOptionChoiceKey(id, value)];

export const GAME_OPTION_PAGES = [
  ['skin', 'gameoptions.page.skin'],
  ['sounds', 'gameoptions.page.sounds'],
  ['video', 'gameoptions.page.video'],
  ['controls', 'gameoptions.page.controls'],
  ['language', 'gameoptions.page.language'],
  ['chat', 'gameoptions.page.chat'],
  ['packs', 'gameoptions.page.packs'],
  ['accessibility', 'gameoptions.page.accessibility'],
  ['telemetry', 'gameoptions.page.telemetry'],
  ['credits', 'gameoptions.page.credits'],
] as const;
export const GAME_OPTIONS: GameOptionDef[] = [
  { ...integer('fov', 'root', 70, 30, 110), encoding: 'fov', unit: '°' },
  {
    id: 'mainHand',
    label: gameOptionLabelKey('mainHand'),
    page: 'skin',
    initial: 'right',
    choices: [choice('mainHand', 'right'), choice('mainHand', 'left')],
    since: '1.9',
    encoding: 'text',
  },
  ...['cape', 'jacket', 'left_sleeve', 'right_sleeve', 'left_pants_leg', 'right_pants_leg', 'hat'].map((part) =>
    bool('modelPart_' + part, 'skin')
  ),
  ...['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice'].map((category) =>
    percent('soundCategory_' + category, 'sounds')
  ),
  bool('showSubtitles', 'sounds', false, '1.9'),
  bool('directionalAudio', 'sounds', false, '1.19.4'),
  integer('renderDistance', 'video', 12, 2, 32),
  integer('simulationDistance', 'video', 12, 5, 32, '1.18'),
  integer('maxFps', 'video', 120, 10, 260),
  bool('enableVsync', 'video'),
  integer('guiScale', 'video', 0, 0, 4),
  percent('gamma', 'video', 50),
  bool('bobView', 'video'),
  {
    id: 'particles',
    label: gameOptionLabelKey('particles'),
    page: 'video',
    initial: 0,
    choices: [choice('particles', 0), choice('particles', 1), choice('particles', 2)],
  },
  {
    id: 'attackIndicator',
    label: gameOptionLabelKey('attackIndicator'),
    page: 'video',
    initial: 1,
    choices: [choice('attackIndicator', 0), choice('attackIndicator', 1), choice('attackIndicator', 2)],
    since: '1.9',
  },
  bool('entityShadows', 'video', true, '1.8'),
  integer('mipmapLevels', 'video', 4, 0, 4),
  bool('showAutosaveIndicator', 'video', true, '1.18'),
  bool('ao', 'video', true, '1.20.1'),
  {
    id: 'renderClouds',
    label: gameOptionLabelKey('renderClouds'),
    page: 'video',
    initial: 'fancy',
    choices: [choice('renderClouds', 'off'), choice('renderClouds', 'fast'), choice('renderClouds', 'fancy')],
    encoding: 'json',
    since: '1.19',
  },
  { ...percent('entityDistanceScaling', 'video', 100, '1.16'), min: 50, max: 500, step: 25 },
  integer('menuBackgroundBlurriness', 'video', 5, 0, 10, '1.20.5'),
  integer('cloudRange', 'video', 128, 2, 128, '26.2'),
  bool('cutoutLeaves', 'video', true, '26.2'),
  bool('improvedTransparency', 'video', true, '26.2'),
  integer('weatherRadius', 'video', 10, 3, 10, '26.2'),
  bool('vignette', 'video', true, '26.2'),
  { ...integer('chunkSectionFadeInTime', 'video', 0.75, 0, 2, '26.2'), step: 0.05, unit: 'gameoptions.unit.seconds' },
  {
    id: 'toggleCrouch',
    label: gameOptionLabelKey('toggleCrouch'),
    page: 'controls',
    initial: false,
    choices: [choice('toggleCrouch', false), choice('toggleCrouch', true)],
    since: '1.15',
  },
  {
    id: 'toggleSprint',
    label: gameOptionLabelKey('toggleSprint'),
    page: 'controls',
    initial: false,
    choices: [choice('toggleSprint', false), choice('toggleSprint', true)],
    since: '1.15',
  },
  {
    id: 'toggleAttack',
    label: gameOptionLabelKey('toggleAttack'),
    page: 'controls',
    initial: false,
    choices: [choice('toggleAttack', false), choice('toggleAttack', true)],
    since: '26.2',
  },
  {
    id: 'toggleUse',
    label: gameOptionLabelKey('toggleUse'),
    page: 'controls',
    initial: false,
    choices: [choice('toggleUse', false), choice('toggleUse', true)],
    since: '26.2',
  },
  bool('autoJump', 'controls', false, '1.10'),
  integer('sprintWindow', 'controls', 7, 0, 10, '26.2'),
  bool('operatorItemsTab', 'controls', false, '1.19.3'),
  { ...integer('mouseSensitivity', 'mouse', 100, 0, 200), encoding: 'sensitivity', unit: '%' },
  { ...integer('mouseWheelSensitivity', 'mouse', 1, 0.01, 10, '1.14'), step: 0.01 },
  bool('discrete_mouse_scroll', 'mouse', false, '1.14'),
  bool('invertXMouse', 'mouse', false, '26.2'),
  bool('invertYMouse', 'mouse', false),
  bool('allowCursorChanges', 'mouse', true, '26.2'),
  { ...bool('touchscreen', 'mouse', false), until: '26.1' },
  bool('rawMouseInput', 'mouse', true, '1.14'),
  {
    id: 'lang',
    label: gameOptionLabelKey('lang'),
    page: 'language',
    initial: 'zh_cn',
    encoding: 'text',
    // 语言名是各语言自身的写法，不随界面语言翻译，直接内联显示。
    choices: [
      ['zh_cn', '简体中文'],
      ['zh_tw', '繁體中文（台灣）'],
      ['zh_hk', '繁體中文（香港）'],
      ['en_us', 'English (US)'],
      ['en_gb', 'English (UK)'],
      ['ja_jp', '日本語'],
      ['ko_kr', '한국어'],
      ['de_de', 'Deutsch'],
      ['fr_fr', 'Français'],
      ['es_es', 'Español'],
      ['ru_ru', 'Русский'],
    ],
  },
  bool('forceUnicodeFont', 'language', false),
  {
    id: 'chatVisibility',
    label: gameOptionLabelKey('chatVisibility'),
    page: 'chat',
    initial: 0,
    choices: [choice('chatVisibility', 0), choice('chatVisibility', 1), choice('chatVisibility', 2)],
  },
  bool('chatColors', 'chat'),
  bool('chatLinks', 'chat'),
  { ...percent('chatOpacity', 'chat'), min: 10, encoding: 'chatOpacity' },
  bool('chatLinksPrompt', 'chat'),
  percent('chatScale', 'chat'),
  { ...integer('chatWidth', 'chat', 320, 40, 320), encoding: 'chatWidth', unit: 'px' },
  { ...integer('chatHeightFocused', 'chat', 180, 20, 180), encoding: 'chatHeight', unit: 'px' },
  { ...integer('chatHeightUnfocused', 'chat', 90, 20, 180), encoding: 'chatHeight', unit: 'px' },
  percent('textBackgroundOpacity', 'chat', 50, '1.14'),
  percent('chatLineSpacing', 'chat', 0, '1.16'),
  {
    id: 'narrator',
    label: gameOptionLabelKey('narrator'),
    page: 'accessibility',
    initial: 0,
    choices: [choice('narrator', 0), choice('narrator', 1), choice('narrator', 2), choice('narrator', 3)],
    since: '1.12',
  },
  bool('highContrast', 'accessibility', false, '1.19.4'),
  ...['toggleCrouch', 'toggleSprint', 'autoJump', 'showSubtitles'].map((id) => ({ id, label: '', page: 'accessibility', initial: false })),
  percent('screenEffectScale', 'accessibility', 100, '1.16.2'),
  percent('fovEffectScale', 'accessibility', 100, '1.16.2'),
  percent('darknessEffectScale', 'accessibility', 100, '1.19'),
  percent('glintSpeed', 'accessibility', 50, '1.19.4'),
  percent('glintStrength', 'accessibility', 75, '1.19.4'),
  percent('damageTiltStrength', 'accessibility', 100, '1.19.4'),
  bool('hideLightningFlashes', 'accessibility', false, '1.19.4'),
  bool('darkMojangStudiosBackground', 'accessibility', false, '1.16'),
  percent('panoramaScrollSpeed', 'accessibility', 100, '1.19.4'),
  bool('highContrastBlockOutline', 'accessibility', false, '1.21.2'),
  bool('narratorHotkey', 'accessibility', true, '1.21.2'),
  bool('telemetryOptInExtra', 'telemetry', false, '1.19.3'),
];
export const uniqueGameOptions = GAME_OPTIONS.filter((d, i, a) => a.findIndex((other) => other.id === d.id) === i);
// Same row-major sequence as the game's video submenus: quality, display, appearance.
export const VIDEO_OPTION_ORDER = [
  'renderDistance',
  'simulationDistance',
  'ao',
  'renderClouds',
  'particles',
  'mipmapLevels',
  'entityShadows',
  'entityDistanceScaling',
  'menuBackgroundBlurriness',
  'cloudRange',
  'cutoutLeaves',
  'improvedTransparency',
  'weatherRadius',
  'maxFps',
  'enableVsync',
  'guiScale',
  'gamma',
  'bobView',
  'showAutosaveIndicator',
  'vignette',
  'attackIndicator',
  'chunkSectionFadeInTime',
];
export function supportedGameOption(def: GameOptionDef, version: string): boolean {
  return (!def.since || mcVersionAtLeast(version, def.since)) && (!def.until || !mcVersionAtLeast(version, def.until));
}
export function validateGameOption(id: string, value: unknown): asserts value is GameOptionValue {
  const d = uniqueGameOptions.find((d) => d.id === id);
  if (!d) throw new Error(t('gameoptions.error.unknown'));
  if (d.choices ? !d.choices.some((c) => c[0] === value) : typeof value !== typeof d.initial)
    throw new Error(t('gameoptions.error.invalid_value'));
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || value < d.min! || value > d.max! || (d.step === 1 && !Number.isInteger(value)))
  )
    throw new Error(t('gameoptions.error.out_of_range'));
}
export function encodeGameOption(d: GameOptionDef, value: GameOptionValue, version: string): string {
  validateGameOption(d.id, value);
  if (d.encoding === 'fov') return String((Number(value) - 70) / 40);
  if (d.encoding === 'chatOpacity') return String((Number(value) - 10) / 90);
  if (d.encoding === 'chatWidth') return String((Number(value) - 40) / 280);
  if (d.encoding === 'chatHeight') return String((Number(value) - 20) / 160);
  if (d.encoding === 'percent') return String(Number(value) / 100);
  if (d.encoding === 'sensitivity') return String(Number(value) / 200);
  if (d.encoding === 'json') return JSON.stringify(value);
  if (d.id === 'lang' && !mcVersionAtLeast(version, '1.11'))
    return String(value).replace(/_([a-z]+)/, (_, region) => '_' + region.toUpperCase());
  if (d.id === 'mainHand' && mcVersionAtLeast(version, '1.19')) return JSON.stringify(value);
  return String(value);
}
export interface DefaultGameOptions {
  enabled: boolean;
  values: Record<string, GameOptionValue>;
}
