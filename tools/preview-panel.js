'use strict';
// 本地预览状态面板布局: 手机(390x844) + 桌面(1280x800) 各截一张
// 用法: node tools/preview-panel.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'logs', '_panel_preview.html'), 'utf8');

// 预览时把 /shot.png 换成一张真实截图, 这样能看出图片在页面里的实际占比
const shot = process.argv[2] || path.join(ROOT, 'results', 'screenshots', 'live.png');
const shotUrl = fs.existsSync(shot) ? 'file:///' + shot.replace(/\\/g, '/') : 'https://placehold.co/1440x900/222/666?text=screenshot';
const html = src.replace(/src="\/shot\.png\?t=\d+"/, `src="${shotUrl}"`);
const file = path.join(ROOT, 'logs', '_panel_preview2.html');
fs.writeFileSync(file, html);
console.log('用图:', shotUrl);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  for (const [name, vp] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto('file:///' + file.replace(/\\/g, '/'));
    await page.waitForTimeout(400);
    const out = path.join(ROOT, 'results', 'screenshots', `_panel_${name}.png`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, fullPage: true });
    console.log(`${name}: ${vp.width}x${vp.height} -> ${path.relative(ROOT, out)}`);
    await ctx.close();
  }
  await browser.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
