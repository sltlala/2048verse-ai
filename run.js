'use strict';
// ============================================================
// 2048verse.com/4x4 自动刷分脚本 (可视化)
//
// 用法:
//   node run.js                 # 无限局自动玩, Ctrl+C 停止
//   node run.js --games 5       # 玩 5 局后停止
//   node run.js --speed 200     # 每步基础延迟 200ms (默认 130)
//   node run.js --newgame       # 启动时不接着旧局面, 直接开新局
//
// 功能:
//   - 打开独立 Chrome 窗口 (登录状态持久保存, 只需登录一次)
//   - 等待你手动登录账号后自动开始 (登录过程页面跳转不会退出)
//   - 页面右上角 HUD 实时显示 AI 决策与局面
//   - Expectimax AI 自动玩, 游戏结束自动重开, 持续冲击高分
//
// 健壮性设计 (v2):
//   - 页面跳转/登录过程中所有页面操作永不抛异常 (等待而非退出)
//   - 登录检测基于 URL + 全局导航链接, 不会误判
//   - 页面离开游戏界面时耐心等待, 回来后自动恢复 (HUD 重注入)
//   - 浏览器断开/标签页关闭时优雅处理
// ============================================================

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const ai = require('./ai');

// ---------- 命令行参数 ----------
function parseArgs() {
  const args = { games: Infinity, speed: 30, newgame: false, profile: '.chrome-profile', guest: false, budget: 150, p4: 10, depth: 0, snake: 0, noAdaptive: false, windowSize: 'none', headless: false, browser: 'auto', webhook: null, session: null, exportSession: null };
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--games') args.games = parseInt(raw[++i], 10);
    else if (raw[i] === '--speed') args.speed = parseInt(raw[++i], 10);
    else if (raw[i] === '--budget') args.budget = parseInt(raw[++i], 10);
    else if (raw[i] === '--p4') args.p4 = parseFloat(raw[++i]);
    else if (raw[i] === '--depth') args.depth = parseInt(raw[++i], 10);
    else if (raw[i] === '--snake') args.snake = parseFloat(raw[++i]);
    else if (raw[i] === '--newgame') args.newgame = true;
    else if (raw[i] === '--profile') args.profile = raw[++i];
    else if (raw[i] === '--guest') args.guest = true;
    else if (raw[i] === '--no-adaptive') args.noAdaptive = true; // 关闭自适应预算(全程用满)
    else if (raw[i] === '--window') args.windowSize = raw[++i];  // 窗口尺寸: none/max/fullscreen/fit/WxH
    else if (raw[i] === '--headless') args.headless = true;      // 无头模式 (服务器部署)
    else if (raw[i] === '--browser') args.browser = raw[++i];    // auto | chrome | chromium
    else if (raw[i] === '--webhook') args.webhook = raw[++i];    // 每局结束后 POST 结果到该 URL
    else if (raw[i] === '--session') args.session = raw[++i];    // 从文件导入登录会话 (服务器部署)
    else if (raw[i] === '--export-session') args.exportSession = raw[++i]; // 导出当前登录会话到文件
    else if (raw[i] === '--selftest-nav') args.selftestNav = true; // 内部测试: 模拟登录跳转
  }
  return args;
}
const ARGS = parseArgs();

// ---------- 方向 → 按键映射 (方向键 + WASD 混用) ----------
const ARROW_KEYS = { 0: 'ArrowUp', 1: 'ArrowDown', 2: 'ArrowLeft', 3: 'ArrowRight' };
const WASD_KEYS = { 0: 'w', 1: 's', 2: 'a', 3: 'd' };
const ARROWS = ['↑', '↓', '←', '→'];
const SITE = 'https://2048verse.com';
const GAME_URL = SITE + '/4x4';

// ---------- 工具 ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => n.toLocaleString('en-US');

// 浏览器/进程状态
let browserDisconnected = false;
process.exitRequested = false;
process.on('SIGINT', () => {
  console.log('\n收到停止信号, 完成当前步骤后退出...');
  process.exitRequested = true;
});

// 安全 evaluate: 页面跳转/关闭时返回 null 而不是抛异常
async function safeEval(page, fn, ...args) {
  try {
    if (page.isClosed()) return null;
    return await page.evaluate(fn, ...args);
  } catch { return null; }
}

// ---------- 统计持久化 ----------
const STATS_FILE = path.join(__dirname, 'stats.json');
const RESULTS_DIR = path.join(__dirname, 'results');
const SHOTS_DIR = path.join(RESULTS_DIR, 'screenshots');
const HISTORY_FILE = path.join(RESULTS_DIR, 'history.json');
const JSONL_FILE = path.join(RESULTS_DIR, 'results.jsonl');

function ensureDirs() {
  for (const d of [RESULTS_DIR, SHOTS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { }
  }
}

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { }
  return { bestScore: 0, bestTile: 0, games: 0, totalScore: 0 };
}
function saveStats(s) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('统计保存失败:', e.message); }
}

// 时间戳 (用于文件命名): 2026-09-25_18-30-45
function tsCompact(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// 读取历史记录: 优先 history.json; 若损坏/缺失则从 results.jsonl 重建 (自愈)
function loadHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(h) && h.length) return h;
  } catch { }
  try {
    const lines = fs.readFileSync(JSONL_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    const arr = [];
    for (const l of lines) {
      try { arr.push(JSON.parse(l.replace(/^\uFEFF/, ''))); } catch { } // 容忍 BOM
    }
    if (arr.length) {
      console.log(`  ℹ history.json 不可用, 已从 results.jsonl 重建 ${arr.length} 条记录`);
      return arr;
    }
  } catch { }
  return [];
}

