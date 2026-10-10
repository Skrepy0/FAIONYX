#!/usr/bin/env node
// 一次性：补齐本批 i18n 迁移新增的词条（键 → [zh, en]）。已存在的键不覆盖。
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'shared', 'i18n', 'locales');

const ADD = {
  'common.list_separator': ['、', ', '],

  'gameoptions.unit.seconds': ['秒', 's'],
  'gameoptions.error.unknown': ['未知游戏选项', 'Unknown game option'],
  'gameoptions.error.invalid_value': ['游戏选项值无效', 'Invalid game option value'],
  'gameoptions.error.out_of_range': ['游戏选项超出有效范围', 'Game option value out of range'],
  'gameoptions.error.sync_invalid': ['同步开关无效', 'Invalid sync toggle'],
  'gameoptions.error.version_unknown': [
    '无法确认 Minecraft 实际版本，未写入默认游戏选项',
    'Cannot determine the actual Minecraft version; default game options were not written',
  ],
  'gameoptions.error.packs_invalid': [
    '现有资源包配置无效，未覆盖 options.txt',
    'Existing resource pack config is invalid; options.txt was not overwritten',
  ],
  'gameoptions.error.write_verify': ['默认游戏选项写入校验失败', 'Default game option write verification failed'],
};

const locales = { 'zh-CN.json': 0, 'en-US.json': 1 };
for (const [file, idx] of Object.entries(locales)) {
  const p = path.join(DIR, file);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  let added = 0;
  for (const [k, pair] of Object.entries(ADD)) {
    if (k in raw) continue;
    raw[k] = pair[idx];
    added++;
  }
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
  console.log(file, 'added', added, 'total', Object.keys(raw).length);
}
