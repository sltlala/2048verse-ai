'use strict';
// 棋盘校准 v2: 用"颜色众数"提取每格底色 (避免被大号白字笔画干扰)
// 用法: node tools/mobile/calibrate.js [图片路径]
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..', '..');
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'mobile-shots', 'game1.png');

const png = PNG.sync.read(fs.readFileSync(file));
const { width: W, height: H, data } = png;
console.log(`图片: ${path.basename(file)}  ${W} x ${H}`);

const px = (x, y) => {
  const i = (Math.floor(y) * W + Math.floor(x)) * 4;
  return [data[i], data[i + 1], data[i + 2]];
};
const hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();

// --- 找棋盘矩形 ---
const isLight = ([r, g, b]) => r > 195 && g > 195 && b > 195;
let top = -1, bottom = -1, left = -1, right = -1;
for (let y = 0; y < H; y++) {
  let cnt = 0;
  for (let x = 0; x < W; x += 4) if (isLight(px(x, y))) cnt++;
  if (cnt > (W / 4) * 0.5) { if (top < 0) top = y; bottom = y; }
}
for (let x = 0; x < W; x++) {
  let cnt = 0;
  for (let y = top; y <= bottom; y += 4) if (isLight(px(x, y))) cnt++;
  if (cnt > ((bottom - top) / 4) * 0.5) { if (left < 0) left = x; right = x; }
}
const boardW = right - left, boardH = bottom - top;
console.log(`棋盘矩形: x ${left}..${right} (${boardW})  y ${top}..${bottom} (${boardH})`);

// --- 逐格取颜色众数 (量化到 8 的倍数以抗噪) ---
function modeColor(x0, y0, x1, y1) {
  const hist = new Map();
  let total = 0;
  for (let y = Math.ceil(y0); y < y1; y++) {
    for (let x = Math.ceil(x0); x < x1; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const [r, g, b] = px(x, y);
      const k = `${r >> 3},${g >> 3},${b >> 3}`;
      const e = hist.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      hist.set(k, e);
      total++;
    }
  }
  let best = null;
  for (const e of hist.values()) if (!best || e.n > best.n) best = e;
  return {
    rgb: [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)],
    share: +(best.n / total).toFixed(3),
  };
}

console.log('\n=== 逐格底色 (众数) ===');
const grid = [];
for (let r = 0; r < 4; r++) {
  const row = [];
  const line = [];
  for (let c = 0; c < 4; c++) {
    // 内缩 18% 避开格子边框与间隙
    const cx0 = left + boardW * c / 4, cx1 = left + boardW * (c + 1) / 4;
    const cy0 = top + boardH * r / 4, cy1 = top + boardH * (r + 1) / 4;
    const padX = (cx1 - cx0) * 0.18, padY = (cy1 - cy0) * 0.18;
    const m = modeColor(cx0 + padX, cy0 + padY, cx1 - padX, cy1 - padY);
    row.push({ r, c, ...m, hex: hex(m.rgb), centerX: Math.round((cx0 + cx1) / 2), centerY: Math.round((cy0 + cy1) / 2) });
    line.push(hex(m.rgb).padEnd(8));
  }
  grid.push(row);
  console.log(`  行${r}: ${line.join(' ')}`);
}

console.log('\n=== 明细 (含"该色占比", 低占比说明取色不可靠) ===');
grid.forEach(row => row.forEach(cell => {
  console.log(`  (${cell.r},${cell.c}) ${cell.hex} 占比 ${cell.share}  中心(${cell.centerX},${cell.centerY})`);
}));

const freq = {};
grid.flat().forEach(cell => { freq[cell.hex] = (freq[cell.hex] || 0) + 1; });
console.log('\n=== 颜色频次 ===');
Object.entries(freq).sort((a, b) => b[1] - a[1]).forEach(([h, n]) => console.log(`  ${h}  ×${n}`));

const out = {
  file: path.basename(file),
  screen: { W, H },
  board: { left, top, right, bottom, width: boardW, height: boardH },
  cells: grid.map(row => row.map(c => ({ r: c.r, c: c.c, x: c.centerX, y: c.centerY, hex: c.hex, share: c.share }))),
  colors: grid.map(row => row.map(c => c.hex)),
};
const outFile = path.join(ROOT, 'mobile-shots', 'calibration.json');
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`\n已保存: ${path.relative(ROOT, outFile)}`);