// ---------- 单局结果保存 (数据 + 结束截图) ----------
// 命名规则: <分数>_<时间点>.png  例: 386636_2026-09-25_18-30-45.png
let lastSavedGameId = null;

async function saveGameResult(page, result, gameNo, label = 'gameover') {
  ensureDirs();
  const endTime = new Date();
  const state = await readState(page);

  const board = (state && state.board) || result.board || [];
  const score = state ? state.score : result.score;
  const moves = state ? state.moves : result.moves;
  const fourSpawns = state ? state.fourSpawns : (result.fourSpawns || 0);
  const tileSum = board.reduce((a, b) => a + b, 0) || (state && state.tileSum) || 0;
  const maxTile = board.length ? Math.max(...board) : result.maxTile;
  const fourSpawnPct = moves > 0 ? +(fourSpawns / moves * 100).toFixed(2) : null;

  const stamp = tsCompact(endTime);
  const base = `${score}_${stamp}`;
  const shotPath = path.join(SHOTS_DIR, `${base}.png`);

  let shotOk = false;
  try {
    await page.screenshot({ path: shotPath });
    shotOk = true;
  } catch (e) { console.log('  ⚠ 截图失败: ' + e.message.split('\n')[0]); }

  const record = {
    gameNo,
    label,                                  // gameover / interrupted
    endTime: endTime.toISOString(),
    endTimeLocal: stamp,
    score,                                  // 总分数
    tileSum,                                // 棋盘所有方块数值之和
    moves,                                  // 步数
    fourSpawns,                             // 生成 4 的次数
    fourSpawnPct,                           // 生成 4 的百分比
    maxTile,                                // 最大方块
    durationMin: result.durationMin || null,
    gameId: state ? state.gameId : null,
    board,
    screenshot: shotOk ? path.relative(__dirname, shotPath).replace(/\\/g, '/') : null,
    config: { fourRate: ARGS.p4, budgetMs: ARGS.budget, fixedDepth: ARGS.depth, snakeWeight: ARGS.snake, speedMs: ARGS.speed },
  };
  if (state && state.gameId) lastSavedGameId = state.gameId;

  // 1) 追加 JSONL (每行一条, 方便后续分析)
  try { fs.appendFileSync(JSONL_FILE, JSON.stringify(record) + '\n'); } catch (e) { console.log('  ⚠ JSONL 写入失败: ' + e.message); }
  // 2) 维护 history.json (数组形式; 若损坏会自动从 jsonl 重建)
  try {
    const hist = loadHistory();
    hist.push(record);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2));
  } catch (e) { console.log('  ⚠ history 写入失败: ' + e.message); }

  console.log(`  💾 已保存: results/screenshots/${base}.png`);
  console.log(`     分数 ${fmt(score)} | Tile Sum ${fmt(tileSum)} | Moves ${moves} | 生成4率 ${fourSpawnPct}% | 最大 ${maxTile}`);

  // 可选: POST 到 webhook (服务器部署时可用来推送通知/入库)
  if (ARGS.webhook) {
    try {
      const res = await fetch(ARGS.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
      console.log(`     ↪ webhook: HTTP ${res.status}`);
    } catch (e) {
      console.log('     ⚠ webhook 推送失败: ' + e.message.split('\n')[0]);
    }
  }
  return record;
}

// ---------- 页面状态读取 + HUD 刷新 (合并为一次页面往返, 省一半 CDP 通信) ----------
async function readStateAndHUD(page, hud) {
  return safeEval(page, (d) => {
    // 1) 读状态
    let state = null;
    if (document.querySelector('#board-4x4')) {
      const raw = localStorage.getItem('gameState4x4');
      if (raw) {
        try {
          const s = JSON.parse(raw);
          const board = [];
          let empty = 0;
          for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
            const cell = s.boardState[r][c];
            const v = cell ? cell.value : 0;
            if (v === 0) empty++;
            board.push(v);
          }
          const msg = document.querySelector('#board-4x4 .game-message');
          const msgShown = msg && msg.style.display !== 'none';
          state = {
            board, empty, score: s.score, moves: s.moves,
            fourSpawns: s.fourSpawns || 0,
            tileSum: board.reduce((a, b) => a + b, 0),
            gameId: s.gameId, msgShown,
            msgText: msgShown ? msg.innerText.slice(0, 50) : null,
            hudAlive: !!document.getElementById('dsh-hud'),
          };
        } catch { state = null; }
      }
    }
    // 2) 刷新 HUD (与读状态同一次往返)
    if (d) {
      const $ = (id) => document.getElementById(id);
      if ($('dsh-hud')) {
        $('dsh-hud-score').textContent = d.score.toLocaleString();
        $('dsh-hud-moves').textContent = d.moves;
        $('dsh-hud-empty').textContent = d.empty;
        $('dsh-hud-maxtile').textContent = d.maxTile >= 1024 ? (d.maxTile / 1024) + 'K' : d.maxTile;
        $('dsh-hud-arrow').textContent = d.arrow || '-';
        $('dsh-hud-detail').textContent = d.depth != null ? `深度${d.depth} · ${d.timeMs}/${d.budget}ms · ${d.mps}步/秒` : '-';
        $('dsh-hud-gameno').textContent = d.gameNo;
        $('dsh-hud-best').textContent = d.best.toLocaleString();
        $('dsh-hud-status').textContent = d.status;
        $('dsh-hud-status').style.color = d.status === '● 运行中' ? '#7fe08a' : '#ffb066';
        const cells = $('dsh-hud-grid').children;
        const colors = d.tileColors;
        for (let i = 0; i < 16; i++) {
          const v = d.board[i];
          cells[i].textContent = v || '';
          cells[i].style.background = v ? colors[v] || '#b44aff' : 'rgba(120,140,180,0.15)';
          cells[i].style.color = v ? '#fff' : 'transparent';
        }
      }
    }
    return state;
  }, hud);
}

