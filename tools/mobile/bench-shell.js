'use strict';
// 对比: 常驻 adb shell 发命令 vs 每次新起 adb 进程
const { DeviceShell, shotOnce } = require('./shell');
const { execFileSync } = require('child_process');
const { ADB } = require('./shot');

(async () => {
  const N = parseInt(process.argv[2] || '6', 10);
  const sh = new DeviceShell().start();
  await new Promise(r => setTimeout(r, 500));

  const t0 = Date.now();
  const banner = await sh.run('echo READY');
  console.log(`通道握手: ${Date.now() - t0}ms, 返回 "${banner}"`);
  if (banner.trim() !== 'READY') { console.log('❌ 哨兵机制异常'); process.exit(1); }

  const once = [], persist = [];
  for (let i = 0; i < N; i++) {
    let t = Date.now();
    execFileSync(ADB, ['shell', 'input', 'swipe', '500', '1900', '500', '1300', '100']);
    once.push(Date.now() - t);
    t = Date.now();
    await sh.run('input swipe 500 1900 500 1300 100');
    persist.push(Date.now() - t);
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`每次新起 adb 进程 swipe: 平均 ${avg(once).toFixed(0)}ms  (${once.join(' ')})`);
  console.log(`常驻 shell swipe       : 平均 ${avg(persist).toFixed(0)}ms  (${persist.join(' ')})`);
  console.log(`加速 ${(avg(once) / avg(persist)).toFixed(2)}x`);

  const c = [];
  for (let i = 0; i < 3; i++) { const t = Date.now(); shotOnce(); c.push(Date.now() - t); }
  console.log(`一次性截图 (保持原样)   : 平均 ${avg(c).toFixed(0)}ms`);
  sh.close();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
