#!/usr/bin/env node
// scripts/check-locales.cjs
// 校验 src/renderer/src/i18n/locales 下所有语言 JSON 的键完整性。
// 基准 = 所有文件键的并集；每个文件报告缺失键与空值键。
// 用法:
//   node scripts/check-locales.cjs
//   node scripts/check-locales.cjs --strict   # 有缺失/解析错误时退出码 1（CI 用）
//   node scripts/check-locales.cjs --json     # JSON 输出
//   node scripts/check-locales.cjs --origin   # 缺失键旁标注该键存在于哪些文件

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'src/shared/i18n/locales');

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const jsonOut = args.includes('--json');
const showOrigin = args.includes('--origin');

/** 展平嵌套对象: { a: { b: 1 } } -> { 'a.b': 1 } */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

if (!fs.existsSync(LOCALES_DIR)) {
  console.error(`未找到目录: ${LOCALES_DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));
if (!files.length) {
  console.error('locales 目录下没有 JSON 文件');
  process.exit(1);
}

const locales = {};
const parseErrors = [];
for (const f of files) {
  try {
    locales[f] = flatten(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8')));
  } catch (e) {
    parseErrors.push({ file: f, error: String(e.message || e) });
  }
}

/** 并集基准 + 每个键的来源文件列表 */
const allKeys = new Set();
const origins = {}; // key -> [file, ...]
for (const [f, map] of Object.entries(locales)) {
  for (const k of Object.keys(map)) {
    allKeys.add(k);
    (origins[k] ??= []).push(f);
  }
}
const refKeys = [...allKeys].sort();

/** 只被单个文件拥有的键：很可能是别处忘了加，或该文件独有的残留/笔误，单独提示 */
const lonelyKeys = refKeys.filter((k) => origins[k].length === 1);

const report = files.map((f) => {
  const map = locales[f];
  if (!map) return { file: f, missing: refKeys, empty: [] };
  const missing = refKeys.filter((k) => !(k in map));
  const empty = Object.keys(map).filter((k) => map[k] === '' || map[k] === null);
  return { file: f, missing, empty };
});

if (jsonOut) {
  console.log(JSON.stringify({ totalKeys: refKeys.length, lonelyKeys, origins, parseErrors, report }, null, 2));
} else {
  console.log(`基准: ${files.length} 个文件键的并集，共 ${refKeys.length} 个键\n`);

  for (const e of parseErrors) console.log(`✗ ${e.file}  JSON 解析失败: ${e.error}`);

  let hasProblem = false;
  for (const r of report) {
    if (!r.missing.length && !r.empty.length) {
      console.log(`✓ ${r.file}  完整（${Object.keys(locales[r.file] ?? {}).length} 个键）`);
      continue;
    }
    hasProblem = true;
    console.log(`✗ ${r.file}（${Object.keys(locales[r.file] ?? {}).length} 个键）`);
    if (r.missing.length) {
      console.log(`    缺失 ${r.missing.length} 个键:`);
      r.missing.forEach((k) => console.log(`      - ${k}${showOrigin ? `  (存在于: ${origins[k].join(', ')})` : ''}`));
    }
    if (r.empty.length) {
      console.log(`    空值 ${r.empty.length} 个键:`);
      r.empty.forEach((k) => console.log(`      ~ ${k}`));
    }
    console.log('');
  }

  if (lonelyKeys.length) {
    console.log(`⚠ 以下 ${lonelyKeys.length} 个键只存在于单个文件中（可能是残留或漏翻）:`);
    lonelyKeys.forEach((k) => console.log(`    ${k}  ← 仅 ${origins[k][0]}`));
    console.log('');
  }

  if (!hasProblem && !parseErrors.length) console.log('所有语言文件键完整一致。');
}

const hasMissing = report.some((r) => r.missing.length) || parseErrors.length;
process.exit(strict && hasMissing ? 1 : 0);