// 单纯读取状态 (其他调用点使用)
async function readState(page) {
  return readStateAndHUD(page, null);
}

// ---------- 登录状态检测 ----------
// 原理: "Log In" 是全站导航链接。已登录 = 不在 /login 页 且 页面上没有 Log In 链接
// (登录页本身没有 Log In 链接, 必须排除, 否则误判)
async function getLoginState(page) {
  const st = await safeEval(page, () => {
    const url = location.href;
    const isLoginPage = /\/login/.test(url);
    const hasLoginLink = Array.from(document.querySelectorAll('a'))
      .some(a => /^log ?in$/i.test((a.textContent || '').trim()));
    const hasBoard = !!document.querySelector('#board-4x4');
    return { url, isLoginPage, hasLoginLink, hasBoard };
  });
  if (!st) return null;
  st.loggedIn = !st.isLoginPage && !st.hasLoginLink;
  return st;
}

// ---------- HUD ----------
const HUD_HTML = `
<div id="dsh-hud" style="position:fixed;top:12px;right:12px;z-index:99999;width:250px;
     background:rgba(20,24,34,0.92);border:1px solid rgba(120,160,255,0.35);border-radius:14px;
     padding:14px 16px;color:#e8ecf5;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;
     box-shadow:0 6px 24px rgba(0,0,0,0.45);line-height:1.65;user-select:none;">
  <div style="font-weight:700;font-size:14px;margin-bottom:8px;letter-spacing:0.5px;">
    🤖 2048 AI 自动驾驶 <span id="dsh-hud-status" style="float:right;color:#7fe08a;">● 运行中</span>
  </div>
  <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
    <span>得分</span><b id="dsh-hud-score" style="color:#ffd76e;font-size:16px;">0</b>
  </div>
  <div style="display:flex;justify-content:space-between;">
    <span>步数 / 空格</span><span><span id="dsh-hud-moves">0</span> / <span id="dsh-hud-empty">0</span></span>
  </div>
  <div style="display:flex;justify-content:space-between;">
    <span>最大方块</span><b id="dsh-hud-maxtile" style="color:#9fd0ff;">2</b>
  </div>
  <div style="display:flex;align-items:center;gap:8px;margin:8px 0;padding:6px 10px;border-radius:10px;
       background:rgba(90,130,255,0.12);border:1px solid rgba(120,160,255,0.25);">
    <span>决策</span>
    <span id="dsh-hud-arrow" style="font-size:26px;font-weight:900;color:#7fe08a;line-height:1;">→</span>
    <span id="dsh-hud-detail" style="margin-left:auto;font-size:11px;color:#a8b4cc;">深度- · -ms</span>
  </div>
  <div id="dsh-hud-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px;margin:8px 0;">
    ${'<div style="aspect-ratio:1;border-radius:5px;background:rgba(120,140,180,0.15);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;"></div>'.repeat(16)}
  </div>
  <div style="display:flex;justify-content:space-between;font-size:12px;color:#a8b4cc;">
    <span>第 <span id="dsh-hud-gameno">1</span> 局</span>
    <span>历史最佳 <b id="dsh-hud-best" style="color:#ffd76e;">0</b></span>
  </div>
</div>`;

async function injectHUD(page) {
  return !!(await safeEval(page, (html) => {
    if (!document.querySelector('#board-4x4')) return false; // 只在游戏页注入
    const old = document.getElementById('dsh-hud');
    if (old) old.remove();
    const container = document.createElement('div');
    container.innerHTML = html;
    // 注意: 必须用 firstElementChild —— 模板字符串开头的换行会让 firstChild 取到文本节点,
    // 那样 appendChild 插进去的只是空白, HUD 不会显示 (曾经的 bug)
    const el = container.firstElementChild;
    if (!el) return false;
    document.body.appendChild(el);
    return true;
  }, HUD_HTML));
}

function tileColor(v) {
  const map = {
    2: '#4a5568', 4: '#5a6a8a', 8: '#c26a4a', 16: '#d95f3b', 32: '#e0523a', 64: '#e8452f',
    128: '#e5c04a', 256: '#e8c93a', 512: '#f0d430', 1024: '#f7dc24', 2048: '#ffd700',
    4096: '#9dff5e', 8192: '#5effa8', 16384: '#4affef', 32768: '#4ab8ff',
  };
  return map[v] || '#b44aff';
}

