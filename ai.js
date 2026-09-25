'use strict';
// ============================================================
// 2048 AI 引擎 — Expectimax 期望搜索
// 规则匹配 2048verse.com/4x4:
//   - 4x4 棋盘，不能撤销
//   - 每次移动后随机生成 1 个方块: 4 的概率 20%, 2 的概率 80%
//   - 标准合并规则: 一次移动中每个方块最多合并一次
//
// 算法: Expectimax (玩家节点取 max, 随机节点取期望)
//   + nneonneo 启发式 (空格 / 单调性 / 合并潜力 / 数值惩罚)
//   + 概率剪枝与空格候选限制, 保证每步耗时可控
// ============================================================

// ---------- 方向常量 ----------
const UP = 0, DOWN = 1, LEFT = 2, RIGHT = 3;
const DIR_NAMES = ['↑上', '↓下', '←左', '→右'];

// ---------- 启发式权重 (nneonneo 经典参数) ----------
const W_LOST_PENALTY = 200000.0; // 存活基准分
const W_MONOTONICITY = 47.0;     // 单调性惩罚权重
const W_SUM = 11.0;              // 大数值惩罚权重
const W_MERGES = 700.0;          // 合并潜力权重
const W_OPEN = 270.0;            // 空格数权重

// ---------- 蛇形位置权重 (snake heuristic) ----------
// 目的: 强制"最大块在角落 + 沿蛇形严格递减"的结构
// 这是突破 16384→32768 的关键: 引擎已能搭出满阶梯, 但重建阶段结构会崩
// 做法: 8 种朝向(4角 × 2种走向)各算一个位置加权分, 取最大值 (旋转不变)
const SNAKE_BASE = 2;                 // 位置权重底数 (头部 BASE^15, 尾部 BASE^0)
let SNAKE_WEIGHT = 0;                 // 蛇形项总权重 (0 = 关闭)
const snakeRowTable = [];             // [4] Float64Array(65536)
const SNAKE_ORIENTS = [];             // [8] -> [{col, idx, rev} × 4]

(function buildSnake() {
  const W = new Float64Array(16);
  for (let i = 0; i < 16; i++) W[i] = Math.pow(SNAKE_BASE, 15 - i);

  for (let s = 0; s < 4; s++) {
    const t = new Float64Array(65536);
    const w0 = W[s * 4], w1 = W[s * 4 + 1], w2 = W[s * 4 + 2], w3 = W[s * 4 + 3];
    for (let key = 0; key < 65536; key++) {
      t[key] = ((key >> 12) & 15) * w0 + ((key >> 8) & 15) * w1 + ((key >> 4) & 15) * w2 + (key & 15) * w3;
    }
    snakeRowTable[s] = t;
  }

  // 构造 8 条蛇形路径 → 每条拆成 4 条"线"(行或列, 正向或反向)
  for (const anchorRow of [0, 3]) {
    for (const anchorCol of [0, 3]) {
      for (const verticalFirst of [false, true]) {
        const path = [];
        const rowDir = anchorRow === 0 ? 1 : -1;
        const colDir = anchorCol === 0 ? 1 : -1;
        for (let k = 0; k < 4; k++) {
          if (!verticalFirst) {
            const r = anchorRow + rowDir * k;
            const sc = (k % 2 === 0) ? anchorCol : (anchorCol === 0 ? 3 : 0);
            const d = (k % 2 === 0) ? colDir : -colDir;
            for (let j = 0; j < 4; j++) path.push([r, sc + d * j]);
          } else {
            const c = anchorCol + colDir * k;
            const sr = (k % 2 === 0) ? anchorRow : (anchorRow === 0 ? 3 : 0);
            const d = (k % 2 === 0) ? rowDir : -rowDir;
            for (let j = 0; j < 4; j++) path.push([sr + d * j, c]);
          }
        }
        const lines = [];
        for (let s = 0; s < 4; s++) {
          const quad = path.slice(s * 4, s * 4 + 4);
          const isRow = quad.every(p => p[0] === quad[0][0]);
          const coords = quad.map(p => isRow ? p[1] : p[0]);
          lines.push({ col: !isRow, idx: isRow ? quad[0][0] : quad[0][1], rev: coords[0] === 3 && coords[3] === 0 });
        }
        SNAKE_ORIENTS.push(lines);
      }
    }
  }
})();

