'use strict';
// 手机 2048 自动玩 (Android + adb + 截图识别 + ai.js)
//
// 用法:
//   node tools/mobile/bot-mobile.js                 # 自动玩, 死局后自动开新局
//   node tools/mobile/bot-mobile.js --moves 30      # 只走 30 步
//   node tools/mobile/bot-mobile.js --budget 150    # AI 每步思考时间(ms)
//   node tools/mobile/bot-mobile.js --discover      # 只识别不操作(收集未知颜色)
//   node tools/mobile/bot-mobile.js --probe         # 打印每步"滑动->确认"耗时, 用于调参
//   node tools/mobile/bot-mobile.js --no-restart    # 死局后退出, 不开新局
//
// 加速要点:
//   1. 每步只截一次图: 滑动后的"确认截图"直接作为下一步输入
//   2. 截图直连 adb server 的 5037 端口 (adbraw.js), 省掉每次启动 adb.exe 的 ~76ms
//   3. 识别只解棋盘区域 (board.js 的 decodeRegion), 不再整屏解码 14MB
//   4. 滑动/点击走常驻 adb shell 通道 (shell.js), 再省一次进程启动
//   5. 用 ai.simulateMove 精确校验落子结果, 等待时间可以压到最小
//
// 实测: 0.83 步/秒 -> 1.58 步/秒 (1260x2800 竖屏, vivo V2339FA)
//
// 关键点:
//   - Unity 游戏读不到控件, 只能截图识别 (tools/mobile/board.js)
//   - 遇到未知颜色会暂停并把样本存到 mobile-shots/unknown/, 需人工补映射表
//   - 输入用 adb shell input swipe
const fs = require('fs');
const path = require('path');
const { adb } = require('./shot');
const { DeviceShell, Capture } = require('./shell');
const boardLib = require('./board');
const ai = require('../../ai');

const ROOT = path.join(__dirname, '..', '..');
const SHOT_DIR = path.join(ROOT, 'mobile-shots');
const UNKNOWN_DIR = path.join(SHOT_DIR, 'unknown');
const RESULT_LOG = path.join(ROOT, 'mobile-results.jsonl');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const MAX_MOVES = parseInt(arg('moves', '100000'), 10);
const BUDGET = parseInt(arg('budget', '80'), 10);
const DISCOVER_ONLY = argv.includes('--discover');
const PROBE = argv.includes('--probe');
const RESTART = !argv.includes('--no-restart');
const USE_SHELL = arg('shell', 'on') !== 'off';
const SWIPE_MS = parseInt(arg('swipe-ms', '60'), 10);       // 实测 60ms 稳定生效 (原 220ms; 40ms 偶尔丢)
const SETTLE_MS = parseInt(arg('settle', '120'), 10);        // 滑动后首次等待 (直连截图没有隐含延迟了, 需要留出动画时间)
const RETRY_WAIT = parseInt(arg('retry-wait', '90'), 10);   // 未确认时的追加等待
const MAX_RETRY = parseInt(arg('retry', '4'), 10);
const RESTART_WAIT = parseInt(arg('restart-wait', '900'), 10);

ai.setFourRate(10);   // 标准 2048 规则 (若该 App 是 20% 可改)

const B = boardLib.BOARD;
const CX = Math.round((B.left + B.right) / 2);
const CY = Math.round((B.top + B.bottom) / 2);
const D = Math.round((B.right - B.left) * 0.30);   // 滑动距离约 1.2 格

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const timing = { capture: 0, read: 0, think: 0, swipe: 0, wait: 0, restart: 0 };
let retryCount = 0, probeMax = 0, probeSum = 0, probeN = 0, inputFallback = 0;

// 常驻 adb shell: 只发输入命令 (swipe/tap)
const sh = USE_SHELL
  ? new DeviceShell({ timeoutMs: 5000 }).start()
  : { broken: true, stats: { runs: 0 }, run: () => Promise.reject(new Error('已用 --shell off 关闭')), close() {} };

// 截图器: 默认直连 adb server 的 5037 端口 (比启动 adb.exe 快 ~72ms), 失败自动退回
const cap = new Capture();

async function capturePng() {
  const t = Date.now();
  const buf = await cap.shot();
  timing.capture += Date.now() - t;
  return buf;
}

// 只用棋盘区域做识别 (board.js 的快速解码, 省掉整屏 90ms 的解码)
function readBoard(buf) {
  const t = Date.now();
  const r = boardLib.readBoardFast(buf);
  timing.read += Date.now() - t;
  return r;
}

// 发一条输入命令 (优先常驻通道, 通道坏了就退回一次性 adb 调用)
async function inputCmd(cmd, oneShotArgs) {
  const t = Date.now();
  try {
    if (sh.broken) throw new Error('通道不可用');
    const out = await sh.run(cmd);
    if (/^error/i.test(out)) console.log(`  ⚠ 设备返回: ${out}`);
  } catch (e) {
    inputFallback++;
    if (USE_SHELL) console.log(`  ⚠ 常驻通道失效 (${e.message}), 本步用一次性 adb`);
    adb(oneShotArgs);
  }  timing.swipe += Date.now() - t;
}