async function updateHUD(page, d) {
  await safeEval(page, (data) => {
    const $ = (id) => document.getElementById(id);
    if (!$('dsh-hud')) return;
    $('dsh-hud-score').textContent = data.score.toLocaleString();
    $('dsh-hud-moves').textContent = data.moves;
    $('dsh-hud-empty').textContent = data.empty;
    $('dsh-hud-maxtile').textContent = data.maxTile >= 1024 ? (data.maxTile / 1024) + 'K' : data.maxTile;
    $('dsh-hud-arrow').textContent = data.arrow || '-';
    $('dsh-hud-detail').textContent = data.depth != null ? `深度${data.depth} · ${data.timeMs}/${data.budget}ms · ${data.mps}步/秒` : '-';
    $('dsh-hud-gameno').textContent = data.gameNo;
    $('dsh-hud-best').textContent = data.best.toLocaleString();
    $('dsh-hud-status').textContent = data.status;
    $('dsh-hud-status').style.color = data.status === '● 运行中' ? '#7fe08a' : '#ffb066';
    const cells = $('dsh-hud-grid').children;
    const colors = data.tileColors;
    for (let i = 0; i < 16; i++) {
      const v = data.board[i];
      cells[i].textContent = v || '';
      cells[i].style.background = v ? colors[v] || '#b44aff' : 'rgba(120,140,180,0.15)';
      cells[i].style.color = v ? '#fff' : 'transparent';
    }
  }, d);
}

// ---------- 登录等待 ----------
// 返回可用的游戏页 (可能不是最初那个, 例如登录在新标签页完成)
async function waitForLogin(browser, initialPage) {
  // 初始快速检查
  const st0 = await getLoginState(initialPage);
  if (st0 && st0.loggedIn) {
    console.log('✓ 已检测到登录状态 (持久化配置有效)');
    return initialPage;
  }

  console.log('\n┌────────────────────────────────────────────────────┐');
  console.log('│  请在打开的 Chrome 窗口中登录你的 2048verse 账号       │');
  console.log('│  登录完成后脚本会自动检测并开始游戏                     │');
  console.log('│  (脚本会一直耐心等待, 不会退出)                        │');
  console.log('└────────────────────────────────────────────────────┘\n');

  let loginPageHinted = false;
  let lastRemind = Date.now();

  while (true) {
    if (process.exitRequested || browserDisconnected) return null;
    await sleep(2000);

    // 检查所有打开的页面 (登录可能在新标签页完成)
    const pages = browser.pages().filter(p => !p.isClosed());
    if (pages.length === 0) continue;

    let loggedInPage = null, onLoginPage = false;
    for (const p of pages) {
      const st = await getLoginState(p);
      if (!st) continue;
      if (st.loggedIn) {
        // 优先有棋盘的页面
        if (!loggedInPage || (st.hasBoard && !loggedInPage.hasBoard)) {
          loggedInPage = { page: p, ...st };
        }
      } else if (st.isLoginPage) onLoginPage = true;
    }

    if (loggedInPage) {
      console.log('✓ 登录成功!');
      const page = loggedInPage.page;
      // 确保回到游戏页 (登录流程已结束, 此时导航是安全的)
      if (!loggedInPage.url.includes('/4x4')) {
        await sleep(1500);
        await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' }).catch(() => { });
        await page.waitForSelector('#board-4x4', { timeout: 15000 }).catch(() => { });
      }
      await sleep(1000);
      return page;
    }

    if (onLoginPage && !loginPageHinted) {
      console.log('⏳ 检测到你在登录页, 请完成登录, 完成后自动继续...');
      loginPageHinted = true;
    }
    if (Date.now() - lastRemind > 300000) {
      console.log('⏳ 仍在等待登录... (脚本会一直等, Ctrl+C 可退出)');
      lastRemind = Date.now();
    }
  }
}

// ---------- 游戏控制 ----------
async function startNewGame(page) {
  await safeEval(page, () => {
    localStorage.setItem('winScreenDisabled', 'true');
    localStorage.setItem('confirmRestart', 'false');
  });
  try {
    if (page.isClosed()) return;
    await page.click('.new-game-button', { timeout: 8000 });
  } catch {
    // 备选: 结束画面的 Try again
    try { await page.click('#board-4x4 .game-message button', { timeout: 3000 }); } catch { }
  }
  await sleep(600);
}

// 胜利画面: 点击 "Keep going" 继续游戏 (冲更高分)
async function clickKeepGoing(page) {
  return !!(await safeEval(page, () => {
    const btns = Array.from(document.querySelectorAll('.game-message button'));
    const keep = btns.find(b => /keep going|继续/i.test((b.textContent || '').trim()));
    if (keep) { keep.click(); return true; }
    return false;
  }));
}

async function pressMove(page, dir) {
  try {
    if (page.isClosed()) return false;
    const useWasd = Math.random() < 0.45;
    const key = useWasd ? WASD_KEYS[dir] : ARROW_KEYS[dir];
    await page.keyboard.press(key);
    return true;
  } catch { return false; }
}