// 蛇形得分: 8 朝向取最大 (使用调用方已算好的列缓冲 _tbuf)
function snakeScore(rows) {
  let best = -Infinity;
  for (let o = 0; o < 8; o++) {
    const L = SNAKE_ORIENTS[o];
    let sc = 0;
    for (let s = 0; s < 4; s++) {
      const d = L[s];
      let key = d.col ? _tbuf[d.idx] : rows[d.idx];
      if (d.rev) key = ROW_REV[key];
      sc += snakeRowTable[s][key];
    }
    if (sc > best) best = sc;
  }
  return best;
}

// 性能优化: 每步搜索开始时用根局面选定一个朝向 (SNAKE_ACTIVE_ORIENT),
// 全搜索沿用该朝向 → 每次评估只需 4 次查表而非 32 次
let SNAKE_ACTIVE_ORIENT = -1;   // -1 = 每次取 8 朝向最大

function snakeScoreOne(rows, o) {
  const L = SNAKE_ORIENTS[o];
  let sc = 0;
  for (let s = 0; s < 4; s++) {
    const d = L[s];
    let key = d.col ? _tbuf[d.idx] : rows[d.idx];
    if (d.rev) key = ROW_REV[key];
    sc += snakeRowTable[s][key];
  }
  return sc;
}

// 用根局面挑选最佳朝向 (调用前需保证 _tbuf 为 rows 的列)
function pickSnakeOrient(rows) {
  // 先填充列缓冲
  for (let c = 0; c < 4; c++) {
    let key = 0;
    for (let r = 0; r < 4; r++) key = (key << 4) | ((rows[r] >> (12 - 4 * c)) & 15);
    _tbuf[c] = key;
  }
  let best = -Infinity, bestO = 0;
  for (let o = 0; o < 8; o++) {
    const sc = snakeScoreOne(rows, o);
    if (sc > best) { best = sc; bestO = o; }
  }
  return bestO;
}

// ---------- 启发式配置 (用于 A/B 对比) ----------
let useGapAwareMerges = true;
let FIXED_DEPTH = 0;            // >0: 跳过迭代加深, 固定深度 (快速筛选实验用)
function configure(opts = {}) {
  if (opts.snakeWeight !== undefined) SNAKE_WEIGHT = opts.snakeWeight;
  if (opts.gapAwareMerges !== undefined) useGapAwareMerges = !!opts.gapAwareMerges;
  if (opts.fixedDepth !== undefined) FIXED_DEPTH = opts.fixedDepth | 0;
  return { snakeWeight: SNAKE_WEIGHT, gapAwareMerges: useGapAwareMerges, fourRate: P_FOUR, fixedDepth: FIXED_DEPTH };
}

// ---------- 搜索参数 ----------
const PROB_CUTOFF = 1e-4;        // 概率剪枝阈值: 低概率分支直接评估
const MAX_CHANCE_CELLS = 7;      // chance 节点最多考虑的空格数
const MAX_FOUR_CELLS = 3;        // 其中最多考虑生成 4 的空格数

// ---- 生成 4 的概率 (可配置) ----
// 网站支持 "Four Spawn Rate %" 配置; 排行榜历史成绩多为 10%
// 玩哪个概率就用哪个值建模, 否则搜索会失真 (用 measure-rate.js 可实测当前站点)
let P_FOUR = 0.1;
function setFourRate(v) {
  const p = v > 1 ? v / 100 : v; // 接受 10 或 0.1
  P_FOUR = Math.max(0, Math.min(1, p));
  return P_FOUR;
}
function getFourRate() { return P_FOUR; }

