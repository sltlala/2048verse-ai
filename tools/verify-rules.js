'use strict';
// 验证: 本地模拟的规则/生成是否与网站完全一致
// 做法: 每步先读网站棋盘 B0, 用本地引擎算出方向 D 并按键, 再读网站棋盘 B1;
//       本地模拟 "B0 执行 D" 得到 E, 则 B1 必须等于 E + 恰好一个新方块(2或4)
//       任何不符 = 规则不一致 (真误差)
const { chromium } = require('playwright');
const ROOT = require('path').join(__dirname, '..');
const path = require('path');
const ai = require('../ai');

const MOVES = parseInt(process.argv[2] || '400', 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ai.setFourRate(10);

async function readBoard(page) {
  return page.evaluate(() => {
    if (!document.querySelector('#board-4x4')) return null;
    const raw = localStorage.getItem('gameState4x4');
    if (!raw) return null;
    try {
      const s = JSON.parse(raw);
      return { board: s.boardState.flat().map(c => c ? c.value : 0), moves: s.moves, fourSpawns: s.fourSpawns, score: s.score };
    } catch { return null; }
  }).catch(() => null);
}

(async () => {
  const browser = await chromium.launchPersistentContext(path.resolve(ROOT, '.chrome-profile-rules'), {
    channel: 'chrome', headless: true, viewport: { width: 1440, height: 900 },
    chromiumSandbox: true, ignoreDefaultArgs: ['--no-sandbox'], args: [],
  });
  const page = browser.pages()[0] || await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('winScreenDisabled', 'true'));
  await page.goto('https://2048verse.com/4x4', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#board-4x4', { timeout: 30000 });
  await sleep(2000);

  let plays = 0, mismatches = 0, spawn2 = 0, spawn4 = 0, scoreSum = 0;
  let last = await readBoard(page);

  while (plays < MOVES) {
    const st = await readBoard(page);
    if (!st) { await sleep(300); continue; }
    if (st.board.filter(v => v > 0).length < 2) { await sleep(300); continue; }

    const dec = ai.getBestMove(st.board, 15);
    if (dec.dir === null) { console.log('  (死局, 停止验证)'); break; }

    const before = st.board.slice();
    const beforeScore = st.score;
    await page.keyboard.press(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'][dec.dir]);

    // 等状态推进
    let after = null;
    for (let i = 0; i < 80; i++) {
      await sleep(12);
      const s2 = await readBoard(page);
      if (s2 && s2.moves !== st.moves) { after = s2; break; }
    }
    if (!after) { console.log('  (按键未生效, 跳过)'); continue; }
    plays++;

    // 本地模拟同一步
    const sim = ai.simulateMove(before, dec.dir);
    const expected = sim.values;   // 移动+合并后 (尚未生成新方块)
    const actual = after.board;

    // 比对: actual 应等于 expected, 且恰好多一个新方块
    const expCounts = {}, actCounts = {};
    for (const v of expected) if (v) expCounts[v] = (expCounts[v] || 0) + 1;
    for (const v of actual) if (v) actCounts[v] = (actCounts[v] || 0) + 1;

    // 找 differences
    const diffExpected = [], diffActual = [];
    const keys = new Set([...Object.keys(expCounts), ...Object.keys(actCounts)]);
    for (const k of keys) {
      const d = (actCounts[k] || 0) - (expCounts[k] || 0);
      if (d > 0) diffActual.push(`${k}×${d}`);
      if (d < 0) diffExpected.push(`${k}×${-d}`);
    }
    const ok = diffExpected.length === 0 && diffActual.length === 1 && (diffActual[0] === '2×1' || diffActual[0] === '4×1');
    if (!ok) {
      mismatches++;
      if (mismatches <= 5) {
        console.log(`  ✗ 第 ${plays} 步不符 (方向${dec.dirName})`);
        console.log(`     本地模拟结果: [${expected.join(',')}]`);
        console.log(`     网站实际结果: [${actual.join(',')}]`);
        console.log(`     多出: ${diffActual.join(' ') || '无'} | 缺少: ${diffExpected.join(' ') || '无'}`);
      }
    }
    if (diffActual[0] === '2×1') spawn2++;
    if (diffActual[0] === '4×1') spawn4++;

    // 分数校验
    scoreSum += (after.score - beforeScore);
    if (after.score - beforeScore !== sim.gain && mismatches <= 5) {
      console.log(`  ⚠ 第 ${plays} 步得分不符: 网站 +${after.score - beforeScore}, 本地算 +${sim.gain}`);
    }
  }

  const fin = await readBoard(page);
  console.log('');
  console.log('===== 验证结果 =====');
  console.log(`  比对步数: ${plays}`);
  console.log(`  规则不符: ${mismatches}  (0 = 本地引擎与网站完全一致)`);
  console.log(`  生成 2: ${spawn2} 次, 生成 4: ${spawn4} 次`);
  const total = spawn2 + spawn4;
  if (total > 0) console.log(`  实测生成4概率: ${(spawn4 / total * 100).toFixed(2)}%  (本地按 10% 建模)`);
  console.log(`  本地模拟累计得分: ${scoreSum.toLocaleString()}`);
  if (fin) console.log(`  网站实际得分: ${fin.score.toLocaleString()}  (差值 ${(fin.score - scoreSum).toLocaleString()} = 开局两个方块等) `);
  await browser.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