// ---------- 单局游戏 ----------
// 返回: {score,maxTile,moves} 正常结束 | 'PAGE_LOST' 页面丢失(主循环找新页面) | null 收到退出信号
async function playOneGame(page, gameNo, stats) {
  const t0 = Date.now();
  let decisionCount = 0, staleCount = 0, lastMoves = -1;
  let keepGoingFails = 0;
  let awayLogged = false, awaySeconds = 0;
  let pendingHud = null;      // 上一轮的 HUD 数据 (与下一次读状态合并成一次往返)
  let lastDecisionDir = null; // 输入丢失时用于重按

  while (true) {
    if (process.exitRequested || browserDisconnected) return null;

    // 一次往返: 读状态 + 刷新上一轮的 HUD
    const state = await readStateAndHUD(page, pendingHud);
    pendingHud = null;

    if (!state) {
      if (page.isClosed()) return 'PAGE_LOST';

      awaySeconds++;
      if (!awayLogged) {
        console.log('  ⏸ 检测到页面离开游戏界面 (登录/跳转中), 脚本等待返回, 不会退出...');
        awayLogged = true;
      }
      if (awaySeconds >= 30) {
        const url = page.url();
        if (/2048verse\.com/.test(url) && !/\/login/.test(url)) {
          console.log('  ↩ 自动返回游戏页面...');
          await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' }).catch(() => { });
          await sleep(1000);
          await injectHUD(page);
        }
        awaySeconds = 0;
      }
      await sleep(1000);
      continue;
    }

    if (awayLogged) {
      if (!state.hudAlive) {
        const ok = await injectHUD(page);
        console.log(ok ? '  🎛  HUD 已重新注入' : '  ⚠  HUD 重注入失败');
      }
      console.log('  ▶ 页面已回到游戏, 继续对局');
      awayLogged = false;
    }
    awaySeconds = 0;

    // 胜利/结束画面处理
    if (state.msgShown) {
      const text = (state.msgText || '').toLowerCase();
      const isWin = /win|胜利|继续/.test(text) && !/over/.test(text);
      if (isWin && keepGoingFails < 6) {
        const clicked = await clickKeepGoing(page);
        keepGoingFails = clicked ? 0 : keepGoingFails + 1;
        console.log(`  🏆 合成 2048! 得分 ${fmt(state.score)}, 点击继续游戏...`);
        await sleep(700);
        continue;
      }
      console.log(`  本局结束: 得分 ${fmt(state.score)} (画面: ${(state.msgText || '').replace(/\n/g, ' ')})`);
      break;
    }

    // 先确认上一步已生效 (避免为无效局面白算一次搜索)
    if (state.moves === lastMoves) {
      staleCount++;
      if (staleCount > 12) {
        await page.click('#board-4x4', { position: { x: 200, y: 200 }, timeout: 5000 }).catch(() => { });
        staleCount = 0;
      } else {
        await sleep(20);
      }
      if (staleCount % 4 === 0 && lastDecisionDir !== null) await pressMove(page, lastDecisionDir);
      continue;
    }
    lastMoves = state.moves;
    staleCount = 0;
    decisionCount++;

    // AI 决策: 按空格数给自适应预算 (前期快, 后期深)
    const budget = ARGS.noAdaptive ? ARGS.budget : ai.adaptiveBudget(state.empty, ARGS.budget);
    const decision = ai.getBestMove(state.board, budget);

    if (decision.dir === null) {
      if (state.empty === 0) {
        console.log(`  本局结束: 得分 ${fmt(state.score)} (无可移动方向)`);
        break;
      }
      console.log('  ⚠ AI 无方向但有空格, 状态异常, 稍后重试');
      await sleep(500);
      continue;
    }

    // 准备 HUD 数据 (下一轮读状态时一并刷新, 省一次往返)
    const maxTile = Math.max(...state.board);
    const elapsedSec = (Date.now() - t0) / 1000;
    pendingHud = {
      score: state.score, moves: state.moves, empty: state.empty, maxTile,
      arrow: ARROWS[decision.dir], depth: decision.depth, timeMs: decision.timeMs,
      budget, mps: elapsedSec > 0 ? (decisionCount / elapsedSec).toFixed(1) : '0',
      dirName: decision.dirName.replace(/[↑↓←→]/, ''), gameNo,
      best: Math.max(stats.bestScore, state.score), status: '● 运行中',
      board: state.board, tileColors: Object.fromEntries(
        [...new Set(state.board.filter(v => v > 0))].map(v => [v, tileColor(v)])
      ),
    };

    // 按键
    lastDecisionDir = decision.dir;
    const pressed = await pressMove(page, decision.dir);
    if (!pressed) continue;

    // 节奏控制: 基础延迟 + 抖动(随速度缩放) + 偶尔停顿
    let delay = ARGS.speed + Math.random() * Math.min(30, ARGS.speed);
    if (ARGS.speed > 0 && Math.random() < 0.03) delay += 200 + Math.random() * 400;
    if (decisionCount % 50 === 0) {
      const elapsed = (Date.now() - t0) / 1000;
      const mps = (decisionCount / elapsed).toFixed(1);
      console.log(`    步 ${state.moves}: 得分 ${fmt(state.score)}, 最大 ${maxTile}, 决策 ${decision.timeMs}ms(预算${budget}ms, 空${state.empty}), 速度 ${mps} 步/秒`);
    }
    await sleep(delay);
  }

  // 结束确认
  await sleep(800);
  const finalState = await readState(page);
  const maxTile = finalState ? Math.max(...finalState.board) : 0;
  const score = finalState ? finalState.score : 0;
  const durMin = (Date.now() - t0) / 60000;
  const dur = durMin.toFixed(1);
  console.log(`  本局汇总: 得分 ${fmt(score)}, 最大方块 ${maxTile}, 步数 ${finalState ? finalState.moves : '?'}, 用时 ${dur} 分钟`);
  return {
    score, maxTile,
    moves: finalState ? finalState.moves : 0,
    fourSpawns: finalState ? finalState.fourSpawns : 0,
    tileSum: finalState ? finalState.tileSum : 0,
    board: finalState ? finalState.board : [],
    durationMin: +durMin.toFixed(2),
  };
}

