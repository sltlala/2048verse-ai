'use strict';
// 修正版: 用左右交替滑动 (保证每步都有效) 测滑动时长下限 + 等待时长下限
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ADB = process.env.ADB || 'D:\\Program_software\\platform-tools\\adb.exe';
const run = (args) => execFileSync(ADB, args, { maxBuffer: 128 * 1024 * 1024 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cap = () => PNG.sync.read(run(['exec-out', 'screencap', '-p']));
function diffRatio(a, b) {
  let d = 0; const n = Math.min(a.data.length, b.data.length);
  for (let i = 0; i < n; i += 4) if (Math.abs(a.data[i] - b.data[i]) > 12) d++;
  return d / (n / 4);
}
// 左滑后右滑交替, 保证每次都是有效移动
function swipe(dir, dur) {
  if (dir === 'L') run(['shell', 'input', 'swipe', '900', '1610', '350', '1610', String(dur)]);
  else run(['shell', 'input', 'swipe', '350', '1610', '900', '1610', String(dur)]);
}

(async () => {
  console.log('=== 滑动时长测试 (左右交替, 保证有效) ===');
  let dir = 'R';
  for (const dur of [80, 120, 160, 220]) {
    const a = cap();
    const t0 = Date.now();
    swipe(dir, dur);
    const swipeMs = Date.now() - t0;
    await sleep(250);
    const b = cap();
    const d = diffRatio(a, b);
    console.log(`  时长 ${String(dur).padStart(3)}ms: 命令阻塞 ${swipeMs}ms, 变化 ${(d * 100).toFixed(1)}%  ${d > 0.02 ? '✓ 生效' : '✗ 无效(或该方向本就无变化)'}`);
    dir = dir === 'R' ? 'L' : 'R';
    await sleep(200);
  }

  console.log('\n=== 等待时长测试 (滑动 150ms 后, 多短等待就够) ===');
  for (const wait of [60, 100, 150, 250]) {
    const a = cap();
    swipe(dir, 150);
    await sleep(wait);
    const b = cap();
    const d = diffRatio(a, b);
    console.log(`  等待 ${String(wait).padStart(3)}ms: 变化 ${(d * 100).toFixed(1)}%  ${d > 0.02 ? '✓' : '✗'}`);
    dir = dir === 'R' ? 'L' : 'R';
    await sleep(300);
  }
  console.log('\n(注: 变化率低也可能是该方向无可动方块, 需结合上下文判断)');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
