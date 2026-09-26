'use strict';
// A/B 对照: 后期专项优化 开/关
// 用法: node ab-endgame.js [局数] [每变体最大并行数]
const { spawn } = require('child_process');
const ROOT = require('path').join(__dirname, '..');
const path = require('path');

const GAMES = parseInt(process.argv[2] || '20', 10);
const DEPTH = parseInt(process.argv[3] || '4', 10);

console.log(`=== 后期优化 A/B (每变体 ${GAMES} 局, 固定深度 ${DEPTH}) ===`);
console.log('  OFF = 复原旧行为 (deathPenalty 8e5, 无风险厌恶, 无蛇形项)');
console.log('  ON  = 新行为 (deathPenalty 1e9, riskAversion 0.5, endgameSnake 0.35)');
console.log('');

function run(variant) {
  return new Promise((resolve) => {
    const args = ['tools/sim.js', String(GAMES), '30', '10', `--depth=${DEPTH}`, '--quiet', `--endgame=${variant}`];
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', d => buf += d.toString());
    p.stderr.on('data', d => buf += d.toString());
    p.on('close', () => {
      const lines = buf.split(/\r?\n/);
      const summary = lines.filter(l => /平均得分|中位得分|最低\/最高|最大方块分布/.test(l));
      resolve({ variant, summary, raw: buf });
    });
  });
}

(async () => {
  const results = await Promise.all([run('off'), run('on')]);
  console.log('\n════════════════════════════════════════════════');
  for (const r of results) {
    console.log(`\n【${r.variant.toUpperCase()}】`);
    r.summary.forEach(l => console.log('  ' + l.trim()));
    const scores = r.raw.split(/\r?\n/).filter(l => l.startsWith('第 ')).map(l => {
      const m = l.match(/得分 (\d+)/); return m ? parseInt(m[1], 10) : null;
    }).filter(Boolean);
    if (scores.length) {
      const sorted = [...scores].sort((a, b) => a - b);
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const sd = Math.sqrt(scores.reduce((a, s) => a + (s - mean) ** 2, 0) / Math.max(scores.length - 1, 1));
      console.log(`  重算: n=${scores.length} 均值 ${mean.toFixed(0)} 标准差 ${sd.toFixed(0)} 中位 ${sorted[Math.floor(sorted.length / 2)]}`);
    }
  }
  console.log('\n════════════════════════════════════════════════');
})();