// ---------- 窗口尺寸 ----------
// 默认 'none': 不干预窗口尺寸 —— Chrome 会沿用该配置上次记住的窗口大小
//             (也就是"现在的尺寸"), 且不会进入全屏/最大化状态
// 需要时可用 --window 显式指定:
//   --window max         最大化
//   --window fullscreen  真全屏 (隐藏浏览器界面)
//   --window fit         铺满屏幕可用区域 (自适应 DPI)
//   --window 1600x900    指定精确尺寸
async function applyWindowSize(context, spec) {
  const mode = spec || 'none';
  try {
    const page = context.pages()[0];
    if (!page) return;
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');

    if (mode === 'none') {
      // 只读取并显示当前尺寸, 不做任何修改
      const b = await cdp.send('Browser.getWindowBounds', { windowId }).catch(() => null);
      if (b && b.bounds) {
        console.log(`  🪟 保持当前窗口尺寸 ${b.bounds.width}×${b.bounds.height} (${b.bounds.windowState})`);
      }
      await cdp.detach().catch(() => { });
      return;
    }

    if (mode === 'fullscreen') {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
      await sleep(400);
      const b = await cdp.send('Browser.getWindowBounds', { windowId }).catch(() => null);
      console.log(`  🪟 已全屏 (${b && b.bounds ? b.bounds.width + '×' + b.bounds.height : ''})`);
    } else if (mode === 'max') {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
      await sleep(400);
      const b = await cdp.send('Browser.getWindowBounds', { windowId }).catch(() => null);
      console.log(`  🪟 已最大化 (${b && b.bounds ? b.bounds.width + '×' + b.bounds.height : ''})`);
    } else if (mode === 'fit') {
      // 铺满当前屏幕的可用区域 (自适应所在显示器)
      const s = await page.evaluate(() => ({
        aw: screen.availWidth, ah: screen.availHeight, sw: screen.width, sh: screen.height,
        dpr: window.devicePixelRatio,
      }));
      // 先退出最大化状态再设置精确尺寸, 否则尺寸会被忽略
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => { });
      await sleep(200);
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: 0, top: 0, width: s.aw, height: s.ah, windowState: 'normal' },
      });
      await sleep(400);
      const b = await cdp.send('Browser.getWindowBounds', { windowId }).catch(() => null);
      const got = b && b.bounds ? `${b.bounds.width}×${b.bounds.height}` : '?';
      console.log(`  🪟 窗口已铺满屏幕 (${got}, 屏幕可用 ${s.aw}×${s.ah}, 缩放 ${Math.round(s.dpr * 100)}%)`);
    } else {
      const m = /^(\d+)\s*[xX]\s*(\d+)$/.exec(mode);
      if (m) {
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => { });
        await sleep(200);
        await cdp.send('Browser.setWindowBounds', {
          windowId,
          bounds: { left: 0, top: 0, windowState: 'normal', width: parseInt(m[1], 10), height: parseInt(m[2], 10) },
        });
        await sleep(400);
        const b = await cdp.send('Browser.getWindowBounds', { windowId }).catch(() => null);
        console.log(`  🪟 窗口尺寸已设为 ${b && b.bounds ? b.bounds.width + '×' + b.bounds.height : mode}`);
      }
    }
    await cdp.detach().catch(() => { });
  } catch (e) {
    console.log('  ⚠ 窗口尺寸调整失败(不影响运行): ' + e.message.split('\n')[0]);
  }
}

// ---------- 会话导入/导出 (服务器部署用) ----------
// Windows 的 Chrome Cookie 由 DPAPI 加密, 直接拷贝 .chrome-profile 到 Linux 会失效。
// 用 Playwright storageState: 它通过 CDP 读出明文 Cookie, 可在任意平台注入。
//   本地(已登录): node run.js --export-session session.json
//   服务器:       node run.js --headless --session session.json --browser chromium
async function exportSession(context, file, page) {
  const state = await context.storageState();
  const out = { savedAt: new Date().toISOString(), cookies: state.cookies, origins: state.origins || [] };
  // 补充 localStorage 里的游戏相关键 (登录凭证通常在 cookie, 这里只是保险)
  try {
    const ls = await safeEval(page, () => {
      const o = {};
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); }
      return o;
    });
    if (ls) out.localStorage = ls;
  } catch { }
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  return out;
}

async function applySession(context, file, page) {
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    console.log(`  ⚠ 会话文件读取失败 (${file}): ` + e.message.split('\n')[0]);
    return false;
  }
  try {
    if (Array.isArray(s.cookies) && s.cookies.length) {
      await context.addCookies(s.cookies);
      console.log(`  🔑 已注入 ${s.cookies.length} 个 Cookie`);
    }
    if (s.localStorage && page) {
      await page.addInitScript((kv) => {
        try {
          if (!/2048verse\.com/.test(location.hostname)) return;
          for (const k of Object.keys(kv)) {
            if (kv[k] !== null && kv[k] !== undefined) localStorage.setItem(k, kv[k]);
          }
        } catch { }
      }, s.localStorage);
      console.log(`  🔑 已注入 ${Object.keys(s.localStorage).length} 个 localStorage 键`);
    }
    return true;
  } catch (e) {
    console.log('  ⚠ 会话注入失败: ' + e.message.split('\n')[0]);
    return false;
  }
}