// ============================================================
// 第一部分: 行移动预计算表
// 棋盘内部表示: 4 个 16-bit 行 key (row0..row3), 每格 4 bit
// rank 含义: 0=空, 1=2, 2=4, 3=8 ... k=2^k
// 行编码: (r0 << 12) | (r1 << 8) | (r2 << 4) | r3
// ============================================================

const ROW_AFTER = new Uint16Array(65536);  // 左移后的新行
const ROW_GAIN = new Int32Array(65536);    // 左移获得的分数
const ROW_MOVED = new Uint8Array(65536);   // 左移是否发生变化
const ROW_REV = new Uint16Array(65536);    // 行反转编码 (右移用)
// 启发式分量表 (每行)
const H_EMPTY = new Uint8Array(65536);     // 空格数
const H_MERGES = new Uint8Array(65536);    // 合并潜力 (隔空格可合并对, nneonneo)
const H_MERGES_STRICT = new Uint8Array(65536); // 合并潜力 (仅紧邻相等对, A/B 对照)
const H_MONO = new Float64Array(65536);    // 单调性惩罚
const H_SUM = new Float64Array(65536);     // 数值惩罚 sum(rank^3.5)

(function buildTables() {
  // pow4[k] = rank^4, 用于单调性 (nneonneo 原版: rank 的幂, 非数值的幂)
  const pow4 = new Float64Array(17);
  for (let k = 0; k <= 16; k++) pow4[k] = Math.pow(k, 4);
  // powSum[k] = rank^3.5, 数值惩罚
  const powSum = new Float64Array(17);
  for (let k = 0; k <= 16; k++) powSum[k] = Math.pow(k, 3.5);

  for (let key = 0; key < 65536; key++) {
    const c = [key >> 12 & 15, key >> 8 & 15, key >> 4 & 15, key & 15];

    // --- 左移 (标准规则: 每格一次合并机会) ---
    const nz = c.filter(v => v !== 0);
    const out = [];
    let gain = 0;
    for (let i = 0; i < nz.length; i++) {
      if (i + 1 < nz.length && nz[i] === nz[i + 1]) {
        const merged = Math.min(nz[i] + 1, 15); // rank 15 封顶 (32768, 实际达不到)
        out.push(merged);
        gain += 1 << merged;
        i++;
      } else {
        out.push(nz[i]);
      }
    }
    while (out.length < 4) out.push(0);
    let pack = 0;
    for (let i = 0; i < 4; i++) pack = (pack << 4) | out[i];
    ROW_AFTER[key] = pack;
    ROW_GAIN[key] = gain;
    ROW_MOVED[key] = pack !== key ? 1 : 0;

    // --- 行反转 ---
    ROW_REV[key] = ((key & 15) << 12) | ((key & 0xF0) << 4) | ((key & 0xF00) >> 4) | ((key >> 12) & 15);

    // --- 启发式分量 ---
    let empty = 0;
    for (let i = 0; i < 4; i++) if (c[i] === 0) empty++;

    // 合并潜力: nneonneo 算法 — 隔空格的相等对也能滑到一起合并, 需计入
    // 例: [2,0,2,4] 压缩后 [2,2,4] 有 1 个可合并对
    let merges = 0;
    {
      let i = 0;
      while (i < 4) {
        let j = i + 1;
        while (j < 4 && c[j] === 0) j++;
        if (j >= 4) break;
        if (c[i] !== 0 && c[i] === c[j]) { merges++; i = j + 1; }
        else i = j;
      }
    }
    // 对照组: 仅统计紧邻相等对
    let mergesStrict = 0;
    for (let i = 0; i < 3; i++) if (c[i] !== 0 && c[i] === c[i + 1]) mergesStrict++;

    // 单调性: 取递增/递减两个方向惩罚中较小者
    let monoLeft = 0, monoRight = 0;
    for (let i = 0; i < 3; i++) {
      const a = pow4[c[i]], b = pow4[c[i + 1]];
      if (a > b) monoLeft += a - b; else monoRight += b - a;
    }
    const mono = Math.min(monoLeft, monoRight);

    let sumPenalty = 0;
    for (let i = 0; i < 4; i++) sumPenalty += powSum[c[i]];

    H_EMPTY[key] = empty;
    H_MERGES[key] = merges;
    H_MERGES_STRICT[key] = mergesStrict;
    H_MONO[key] = mono;
    H_SUM[key] = sumPenalty;
  }
})();