async function swipeDir(dir) {
  // ai.js: 0=上 1=下 2=左 3=右
  let x1, y1, x2, y2;
  if (dir === 0) { x1 = CX; y1 = CY + D; x2 = CX; y2 = CY - D; }
  else if (dir === 1) { x1 = CX; y1 = CY - D; x2 = CX; y2 = CY + D; }
  else if (dir === 2) { x1 = CX + D; y1 = CY; x2 = CX - D; y2 = CY; }
  else { x1 = CX - D; y1 = CY; x2 = CX + D; y2 = CY; }
  const cmd = `input swipe ${x1} ${y1} ${x2} ${y2} ${SWIPE_MS}`;
  await inputCmd(cmd, ['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(SWIPE_MS)]);
}

// 用 ai.js 的移动规则算出"滑动后、生成新方块前"的棋盘, 用来校验截图结果
function expectedAfter(before, dir) {
  return ai.simulateMove(before, dir).values;
}

// 校验: 实际棋盘必须 = 期望棋盘 + 恰好 1 个新方块(2 或 4)
function checkAfter(actual, expected) {
  let spawns = 0;
  for (let i = 0; i < 16; i++) {
    if (actual[i] === expected[i]) continue;
    if (expected[i] !== 0) return `原有方块位置 ${i} 不符 (期望 ${expected[i]}, 实际 ${actual[i]})`;
    if (actual[i] !== 2 && actual[i] !== 4) return `新增方块值异常 ${actual[i]}`;
    spawns++;
  }
  if (spawns !== 1) return `新增方块数量 ${spawns}`;
  return null;   // null = 校验通过
}

function dumpUnknown(buf, unknown) {
  console.log(`\n⚠️ 出现 ${unknown.length} 个未知颜色, 已保存样本, 请确认数值后补进 board.js 的 COLOR_MAP:`);
  const full = boardLib.decode(buf);          // 只在需要留样本时才整屏解码
  fs.mkdirSync(UNKNOWN_DIR, { recursive: true });
  for (const u of unknown) {
    const f = path.join(UNKNOWN_DIR, `${u.hex.replace('#', '')}_r${u.r}c${u.c}.png`);
    if (!fs.existsSync(f)) {
      boardLib.saveCellCrop(full, u.r, u.c, f);
      console.log(`   ${u.hex}  在 (${u.r},${u.c})  样本: ${path.relative(ROOT, f)}`);
    }
  }
  const shot = path.join(SHOT_DIR, 'unknown-board.png');
  fs.writeFileSync(shot, require('pngjs').PNG.sync.write(full));
  console.log(`   完整截图: ${path.relative(ROOT, shot)}`);
  console.log('   (补齐映射后重新运行即可)');
}

function startNewGame() {
  const t = Date.now();
  const p = boardLib.UI.reset;
  return inputCmd(`input tap ${p.x} ${p.y}`, ['shell', 'input', 'tap', String(p.x), String(p.y)])
    .then(() => { timing.restart += Date.now() - t; });
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  console.log('=== 手机 2048 自动玩 ===');
  console.log(`  棋盘中心 (${CX},${CY})  滑动距离 ${D}px  滑动时长 ${SWIPE_MS}ms  首次等待 ${SETTLE_MS}ms`);
  console.log(`  AI 预算 ${BUDGET}ms/步  最多 ${MAX_MOVES} 步  死局后${RESTART ? '自动开新局' : '退出'}` +
    `${DISCOVER_ONLY ? '  [仅识别模式]' : ''}`);
  console.log('');

  let moves = 0, games = 1, gameMoves = 0, gameStart = Date.now(), blankRestarts = 0;
  const t0 = Date.now();
  // 上一步滑动后的确认截图: 直接给下一步用, 保证每步只截一次图
  let pending = null;

  while (moves < MAX_MOVES) {
    let png, board, colors, unknown;

    if (pending) {
      ({ png, board, colors, unknown } = pending);
      pending = null;
    } else {
      png = await capturePng();
      ({ board, colors, unknown } = readBoard(png));
    }

    if (unknown.length) {
      dumpUnknown(png, unknown);
      sh.close();
      process.exit(2);
    }
    const empty = board.filter(v => v === 0).length;
    const maxTile = Math.max(...board);

    if (DISCOVER_ONLY) {
      console.log(`--- 识别结果 (空格 ${empty}, 最大 ${maxTile}) ---`);
      console.log(boardLib.boardToText(board));
      console.log('  颜色: ' + colors.join(' '));
      if (maxTile === 0) {
        console.log('\n⚠️ 棋盘区域里没有任何方块: 请先把手机上的 2048 打开到游戏界面, 再运行本脚本');
        sh.close();
        process.exit(3);
      }
      sh.close();
      process.exit(0);
    }

    const tt = Date.now();
    const dec = ai.getBestMove(board, BUDGET);
    timing.think += Date.now() - tt;

    if (!dec.dir && dec.dir !== 0) {
      // ---- 死局 ----
      const dur = ((Date.now() - gameStart) / 1000).toFixed(0);
      console.log(`\n🏁 第 ${games} 局死局: ${gameMoves} 步, 最大方块 ${maxTile}, 用时 ${dur}s (总 ${moves} 步)`);
      console.log(boardLib.boardToText(board));
      fs.writeFileSync(path.join(SHOT_DIR, `gameover-${Date.now()}.png`),
        require('pngjs').PNG.sync.write(boardLib.decode(png)));
      try {
        fs.appendFileSync(RESULT_LOG, JSON.stringify({
          endedAt: new Date().toISOString(), game: games, moves: gameMoves,
          maxTile, durationSec: +dur, totalMoves: moves,
        }) + '\n');
      } catch (_) { /* 记录失败不影响继续玩 */ }

      if (!RESTART) break;

      // 连续死局且一步都没走成 -> 多半是"重置"按钮坐标不对, 不能无限点下去
      if (gameMoves === 0) {
        blankRestarts++;
        if (blankRestarts >= 3) {
          console.log('\n⚠️ 连续 3 次开新局后棋盘仍是死局: "重置"按钮坐标可能已过期');
          console.log(`   当前设置: board.js 里的 UI.reset = (${boardLib.UI.reset.x}, ${boardLib.UI.reset.y})`);
          console.log('   请重新截图确认按钮位置 (GAMEOVER 后右侧那个按钮), 或换用 tools/mobile/calibrate.js');
          break;
        }
      } else {
        blankRestarts = 0;
      }

      await startNewGame();
      await sleep(RESTART_WAIT);
      games++; gameMoves = 0; gameStart = Date.now();
      pending = null;
      continue;
    }

    const before = board;
    const expected = expectedAfter(before, dec.dir);
    await swipeDir(dec.dir);
    const swipeDone = Date.now();
    await sleep(SETTLE_MS);
    timing.wait += Date.now() - swipeDone;

    // 精确校验: 直到截图结果 = 期望棋盘 + 1 个新方块 才认为滑动生效
    let tries = 0, reason = null;
    for (;;) {
      const p2 = await capturePng();
      const r2 = readBoard(p2);
      reason = checkAfter(r2.board, expected);
      if (reason === null || tries >= MAX_RETRY) {
        if (PROBE) {
          const dt = Date.now() - swipeDone;
          probeSum += dt; probeN++; if (dt > probeMax) probeMax = dt;
        }
        if (reason !== null) {
          console.log(`  ⚠ 第 ${moves + 1} 步 ${dec.dirName} 校验失败 (重试 ${tries} 次): ${reason}`);
          console.log(`     期望: ${expected.join(',')}`);
          console.log(`     实际: ${r2.board.join(',')}`);
        } else if (tries > 0) {
          retryCount++;
        }
        pending = { png: p2, board: r2.board, colors: r2.colors, unknown: r2.unknown };
        break;
      }
      tries++;
      const tw = Date.now();
      await sleep(RETRY_WAIT + tries * 60);
      timing.wait += Date.now() - tw;
    }
    moves++; gameMoves++;

    if (moves % 10 === 0 || moves <= 5) {
      const per = (k) => (timing[k] / moves).toFixed(0).padStart(3);
      console.log(`步 ${String(moves).padStart(4)} ${dec.dirName}  空格 ${String(empty).padStart(2)}  最大 ${String(maxTile).padStart(4)}  ` +
        `深度${String(dec.depth).padStart(2)}  截图${per('capture')} 识别${per('read')} 思考${per('think')} 滑动${per('swipe')} 等待${per('wait')}ms`);
    }
  }

  const dur = (Date.now() - t0) / 1000;
  console.log(`\n结束: ${moves} 步 / ${games} 局, 用时 ${dur.toFixed(0)}s (${(moves / dur).toFixed(2)} 步/秒)`);
  if (PROBE && probeN) {
    console.log(`滑动->确认: 平均 ${(probeSum / probeN).toFixed(0)}ms  最慢 ${probeMax}ms  (${probeN} 次采样)`);
  }
  console.log(`重试(等待不足)次数: ${retryCount} / ${moves} 步` +
    (USE_SHELL ? `  常驻通道发命令 ${sh.stats.runs} 次, 退回首用 ${inputFallback} 次` : '') +
    `  截图: 直连 ${cap.stats.raw} 次, 退回 adb.exe ${cap.stats.fallback} 次`);
  sh.close();
})().catch(e => { console.error('ERROR:', e.message); sh.close(); process.exit(1); });
