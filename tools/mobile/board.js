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

// 界面按钮坐标 (1260x2800 竖屏, 由截图人工确认)
const UI = {
  reset: { x: 1004, y: 954 },   // "重置" 按钮 (GAMEOVER 后开新局)
  undo: { x: 750, y: 954 },     // "撤回" 按钮 (本项目不使用)
};

const hex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();

// 逐格取颜色众数 (量化到 8 的倍数抗噪), 内缩 18% 避开边框与间隙
//
// 性能: 用定长数组直方图 (32*32*32 桶) 代替 Map + 字符串键, 并按 STRIDE 跳采样。
//       方块底色是纯色块, 跳采样不影响众数判定, 但把每格要扫的像素降到 1/9。
const HIST_N = new Int32Array(32768);
const HIST_R = new Int32Array(32768);
const HIST_G = new Int32Array(32768);
const HIST_B = new Int32Array(32768);
const STRIDE = 3;

function modeColor(data, W, H, x0, y0, x1, y1) {
  const touched = [];
  let total = 0;
  const ys = Math.max(0, Math.ceil(y0)), ye = Math.min(H, y1);
  const xs = Math.max(0, Math.ceil(x0)), xe = Math.min(W, x1);
  for (let y = ys; y < ye; y += STRIDE) {
    const rowBase = y * W;
    for (let x = xs; x < xe; x += STRIDE) {
      const i = (rowBase + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      if (HIST_N[k] === 0) touched.push(k);
      HIST_N[k]++; HIST_R[k] += r; HIST_G[k] += g; HIST_B[k] += b;
      total++;
    }
  }
  let best = -1, bestN = -1;
  for (const k of touched) if (HIST_N[k] > bestN) { bestN = HIST_N[k]; best = k; }
  if (best < 0 || total === 0) return { rgb: [0, 0, 0], hex: '#000000', share: 0 };
  const rgb = [Math.round(HIST_R[best] / bestN), Math.round(HIST_G[best] / bestN), Math.round(HIST_B[best] / bestN)];
  for (const k of touched) { HIST_N[k] = 0; HIST_R[k] = 0; HIST_G[k] = 0; HIST_B[k] = 0; }   // 复位, 供下一格复用
  return { rgb, hex: hex(...rgb), share: +(bestN / total).toFixed(3) };
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

// 只解出棋盘区域的快速解码器。
// pngjs 的整屏解码约 90ms (14MB 缓冲区 + 全屏反滤波), 而我们只用棋盘那一块;
// 这里自己按 PNG 规范反滤波, 只把棋盘矩形写进输出缓冲, 并且解到棋盘底边就停。
// 非 8bit RGBA / 隔行扫描等特殊情况返回 null, 由调用方回退到 decode()。
const zlib = require('zlib');

function decodeRegion(buf, region) {
  if (buf.length < 33) return null;
  const W = buf.readUInt32BE(16), H = buf.readUInt32BE(20);
  const bitDepth = buf[24], colorType = buf[25], compression = buf[26], filter = buf[27], interlace = buf[28];
  if (bitDepth !== 8 || colorType !== 6 || compression !== 0 || filter !== 0 || interlace !== 0) return null;

  const idats = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IDAT') idats.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
    if (type === 'IEND') break;
  }
  if (!idats.length) return null;

  const raw = zlib.inflateSync(idats.length === 1 ? idats[0] : Buffer.concat(idats));
  const stride = W * 4;
  const bpp = 4;

  const top = Math.max(0, region.top), bottom = Math.min(H, region.bottom);
  const left = Math.max(0, region.left), right = Math.min(W, region.right);
  const rw = right - left, rh = Math.max(0, bottom - top);
  if (rw <= 0 || rh <= 0) return null;
  const out = Buffer.alloc(rw * rh * 4);

  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < H; y++) {
    const ft = raw[pos++];
    const src = pos; pos += stride;
    if (ft === 0) {
      raw.copy(cur, 0, src, src + stride);
    } else if (ft === 1) {
      for (let x = 0; x < stride; x++) cur[x] = (raw[src + x] + (x >= bpp ? cur[x - bpp] : 0)) & 0xff;
    } else if (ft === 2) {
      for (let x = 0; x < stride; x++) cur[x] = (raw[src + x] + prev[x]) & 0xff;
    } else if (ft === 3) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        cur[x] = (raw[src + x] + ((a + prev[x]) >> 1)) & 0xff;
      }
    } else if (ft === 4) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        cur[x] = (raw[src + x] + pr) & 0xff;
      }
    } else {
      return null;   // 未知滤波类型
    }
    if (y >= top && y < bottom) cur.copy(out, (y - top) * rw * 4, left * 4, right * 4);
    if (y + 1 >= bottom) break;
    const t = prev; prev = cur; cur = t;
  }
  return { width: rw, height: rh, data: out };
}

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

// 快速路径: 只解棋盘区域, 并直接按棋盘坐标识别
function readBoardFast(buf, opts = {}) {
  const B = opts.board || BOARD;
  const rw = B.right - B.left, rh = B.bottom - B.top;
  const img = decodeRegion(buf, B);
  if (!img) return readBoardFromPng(decode(buf), opts);      // 特殊情况回退
  const r = readBoardFromPng(img, { board: { left: 0, top: 0, right: rw, bottom: rh } });
  r.image = img;
  return r;
}

module.exports = { COLOR_MAP, BOARD, UI, readBoardFromPng, readBoardFast, decodeRegion, decode, saveCellCrop, boardToText, hex };