// ============================================================
// 第二部分: 棋盘操作
// board = Uint16Array(4), 每元素是一行的 16-bit key
// ============================================================

function transposeRows(rows) {
  const t = new Uint16Array(4);
  for (let c = 0; c < 4; c++) {
    let key = 0;
    for (let r = 0; r < 4; r++) {
      key = (key << 4) | ((rows[r] >> (12 - 4 * c)) & 15);
    }
    t[c] = key;
  }
  return t;
}

// 对 board 执行 dir 移动, 返回 { board, moved, gain }
function applyMoveDir(rows, dir) {
  const nb = new Uint16Array(4);
  let moved = false, gain = 0;
  if (dir === LEFT) {
    for (let i = 0; i < 4; i++) {
      const k = rows[i];
      if (ROW_MOVED[k]) moved = true;
      gain += ROW_GAIN[k];
      nb[i] = ROW_AFTER[k];
    }
  } else if (dir === RIGHT) {
    for (let i = 0; i < 4; i++) {
      const rk = ROW_REV[rows[i]];
      if (ROW_MOVED[rk]) moved = true;
      gain += ROW_GAIN[rk];
      nb[i] = ROW_REV[ROW_AFTER[rk]];
    }
  } else {
    // UP/DOWN: 转置 → LEFT/RIGHT → 转置回来
    const t = transposeRows(rows);
    if (dir === UP) {
      for (let i = 0; i < 4; i++) {
        const k = t[i];
        if (ROW_MOVED[k]) moved = true;
        gain += ROW_GAIN[k];
        nb[i] = ROW_AFTER[k];
      }
    } else {
      for (let i = 0; i < 4; i++) {
        const rk = ROW_REV[t[i]];
        if (ROW_MOVED[rk]) moved = true;
        gain += ROW_GAIN[rk];
        nb[i] = ROW_REV[ROW_AFTER[rk]];
      }
    }
    return { board: transposeRows(nb), moved, gain };
  }
  return { board: nb, moved, gain };
}

// 数值数组 (16, 行优先, 0 或 2 的幂) ↔ 内部行 key 表示
function valuesToBoard(values) {
  const rows = new Uint16Array(4);
  for (let r = 0; r < 4; r++) {
    let key = 0;
    for (let c = 0; c < 4; c++) {
      const v = values[r * 4 + c];
      const rank = v === 0 ? 0 : Math.round(Math.log2(v));
      key = (key << 4) | Math.min(rank, 15);
    }
    rows[r] = key;
  }
  return rows;
}

function boardToValues(rows) {
  const v = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const rank = (rows[r] >> (12 - 4 * c)) & 15;
      v[r * 4 + c] = rank === 0 ? 0 : 1 << rank;
    }
  }
  return v;
}

// ============================================================
// 第三部分: 启发式评估
// ============================================================

function evaluate(rows) {
  let v = W_LOST_PENALTY;
  for (let i = 0; i < 4; i++) {
    const k = rows[i];
    v += H_EMPTY[k] * W_OPEN + H_MERGES[k] * W_MERGES - H_MONO[k] * W_MONOTONICITY - H_SUM[k] * W_SUM;
  }
  const cols = transposeRows(rows);
  for (let i = 0; i < 4; i++) {
    const k = cols[i];
    v += H_EMPTY[k] * W_OPEN + H_MERGES[k] * W_MERGES - H_MONO[k] * W_MONOTONICITY - H_SUM[k] * W_SUM;
  }
  return v;
}

