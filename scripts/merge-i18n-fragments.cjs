#!/usr/bin/env node
/**
 * 合并 i18n 片段：读取 i18n-fragments/*.json（{ "zh-CN": {...}, "en-US": {...} }），
 * 并入 src/shared/i18n/locales/{zh-CN,en-US}.json。已存在的键保留原值。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRAG_DIR = path.join(ROOT, 'i18n-fragments');
const LOCALES = { 'zh-CN': 'zh-CN.json', 'en-US': 'en-US.json' };

if (!fs.existsSync(FRAG_DIR)) {
  console.log('没有片段目录，跳过');
  process.exit(0);
}
const files = fs.readdirSync(FRAG_DIR).filter((f) => f.endsWith('.json'));
if (!files.length) {
  console.log('没有片段文件，跳过');
  process.exit(0);
}

const data = { 'zh-CN': {}, 'en-US': {} };
const sources = { 'zh-CN': {}, 'en-US': {} };
for (const file of files) {
  let frag;
  try {
    frag = JSON.parse(fs.readFileSync(path.join(FRAG_DIR, file), 'utf8'));
  } catch (error) {
    console.error('片段解析失败：', file, error.message);
    process.exitCode = 1;
    continue;
  }
  for (const loc of Object.keys(LOCALES)) {
    for (const [k, v] of Object.entries(frag[loc] ?? {})) {
      if (typeof v !== 'string' || !v) continue;
      if (k in data[loc]) {
        if (data[loc][k] !== v) console.warn(`键冲突（${loc}）${k}: ${JSON.stringify(data[loc][k])} vs ${JSON.stringify(v)} @ ${file}`);
        continue;
      }
      data[loc][k] = v;
      sources[loc][k] = file;
    }
  }
}

for (const [loc, file] of Object.entries(LOCALES)) {
  const p = path.join(ROOT, 'src', 'shared', 'i18n', 'locales', file);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  let added = 0;
  for (const [k, v] of Object.entries(data[loc])) {
    if (k in raw) continue;
    raw[k] = v;
    added++;
  }
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
  console.log(`${file}: +${added} → ${Object.keys(raw).length} 键`);
}

// 报告两侧键集差异，避免片段漏翻译
const zhOnly = Object.keys(data['zh-CN']).filter((k) => !(k in data['en-US']));
const enOnly = Object.keys(data['en-US']).filter((k) => !(k in data['zh-CN']));
if (zhOnly.length) console.warn('片段中仅 zh-CN 有：', zhOnly.join(', '));
if (enOnly.length) console.warn('片段中仅 en-US 有：', enOnly.join(', '));
