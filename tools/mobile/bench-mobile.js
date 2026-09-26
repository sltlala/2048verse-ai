'use strict';
// 测量手机端各环节耗时, 找优化点
const { execFileSync } = require('child_process');
const path = require('path');

const ADB = process.env.ADB || 'D:\\Program_software\\platform-tools\\adb.exe';
const run = (args, opts = {}) => execFileSync(ADB, args, { maxBuffer: 128 * 1024 * 1024, ...opts });

function bench(name, fn, n = 3) {
  const times = [];
  let size = 0;
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    const out = fn();
    times.push(Date.now() - t);
    if (Buffer.isBuffer(out)) size = out.length;
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(`  ${name.padEnd(38)} ${String(avg).padStart(5)}ms  ${times.join('/')}ms` + (size ? `  ${Math.round(size / 1024)}KB` : ''));
  return avg;
}

console.log('=== screencap 帮助 ===');
try {
  const h = run(['shell', 'screencap', '-h']).toString('utf8');
  console.log(h.split('\n').slice(0, 10).map(l => '  ' + l).join('\n') || '  (无输出)');
} catch (e) { console.log('  ' + e.message.split('\n')[0]); }

console.log('\n=== 各环节耗时 ===');
bench('adb 客户端启动 (shell echo)', () => run(['shell', 'echo', '1']).toString());
bench('截图 PNG (exec-out screencap -p)', () => run(['exec-out', 'screencap', '-p']));
bench('截图 RAW (exec-out screencap)', () => run(['exec-out', 'screencap']));
bench('滑动 (input swipe)', () => run(['shell', 'input', 'swipe', '900', '1610', '350', '1610', '220']).toString());
bench('点击 (input tap)', () => run(['shell', 'input', 'tap', '630', '1610']).toString());

console.log('\n=== 参考: 当前 bot 每步 ~1200ms 的构成 ===');
console.log('  截图 ~450ms + 识别 ~60ms + 思考 ~120ms + 等待 260ms + 滑动 ~30ms + 循环开销');
