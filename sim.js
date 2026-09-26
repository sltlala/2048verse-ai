'use strict';
// AI 强度模拟测试: 用 ai.js 自动玩完整局, 统计得分分布
// 用法: node sim.js [局数] [每步预算ms] [生成4概率%] [--snake=W] [--strict-merges] [--quiet]
// 例:   node sim.js 3 60 10 --snake=0.3

const ai = require('./ai');

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const nums = args.filter(a => /^\d+$/.test(a)).map(Number);
const n = nums[0] !== undefined ? nums[0] : 5;
const BUDGET = nums[1] !== undefined ? nums[1] : 60;
const FOUR_RATE = nums[2] !== undefined ? nums[2] : 10;
ai.setFourRate(FOUR_RATE);

// 启发式开关 (A/B 对比用)
const snakeArg = args.find(a => a.startsWith('--snake='));
const SNAKE_W = snakeArg ? parseFloat(snakeArg.split('=')[1]) : 0;
const STRICT = args.includes('--strict-merges');
const depthArg = args.find(a => a.startsWith('--depth='));
const FIXED_DEPTH = depthArg ? parseInt(depthArg.split('=')[1], 10) : 0;
const ADAPTIVE = args.includes('--adaptive');   // 自适应预算 (前期快/后期深)
// 后期专项优化开关: --endgame=on (新行为) / off (复原旧行为)
const egArg = args.find(a => a.startsWith('--endgame='));
const ENDGAME = egArg ? egArg.split('=')[1] : 'default';
ai.configure({ snakeWeight: SNAKE_W, gapAwareMerges: !STRICT, fixedDepth: FIXED_DEPTH });
if (ENDGAME === 'off') ai.setEndgameMode('off');
if (ENDGAME === 'on') ai.setEndgameMode('on');
const CFG_TAG = `snake=${SNAKE_W} merges=${STRICT ? 'strict' : 'gap'}${FIXED_DEPTH ? ' depth=' + FIXED_DEPTH : ''}${ADAPTIVE ? ' adaptive' : ''} endgame=${ENDGAME}`;

// ---------- 结果落盘 ----------
const fs = require('fs');
const path = require('path');
const RESULTS_DIR = path.join(__dirname, 'results');
const SIM_JSONL = path.join(RESULTS_DIR, 'sim-results.jsonl');

function tsCompact(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function saveSimResult(gameNo, r) {
  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const endTime = new Date();
    const rec = {
      gameNo,
      source: 'sim',
      endTime: endTime.toISOString(),
      endTimeLocal: tsCompact(endTime),
      score: r.score,
      tileSum: r.tileSum,
      moves: r.moves,
      fourSpawns: r.fourSpawns,
      fourSpawnPct: r.fourSpawnPct,
      maxTile: r.maxTile,
      avgDecisionMs: +r.avgTimeMs.toFixed(2),
      config: { fourRate: FOUR_RATE, budgetMs: BUDGET, snakeWeight: SNAKE_W, gapAwareMerges: !STRICT, fixedDepth: FIXED_DEPTH },
      board: r.finalBoard,
    };
    fs.appendFileSync(SIM_JSONL, JSON.stringify(rec) + '\n');
  } catch (e) { console.error('结果保存失败:', e.message); }
}

function playGame(gameIdx) {
  // 开局: 2 个随机方块 (与 2048verse 一致)
  let values = new Array(16).fill(0);
  let fourSpawns = 0;
  if (ai.simulateSpawn(values) === 4) fourSpawns++;
  if (ai.simulateSpawn(values) === 4) fourSpawns++;

  let score = 0, moves = 0, maxTimeMs = 0, totalTimeMs = 0;
  const gameStart = Date.now();

  while (true) {
    // 预算: 自适应(按空格数) 或 固定
    const empty = ADAPTIVE ? values.filter(v => v === 0).length : 0;
    const budget = ADAPTIVE ? ai.adaptiveBudget(empty, BUDGET) : BUDGET;
    const best = ai.getBestMove(values, budget);
    if (best.dir === null) break; // 死局
    const t0 = Date.now();
    const r = ai.simulateMove(values, best.dir);
    if (!r.moved) break; // 保险: AI 不应给出无效方向
    values = r.values; // 采用移动后的棋盘
    score += r.gain;
    if (ai.simulateSpawn(values) === 4) fourSpawns++; // 统计生成 4 的次数
    moves++;
    const dt = Date.now() - t0 + best.timeMs;
    totalTimeMs += dt; if (dt > maxTimeMs) maxTimeMs = dt;
    if (!quiet && moves % 200 === 0) {
      console.log(`  ... 进行中: 步 ${moves}, 当前得分 ${score}, 最大方块 ${Math.max(...values)}, 上步决策 ${best.timeMs}ms`);
    }
  }

  const maxTile = Math.max(...values);
  const tileSum = values.reduce((a, b) => a + b, 0);
  const wallSec = (Date.now() - gameStart) / 1000;
  return {
    score, moves, maxTile, fourSpawns, tileSum,
    fourSpawnPct: moves > 0 ? +(fourSpawns / moves * 100).toFixed(2) : null,
    maxTimeMs, avgTimeMs: totalTimeMs / Math.max(moves, 1),
    wallSec, movesPerSec: +(moves / Math.max(wallSec, 0.001)).toFixed(2),
    finalBoard: values.slice(),
  };
}

