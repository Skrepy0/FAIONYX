#!/usr/bin/env node
// scripts/scan-zh-i18n.cjs
// 扫描渲染层 / 共享层 / 主进程源码中的中文字符串，报告未外置的硬编码文案。
//
// 用法：
//   node scripts/scan-zh-i18n.cjs                      默认：剥离所有注释后扫描
//   node scripts/scan-zh-i18n.cjs --comments           保留所有注释一起扫描
//   node scripts/scan-zh-i18n.cjs --comments --skip-jsdoc
//                                                      --comments 下再屏蔽 JSDoc（/** ... */）
//   node scripts/scan-zh-i18n.cjs --scope=renderer     仅扫 src/renderer/src
//   node scripts/scan-zh-i18n.cjs --scope=main         仅扫 src/main
//   node scripts/scan-zh-i18n.cjs --json               机器可读输出
//   node scripts/scan-zh-i18n.cjs --check              发现未外置文案时退出码 1（CI 用）
//   node scripts/scan-zh-i18n.cjs --help               显示帮助

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SCAN_DIRS_BY_SCOPE = {
  all: ['src/renderer/src', 'src/shared', 'src/main'],
  renderer: ['src/renderer/src'],
  shared: ['src/shared'],
  main: ['src/main'],
};

const EXTS = ['.vue', '.ts', '.tsx', '.js'];

// 覆盖：CJK 标点、扩展 A、统一表意文字、兼容表意文字、全角标点/数字/字母
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/;

// 精确路径白名单
const ALLOWLIST_FILES = [
  'src/main/core/community-zh.ts', // 中文社区数据源
  'src/shared/updateNotes.ts', // 中文更新日志
];

// 目录白名单（目录下所有文件跳过）
const ALLOWLIST_DIRS = [
  // 例如：'src/renderer/src/locales/',
];

// 行级跳过规则（不区分注释 / 代码，整行豁免）
const SKIP_LINE_PATTERNS = [
  /keywords\s*:/, // settingsCatalog 的搜索关键词本来就是中文
];

// ---------------------------------------------------------------------------
// CLI 参数解析
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    `
扫描源码中的中文硬编码文案。

用法：node scripts/scan-zh-i18n.cjs [options]

选项：
  --comments             保留注释一起扫描（默认会剥离所有注释）
  --skip-jsdoc           与 --comments 配合，屏蔽 JSDoc（/** ... */），保留其他注释
  --scope=all|renderer|shared|main
                         按目录范围扫描（默认 all）
  --json                 机器可读 JSON 输出
  --check                发现未外置文案时退出码 1（CI 用）
  --help, -h             显示本帮助
`.trim()
  );
  process.exit(0);
}

const includeComments = args.includes('--comments');
const skipJsDoc = args.includes('--skip-jsdoc');
const jsonOut = args.includes('--json');
const checkMode = args.includes('--check');

const scopeArg = args.find((a) => a.startsWith('--scope='));
const scope = scopeArg ? scopeArg.slice('--scope='.length) : 'all';
const SCAN_DIRS = SCAN_DIRS_BY_SCOPE[scope];
if (!SCAN_DIRS) {
  console.error(`未知 --scope 值：${scope}（可选：all / renderer / shared / main）`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 状态机剥离注释
//   mode = 'all'         剥离行注释、块注释、JSDoc、HTML 注释
//   mode = 'jsdoc-only'  仅剥离 JSDoc（/** ... */），保留其他
//   mode = 'none'        不剥离（保留一切）
// 剥离后以等长空白占位（保留换行），保证行号与原始文件一致。
// ---------------------------------------------------------------------------
function stripComments(code, mode = 'all') {
  if (mode === 'none') return code;

  const out = [];
  const len = code.length;
  let i = 0;

  const blank = (from, to) => {
    for (let k = from; k < to; k++) out.push(code.charCodeAt(k) === 10 ? '\n' : ' ');
  };
  const copy = (from, to) => {
    for (let k = from; k < to; k++) out.push(code[k]);
  };

  while (i < len) {
    const ch = code[i];
    const nx = code[i + 1];

    // 行注释 //
    if (ch === '/' && nx === '/') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      if (mode === 'jsdoc-only') copy(start, i);
      else blank(start, i);
      continue;
    }

    // 块注释 /* ... */ 或 JSDoc /** ... */
    if (ch === '/' && nx === '*') {
      const isJsDoc = code[i + 2] === '*';
      const start = i;
      i += 2;
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i++;
      if (i < len) i += 2;

      const shouldStrip = mode === 'all' || (mode === 'jsdoc-only' && isJsDoc);
      if (shouldStrip) blank(start, i);
      else copy(start, i);
      continue;
    }

    // HTML / Vue 模板注释 <!-- ... -->
    if (ch === '<' && code[i + 1] === '!' && code[i + 2] === '-' && code[i + 3] === '-') {
      const start = i;
      i += 4;
      while (i < len && !(code[i] === '-' && code[i + 1] === '-' && code[i + 2] === '>')) i++;
      if (i < len) i += 3;
      if (mode === 'jsdoc-only') copy(start, i);
      else blank(start, i);
      continue;
    }

    // 字符串字面量：跳过内部，避免把字符串里的 // 或 /* 当注释
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out.push(ch);
      i++;
      while (i < len) {
        const c = code[i];
        if (c === '\\' && i + 1 < len) {
          out.push(c, code[i + 1]);
          i += 2;
          continue;
        }
        out.push(c);
        i++;
        if (c === quote) break;
      }
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join('');
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      yield* walk(p);
    } else if (EXTS.includes(path.extname(e.name))) {
      yield p;
    }
  }
}

function isAllowed(rel) {
  if (ALLOWLIST_FILES.includes(rel)) return true;
  return ALLOWLIST_DIRS.some((d) => rel.startsWith(d));
}

/** 决定每份源码使用哪种剥离模式 */
function pickStripMode() {
  if (!includeComments) return 'all';
  if (skipJsDoc) return 'jsdoc-only';
  return 'none';
}

const results = [];
const STRIP_MODE = pickStripMode();

for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;

  for (const file of walk(abs)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (isAllowed(rel)) continue;

    const raw = fs.readFileSync(file, 'utf8');
    const code = stripComments(raw, STRIP_MODE);

    const codeLines = code.split('\n');
    const rawLines = raw.split('\n');

    codeLines.forEach((line, i) => {
      if (!CJK.test(line)) return;
      if (SKIP_LINE_PATTERNS.some((re) => re.test(line))) return;
      results.push({
        file: rel,
        line: i + 1,
        text: (rawLines[i] ?? '').trim().slice(0, 160),
      });
    });
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
if (jsonOut) {
  console.log(JSON.stringify(results, null, 2));
} else {
  let cur = '';
  for (const r of results) {
    if (r.file !== cur) {
      cur = r.file;
      console.log(`\n${r.file}`);
    }
    console.log(`  ${r.line}: ${r.text}`);
  }
  const fileCount = new Set(results.map((r) => r.file)).size;
  const modeDesc = STRIP_MODE === 'all' ? '已剥离注释' : STRIP_MODE === 'jsdoc-only' ? '已屏蔽 JSDoc，保留其他注释' : '保留所有注释';
  console.log(`\n共 ${results.length} 处中文文本，分布在 ${fileCount} 个文件（scope=${scope}，${modeDesc}）。`);
}

if (checkMode && results.length > 0) process.exit(1);
process.exit(0);