// ============================================================
// 第四部分: Expectimax 搜索 (就地修改 + 回滚, 零分配)
// ============================================================

// 统计信息 (供 HUD 显示)
let stats = { nodes: 0, startTime: 0 };

// ---- 置换表 (Transposition Table) ----
// 数值哈希 + 开地址探测: 比 Map<string,...> 快 3-5 倍, 且用世代戳 O(1) 清空
// 键: 4 行 Uint16 → 两个 32 位半键 (kLo = r0|r1<<16, kHi = r2|r3<<16)
// 表大小 2^22 = 419 万槽 (约 88MB), 减少哈希冲突、提升深搜命中率
const TT_BITS = 22;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttLo = new Uint32Array(TT_SIZE);
const ttHi = new Uint32Array(TT_SIZE);
const ttVal = new Float64Array(TT_SIZE);
const ttDepth = new Uint8Array(TT_SIZE);
const ttStamp = new Uint32Array(TT_SIZE);
let ttGen = 0;

function ttClear() { ttGen++; }

function ttHash(lo, hi) {
  let h = (lo ^ Math.imul(hi, 0x9E3779B1)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x85EBCA6B) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35) >>> 0;
  h ^= h >>> 16;
  return h & TT_MASK;
}

function ttGet(lo, hi, depth) {
  let idx = ttHash(lo, hi);
  for (let p = 0; p < 4; p++) {
    if (ttStamp[idx] !== ttGen) return undefined;      // 空槽
    if (ttLo[idx] === lo && ttHi[idx] === hi) {
      return ttDepth[idx] >= depth ? ttVal[idx] : undefined;
    }
    idx = (idx + 1) & TT_MASK;
  }
  return undefined;
}

function ttSet(lo, hi, depth, v) {
  let idx = ttHash(lo, hi);
  for (let p = 0; p < 4; p++) {
    if (ttStamp[idx] !== ttGen) {                      // 空槽: 写入
      ttStamp[idx] = ttGen; ttLo[idx] = lo; ttHi[idx] = hi;
      ttDepth[idx] = depth; ttVal[idx] = v;
      return;
    }
    if (ttLo[idx] === lo && ttHi[idx] === hi) {         // 同局面: 深度更新
      if (ttDepth[idx] <= depth) { ttDepth[idx] = depth; ttVal[idx] = v; }
      return;
    }
    idx = (idx + 1) & TT_MASK;
  }
  // 4 次探测全冲突: 覆盖首槽 (近似可接受)
  idx = ttHash(lo, hi);
  ttStamp[idx] = ttGen; ttLo[idx] = lo; ttHi[idx] = hi;
  ttDepth[idx] = depth; ttVal[idx] = v;
}

// ---- 迭代加深的时间控制 ----
let searchDeadline = Infinity;             // 超过此时刻中止搜索
const SEARCH_ABORTED = Symbol('aborted');  // 中止哨兵 (抛出以解开递归)

// 就地移动: 修改 rows, 返回 {moved, gain}
function moveInPlace(rows, dir) {
  let moved = false, gain = 0;
  if (dir === LEFT) {
    for (let i = 0; i < 4; i++) {
      const k = rows[i];
      if (ROW_MOVED[k]) moved = true;
      gain += ROW_GAIN[k];
      rows[i] = ROW_AFTER[k];
    }
  } else if (dir === RIGHT) {
    for (let i = 0; i < 4; i++) {
      const rk = ROW_REV[rows[i]];
      if (ROW_MOVED[rk]) moved = true;
      gain += ROW_GAIN[rk];
      rows[i] = ROW_REV[ROW_AFTER[rk]];
    }
  } else {
    transposeInPlace(rows);
    const rev = dir === DOWN;
    for (let i = 0; i < 4; i++) {
      if (rev) {
        const rk = ROW_REV[rows[i]];
        if (ROW_MOVED[rk]) moved = true;
        gain += ROW_GAIN[rk];
        rows[i] = ROW_REV[ROW_AFTER[rk]];
      } else {
        const k = rows[i];
        if (ROW_MOVED[k]) moved = true;
        gain += ROW_GAIN[k];
        rows[i] = ROW_AFTER[k];
      }
    }
    transposeInPlace(rows);
  }
  return { moved, gain };
}

