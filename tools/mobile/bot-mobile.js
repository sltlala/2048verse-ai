'use strict';
// 手机 2048 自动玩 (Android + adb + 截图识别 + ai.js)
//
// 用法:
//   node tools/mobile/bot-mobile.js                 # 自动玩, 直到死局
//   node tools/mobile/bot-mobile.js --moves 30      # 只走 30 步
//   node tools/mobile/bot-mobile.js --budget 150    # AI 每步思考时间(ms)
//   node tools/mobile/bot-mobile.js --discover      # 只识别不操作(收集未知颜色)
//
// 关键点:
//   - Unity 游戏读不到控件, 只能截图识别 (tools/mobile/board.js)
//   - 遇到未知颜色会暂停并把样本存到 mobile-shots/unknown/, 需人工补映射表
//   - 输入用 adb shell input swipe
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { adb } = require('./shot');
const boardLib = require('./board');
const ai = require('../../ai');

const ROOT = path.join(__dirname, '..', '..');
const SHOT_DIR = path.join(ROOT, 'mobile-shots');
const UNKNOWN_DIR = path.join(SHOT_DIR, 'unknown');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const MAX_MOVES = parseInt(arg('moves', '100000'), 10);
const BUDGET = parseInt(arg('budget', '120'), 10);
const DISCOVER_ONLY = argv.includes('--discover');
const SWIPE_MS = parseInt(arg('swipe-ms', '220'), 10);
const SETTLE_MS = parseInt(arg('settle', '260'), 10);

ai.setFourRate(10);   // 标准 2048 规则 (若该 App 是 20% 可改)

const B = boardLib.BOARD;
const CX = Math.round((B.left + B.right) / 2);
const CY = Math.round((B.top + B.bottom) / 2);
const D = Math.round((B.right - B.left) * 0.30);   // 滑动距离约 1.2 格

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function capturePng() {
  const buf = adb(['exec-out', 'screencap', '-p']);
  if (!(buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50)) throw new Error('截图数据异常');
  return boardLib.decode(buf);
}

function swipeDir(dir) {
  // ai.js: 0=上 1=下 2=左 3=右
  let x1, y1, x2, y2;
  if (dir === 0) { x1 = CX; y1 = CY + D; x2 = CX; y2 = CY - D; }
  else if (dir === 1) { x1 = CX; y1 = CY - D; x2 = CX; y2 = CY + D; }
  else if (dir === 2) { x1 = CX + D; y1 = CY; x2 = CX - D; y2 = CY; }
  else { x1 = CX - D; y1 = CY; x2 = CX + D; y2 = CY; }
  adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(SWIPE_MS)]);
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  console.log('=== 手机 2048 自动玩 ===');
  console.log(`  棋盘中心 (${CX},${CY})  滑动距离 ${D}px  滑动时长 ${SWIPE_MS}ms`);
  console.log(`  AI 预算 ${BUDGET}ms/步  最多 ${MAX_MOVES} 步${DISCOVER_ONLY ? '  [仅识别模式]' : ''}`);
  console.log('');

  let moves = 0, captureMs = 0, readMs = 0, thinkMs = 0;
  const t0 = Date.now();

  while (moves < MAX_MOVES) {
    const ts = Date.now();
    const png = capturePng();
    captureMs += Date.now() - ts;

    const tr = Date.now();
    const { board, colors, unknown } = boardLib.readBoardFromPng(png);
    readMs += Date.now() - tr;

    if (unknown.length) {
      console.log(`\n⚠️ 出现 ${unknown.length} 个未知颜色, 已保存样本, 请确认数值后补进 board.js 的 COLOR_MAP:`);
      fs.mkdirSync(UNKNOWN_DIR, { recursive: true });
      for (const u of unknown) {
        const f = path.join(UNKNOWN_DIR, `${u.hex.replace('#', '')}_r${u.r}c${u.c}.png`);
        if (!fs.existsSync(f)) {
          boardLib.saveCellCrop(png, u.r, u.c, f);
          console.log(`   ${u.hex}  在 (${u.r},${u.c})  样本: ${path.relative(ROOT, f)}`);
        }
      }
      fs.writeFileSync(path.join(SHOT_DIR, 'unknown-board.png'), require('pngjs').PNG.sync.write(png));
      console.log(`   完整截图: mobile-shots/unknown-board.png`);
      console.log('   (补齐映射后重新运行即可)');
      process.exit(2);
    }

    const empty = board.filter(v => v === 0).length;
    const maxTile = Math.max(...board);

    if (DISCOVER_ONLY) {
      console.log(`--- 识别结果 (空格 ${empty}, 最大 ${maxTile}) ---`);
      console.log(boardLib.boardToText(board));
      console.log('  颜色: ' + colors.join(' '));
      process.exit(0);
    }

    const tt = Date.now();
    const dec = ai.getBestMove(board, BUDGET);
    thinkMs += Date.now() - tt;

    if (!dec.dir && dec.dir !== 0) {
      console.log(`\n🏁 死局 (无可移动方向). 共走 ${moves} 步, 最大方块 ${maxTile}, 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      console.log(boardLib.boardToText(board));
      require('pngjs').PNG.sync.write(png) && fs.writeFileSync(path.join(SHOT_DIR, `gameover-${Date.now()}.png`), require('pngjs').PNG.sync.write(png));
      break;
    }

    const before = board.slice();
    swipeDir(dec.dir);
    await sleep(SETTLE_MS);
    moves++;

    if (moves % 10 === 0 || moves <= 5) {
      const avgCap = (captureMs / moves).toFixed(0), avgRead = (readMs / moves).toFixed(0), avgThink = (thinkMs / moves).toFixed(0);
      console.log(`步 ${String(moves).padStart(4)} ${dec.dirName}  空格 ${String(empty).padStart(2)}  最大 ${String(maxTile).padStart(4)}  ` +
        `深度${dec.depth}  [截图${avgCap}ms 识别${avgRead}ms 思考${avgThink}ms]`);
    }
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n结束: ${moves} 步, 用时 ${dur}s (${(moves / dur).toFixed(2)} 步/秒)`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