// ---------- 浏览器启动 ----------
// 优先用系统 Chrome; 服务器上没有 Chrome 时自动回退到 Playwright 自带 Chromium
// (需先执行 npx playwright install --with-deps chromium)
// root 用户下 Chrome 拒绝启用沙箱, 此时自动关闭沙箱 (服务器场景可接受)
async function launchGameBrowser(userDataDir) {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const baseOpts = {
    headless: !!ARGS.headless,
    viewport: ARGS.headless ? { width: 1440, height: 900 } : null,
    // 沙箱: 只在非 root 且非无头时启用 (Chrome 在 root 下会直接拒绝启动)
    ...(isRoot ? {} : { chromiumSandbox: true, ignoreDefaultArgs: ['--no-sandbox'] }),
    args: [],
  };

  const want = ARGS.browser; // 'auto' | 'chrome' | 'chromium'
  if (want === 'chromium') {
    console.log('  🌐 使用 Playwright 自带 Chromium');
    return chromium.launchPersistentContext(userDataDir, baseOpts);
  }
  if (want === 'chrome') {
    console.log('  🌐 使用系统 Google Chrome' + (isRoot ? ' (root 环境: 已关闭沙箱)' : ''));
    return chromium.launchPersistentContext(userDataDir, { ...baseOpts, channel: 'chrome' });
  }
  // auto: 先试系统 Chrome, 失败回退自带 Chromium
  try {
    const ctx = await chromium.launchPersistentContext(userDataDir, { ...baseOpts, channel: 'chrome' });
    console.log('  🌐 使用系统 Google Chrome' + (isRoot ? ' (root 环境: 已关闭沙箱)' : ''));
    return ctx;
  } catch (e) {
    console.log('  ⚠ 系统 Chrome 不可用 (' + e.message.split('\n')[0] + ')');
    console.log('  🌐 回退到 Playwright 自带 Chromium');
    return chromium.launchPersistentContext(userDataDir, baseOpts);
  }
}

// ---------- 页面管理 ----------
// 找一个可用的游戏页: 优先当前页, 其次有棋盘的页, 否则新开
async function ensureGamePage(browser, current) {
  if (browserDisconnected) return null;
  const pages = browser.pages().filter(p => !p.isClosed());
  if (pages.length === 0) {
    try {
      const p = await browser.newPage();
      await p.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForSelector('#board-4x4', { timeout: 15000 }).catch(() => { });
      return p;
    } catch { return null; }
  }
  if (current && !current.isClosed()) return current;
  // 找有棋盘的
  for (const p of pages) {
    const st = await getLoginState(p);
    if (st && st.hasBoard) return p;
  }
  // 都没有: 用第一个导航到游戏页
  const p = pages[0];
  await p.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
  await p.waitForSelector('#board-4x4', { timeout: 15000 }).catch(() => { });
  return p;
}

// ---------- 自检: 模拟用户点击登录引发的页面跳转 ----------
function scheduleSelfTestNav(page) {
  setTimeout(async () => {
    try {
      console.log('\n[自检] 模拟点击登录: 导航到 /login ...');
      await page.goto(SITE + '/login?r=%2F4x4', { waitUntil: 'domcontentloaded' });
      await sleep(8000);
      console.log('[自检] 模拟登录完成: 返回 /4x4 ...');
      await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
    } catch (e) { console.log('[自检] 导航异常(忽略):', e.message); }
  }, 15000);
}

