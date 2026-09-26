// 抓取 2048verse 排行榜, 定位我方分数能排第几
const { chromium } = require('playwright');
const ROOT = require('path').join(__dirname, '..');
const path = require('path');

const MY_SCORE = parseInt(process.argv[2] || '338668', 10);

(async () => {
  const browser = await chromium.launchPersistentContext(path.resolve(ROOT, '.chrome-profile-lb'), {
    channel: 'chrome', headless: true, viewport: { width: 1440, height: 900 },
  });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('https://2048verse.com/4x4', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);

  // 滚动加载更多排行 (如果支持)
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(600);
  }

  const rows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.leaderboard-row')).map(r => r.innerText.replace(/\n/g, ' | ').trim());
  });
  console.log('排行榜行数:', rows.length);
  rows.forEach((r, i) => console.log(r));

  // 解析分数
  const scores = [];
  for (const r of rows) {
    const m = r.match(/(\d[\d,]{2,})/);
    if (m) scores.push(parseInt(m[1].replace(/,/g, ''), 10));
  }
  scores.sort((a, b) => b - a);
  const rank = scores.filter(s => s > MY_SCORE).length + 1;
  console.log('\n=== 定位 ===');
  console.log(`我方得分 ${MY_SCORE.toLocaleString()} → 在已抓取的前 ${scores.length} 名中排第 ${rank}`);
  console.log('分数区间: 最高 ' + scores[0].toLocaleString() + ' | 最低 ' + scores[scores.length - 1].toLocaleString());
  console.log('前 20 名分数: ' + scores.slice(0, 20).join(', '));
  await browser.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
