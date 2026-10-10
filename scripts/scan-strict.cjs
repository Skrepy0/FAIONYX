#!/usr/bin/env node
// 临时：更严格的中文扫描（去除 HTML 注释/块注释/行注释，跳过 keywords）
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src/renderer/src', 'src/shared', 'src/main'];
const EXTS = ['.vue', '.ts', '.tsx', '.js'];
const CJK = /[一-龥]/;
const SKIP = [/keywords\s*:/];

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      yield* walk(p);
    } else if (EXTS.includes(path.extname(e.name))) yield p;
  }
}

const out = [];
for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of walk(abs)) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    let raw = fs.readFileSync(f, 'utf8');
    raw = raw.replace(/<!--[\s\S]*?-->/g, (m) => '\n'.repeat(m.split('\n').length - 1));
    raw = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1));
    raw = raw.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    raw.split('\n').forEach((l, i) => {
      if (!CJK.test(l)) return;
      if (SKIP.some((r) => r.test(l))) return;
      out.push({ f: rel, line: i + 1, text: l.trim() });
    });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 1));
} else {
  const by = {};
  for (const x of out) by[x.f] = (by[x.f] || 0) + 1;
  console.log('TOTAL', out.length);
  Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .forEach(([f, c]) => console.log(c, f));
}