// 共享转置缓冲 (同步递归中安全: 值立即消费)
const _tbuf = new Uint16Array(4);
function transposeInPlace(rows) {
  for (let c = 0; c < 4; c++) {
    let key = 0;
    for (let r = 0; r < 4; r++) key = (key << 4) | ((rows[r] >> (12 - 4 * c)) & 15);
    _tbuf[c] = key;
  }
  rows[0] = _tbuf[0]; rows[1] = _tbuf[1]; rows[2] = _tbuf[2]; rows[3] = _tbuf[3];
}

// 就地启发式评估 (行列各计一次 + 可选蛇形结构项)
function evaluateInPlace(rows) {
  const mergeTab = useGapAwareMerges ? H_MERGES : H_MERGES_STRICT;
  let v = W_LOST_PENALTY;
  for (let i = 0; i < 4; i++) {
    const k = rows[i];
    v += H_EMPTY[k] * W_OPEN + mergeTab[k] * W_MERGES - H_MONO[k] * W_MONOTONICITY - H_SUM[k] * W_SUM;
  }
  // 列分量: 复制到共享缓冲再算
  for (let c = 0; c < 4; c++) {
    let key = 0;
    for (let r = 0; r < 4; r++) key = (key << 4) | ((rows[r] >> (12 - 4 * c)) & 15);
    _tbuf[c] = key;
  }
  for (let i = 0; i < 4; i++) {
    const k = _tbuf[i];
    v += H_EMPTY[k] * W_OPEN + mergeTab[k] * W_MERGES - H_MONO[k] * W_MONOTONICITY - H_SUM[k] * W_SUM;
  }
  // 蛇形结构项 (朝向固定则 4 次查表, 否则 8 朝向取最大)
  if (SNAKE_WEIGHT > 0) {
    v += SNAKE_WEIGHT * (SNAKE_ACTIVE_ORIENT >= 0 ? snakeScoreOne(rows, SNAKE_ACTIVE_ORIENT) : snakeScore(rows));
  }
  return v;
}

// chance 节点: 空格生成方块后的期望评估 (带置换表)
function chanceNode(rows, depth, cprob) {
  if (cprob < PROB_CUTOFF || depth <= 0) return evaluateInPlace(rows);

  // 置换表查询 (键必须无符号, 否则高位为1时永远不命中)
  const kLo = (rows[0] | (rows[1] << 16)) >>> 0;
  const kHi = (rows[2] | (rows[3] << 16)) >>> 0;
  const cached = ttGet(kLo, kHi, depth);
  if (cached !== undefined) return cached;

  // 收集空格 (最多 MAX_CHANCE_CELLS 个)
  const cells = [];
  outer: for (let r = 0; r < 4; r++) {
    const k = rows[r];
    for (let c = 0; c < 4; c++) {
      if (((k >> (12 - 4 * c)) & 15) === 0) {
        cells.push(r * 4 + c);
        if (cells.length >= MAX_CHANCE_CELLS) break outer;
      }
    }
  }
  const n = cells.length;
  if (n === 0) return evaluateInPlace(rows);

  // 空格少(=残局, 最需要精度)时对所有空格精确建模 4; 多时用近似控制开销
  const fourLimit = n <= 4 ? n : MAX_FOUR_CELLS;
  const p2 = 1 - P_FOUR;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const idx = cells[i];
    const r = idx >> 2, c = idx & 3;
    const shift = 12 - 4 * c;
    const savedRow = rows[r];

    // 生成 2 (rank 1)
    rows[r] = (savedRow & ~(15 << shift)) | (1 << shift);
    stats.nodes++;
    sum += p2 * playerNode(rows, depth - 1, cprob * p2 / n);

    // 生成 4 (rank 2); 超出限额的位置用 2 近似
    const fourRank = i < fourLimit ? 2 : 1;
    rows[r] = (savedRow & ~(15 << shift)) | (fourRank << shift);
    stats.nodes++;
    sum += P_FOUR * playerNode(rows, depth - 1, cprob * P_FOUR / n);

    rows[r] = savedRow; // 回滚
  }
  const v = sum / n;
  ttSet(kLo, kHi, depth, v);
  return v;
}

