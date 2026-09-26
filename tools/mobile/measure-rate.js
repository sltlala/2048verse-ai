'use strict';
// 实测手机 App "生成 4" 的真实概率
//
// 原理: 每一步走完后, 用 ai.simulateMove 算出"落子后、生成新方块前"的棋盘,
//       和截图识别的实际棋盘一比, 差异格就是刚生成的新方块, 直接读出它是 2 还是 4。
//       这样每一步都能拿到 1 个样本, 完全不需要额外操作。
//
// 用法:
//   node tools/mobile/measure-rate.js 400          # 采样 400 步
//   node tools/mobile/measure-rate.js 400 --budget 60
//
// 结果会追加到 mobile-spawn-stats.json (累计统计)
const fs = require('fs');
const path = require('path');
const { DeviceShell, Capture } = require('./shell');
const boardLib = require('./board');
const ai = require('../../ai');

const ROOT = path.join(__dirname, '..', '..');
const STATS = path.join(ROOT, 'mobile-spawn-stats.json');
const TARGET = parseInt(process.argv[2] || '300', 10);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BUDGET = parseInt(arg('budget', '60'), 10);
const SWIPE_MS = parseInt(arg('swipe-ms', '60'), 10);
const SETTLE = parseInt(arg('settle', '120'), 10);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const B = boardLib.BOARD;
const CX = Math.round((B.left + B.right) / 2);
const CY = Math.round((B.top + B.bottom) / 2);
const D = Math.round((B.right - B.left) * 0.30);

const sh = new DeviceShell({ timeoutMs: 5000 }).start();
const cap = new Capture();

const read = async () => boardLib.readBoardFast(await cap.shot());

async function swipe(dir) {
  let x1, y1, x2, y2;
  if (dir === 0) { x1 = CX; y1 = CY + D; x2 = CX; y2 = CY - D; }
  else if (dir === 1) { x1 = CX; y1 = CY - D; x2 = CX; y2 = CY + D; }
  else if (dir === 2) { x1 = CX + D; y1 = CY; x2 = CX - D; y2 = CY; }
  else { x1 = CX - D; y1 = CY; x2 = CX + D; y2 = CY; }
  await sh.run(`input swipe ${x1} ${y1} ${x2} ${y2} ${SWIPE_MS}`);
}

// 返回新方块的值 (2/4), 识别不出返回 0
function spawnValue(before, dir, after) {
  const expected = ai.simulateMove(before, dir).values;
  let cell = -1, val = 0;
  for (let i = 0; i < 16; i++) {
    if (after[i] === expected[i]) continue;
    if (expected[i] !== 0) return 0;            // 原有方块被改动 -> 不可信
    if (after[i] !== 2 && after[i] !== 4) return 0;
    if (cell >= 0) return 0;                    // 多于一个差异 -> 不可信
    cell = i; val = after[i];
  }
  return val;
}

(async () => {
  await sleep(400);
  let n = 0, fours = 0, twos = 0, bad = 0, dead = 0, resets = 0;
  const t0 = Date.now();

  while (n < TARGET) {
    let r = await read();
    if (r.covered) { console.log('界面被面板盖住, 请先关掉手机上的弹窗'); break; }
    const board = r.board;
    if (Math.max(...board) === 0) { console.log('棋盘识别为空, 请确认游戏在前台'); break; }

    const dec = ai.getBestMove(board, BUDGET);
    if (dec.dir === null || dec.dir === undefined) {
      // 真死局: 点"重置"开新局继续采样
      dead++;
      if (dead > 3) { console.log('连续死局, 停止'); break; }
      console.log(`  [第 ${dead} 次死局] 点重置开新局继续采样`);
      await sh.run(`input tap ${boardLib.UI.reset.x} ${boardLib.UI.reset.y}`);
      await sleep(1200);
      resets++;
      continue;
    }
    dead = 0;

    await swipe(dec.dir);
    await sleep(SETTLE);
    const a = await read();
    const v = spawnValue(board, dec.dir, a.board);
    if (v === 2) twos++;
    else if (v === 4) fours++;
    else bad++;
    n++;

    if (n % 50 === 0) {
      const rate = 100 * fours / Math.max(1, twos + fours);
      console.log(`  样本 ${n}: 2 x${twos}, 4 x${fours}  -> 4 占 ${rate.toFixed(2)}%  (不可信 ${bad}, 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }

  const valid = twos + fours;
  const rate = valid ? fours / valid : 0;
  const se = valid ? Math.sqrt(rate * (1 - rate) / valid) : 0;
  const ci = 1.96 * se;
  console.log(`\n=== 本次结果 ===`);
  console.log(`有效样本 ${valid}  其中 2 x${twos}, 4 x${fours}`);
  console.log(`生成 4 的概率 = ${(rate * 100).toFixed(2)}%   95% 置信区间 ±${(ci * 100).toFixed(2)}%`);
  console.log(`不可信样本 ${bad} 次 (动画中间帧/识别异常), 死局重开 ${resets} 次`);
  console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(0)}s (${(n / ((Date.now() - t0) / 1000)).toFixed(2)} 步/秒)`);

  let all = { twos: 0, fours: 0, runs: 0, updatedAt: null };
  try { all = { ...all, ...JSON.parse(fs.readFileSync(STATS, 'utf8')) }; } catch (_) {}
  all.twos += twos; all.fours += fours; all.runs += 1; all.updatedAt = new Date().toISOString();
  const ar = all.fours / Math.max(1, all.twos + all.fours);
  console.log(`\n=== 累计 (${all.runs} 次运行) ===`);
  console.log(`2 x${all.twos}, 4 x${all.fours}  -> 生成 4 的概率 = ${(ar * 100).toFixed(2)}%` +
    `  (±${(196 * Math.sqrt(ar * (1 - ar) / Math.max(1, all.twos + all.fours))).toFixed(2)}%)`);
  fs.writeFileSync(STATS, JSON.stringify(all, null, 2));
  console.log(`已写入 ${path.relative(ROOT, STATS)}`);
  console.log(`\n设置建议: ai.setFourRate(${Math.round(ar * 100)})   (bot-mobile.js 里的 --p4)`);
  sh.close();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); sh.close(); process.exit(1); });
