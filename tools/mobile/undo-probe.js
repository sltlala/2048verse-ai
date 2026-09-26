'use strict';
// 实测 "撤回" 按钮的行为:
//   1. 撤回是否把棋盘完全还原 (包括上一步生成的新方块)
//   2. 撤回是否把分数一起还原 (对比记分区像素指纹)
//   3. 能不能连续撤回多次 (撤销栈有多深)
//   4. 撤回按钮用过后外观是否变化 (是否限量/禁用)
//
// 用法: node tools/mobile/undo-probe.js [次数]
// 注意: 会真实操作手机; 如果撤回正常, 棋局会回到原状, 不影响继续玩
const path = require('path');
const { DeviceShell, Capture } = require('./shell');
const boardLib = require('./board');
const ai = require('../../ai');

const N = parseInt(process.argv[2] || '3', 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const B = boardLib.BOARD;
const CX = Math.round((B.left + B.right) / 2);
const CY = Math.round((B.top + B.bottom) / 2);
const D = Math.round((B.right - B.left) * 0.30);
const SWIPE_MS = 60;

// 记分区 (分数大字), 用于判断分数有没有跟着回退
const SCORE = { left: 150, top: 790, right: 620, bottom: 990 };
// 撤回按钮: 实测矩形 x 650..847, y 872..1009
const UNDO_TAP = { x: 748, y: 940 };
const UNDO_SAMPLE = { x: 690, y: 880 };   // 按钮内部偏上, 避开文字

const sh = new DeviceShell({ timeoutMs: 5000 }).start();
const cap = new Capture();

function regionHash(buf, r) {
  const img = boardLib.decodeRegion(buf, r);
  if (!img) return 'n/a';
  return require('crypto').createHash('sha1').update(img.data).digest('hex').slice(0, 10);
}

function pixel(buf, x, y) {
  const img = boardLib.decodeRegion(buf, { left: x, top: y, right: x + 1, bottom: y + 1 });
  return img ? `#${[img.data[0], img.data[1], img.data[2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}` : 'n/a';
}

async function snap() {
  const buf = await cap.shot();
  const board = boardLib.readBoardFast(buf).board;
  return {
    buf, board,
    sum: board.reduce((a, b) => a + b, 0),
    scoreHash: regionHash(buf, SCORE),
    btn: pixel(buf, UNDO_SAMPLE.x, UNDO_SAMPLE.y),
  };
}

async function swipeDir(dir) {
  let x1, y1, x2, y2;
  if (dir === 0) { x1 = CX; y1 = CY + D; x2 = CX; y2 = CY - D; }
  else if (dir === 1) { x1 = CX; y1 = CY - D; x2 = CX; y2 = CY + D; }
  else if (dir === 2) { x1 = CX + D; y1 = CY; x2 = CX - D; y2 = CY; }
  else { x1 = CX - D; y1 = CY; x2 = CX + D; y2 = CY; }
  await sh.run(`input swipe ${x1} ${y1} ${x2} ${y2} ${SWIPE_MS}`);
}

function show(b) { return boardLib.boardToText(b); }

(async () => {
  await sleep(400);
  console.log('=== 撤回(undo) 行为实测 ===\n');

  const s0 = await snap();
  console.log('起始棋盘:');
  console.log(show(s0.board));
  console.log(`  方块总和 ${s0.sum}   记分区指纹 ${s0.scoreHash}   撤回按钮颜色 ${s0.btn}\n`);

  // ---- 连续走 N 步, 记录每一步之前的状态 ----
  const hist = [s0];
  for (let i = 0; i < N; i++) {
    const cur = hist[hist.length - 1];
    const dec = ai.getBestMove(cur.board, 80);
    if (dec.dir === null || dec.dir === undefined) { console.log(`第 ${i + 1} 步已死局, 提前结束`); break; }
    await swipeDir(dec.dir);
    await sleep(200);
    const s = await snap();
    hist.push(s);
    console.log(`走第 ${i + 1} 步 ${dec.dirName}: 空格 ${s.board.filter(v => v === 0).length}  总和 ${s.sum}  记分区 ${s.scoreHash}`);
  }

  const moved = hist.length - 1;
  console.log(`\n--- 连续撤回 ${moved} 次 (从最近一步往回撤) ---`);
  for (let i = 1; i <= moved; i++) {
    const expect = hist[hist.length - 1 - i];
    await sh.run(`input tap ${UNDO_TAP.x} ${UNDO_TAP.y}`);
    await sleep(450);
    const now = await snap();
    const same = now.board.join(',') === expect.board.join(',');
    const scoreSame = now.scoreHash === expect.scoreHash;
    console.log(`撤回 ${i}: 棋盘 ${same ? 'OK 完全还原' : 'XX 不一致'}   分数 ${scoreSame ? 'OK 一起还原' : 'XX 分数没回退'}   按钮 ${now.btn}  总和 ${now.sum}`);
    if (!same) {
      console.log('  期望:'); console.log(show(expect.board));
      console.log('  实际:'); console.log(show(now.board));
    }
    if (!scoreSame) console.log(`  记分区: 期望 ${expect.scoreHash} -> 实际 ${now.scoreHash}`);
    require('fs').writeFileSync(path.join(__dirname, '..', '..', 'mobile-shots', `undo-${i}.png`),
      require('pngjs').PNG.sync.write(require('pngjs').PNG.sync.read(now.buf)));
  }

  const fin = await snap();
  console.log('\n最终棋盘:');
  console.log(show(fin.board));
  console.log(`  方块总和 ${fin.sum}  (起始 ${s0.sum})`);
  console.log(`  记分区指纹 ${fin.scoreHash}  (起始 ${s0.scoreHash})`);
  sh.close();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); sh.close(); process.exit(1); });
