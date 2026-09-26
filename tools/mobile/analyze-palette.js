'use strict';
// 分析 data.unity3d 中疑似调色板数组的区域
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '..', 'mobile-shots', 'apk', 'assets', 'bin', 'Data', 'data.unity3d');
const buf = fs.readFileSync(file);
const CENTER = 21571131;
const RANGE = 3000;

const hex3 = (o) => '#' + [buf[o], buf[o + 1], buf[o + 2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
// 判断是否像"方块底色": 三通道都在合理范围且不是纯黑/纯白/灰
const looksLikeTile = (o) => {
  const r = buf[o], g = buf[o + 1], b = buf[o + 2];
  if (r === g && g === b) return false;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx > 180 && (mx - mn) > 40;      // 偏亮且有饱和度
};

console.log(`文件: ${path.basename(file)}  ${Math.round(buf.length / 1024 / 1024)} MB`);
console.log(`\n=== 区域 ${CENTER - RANGE} .. ${CENTER + RANGE} 内的疑似颜色 ===`);

const found = [];
for (let o = CENTER - RANGE; o < CENTER + RANGE; o++) {
  if (looksLikeTile(o)) found.push(o);
}
// 合并相邻偏移 (同一个颜色可能连续多字节命中)
const merged = [];
for (const o of found) {
  if (merged.length && o - merged[merged.length - 1] <= 4) continue;
  merged.push(o);
}
console.log(`共 ${merged.length} 个候选位置:\n`);
for (const o of merged) {
  // 顺便看看该位置附近有没有 float32 的 2 的幂 (方块数值 2,4,8...2048)
  let numNear = '';
  for (let k = -40; k <= 40; k += 4) {
    const p = o + k;
    if (p < 0 || p + 4 > buf.length) continue;
    const f = buf.readFloatLE(p);
    if (f >= 1.9 && f <= 8192 && Math.abs(f - Math.pow(2, Math.round(Math.log2(f)))) < 0.01) {
      numNear += ` f32@${k}=${f}`;
    }
  }
  const d = o - CENTER;
  console.log(`  ${String(o).padStart(9)} (相对 ${String(d).padStart(6)})  ${hex3(o)}` +
    `  rgb(${buf[o]},${buf[o + 1]},${buf[o + 2]})${numNear}`);
}

// 尝试: 按固定步长扫描, 找出重复间隔
console.log('\n=== 候选间隔分析 (寻找步长规律) ===');
for (const step of [16, 20, 24, 28, 32, 33, 36, 40, 48, 64]) {
  let hits = 0;
  for (let o = CENTER - 400; o < CENTER + 400; o += step) {
    if (looksLikeTile(o)) hits++;
  }
  if (hits >= 3) console.log(`  步长 ${step}: ${hits} 个颜色候选`);
}
