'use strict';
// 实证测量网站实际的"生成4"概率
// 原理: gameState.fourSpawns 是精确的 4 生成次数, moves 是总生成次数
// 用法: node measure-rate.js [目标步数]
const { chromium } = require('playwright');
const ROOT = require('path').join(__dirname, '..');
const path = require('path');
const ai = require('../ai');

const TARGET_MOVES = parseInt(process.argv[2] || '1500', 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readState(page) {
  return page.evaluate(() => {
    if (!document.querySelector('#board-4x4')) return null;
    const raw = localStorage.getItem('gameState4x4');
    if (!raw) return null;
    try {
      const s = JSON.parse(raw);
      return {
        board: s.boardState.flat().map(c => c ? c.value : 0),
        moves: s.moves, fourSpawns: s.fourSpawns, score: s.score,
      };
    } catch { return null; }
  }).catch(() => null);
}

(async () => {
  const browser = await chromium.launchPersistentContext(path.resolve(ROOT, '.chrome-profile-rate'), {
    channel: 'chrome', headless: true, viewport: { width: 1280, height: 800 },
  });
  const page = browser.pages()[0] || await browser.newPage();
  await page.addInitScript(() => { localStorage.setItem('winScreenDisabled', 'true'); });
  await page.goto('https://2048verse.com/4x4', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#board-4x4', { timeout: 30000 });
  await sleep(2000);

  let accMoves = 0, accFours = 0, games = 0;
  const startTime = Date.now();
  let lastProgress = 0;

  while (accMoves < TARGET_MOVES && Date.now() - startTime < 900000) {
    const st = await readState(page);
    if (!st) { await sleep(300); continue; }

    const tiles = st.board.filter(v => v > 0).length;

    // 空棋盘 / 未开局: 等待 (不当作死局)
    if (tiles < 2) { await sleep(300); continue; }

    const decision = ai.getBestMove(st.board, 12);

    // 死局判定: 有方块 且 无任何有效移动
    if (decision.dir === null) {
      games++;
      accMoves += st.moves; accFours += st.fourSpawns;
      console.log(`  第 ${games} 局结束: ${st.moves} 步, 生成4 ${st.fourSpawns} 次 (累计 ${accMoves} 步 / ${accFours} 个4)`);
      await page.click('.new-game-button').catch(() => { });
      await sleep(1000);
      continue;
    }

    await page.keyboard.press(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'][decision.dir]);

    // 等待状态推进
    for (let i = 0; i < 80; i++) {
      await sleep(10);
      const s2 = await readState(page);
      if (s2 && s2.moves !== st.moves) {
        if (s2.moves - lastProgress >= 200) {
          lastProgress = s2.moves;
          console.log(`  进行中: ${s2.moves} 步, 本局生成4 ${s2.fourSpawns} 次 (${(s2.fourSpawns / Math.max(s2.moves, 1) * 100).toFixed(1)}%), 得分 ${s2.score}`);
        }
        break;
      }
    }
  }

  const fin = await readState(page);
  const allMoves = accMoves + (fin ? fin.moves : 0);
  const allFours = accFours + (fin ? fin.fourSpawns : 0);
  const p = allFours / allMoves;
  console.log('\n===== 测量结果 =====');
  console.log(`总生成次数(步数): ${allMoves}`);
  console.log(`生成4次数: ${allFours}`);
  console.log(`★ 实测生成4概率: ${(p * 100).toFixed(2)}%`);
  const se20 = Math.sqrt(0.2 * 0.8 / allMoves) * 100;
  const se10 = Math.sqrt(0.1 * 0.9 / allMoves) * 100;
  console.log(`判定参考: 若真值20% 标准误±${se20.toFixed(2)}%; 若真值10% ±${se10.toFixed(2)}%`);
  console.log(`结论: ${Math.abs(p - 0.2) < Math.abs(p - 0.1) ? '更接近 20%' : '更接近 10%'}`);
  await browser.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