// ---------- 主流程 ----------
(async () => {
  console.log('════════════════════════════════════════════════');
  console.log('  2048verse 4x4 AI 自动刷分 (Expectimax)');
  console.log(`  局数: ${ARGS.games === Infinity ? '无限 (Ctrl+C 停止)' : ARGS.games} | 步延迟: ${ARGS.speed}ms | 决策预算: ${ARGS.budget}ms | 生成4概率: ${ARGS.p4}%`);
  ai.setFourRate(ARGS.p4);
  if (ARGS.depth > 0 || ARGS.snake > 0) {
    ai.configure({ fixedDepth: ARGS.depth, snakeWeight: ARGS.snake });
    console.log(`  引擎: 固定深度 ${ARGS.depth || '自适应'} | 蛇形权重 ${ARGS.snake}`);
  }
  ensureDirs();
  console.log('════════════════════════════════════════════════\n');

  const userDataDir = path.resolve(__dirname, ARGS.profile);
  let browser;
  try {
    browser = await launchGameBrowser(userDataDir);
  } catch (e) {
    console.error('\n❌ 浏览器启动失败: ' + e.message.split('\n')[0]);
    console.error('   常见原因: 上一次运行残留的 Chrome 窗口仍占用配置目录 ' + ARGS.profile);
    console.error('   解决办法: 关闭残留的自动化 Chrome 窗口后重试;');
    console.error('             或换一个配置目录: node run.js --profile .chrome-profile2');
    process.exit(1);
  }

  // 窗口尺寸 (无头模式下跳过)
  if (ARGS.headless) {
    console.log('  🖥  无头模式 (headless): 不显示窗口, 截图与数据照常保存');
  } else {
    await applyWindowSize(browser, ARGS.windowSize);
  }
  browser.on('disconnected', () => { browserDisconnected = true; });
  browser.on('dialog', d => d.accept().catch(() => { }));

  let page = browser.pages()[0] || await browser.newPage();
  page.setDefaultTimeout(30000);

  // 在任何页面脚本运行前禁用胜利弹窗 (对上下文内所有页面生效)
  await browser.addInitScript(() => {
    try {
      localStorage.setItem('winScreenDisabled', 'true');
      localStorage.setItem('confirmRestart', 'false');
    } catch { }
  });

  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#board-4x4', { timeout: 30000 });
  await sleep(1500);

  // 导入登录会话 (服务器部署: 免去在服务器上手动登录)
  if (ARGS.session) {
    const ok = await applySession(browser, ARGS.session, page);
    if (ok) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
      await page.waitForSelector('#board-4x4', { timeout: 20000 }).catch(() => { });
      await sleep(1200);
    }
  }

  // 等待登录 (返回实际可用的游戏页)
  if (ARGS.guest) {
    console.log('⏩ 游客模式: 跳过登录 (成绩不计入账号)');
  } else {
    const loginPage = await waitForLogin(browser, page);
    if (!loginPage) { console.log('浏览器已关闭或收到停止信号, 退出'); process.exit(0); }
    if (loginPage !== page) console.log('ℹ 游戏已切换到新标签页');
    page = loginPage;
    // 回到游戏页并等待棋盘
    if (!page.url().includes('/4x4')) {
      await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForSelector('#board-4x4', { timeout: 15000 }).catch(() => { });
  }

  // 导出登录会话 (供服务器复用, 之后可 Ctrl+C)
  if (ARGS.exportSession) {
    const s = await exportSession(browser, ARGS.exportSession, page);
    console.log(`\n🔑 会话已导出到 ${ARGS.exportSession}`);
    console.log(`   Cookie ${s.cookies.length} 个, localStorage ${s.localStorage ? Object.keys(s.localStorage).length : 0} 个键`);
    console.log(`   把它复制到服务器后: node run.js --headless --session ${path.basename(ARGS.exportSession)} --browser chromium`);
    console.log('   (会话文件含登录凭证, 请勿公开分享)\n');
    await browser.close().catch(() => { });
    process.exit(0);
  }

  // 注入 HUD (页面右上角可视化面板; 无头模式下没人看, 跳过以省开销)
  if (ARGS.headless) {
    console.log('🎛  无头模式: 跳过 HUD 注入 (不影响数据与截图保存)');
  } else if (await injectHUD(page)) {
    console.log('🎛  HUD 已注入 (页面右上角, 显示得分/决策/深度/速度/小地图)');
  } else {
    console.log('⚠  HUD 注入失败 (页面可能未就绪, 游戏循环中会自动重试)');
  }
  const stats = loadStats();
  console.log(`\n历史最佳: ${fmt(stats.bestScore)} (共 ${stats.games} 局)\n`);

  // 开新局 (可选) 或接着当前局面
  if (ARGS.newgame) await startNewGame(page);

  // 自检: 模拟登录跳转
  if (ARGS.selftestNav) scheduleSelfTestNav(page);

  // 游戏主循环 (任何一局的异常都不退出, 换页/重试)
  let gameNo = 0, consecutiveErrors = 0, completedGames = 0;
  while (gameNo < ARGS.games && !process.exitRequested && !browserDisconnected) {
    gameNo++;
    console.log(`\n━━━ 第 ${gameNo} 局 ━━━`);
    let result;
    try {
      result = await playOneGame(page, gameNo, stats);
    } catch (e) {
      console.log(`  ⚠ 本局出现异常 (${e.message.split('\n')[0]}), 尝试恢复...`);
      result = 'PAGE_LOST';
    }

    if (result === null) break;                      // 退出信号
    if (result === 'PAGE_LOST') {                    // 页面丢失: 找新页面
      gameNo--; // 本局不算
      const p = await ensureGamePage(browser, null);
      if (!p) break;
      page = p;
      await injectHUD(page);
      consecutiveErrors++;
      if (consecutiveErrors > 20) { console.log('连续恢复失败次数过多, 停止'); break; }
      continue;
    }

    consecutiveErrors = 0;
    completedGames++;

    // 保存本局数据 + 结束截图 (必须在开新局之前, 否则局面被重置)
    try {
      await saveGameResult(page, result, gameNo, 'gameover');
    } catch (e) {
      console.log('  ⚠ 结果保存异常: ' + e.message.split('\n')[0]);
    }

    // 更新统计
    stats.games++;
    stats.totalScore += result.score;
    if (result.score > stats.bestScore) {
      stats.bestScore = result.score;
      console.log(`  🎉 新纪录! ${fmt(result.score)}`);
    }
    if (result.maxTile > stats.bestTile) stats.bestTile = result.maxTile;
    saveStats(stats);

    if (gameNo < ARGS.games && !process.exitRequested && !browserDisconnected) {
      console.log('  自动开始下一局...');
      await startNewGame(page);
    }
  }

  // 退出汇总
  console.log('\n════════════════════════════════════════════════');
  if (browserDisconnected) {
    console.log('  ⚠ 浏览器窗口已关闭 (或崩溃), 脚本随之退出。');
  }
  console.log('  会话汇总');
  console.log(`  完成局数: ${completedGames}`);
  if (stats.games > 0) {
    console.log(`  历史最佳: ${fmt(stats.bestScore)}  (最大方块 ${stats.bestTile})`);
    console.log(`  历史平均: ${fmt(Math.round(stats.totalScore / stats.games))} (共 ${stats.games} 局)`);
  }
  console.log(`  结果目录: results/  (数据 results.jsonl + history.json) | 截图 results/screenshots/`);
  console.log('════════════════════════════════════════════════');

  // 退出时若局面未结束(且不是刚保存过的那局), 也存一份快照 (标记 interrupted)
  try {
    const st = await readState(page);
    if (st && st.moves > 0 && st.gameId !== lastSavedGameId && !browserDisconnected && !page.isClosed()) {
      await saveGameResult(page, {
        score: st.score, maxTile: Math.max(...st.board), moves: st.moves,
        fourSpawns: st.fourSpawns, tileSum: st.tileSum, board: st.board, durationMin: null,
      }, gameNo, 'interrupted');
    }
  } catch { }

  try { await updateHUD(page, { status: '■ 已停止' }); } catch { }
  await sleep(600);
  try { await browser.close(); } catch { }
  process.exit(0);
})().catch(e => {
  console.error('致命错误:', e.message);
  process.exit(1);
});