// player 节点: 四个方向取最优 (带超时中止)
function playerNode(rows, depth, cprob) {
  if (depth <= 0) return evaluateInPlace(rows);
  // 周期性检查时间预算
  if ((stats.nodes & 2047) === 0 && Date.now() > searchDeadline) throw SEARCH_ABORTED;
  const s0 = rows[0], s1 = rows[1], s2 = rows[2], s3 = rows[3];
  let best = -Infinity;
  for (let dir = 0; dir < 4; dir++) {
    const { moved } = moveInPlace(rows, dir);
    if (moved) {
      stats.nodes++;
      const v = chanceNode(rows, depth, cprob);
      if (v > best) best = v;
    }
    rows[0] = s0; rows[1] = s1; rows[2] = s2; rows[3] = s3; // 回滚
  }
  if (best === -Infinity) {
    return evaluateInPlace(rows) - W_LOST_PENALTY * 4; // 死局
  }
  return best;
}

// (深度策略已由 getBestMove 的迭代加深 + 时间预算取代)

// ---------- 自适应思考预算 ----------
// 依据: 前期棋盘开阔(空格多), 可选方向多、单步对最终得分影响很小 → 浅搜即可;
//       后期空格少, 一步走错就崩盘 → 给足时间深搜。
// 调参依据(实测): 后期局面小、单节点展开少, 加时间能换到明显更深的搜索
//   (150ms→400ms 时, 后期 9→12 层, 残局 11→13 层, 平均 8.7→11.0 层)
// 所以把中期预算压下来, 把省下的时间投给后期。
function adaptiveBudget(emptyCount, maxBudget) {
  let f;
  if (emptyCount >= 9) f = 0.08;        // 开局
  else if (emptyCount >= 7) f = 0.15;   // 早中期
  else if (emptyCount >= 5) f = 0.25;   // 中期
  else if (emptyCount >= 3) f = 0.6;    // 后期
  else f = 1.5;                         // 关键期(≤2空格): 决胜阶段, 1.5 倍加码
  return Math.max(5, Math.round(maxBudget * f));
}

