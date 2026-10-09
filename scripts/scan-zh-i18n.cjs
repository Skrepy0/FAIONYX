#!/usr/bin/env node
// scripts/scan-zh-i18n.cjs
// 扫描渲染层/共享层源码中的中文字符串，报告未外置的硬编码文案。
// 用法: node scripts/scan-zh-i18n.cjs [--comments] [--json]

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src/renderer/src', 'src/shared', 'src/main'];
const EXTS = ['.vue', '.ts', '.tsx', '.js'];
const CJK = /[一-龥]/;

// 已知"故意为中文"的文件/字段，跳过
const ALLOWLIST = [
  'src/main/core/community-zh.ts', // 中文社区数据源
  'src/shared/updateNotes.ts', // 中文更新日志
];
// settingsCatalog 里 keywords 字段本来就是中文搜索词，不算 UI 文案
const SKIP_LINE_PATTERNS = [/keywords\s*:/];

const args = process.argv.slice(2);
const includeComments = args.includes('--comments');
const jsonOut = args.includes('--json');

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

function stripComments(code) {
  // 粗粒度去除块注释与行注释（可能在极少数边缘情况误伤，用于扫描足够）
  return code.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1)).replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const results = [];

for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (ALLOWLIST.includes(rel)) continue;

    const raw = fs.readFileSync(file, 'utf8');
    const code = includeComments ? raw : stripComments(raw);
    const lines = code.split('\n');
    const rawLines = raw.split('\n');

    lines.forEach((line, i) => {
      if (!CJK.test(line)) return;
      if (SKIP_LINE_PATTERNS.some((re) => re.test(line))) return;
      results.push({
        file: rel,
        line: i + 1,
        text: rawLines[i].trim().slice(0, 120),
      });
    });
  }
}

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
  console.log(`\n共 ${results.length} 处中文文本，分布在 ${new Set(results.map((r) => r.file)).size} 个文件。`);
}

process.exit(0);
