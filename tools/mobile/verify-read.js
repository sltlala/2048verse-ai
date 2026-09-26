'use strict';
// 校验 tools/mobile/board.js 的快速路径 (只解棋盘区域) 与整屏解码 (pngjs) 结果完全一致
// 用法: node tools/mobile/verify-read.js <png...>
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const boardLib = require('./board');

const ROOT = path.join(__dirname, '..', '..');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法: node tools/mobile/verify-read.js <png...>');
  process.exit(1);
}

let bad = 0, cells = 0;
for (const f of files) {
  const p = path.isAbsolute(f) ? f : path.join(ROOT, f);
  const buf = fs.readFileSync(p);

  const t0 = Date.now();
  const fast = boardLib.readBoardFast(buf);
  const tFast = Date.now() - t0;

  const t1 = Date.now();
  const slow = boardLib.readBoardFromPng(PNG.sync.read(buf));
  const tSlow = Date.now() - t1;

  let diff = 0;
  for (let i = 0; i < 16; i++) {
    cells++;
    if (slow.colors[i] !== fast.colors[i]) {
      diff++; bad++;
      console.log(`  ✗ 格${i}: 快速 ${fast.colors[i]} vs 整屏 ${slow.colors[i]}`);
    }
    if (slow.board[i] !== fast.board[i]) {
      diff++; bad++;
      console.log(`  ✗ 格${i}: 值 ${fast.board[i]} vs ${slow.board[i]}`);
    }
  }
  console.log(`${path.basename(p)}  不一致 ${diff}/32  耗时 快速${tFast}ms 整屏${tSlow}ms (加速 ${(tSlow / Math.max(tFast, 1)).toFixed(1)}x)`);
  if (fast.unknown.length) console.log(`  未知色: ${fast.unknown.map(u => u.hex).join(' ')}`);
  console.log(boardLib.boardToText(fast.board));
}
console.log(bad === 0 ? `\n✅ 全部一致 (${cells} 格)` : `\n❌ 有 ${bad} 项不一致`);
process.exit(bad === 0 ? 0 : 1);
