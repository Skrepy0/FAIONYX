#!/usr/bin/env node
// 一次性迁移：把 gameoptions.* 旧键名（option_/page_/语义化取值名）改为新命名（opt./page./choice.<id>.<value>）。
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'shared', 'i18n', 'locales');
const FILES = ['zh-CN.json', 'en-US.json'];

// 取值旧键 → 新键
const CHOICE_RENAME = {
  'gameoptions.mainHand_right': 'gameoptions.choice.mainHand.right',
  'gameoptions.mainHand_left': 'gameoptions.choice.mainHand.left',
  'gameoptions.particles_all': 'gameoptions.choice.particles.0',
  'gameoptions.particles_decreased': 'gameoptions.choice.particles.1',
  'gameoptions.particles_minimal': 'gameoptions.choice.particles.2',
  'gameoptions.attackIndicator_off': 'gameoptions.choice.attackIndicator.0',
  'gameoptions.attackIndicator_crosshair': 'gameoptions.choice.attackIndicator.1',
  'gameoptions.attackIndicator_hotbar': 'gameoptions.choice.attackIndicator.2',
  'gameoptions.clouds_off': 'gameoptions.choice.renderClouds.off',
  'gameoptions.clouds_fast': 'gameoptions.choice.renderClouds.fast',
  'gameoptions.clouds_fancy': 'gameoptions.choice.renderClouds.fancy',
  'gameoptions.hold': null, // 展开为每个开关选项各自的键，见 HOLD_TOGGLE
  'gameoptions.toggle': null,
  'gameoptions.chatVisibility_shown': 'gameoptions.choice.chatVisibility.0',
  'gameoptions.chatVisibility_commands': 'gameoptions.choice.chatVisibility.1',
  'gameoptions.chatVisibility_hidden': 'gameoptions.choice.chatVisibility.2',
  'gameoptions.narrator_off': 'gameoptions.choice.narrator.0',
  'gameoptions.narrator_all': 'gameoptions.choice.narrator.1',
  'gameoptions.narrator_chat': 'gameoptions.choice.narrator.2',
  'gameoptions.narrator_system': 'gameoptions.choice.narrator.3',
};
// 「按住/切换」对每个开关型选项各自成键（值为 false/true）
const HOLD_TOGGLE_OPTIONS = ['toggleCrouch', 'toggleSprint', 'toggleAttack', 'toggleUse'];
// 语言名改为内联，不再需要词条
const DROP = new Set(
  ['zh_cn', 'zh_tw', 'zh_hk', 'en_us', 'en_gb', 'ja_jp', 'ko_kr', 'de_de', 'fr_fr', 'es_es', 'ru_ru'].map((l) => `gameoptions.lang_${l}`)
);

for (const file of FILES) {
  const p = path.join(DIR, file);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const out = {};
  let holdValue = null,
    toggleValue = null;
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'gameoptions.hold') {
      holdValue = v;
      continue;
    }
    if (k === 'gameoptions.toggle') {
      toggleValue = v;
      continue;
    }
    if (DROP.has(k)) continue;
    let key = k;
    if (CHOICE_RENAME[k]) key = CHOICE_RENAME[k];
    else if (k.startsWith('gameoptions.option_')) key = 'gameoptions.opt.' + k.slice('gameoptions.option_'.length);
    else if (k.startsWith('gameoptions.page_')) key = 'gameoptions.page.' + k.slice('gameoptions.page_'.length);
    out[key] = v;
  }
  for (const id of HOLD_TOGGLE_OPTIONS) {
    out[`gameoptions.choice.${id}.false`] = holdValue;
    out[`gameoptions.choice.${id}.true`] = toggleValue;
  }
  fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n');
  console.log(file, Object.keys(raw).length, '→', Object.keys(out).length);
}
