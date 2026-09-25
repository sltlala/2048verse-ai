'use strict';
// 验证 HUD 注入: 从 run.js 提取真实 HUD_HTML, 注入页面并截图
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 从 run.js 提取 HUD_HTML 模板字符串
const src = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
const m = src.match(/const HUD_HTML = `([\s\S]*?)`;/);
if (!m) { console.error('未能提取 HUD_HTML'); process.exit(1); }
const HUD_HTML = eval('`' + m[1] + '`');   // 展开 ${...} 表达式
console.log('HUD_HTML 长度:', HUD_HTML.length, '字符');
console.log('开头 30 字符:', JSON.stringify(HUD_HTML.slice(0, 30)));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launchPersistentContext(path.resolve(__dirname, '.chrome-profile-hudtest'), {
    channel: 'chrome', headless: false, viewport: null,
  });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('https://2048verse.com/4x4', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#board-4x4', { timeout: 30000 });
  await sleep(2000);

  // 用修复后的方式注入
  const ok = await page.evaluate((html) => {
    if (!document.querySelector('#board-4x4')) return 'no-board';
    const old = document.getElementById('dsh-hud');
    if (old) old.remove();
    const container = document.createElement('div');
    container.innerHTML = html;
    const el = container.firstElementChild;
    if (!el) return 'no-element';
    document.body.appendChild(el);
    return 'injected';
  }, HUD_HTML);
  console.log('注入结果:', ok);
  await sleep(500);

  // 写入一些模拟数据, 检查渲染
  await page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    if (!$('dsh-hud')) return;
    $('dsh-hud-score').textContent = '386,636';
    $('dsh-hud-moves').textContent = '14693';
    $('dsh-hud-empty').textContent = '2';
    $('dsh-hud-maxtile').textContent = '16K';
    $('dsh-hud-arrow').textContent = '→';
    $('dsh-hud-detail').textContent = '深度12 · 294/225ms · 4.5步/秒';
    $('dsh-hud-gameno').textContent = '3';
    $('dsh-hud-best').textContent = '386,636';
    const cells = $('dsh-hud-grid').children;
    const vals = [16384,8192,4096,2048,1024,512,256,128,64,32,16,8,4,2,0,0];
    const colors = {16384:'#4affef',8192:'#5effa8',4096:'#9dff5e',2048:'#ffd700',1024:'#f7dc24',512:'#f0d430',256:'#e8c93a',128:'#e5c04a',64:'#e8452f',32:'#e0523a',16:'#d95f3b',8:'#c26a4a',4:'#5a6a8a',2:'#4a5568'};
    for (let i = 0; i < 16; i++) {
      const v = vals[i];
      cells[i].textContent = v || '';
      cells[i].style.background = v ? colors[v] : 'rgba(120,140,180,0.15)';
      cells[i].style.color = v ? '#fff' : 'transparent';
    }
  });
  await sleep(500);

  // 检查元素是否存在 + 可见性
  const info = await page.evaluate(() => {
    const el = document.getElementById('dsh-hud');
    if (!el) return { exists: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
    return {
      exists: true,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
      zIndex: cs.zIndex, position: cs.position,
      topElementAtHud: top ? (top.id || top.className || top.tagName) : null,
    };
  });
  console.log('HUD 状态:', JSON.stringify(info, null, 2));

  await page.screenshot({ path: 'hud_check.png' });
  console.log('截图已保存: hud_check.png');
  await sleep(500);
  await browser.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
