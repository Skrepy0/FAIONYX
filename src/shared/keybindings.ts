/**
 * MC 原版键位表（options.txt 的 key_* 项）与默认值。
 * 用于启动器的「默认按键」功能：启动时把默认键位同步进实例 options.txt。
 */
import { translate as t } from './i18n';

export interface KeybindDef {
  /** options.txt 键位项 id，如 key_key.forward */
  id: string;
  /** 分类的 i18n 键（UI 分组展示） */
  category: string;
  /** 显示名的 i18n 键 */
  label: string;
  /** MC 默认绑定（key.keyboard.* / key.mouse.* / key.keyboard.unknown） */
  defaultBind: string;
}

/** 键位显示名 i18n 键：key_key.forward → keys.bindings.key_forward */
export const keybindLabelKey = (id: string): string => 'keys.bindings.' + id.replace(/^key_key\./, 'key_');

const KEYBIND_CATEGORY_KEYS = {
  movement: 'keys.bindings.category_movement',
  gameplay: 'keys.bindings.category_gameplay',
  inventory: 'keys.bindings.category_inventory',
  camera: 'keys.bindings.category_camera',
  interface: 'keys.bindings.category_interface',
  multiplayer: 'keys.bindings.category_multiplayer',
  misc: 'keys.bindings.category_misc',
} as const;

const bind = (id: string, category: string, defaultBind: string): KeybindDef => ({
  id,
  category,
  label: keybindLabelKey(id),
  defaultBind,
});