// ---------- 对外主接口 ----------
// values: 16 个数值的数组 (行优先), budgetMs: 每步时间预算 (默认 60ms)
// 迭代加深: 从深度2逐层加深, 时间预算用完或加深不划算时停止, 用最后完整算完的一层
function getBestMove(values, budgetMs) {
  const budget = budgetMs || 60;
  const rows = valuesToBoard(values);
  const emptyCount = values.filter(v => v === 0).length;

  ttClear();
  stats = { nodes: 0, startTime: Date.now() };

  // 蛇形启发式: 用根局面选定朝向, 全搜索沿用 (性能优化)
  SNAKE_ACTIVE_ORIENT = SNAKE_WEIGHT > 0 ? pickSnakeOrient(rows) : -1;

  let bestDir = null, bestScore = null, bestDepth = 0;
  const tried = [];

  // 固定深度模式 (快速筛选实验): 单层搜索, 不做迭代加深
  if (FIXED_DEPTH > 0) {
    let dBest = null, dScore = -Infinity;
    for (let dir = 0; dir < 4; dir++) {
      const work = new Uint16Array(rows);
      const { moved, gain } = moveInPlace(work, dir);
      const t = { dir, score: null, gain, depth: FIXED_DEPTH };
      tried.push(t);
      if (!moved) continue;
      const score = chanceNode(work, FIXED_DEPTH, 1.0);
      t.score = score;
      if (score > dScore) { dScore = score; dBest = dir; }
    }
    return {
      dir: dBest,
      dirName: dBest === null ? '死局' : DIR_NAMES[dBest],
      score: dBest === null ? null : dScore,
      depth: FIXED_DEPTH, emptyCount,
      nodes: stats.nodes, timeMs: Date.now() - stats.startTime, tried,
    };
  }

  // 迭代加深: 用"实测增长率"预测下一层耗时, 把预算用满
  // ID_LIMIT: 允许的最大超支倍数 (只在能多算完一层时才允许轻微超支)
  const ID_LIMIT = 1.3;
  let prevIterMs = 0;
  for (let depth = 2; depth <= 20; depth++) {
    const iterStart = Date.now();
    // 深度2必定算完 (保证总有结果); 更深层启用时间预算
    searchDeadline = depth === 2 ? Infinity : stats.startTime + budget * ID_LIMIT;

    let dBest = null, dScore = -Infinity;
    try {
      for (let dir = 0; dir < 4; dir++) {
        const work = new Uint16Array(rows);
        const { moved, gain } = moveInPlace(work, dir);
        const t = tried[dir] || (tried[dir] = { dir, score: null, gain: 0, depth: 0 });
        t.gain = gain;
        if (!moved) { t.score = null; continue; }
        const score = chanceNode(work, depth, 1.0);
        t.score = score; t.depth = depth;
        if (score > dScore) { dScore = score; dBest = dir; }
      }
    } catch (e) {
      if (e === SEARCH_ABORTED) break; // 本层超时未算完, 丢弃部分结果
      throw e;
    }
    // 本层完整算完
    if (dBest !== null) { bestDir = dBest; bestScore = dScore; bestDepth = depth; }

    const iterMs = Math.max(1, Date.now() - iterStart);
    // 增长率取自实测 (相邻两层耗时比), 无历史时按 4 倍估计
    const growth = prevIterMs > 0 ? Math.max(2, Math.min(10, iterMs / prevIterMs)) : 4;
    prevIterMs = iterMs;
    const elapsed = Date.now() - stats.startTime;
    const predicted = elapsed + iterMs * growth;
    // 停止条件: 预测下一层会超支, 且预算已用掉大半 (否则继续尝试加深, 由 deadline 兜底)
    if (predicted > budget * ID_LIMIT && elapsed >= budget * 0.6) break;
  }

  return {
    dir: bestDir,
    dirName: bestDir === null ? '死局' : DIR_NAMES[bestDir],
    score: bestScore,
    depth: bestDepth,
    emptyCount,
    nodes: stats.nodes,
    timeMs: Date.now() - stats.startTime,
    tried,
  };
}

// 模拟用: 对数值棋盘执行移动 (与网站规则一致)
function simulateMove(values, dir) {
  const rows = valuesToBoard(values);
  const { board, moved, gain } = applyMoveDir(rows, dir);
  return { values: boardToValues(board), moved, gain };
}

// 模拟用: 随机生成方块 (概率跟随 P_FOUR), 返回生成的值 (2/4), 无空格返回 0
function simulateSpawn(values, rng = Math.random) {
  const empties = [];
  for (let i = 0; i < 16; i++) if (values[i] === 0) empties.push(i);
  if (empties.length === 0) return 0;
  const idx = empties[Math.floor(rng() * empties.length)];
  const v = rng() < P_FOUR ? 4 : 2;
  values[idx] = v;
  return v;
}

module.exports = {
  UP, DOWN, LEFT, RIGHT, DIR_NAMES,
  getBestMove, simulateMove, simulateSpawn,
  valuesToBoard, boardToValues, applyMoveDir, evaluate,
  moveInPlace, evaluateInPlace,
  setFourRate, getFourRate, configure, adaptiveBudget,
};
