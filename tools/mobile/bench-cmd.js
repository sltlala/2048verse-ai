'use strict';
// 手机端命令耗时基准: 截图 / 滑动 / 点击
// 用法: node tools/mobile/bench-cmd.js [轮数]
const { execFileSync, execFile } = require('child_process');
const ADB = 'D:\\Program_software\\platform-tools\\adb.exe';

const N = parseInt(process.argv[2] || '6', 10);
const t = (label, fn, n = N) => {
  const xs = [];
  for (let i = 0; i < n; i++) {
    const a = Date.now();
    const r = fn();
    xs.push(Date.now() - a);
    if (i === 0 && r !== undefined) process.stdout.write(`  [${label} 返回 ${r} 字节] `);
  }
  xs.sort((a, b) => a - b);
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`${label.padEnd(34)} 平均 ${avg.toFixed(0).padStart(5)}ms  最快 ${String(xs[0]).padStart(4)}  最慢 ${String(xs[xs.length - 1]).padStart(4)}`);
  return avg;
};

const cap = (args) => {
  const b = execFileSync(ADB, args, { maxBuffer: 1 << 28 });
  return b.length;
};

(async () => {
  console.log(`=== adb 命令基准 (${N} 轮) ===`);
  t('adb devices (纯进程开销)', () => execFileSync(ADB, ['devices']).length);
  t('exec-out screencap -p (PNG)', () => cap(['exec-out', 'screencap', '-p']));
  t('exec-out screencap (RAW)', () => cap(['exec-out', 'screencap']), 2);
  t('shell screencap -p /sdcard/b.png', () => execFileSync(ADB, ['shell', 'screencap', '-p', '/sdcard/b.png']).length);
  t('shell input swipe 100ms', () => execFileSync(ADB, ['shell', 'input', 'swipe', '500', '1900', '500', '1300', '100']).length);
  t('shell input swipe 60ms', () => execFileSync(ADB, ['shell', 'input', 'swipe', '500', '1900', '500', '1300', '60']).length);
  t('shell input tap', () => execFileSync(ADB, ['shell', 'input', 'tap', '630', '1610']).length);
  t('shell echo (shell 往返)', () => execFileSync(ADB, ['shell', 'echo', 'x']).length);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