/** MC Java 版 options.txt 中的全部原版键位 */
export const VANILLA_KEYBINDS: KeybindDef[] = [
  // 移动
  bind('key_key.forward', KEYBIND_CATEGORY_KEYS.movement, 'key.keyboard.w'),
  bind('key_key.back', KEYBIND_CATEGORY_KEYS.movement, 'key.keyboard.s'),
  bind('key_key.left', KEYBIND_CATEGORY_KEYS.movement, 'key.keyboard.a'),
  bind('key_key.right', KEYBIND_CATEGORY_KEYS.movement, 'key.keyboard.d'),
  bind('key_key.jump', KEYBIND_CATEGORY_KEYS.movement, 'key.keyboard.space'),
  bind('key_key.sneak', KEYBIND_CATEGORY_KEYS.movement, 'key.keyboard.left.shift'),
  bind('key_key.sprint', KEYBIND_CATEGORY_KEYS.movement, 'key.keyboard.left.control'),
  // 游戏
  bind('key_key.attack', KEYBIND_CATEGORY_KEYS.gameplay, 'key.mouse.left'),
  bind('key_key.use', KEYBIND_CATEGORY_KEYS.gameplay, 'key.mouse.right'),
  bind('key_key.pickItem', KEYBIND_CATEGORY_KEYS.gameplay, 'key.mouse.middle'),
  // 物品栏
  bind('key_key.inventory', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.e'),
  bind('key_key.drop', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.q'),
  bind('key_key.swapOffhand', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.f'),
  bind('key_key.hotbar.1', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.1'),
  bind('key_key.hotbar.2', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.2'),
  bind('key_key.hotbar.3', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.3'),
  bind('key_key.hotbar.4', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.4'),
  bind('key_key.hotbar.5', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.5'),
  bind('key_key.hotbar.6', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.6'),
  bind('key_key.hotbar.7', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.7'),
  bind('key_key.hotbar.8', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.8'),
  bind('key_key.hotbar.9', KEYBIND_CATEGORY_KEYS.inventory, 'key.keyboard.9'),
  // 视角
  bind('key_key.togglePerspective', KEYBIND_CATEGORY_KEYS.camera, 'key.keyboard.f5'),
  bind('key_key.smoothCamera', KEYBIND_CATEGORY_KEYS.camera, 'key.keyboard.unknown'),
  bind('key_key.zoom', KEYBIND_CATEGORY_KEYS.camera, 'key.keyboard.c'),
  // 界面
  bind('key_key.chat', KEYBIND_CATEGORY_KEYS.interface, 'key.keyboard.t'),
  bind('key_key.command', KEYBIND_CATEGORY_KEYS.interface, 'key.keyboard.slash'),
  bind('key_key.socialInteractions', KEYBIND_CATEGORY_KEYS.interface, 'key.keyboard.p'),
  bind('key_key.advancements', KEYBIND_CATEGORY_KEYS.interface, 'key.keyboard.l'),
  bind('key_key.screenshot', KEYBIND_CATEGORY_KEYS.interface, 'key.keyboard.f2'),
  bind('key_key.fullscreen', KEYBIND_CATEGORY_KEYS.interface, 'key.keyboard.f11'),
  bind('key_key.narrator', KEYBIND_CATEGORY_KEYS.interface, 'key.keyboard.b'),
  // 多人游戏
  bind('key_key.playerlist', KEYBIND_CATEGORY_KEYS.multiplayer, 'key.keyboard.tab'),
  // 杂项
  bind('key_key.saveToolbarActivator', KEYBIND_CATEGORY_KEYS.misc, 'key.keyboard.unknown'),
  bind('key_key.loadToolbarActivator', KEYBIND_CATEGORY_KEYS.misc, 'key.keyboard.unknown'),
  bind('key_key.spectatorOutlines', KEYBIND_CATEGORY_KEYS.misc, 'key.keyboard.unknown'),
];

/** 分类 i18n 键，按 UI 展示顺序 */
export const KEYBIND_CATEGORIES = [
  KEYBIND_CATEGORY_KEYS.movement,
  KEYBIND_CATEGORY_KEYS.gameplay,
  KEYBIND_CATEGORY_KEYS.inventory,
  KEYBIND_CATEGORY_KEYS.camera,
  KEYBIND_CATEGORY_KEYS.interface,
  KEYBIND_CATEGORY_KEYS.multiplayer,
  KEYBIND_CATEGORY_KEYS.misc,
] as const;

/** DOM KeyboardEvent.code → MC 绑定值。无法识别的返回 null。 */
const CODE_TO_MC: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') map['Key' + letter.toUpperCase()] = 'key.keyboard.' + letter;
  for (const digit of '0123456789') map['Digit' + digit] = 'key.keyboard.' + digit;
  const named: Record<string, string> = {
    Space: 'key.keyboard.space',
    Tab: 'key.keyboard.tab',
    Enter: 'key.keyboard.enter',
    Escape: 'key.keyboard.escape',
    Backspace: 'key.keyboard.backspace',
    Delete: 'key.keyboard.delete',
    Insert: 'key.keyboard.insert',
    Home: 'key.keyboard.home',
    End: 'key.keyboard.end',
    PageUp: 'key.keyboard.page.up',
    PageDown: 'key.keyboard.page.down',
    ArrowUp: 'key.keyboard.up',
    ArrowDown: 'key.keyboard.down',
    ArrowLeft: 'key.keyboard.left',
    ArrowRight: 'key.keyboard.right',
    ShiftLeft: 'key.keyboard.left.shift',
    ShiftRight: 'key.keyboard.right.shift',
    ControlLeft: 'key.keyboard.left.control',
    ControlRight: 'key.keyboard.right.control',
    AltLeft: 'key.keyboard.left.alt',
    AltRight: 'key.keyboard.right.alt',
    MetaLeft: 'key.keyboard.left.win',
    MetaRight: 'key.keyboard.right.win',
    CapsLock: 'key.keyboard.caps.lock',
    NumLock: 'key.keyboard.num.lock',
    Minus: 'key.keyboard.minus',
    Equal: 'key.keyboard.equal',
    BracketLeft: 'key.keyboard.left.bracket',
    BracketRight: 'key.keyboard.right.bracket',
    Backslash: 'key.keyboard.backslash',
    Semicolon: 'key.keyboard.semicolon',
    Quote: 'key.keyboard.apostrophe',
    Comma: 'key.keyboard.comma',
    Period: 'key.keyboard.period',
    Slash: 'key.keyboard.slash',
    Backquote: 'key.keyboard.grave.accent',
    NumpadEnter: 'key.keyboard.keypad.enter',
  };
  Object.assign(map, named);
  for (let i = 1; i <= 12; i++) map['F' + i] = 'key.keyboard.f' + i;
  for (let i = 0; i <= 9; i++) map['Numpad' + i] = 'key.keyboard.keypad.' + i;
  const numpadOps: Record<string, string> = {
    NumpadMultiply: 'key.keyboard.keypad.multiply',
    NumpadAdd: 'key.keyboard.keypad.add',
    NumpadSubtract: 'key.keyboard.keypad.subtract',
    NumpadDecimal: 'key.keyboard.keypad.decimal',
    NumpadDivide: 'key.keyboard.keypad.divide',
    NumpadEqual: 'key.keyboard.keypad.equal',
  };
  Object.assign(map, numpadOps);
  return map;
})();

const MOUSE_TO_MC: Record<number, string> = {
  0: 'key.mouse.left',
  1: 'key.mouse.middle',
  2: 'key.mouse.right',
  3: 'key.mouse.4',
  4: 'key.mouse.5',
};

export function codeToMcKey(code: string): string | null {
  return CODE_TO_MC[code] ?? null;
}
export function mouseButtonToMcKey(button: number): string | null {
  return MOUSE_TO_MC[button] ?? null;
}

/** MC 绑定值 → 简短显示（key.keyboard.left.shift → LShift，key.mouse.left → 鼠标左键） */
const MC_KEY_KEYS: Record<string, string> = {
  space: 'keys.bindings.key_space',
  tab: 'keys.bindings.key_tab',
  enter: 'keys.bindings.key_enter',
  escape: 'keys.bindings.key_escape',
  backspace: 'keys.bindings.key_backspace',
  delete: 'keys.bindings.key_delete',
  'left.shift': 'keys.bindings.key_left.shift',
  'right.shift': 'keys.bindings.key_right.shift',
  'left.control': 'keys.bindings.key_left.control',
  'right.control': 'keys.bindings.key_right.control',
  'left.alt': 'keys.bindings.key_left.alt',
  'right.alt': 'keys.bindings.key_right.alt',
  'left.win': 'keys.bindings.key_left.win',
  'right.win': 'keys.bindings.key_right.win',
  up: 'keys.bindings.key_up',
  down: 'keys.bindings.key_down',
  left: 'keys.bindings.key_arrow_left',
  right: 'keys.bindings.key_arrow_right',
  'page.up': 'keys.bindings.key_page.up',
  'page.down': 'keys.bindings.key_page.down',
  'caps.lock': 'keys.bindings.key_caps.lock',
  'num.lock': 'keys.bindings.key_num.lock',
  'grave.accent': 'keys.bindings.key_grave.accent',
  apostrophe: 'keys.bindings.key_apostrophe',
  slash: 'keys.bindings.key_slash',
  backslash: 'keys.bindings.key_backslash',
  minus: 'keys.bindings.key_minus',
  equal: 'keys.bindings.key_equal',
  comma: 'keys.bindings.key_comma',
  period: 'keys.bindings.key_period',
  'left.bracket': 'keys.bindings.key_left.bracket',
  'right.bracket': 'keys.bindings.key_right.bracket',
  semicolon: 'keys.bindings.key_semicolon',
  home: 'keys.bindings.key_home',
  end: 'keys.bindings.key_end',
  insert: 'keys.bindings.key_insert',
};
const MOUSE_KEY_KEYS: Record<string, string> = {
  left: 'keys.bindings.mouse_left',
  middle: 'keys.bindings.mouse_middle',
  right: 'keys.bindings.mouse_right',
  4: 'keys.bindings.mouse_4',
  5: 'keys.bindings.mouse_5',
};

export function mcKeyLabel(bind: string): string {
  if (!bind || bind === 'key.keyboard.unknown') return t('keys.bindings.key_unbound');
  if (bind.startsWith('key.mouse.')) {
    const key = MOUSE_KEY_KEYS[bind.slice('key.mouse.'.length)];
    return key ? t(key) : bind;
  }
  const key = bind.replace(/^key\.keyboard\./, '');
  if (MC_KEY_KEYS[key]) return t(MC_KEY_KEYS[key]);
  if (key.startsWith('keypad.')) return t('keys.bindings.key_prefix_keypad') + key.slice(7);
  return key.length === 1 ? key.toUpperCase() : key;
}

export function parseSnapshotId(version: string): [number, number] | null {
  const m = /^(\d{2})w(\d{1,2})[a-e]?$/i.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * 把任意 MC 版本字符串映射为可比较的数值元组（版本族）：
 * - 正式版按数字段比较（26.x 新版号天然大于所有 1.x）；-pre/-rc/-snapshot 及 "1.14 Pre-Release 2"
 *   等开发后缀视为其对应正式版（pre1/rc1 的 options.txt 字段已与正式版一致）；
 * - 快照按「年-周 → 版本族」映射，分界周对齐启动器判定的功能引入点：
 *   16w20a=autoJump(1.10)、17w43a=新键位系统(1.13)、19w41a=toggleCrouch/toggleSprint(1.15)、
 *   20w06a=1.16 开发周期（graphicsMode）、25w41a=1.21.11 开发周期（graphicsPreset）、26.x 新版号。
 *   只需保证对本启动器使用的分界目标（1.10/1.13/1.15/1.16/1.21.11/26.x）单调正确。
 * 无法解析的非常规 id 按最新处理（与空版本一致的保守方向：宁写新字段不写错旧字段会由字段本身被忽略兜底）。
 */
export function mcVersionFamily(version: string): number[] {
  const v = String(version ?? '').trim();
  const snap = parseSnapshotId(v);
  if (snap) {
    const [yy, ww] = snap;
    if (yy >= 26) return [26, 0];
    if (yy === 25) return ww >= 41 ? [1, 21, 11] : [1, 21, 10];
    if (yy === 24) return [1, 21, 4];
    if (yy === 23) return [1, 20, 4];
    if (yy === 22) return [1, 19, 3];
    if (yy === 21) return [1, 18, 2];
    if (yy === 20) return ww >= 6 ? [1, 16, 5] : [1, 15, 2];
    if (yy === 19) return ww >= 41 ? [1, 15, 2] : [1, 14, 4];
    if (yy === 18) return [1, 14, 4];
    if (yy === 17) return ww >= 43 ? [1, 13] : [1, 12, 2];
    if (yy === 16) return ww >= 20 ? [1, 10, 2] : [1, 9, 4];
    if (yy === 15) return [1, 9];
    return [1, 8];
  }
  // 正式版：剥离开发后缀（含 26.2-snapshot-1 / 1.21.11-pre1 / 1.14 Pre-Release 2 三种写法）
  const base = v.split(/[\s-]/)[0];
  const parts = base.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return [999];
  return parts;
}

/** 版本族元组比较：返回 -1/0/1。26.x > 全部 1.x；1.21.11 > 1.21.9（数字段比较，非字符串） */
export function compareMcVersions(a: string, b: string): number {
  const fa = mcVersionFamily(a);
  const fb = mcVersionFamily(b);
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
    const d = (fa[i] ?? 0) - (fb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** MC 版本是否 ≥ 目标版本。空版本按最新处理（未知实例不丢同步项）。 */
export function mcVersionAtLeast(mcVersion: string, target: string): boolean {
  if (!mcVersion) return true;
  return compareMcVersions(mcVersion, target) >= 0;
}
