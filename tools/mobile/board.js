'use strict';
// 手机 2048 棋盘识别 (Lite2048 / Unity 游戏, 只能靠截图)
// 原理: 棋盘为固定位置的 4x4 网格; 每格取"颜色众数"作为底色,
//       再按 颜色 -> 数值 映射表还原方块数值 (大号白字不会干扰众数)
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..', '..');

// ---- 颜色 -> 数值 映射 (由 tools/mobile/calibrate.js 实测得到) ----
// 缺 32/64/512/1024/2048... 时, readBoard 会把未知色报告出来并保存样本
const COLOR_MAP = {
  '#CDF5F4': 0,      // 空格底色
  '#92F5F4': 2,
  '#00DCF4': 4,
  '#00A7F4': 8,
  '#74A0FD': 16,
  '#007AE2': 32,     // 实测确认
  '#2F5093': 64,     // 实测确认 (样本 2F5093_r0c1.png)
  '#0442E5': 128,
  '#6155DC': 256,
  '#A580EB': 512,    // 实测确认 (样本 A580EB_r0c3.png)
};

// 设备实测的棋盘矩形 (1260x2800 竖屏)
const BOARD = { left: 105, top: 1085, right: 1154, bottom: 2134 };

const hex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();

// 逐格取颜色众数 (量化到 8 的倍数抗噪), 内缩 18% 避开边框与间隙
function modeColor(data, W, H, x0, y0, x1, y1) {
  const hist = new Map();
  let total = 0;
  for (let y = Math.ceil(y0); y < y1; y++) {
    for (let x = Math.ceil(x0); x < x1; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const k = `${r >> 3},${g >> 3},${b >> 3}`;
      const e = hist.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      hist.set(k, e);
      total++;
    }
  }
  let best = null;
  for (const e of hist.values()) if (!best || e.n > best.n) best = e;
  const rgb = [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
  return { rgb, hex: hex(...rgb), share: +(best.n / total).toFixed(3) };
}

// 解析一张已解码的 PNG -> { board:number[16], unknown:[{r,c,hex,share}], colors:string[16] }
function readBoardFromPng(png, opts = {}) {
  const { width: W, height: H, data } = png;
  const B = opts.board || BOARD;
  const bw = B.right - B.left, bh = B.bottom - B.top;
  const board = new Array(16).fill(0);
  const colors = new Array(16).fill(null);
  const unknown = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x0 = B.left + bw * c / 4, x1 = B.left + bw * (c + 1) / 4;
      const y0 = B.top + bh * r / 4, y1 = B.top + bh * (r + 1) / 4;
      const padX = (x1 - x0) * 0.18, padY = (y1 - y0) * 0.18;
      const m = modeColor(data, W, H, x0 + padX, y0 + padY, x1 - padX, y1 - padY);
      colors[r * 4 + c] = m.hex;
      if (Object.prototype.hasOwnProperty.call(COLOR_MAP, m.hex)) {
        board[r * 4 + c] = COLOR_MAP[m.hex];
      } else {
        unknown.push({ r, c, hex: m.hex, share: m.share });
      }
    }
  }
  return { board, colors, unknown };
}

function decode(buf) { return PNG.sync.read(buf); }

// 保存某格的放大截图, 便于人工确认数值
function saveCellCrop(png, r, c, outFile) {
  const B = BOARD;
  const bw = B.right - B.left, bh = B.bottom - B.top;
  const x0 = Math.round(B.left + bw * c / 4), x1 = Math.round(B.left + bw * (c + 1) / 4);
  const y0 = Math.round(B.top + bh * r / 4), y1 = Math.round(B.top + bh * (r + 1) / 4);
  const w = x1 - x0, h = y1 - y0;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * png.width + (x0 + x)) * 4;
      const di = (y * w + x) * 4;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, PNG.sync.write(out));
  return outFile;
}

function boardToText(board) {
  const w = 5;
  const lines = [];
  for (let r = 0; r < 4; r++) {
    lines.push('  ' + board.slice(r * 4, r * 4 + 4).map(v => String(v || '·').padStart(w)).join(' '));
  }
  return lines.join('\n');
}

module.exports = { COLOR_MAP, BOARD, readBoardFromPng, decode, saveCellCrop, boardToText, hex };
