'use strict';
// 搜索性能基准: 在代表性局面上测量 深度 / 节点数 / 吞吐
// 用法: node bench-depth.js [预算ms]
const ai = require('../ai');

const BUDGET = parseInt(process.argv[2] || '150', 10);
ai.setFourRate(10);

// 代表性局面: 空格数从多到少
const BOARDS = {
  '开局(12空)': [2, 0, 0, 0, 0, 4, 0, 0, 0, 0, 2, 0, 0, 0, 0, 4],
  '早中期(9空)': [2, 4, 8, 0, 0, 16, 0, 0, 0, 0, 32, 0, 0, 0, 0, 64],
  '中盘(6空)': [128, 64, 32, 0, 4, 8, 16, 0, 2, 4, 8, 0, 0, 0, 2, 0],
  '中后期(4空)': [512, 256, 128, 64, 32, 16, 8, 4, 2, 1024, 0, 0, 0, 0, 0, 0],
  '后期(3空)': [8192, 4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 0, 0, 0],
  '残局(2空)': [16384, 8192, 4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 0, 0],
  '关键(1空)': [16384, 8192, 4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 4, 0],
};

console.log(`===== 搜索基准 (预算 ${BUDGET}ms, 生成4率 10%) =====\n`);
let totalDepth = 0, cnt = 0;

for (const [name, b] of Object.entries(BOARDS)) {
  // 每个局面跑 5 次取中位数, 减少抖动
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(ai.getBestMove(b, BUDGET));
  runs.sort((x, y) => x.timeMs - y.timeMs);
  const r = runs[2];
  const mps = Math.round(r.nodes / Math.max(r.timeMs, 1) / 1000);
  console.log(`${name.padEnd(14)} 深度 ${String(r.depth).padStart(2)}  节点 ${String(r.nodes).padStart(8)}  耗时 ${String(r.timeMs).padStart(4)}ms  吞吐 ${String(mps).padStart(5)}k/s  → ${r.dirName}`);
  totalDepth += r.depth; cnt++;
}
console.log(`\n平均深度: ${(totalDepth / cnt).toFixed(2)}`);
