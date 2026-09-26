'use strict';
// 从 Unity APK 中挖掘方块调色板: 用已知颜色作为锚点搜索 float32 序列
const fs = require('fs');
const path = require('path');

// 已知颜色 (来自截图校准)
const KNOWN = {
  '#CDF5F4': 0, '#92F5F4': 2, '#00DCF4': 4, '#00A7F4': 8,
  '#74A0FD': 16, '#0442E5': 128, '#6155DC': 256,
};

function toFloats(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}
function f32(v) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; }

// 搜索锚点: 每个已知颜色取其 (r,g,b) 三连 float32 序列
const anchors = Object.entries(KNOWN).map(([hex, val]) => ({
  hex, val, pat: Buffer.concat(toFloats(hex).map(f32)),
}));

const dir = process.argv[2] || path.join(__dirname, '..', '..', 'mobile-shots', 'apk');
if (!fs.existsSync(dir)) { console.error('目录不存在: ' + dir); process.exit(1); }

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) files.push(p);
  }
})(dir);

console.log(`扫描 ${files.length} 个文件...`);
let totalHits = 0;
const hitsByFile = new Map();

for (const f of files) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  if (buf.length < 12) continue;
  for (const a of anchors) {
    let idx = buf.indexOf(a.pat);
    let n = 0;
    while (idx >= 0 && n < 20) {
      hitsByFile.set(f, (hitsByFile.get(f) || 0) + 1);
      totalHits++; n++;
      idx = buf.indexOf(a.pat, idx + 1);
    }
  }
}

console.log(`\n命中文件数: ${hitsByFile.size}, 命中总数: ${totalHits}`);
for (const [f, n] of [...hitsByFile].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${n} 次  ${path.relative(dir, f)}  (${Math.round(fs.statSync(f).size / 1024)} KB)`);
}

// 对命中最多的文件, 打印锚点附近的 float 序列, 尝试还原整块调色板
const top = [...hitsByFile].sort((a, b) => b[1] - a[1])[0];
if (top) {
  const f = top[0];
  const buf = fs.readFileSync(f);
  console.log(`\n=== 分析 ${path.relative(dir, f)} ===`);
  const seen = new Set();
  for (const a of anchors) {
    let idx = buf.indexOf(a.pat);
    let shown = 0;
    while (idx >= 0 && shown < 3) {
      const key = Math.round(idx / 64);
      if (!seen.has(key)) {
        seen.add(key);
        // 向前后各取 80 字节, 按 float 解释
        const s = Math.max(0, idx - 80), e = Math.min(buf.length, idx + 80 + 12);
        const vals = [];
        for (let o = s; o + 4 <= e; o += 4) vals.push(buf.readFloatLE(o));
        const fmt = vals.map(v => (Math.abs(v) <= 1.0001 && v >= 0) ? v.toFixed(4) : String(Math.round(v)));
        console.log(`\n锚点 ${a.hex} (值${a.val}) @ ${idx}:`);
        console.log('  ' + fmt.join(' '));
      }
      idx = buf.indexOf(a.pat, idx + 1);
      shown++;
    }
  }
}