function fmtBoard(b) {
  const w = String(Math.max(...b)).length;
  let s = '';
  for (let r = 0; r < 4; r++) {
    s += '  ' + b.slice(r * 4, r * 4 + 4).map(v => String(v || '·').padStart(w)).join(' ') + '\n';
  }
  return s;
}

(async () => {
  console.log(`===== 2048 AI 模拟测试: ${n} 局 (生成4概率${FOUR_RATE}%, 预算${BUDGET}ms/步, ${CFG_TAG}) =====\n`);
  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const r = playGame(i);
    results.push(r);
    saveSimResult(i + 1, r);
    if (!quiet) {
      console.log(`第 ${i + 1} 局: 得分 ${r.score}  最大方块 ${r.maxTile}  步数 ${r.moves}  生成4率 ${r.fourSpawnPct}%  平均决策 ${r.avgTimeMs.toFixed(0)}ms`);
      console.log(fmtBoard(r.finalBoard));
    } else {
      console.log(`第 ${i + 1} 局: 得分 ${r.score}  最大方块 ${r.maxTile}  步数 ${r.moves}  生成4率 ${r.fourSpawnPct}%  用时 ${r.wallSec.toFixed(0)}s (${r.movesPerSec} 步/秒)`);
    }
  }

  const scores = results.map(r => r.score).sort((a, b) => a - b);
  const sum = scores.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const sd = n > 1 ? Math.sqrt(scores.reduce((a, s) => a + (s - mean) ** 2, 0) / (n - 1)) : 0;
  const reach = {};
  for (const r of results) { for (const v of r.finalBoard) if (v > 0) reach[v] = (reach[v] || 0) + 1; }
  const maxTileCount = {};
  for (const r of results) maxTileCount[r.maxTile] = (maxTileCount[r.maxTile] || 0) + 1;

  console.log('===== 汇总 =====');
  console.log(`平均得分: ${mean.toFixed(0)}  (标准差 ${sd.toFixed(0)}, 均值标准误 ${(sd / Math.sqrt(n)).toFixed(0)})`);
  // 中位数: 偶数样本取中间两个的平均 (旧写法 scores[floor(n/2)] 在偶数时会取到第 75 百分位)
  const median = scores.length % 2 === 1
    ? scores[(scores.length - 1) / 2]
    : Math.round((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2);
  const q = (p) => scores[Math.min(scores.length - 1, Math.floor(p * scores.length))];
  console.log(`中位得分: ${median}   (P25 ${q(0.25)} / P75 ${q(0.75)})`);
  console.log(`最低/最高: ${scores[0]} / ${scores[n - 1]}`);
  console.log(`总耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s (含 ${results.reduce((a, r) => a + r.moves, 0)} 步)`);
  const avgMps = results.reduce((a, r) => a + r.movesPerSec, 0) / results.length;
  console.log(`平均模拟速度: ${avgMps.toFixed(2)} 步/秒 | 平均每局 ${(results.reduce((a, r) => a + r.wallSec, 0) / results.length).toFixed(0)}s`);
  console.log(`最大方块分布: ${JSON.stringify(maxTileCount)}`);
  const allMax = results.map(r => r.maxTimeMs);
  console.log(`单步最慢决策: ${Math.max(...allMax).toFixed(0)}ms`);
  console.log(`结果已保存: results/sim-results.jsonl`);
})();
