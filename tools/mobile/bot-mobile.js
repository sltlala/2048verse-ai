'use strict';
// 手机 2048 自动玩 (Android + adb + 截图识别 + ai.js)
//
// 用法:
//   node tools/mobile/bot-mobile.js                 # 自动玩, 死局后自动开新局
//   node tools/mobile/bot-mobile.js --moves 30      # 只走 30 步
//   node tools/mobile/bot-mobile.js --budget 150    # AI 每步思考时间(ms)
//   node tools/mobile/bot-mobile.js --discover      # 只识别不操作(收集未知颜色)
//   node tools/mobile/bot-mobile.js --probe         # 打印每步"滑动->确认"耗时, 用于调参
//   node tools/mobile/bot-mobile.js --no-restart    # 死局后退出, 不开新局
//   node tools/mobile/bot-mobile.js --undo off      # 完全不用撤回
//
// 撤回(undo) 用法 —— 实测 App 的撤销只回退一步, 但可以无限次重复用, 棋盘和分数一起还原:
//   1. 死局救援: 走成死局就撤回那一步, 换个方向重走 (走死过的方向会被禁用)
//      -> 游戏从"一步走死就结束"变成"同一局面四个方向都走死才结束"
//   2. 关键时刻试走: 空格 <= --undo-empties 时, 把每个合法方向真走一遍, 看真实结果,
//      每个方向撤回后再用 --undo-think 的搜索给结果打分, 最后选最好的方向落子
//      (比浅层搜索凭空猜准, 代价是关键时刻约慢 4 倍)
//
// 加速要点:
//   1. 每步只截一次图: 滑动后的"确认截图"直接作为下一步输入
//   2. 截图直连 adb server 的 5037 端口 (adbraw.js), 省掉每次启动 adb.exe 的 ~76ms
//   3. 识别只解棋盘区域 (board.js 的 decodeRegion), 不再整屏解码 14MB
//   4. 滑动/点击走常驻 adb shell 通道 (shell.js), 再省一次进程启动
//   5. 用 ai.simulateMove 精确校验落子结果, 等待时间可以压到最小
//
// 实测: 0.83 步/秒 -> 1.58 步/秒 (1260x2800 竖屏, vivo V2339FA)
//
// 关键点:
//   - Unity 游戏读不到控件, 只能截图识别 (tools/mobile/board.js)
//   - 遇到未知颜色会暂停并把样本存到 mobile-shots/unknown/, 需人工补映射表
//   - 输入用 adb shell input swipe
const fs = require('fs');
const path = require('path');
const { adb } = require('./shot');
const { DeviceShell, Capture } = require('./shell');
const boardLib = require('./board');
const ai = require('../../ai');

const ROOT = path.join(__dirname, '..', '..');
const SHOT_DIR = path.join(ROOT, 'mobile-shots');
const UNKNOWN_DIR = path.join(SHOT_DIR, 'unknown');
const RESULT_LOG = path.join(ROOT, 'mobile-results.jsonl');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const MAX_MOVES = parseInt(arg('moves', '100000'), 10);
const BUDGET = parseInt(arg('budget', '80'), 10);
const DISCOVER_ONLY = argv.includes('--discover');
const PROBE = argv.includes('--probe');
const RESTART = !argv.includes('--no-restart');
const USE_SHELL = arg('shell', 'on') !== 'off';
const SWIPE_MS = parseInt(arg('swipe-ms', '60'), 10);       // 实测 60ms 稳定生效 (原 220ms; 40ms 偶尔丢)
const SETTLE_MS = parseInt(arg('settle', '120'), 10);        // 滑动后首次等待 (直连截图没有隐含延迟了, 需要留出动画时间)
const RETRY_WAIT = parseInt(arg('retry-wait', '90'), 10);   // 未确认时的追加等待
const MAX_RETRY = parseInt(arg('retry', '4'), 10);
const RESTART_WAIT = parseInt(arg('restart-wait', '900'), 10);
// ---- 撤回 (undo) ----
// 实测: 撤销只回退一步, 但可以无限次重复用, 棋盘和分数都会一起还原
const USE_UNDO = arg('undo', 'on') !== 'off';
const UNDO_EMPTIES = parseInt(arg('undo-empties', '4'), 10);   // 空格 <= 此值时, 真实试走每个方向再选最好
const UNDO_THINK = parseInt(arg('undo-think', '150'), 10);     // 试走结果用多深的搜索来打分
const UNDO_WAIT = parseInt(arg('undo-wait', '160'), 10);       // 点撤回后等画面回退
const UNDO_RESCUE = arg('undo-rescue', 'on') !== 'off';        // 死局时撤回换方向
const UNDO_TRY = arg('undo-try', 'lazy');                      // lazy=按分数高低试到第一个能活的 | all=四个都试 | rescue=只做死局救援
const P4 = parseFloat(arg('p4', '10'));                        // 生成 4 的概率(%), 实测见 tools/mobile/measure-rate.js

ai.setFourRate(P4);   // 生成 4 的概率 (实测手机 App 约 9.75%, 与网站一致; 用 --p4 可改)

const B = boardLib.BOARD;
const CX = Math.round((B.left + B.right) / 2);
const CY = Math.round((B.top + B.bottom) / 2);
const D = Math.round((B.right - B.left) * 0.30);   // 滑动距离约 1.2 格

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const timing = { capture: 0, read: 0, think: 0, swipe: 0, wait: 0, restart: 0, undo: 0 };
let retryCount = 0, probeMax = 0, probeSum = 0, probeN = 0, inputFallback = 0;
let undoCount = 0, rescueCount = 0, trialCount = 0;
let spawnTwos = 0, spawnFours = 0;   // 本局跑下来的"新方块是 2 还是 4"统计

// 常驻 adb shell: 只发输入命令 (swipe/tap)
const sh = USE_SHELL
  ? new DeviceShell({ timeoutMs: 5000 }).start()
  : { broken: true, stats: { runs: 0 }, run: () => Promise.reject(new Error('已用 --shell off 关闭')), close() {} };

// 截图器: 默认直连 adb server 的 5037 端口 (比启动 adb.exe 快 ~72ms), 失败自动退回
const cap = new Capture();

async function capturePng() {
  const t = Date.now();
  const buf = await cap.shot();
  timing.capture += Date.now() - t;
  return buf;
}

// 只用棋盘区域做识别 (board.js 的快速解码, 省掉整屏 90ms 的解码)
function readBoard(buf) {
  const t = Date.now();
  const r = boardLib.readBoardFast(buf);
  timing.read += Date.now() - t;
  return r;
}

// 发一条输入命令 (优先常驻通道, 通道坏了就退回一次性 adb 调用)
async function inputCmd(cmd, oneShotArgs) {
  const t = Date.now();
  try {
    if (sh.broken) throw new Error('通道不可用');
    const out = await sh.run(cmd);
    if (/^error/i.test(out)) console.log(`  ⚠ 设备返回: ${out}`);
  } catch (e) {
    inputFallback++;
    if (USE_SHELL) console.log(`  ⚠ 常驻通道失效 (${e.message}), 本步用一次性 adb`);
    adb(oneShotArgs);
  }
  timing.swipe += Date.now() - t;
}

async function swipeDir(dir) {
  // ai.js: 0=上 1=下 2=左 3=右
  let x1, y1, x2, y2;
  if (dir === 0) { x1 = CX; y1 = CY + D; x2 = CX; y2 = CY - D; }
  else if (dir === 1) { x1 = CX; y1 = CY - D; x2 = CX; y2 = CY + D; }
  else if (dir === 2) { x1 = CX + D; y1 = CY; x2 = CX - D; y2 = CY; }
  else { x1 = CX - D; y1 = CY; x2 = CX + D; y2 = CY; }
  const cmd = `input swipe ${x1} ${y1} ${x2} ${y2} ${SWIPE_MS}`;
  await inputCmd(cmd, ['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(SWIPE_MS)]);
}

// 点 "撤回" 按钮: 把上一步完全撤销 (棋盘和分数一起回退, 可以反复用)
async function tapUndo() {
  const p = boardLib.UI.undo;
  const t = Date.now();
  await inputCmd(`input tap ${p.x} ${p.y}`, ['shell', 'input', 'tap', String(p.x), String(p.y)]);
  undoCount++;
  timing.undo += Date.now() - t;
}

// 撤回并确认棋盘确实回到 base。
// 两种失败都要兜住:
//   - 点按被吞掉 (App 正在播动画时会漏掉这一次 tap) -> 重新点一次
//   - 截图抓到回退动画的中间帧 -> 多截一次
// 撤销栈只有一层, 已经撤到底之后再点撤回是无害的空操作, 所以补点是安全的。
async function undoTo(base) {
  const want = base.join(',');
  let png = null, r = null;
  for (let tap = 0; tap < 3; tap++) {
    await tapUndo();
    for (let i = 0; i < 3; i++) {
      await sleep(i === 0 ? UNDO_WAIT : 140 + i * 90);
      png = await capturePng();
      r = readBoard(png);
      if (r.board.join(',') === want) return { ok: true, png, ...r, taps: tap + 1 };
    }
  }
  return { ok: false, png, ...r, taps: 3, want };
}

// 用 ai.js 的移动规则算出"滑动后、生成新方块前"的棋盘, 用来校验截图结果
function expectedAfter(before, dir) {
  return ai.simulateMove(before, dir).values;
}

// 校验: 实际棋盘必须 = 期望棋盘 + 恰好 1 个新方块(2 或 4)
function checkAfter(actual, expected) {
  let spawns = 0;
  for (let i = 0; i < 16; i++) {
    if (actual[i] === expected[i]) continue;
    if (expected[i] !== 0) return `原有方块位置 ${i} 不符 (期望 ${expected[i]}, 实际 ${actual[i]})`;
    if (actual[i] !== 2 && actual[i] !== 4) return `新增方块值异常 ${actual[i]}`;
    spawns++;
  }
  if (spawns !== 1) return `新增方块数量 ${spawns}`;
  return null;   // null = 校验通过
}

// 校验通过时, 顺手读出刚生成的新方块是 2 还是 4 (0 = 读不出)
// 这样每走一步就白拿一个"生成 4 概率"的样本, 长跑下来可以复核 --p4 设得对不对
function spawnOf(actual, expected) {
  for (let i = 0; i < 16; i++) if (actual[i] !== expected[i]) return actual[i];
  return 0;
}

// 走一步并确认结果 (校验通过才算数); 返回 { png, board, ..., reason, tries, ms }
async function playAndConfirm(dir, base) {
  const expected = expectedAfter(base, dir);
  const t0 = Date.now();
  await swipeDir(dir);
  await sleep(SETTLE_MS);
  timing.wait += Date.now() - t0;
  for (let tries = 0; ; tries++) {
    const png = await capturePng();
    const r = readBoard(png);
    const reason = checkAfter(r.board, expected);
    if (reason === null || tries >= MAX_RETRY) return { png, ...r, reason, tries, ms: Date.now() - t0 };
    await sleep(RETRY_WAIT + tries * 60);
  }
}

// 合法方向 (不需要碰手机, 直接按规则算)
function legalDirs(board) {
  const out = [];
  for (let d = 0; d < 4; d++) if (ai.simulateMove(board, d).moved) out.push(d);
  return out;
}

// 局面打分: 用一次搜索的结果值; 死局返回 -Infinity
function positionValue(board, budget) {
  const r = ai.getBestMove(board, budget);
  return (r.dir === null || r.dir === undefined) ? -Infinity : r.score;
}

function isDead(board) {
  for (let d = 0; d < 4; d++) if (ai.simulateMove(board, d).moved) return false;
  return true;
}

// 关键时刻选方向:
//   1) 先不碰手机, 对每个方向的"确定落子结果"(不含随机新方块) 用更深预算打分
//      —— 这样比的纯粹是方向好坏, 不会被一个随机新方块的运气带偏
//   2) 再按分数从高到低真实试走, 看实际结果是不是已经死局 (真实信息)
//      试到第一个没死的就选它 (lazy: 通常只试 1 个方向, 死局多的局面才多试)
//   3) --undo-try all 则四个方向全试一遍再选, 只为了多打一份对照表, 更慢
// 返回 { chosen, aborted } ; aborted 时 pending 已填好, 交给主循环重读棋盘
async function chooseCritical(board, legal, pendingRef) {
  const rated = legal.map(d => ({ dir: d, dead: false, value: positionValue(expectedAfter(board, d), UNDO_THINK) }));
  rated.sort((a, b) => b.value - a.value);

  const testOrder = UNDO_TRY === 'all' ? rated : rated;
  const tried = [];
  let chosen = null;
  for (const r of testOrder) {
    const t = await playAndConfirm(r.dir, board);
    if (t.reason !== null) {
      console.log(`  ⚠ 试走 ${ai.DIR_NAMES[r.dir]} 校验失败 (${t.reason}), 放弃试走, 直接按实际棋盘继续`);
      pendingRef.value = t;
      return { aborted: true };
    }
    r.dead = isDead(t.board);
    tried.push(r);
    const u = await undoTo(board);
    if (!u.ok) {
      console.log(`  ⚠ 试走 ${ai.DIR_NAMES[r.dir]} 后撤回没有回到原局面 (点了 ${u.taps} 次)`);
      console.log(`     期望: ${u.want}`);
      console.log(`     实际: ${u.board.join(',')}`);
      pendingRef.value = u;
      return { aborted: true };
    }
    if (!r.dead) { chosen = r; break; }                       // lazy: 找到能活的方向就停
  }

  const detail = rated.map(r => {
    const seen = tried.includes(r);
    return `${ai.DIR_NAMES[r.dir]}=${r.value === -Infinity ? '死' : Math.round(r.value)}` + (seen ? (r.dead ? '(试走死)' : '(试走活)') : '');
  }).join(' ');
  const empty = board.filter(x => x === 0).length;
  if (!chosen) {
    console.log(`  ⚠ 关键时刻试走 (空格 ${empty}): ${detail}  -> 试过的方向全都走死`);
    return { chosen: { dir: rated[0].dir, dirName: ai.DIR_NAMES[rated[0].dir], depth: '-', trial: true }, allDead: true };
  }
  console.log(`  🔍 关键时刻试走 (空格 ${empty}): ${detail}  -> 选 ${ai.DIR_NAMES[chosen.dir]}`);
  return { chosen: { dir: chosen.dir, dirName: ai.DIR_NAMES[chosen.dir], depth: '-', trial: true } };
}

function dumpUnknown(buf, unknown) {
  console.log(`\n⚠️ 出现 ${unknown.length} 个未知颜色, 已保存样本, 请确认数值后补进 board.js 的 COLOR_MAP:`);
  const full = boardLib.decode(buf);          // 只在需要留样本时才整屏解码
  fs.mkdirSync(UNKNOWN_DIR, { recursive: true });
  for (const u of unknown) {
    const f = path.join(UNKNOWN_DIR, `${u.hex.replace('#', '')}_r${u.r}c${u.c}.png`);
    if (!fs.existsSync(f)) {
      boardLib.saveCellCrop(full, u.r, u.c, f);
      console.log(`   ${u.hex}  在 (${u.r},${u.c})  样本: ${path.relative(ROOT, f)}`);
    }
  }
  const shot = path.join(SHOT_DIR, 'unknown-board.png');
  fs.writeFileSync(shot, require('pngjs').PNG.sync.write(full));
  console.log(`   完整截图: ${path.relative(ROOT, shot)}`);
  console.log('   (补齐映射后重新运行即可)');
}

function startNewGame() {
  const t = Date.now();
  const p = boardLib.UI.reset;
  return inputCmd(`input tap ${p.x} ${p.y}`, ['shell', 'input', 'tap', String(p.x), String(p.y)])
    .then(() => { timing.restart += Date.now() - t; });
}

// 关掉可能误弹出的设置面板 (点面板里的"返回")
async function closeDialog() {
  const p = boardLib.UI.back;
  await inputCmd(`input tap ${p.x} ${p.y}`, ['shell', 'input', 'tap', String(p.x), String(p.y)]);
  await sleep(400);
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  console.log('=== 手机 2048 自动玩 ===');
  console.log(`  棋盘中心 (${CX},${CY})  滑动距离 ${D}px  滑动时长 ${SWIPE_MS}ms  首次等待 ${SETTLE_MS}ms`);
  console.log(`  AI 预算 ${BUDGET}ms/步  最多 ${MAX_MOVES} 步  死局后${RESTART ? '自动开新局' : '退出'}` +
    `${DISCOVER_ONLY ? '  [仅识别模式]' : ''}`);
  console.log(`  生成 4 的概率 ${P4}%  (实测工具: node tools/mobile/measure-rate.js 400)`);
  let undoMsg = '  撤回: 关';
  if (USE_UNDO) {
    const tryMsg = UNDO_TRY === 'rescue'
      ? '只做死局救援, 不试走'
      : `空格 <= ${UNDO_EMPTIES} 时按 ${UNDO_THINK}ms 深评排序试走` +
        (UNDO_TRY === 'all' ? '四个方向都试' : '试到能活的为止');
    undoMsg = `  撤回: 开 (死局救援${UNDO_RESCUE ? '开' : '关'}; ${tryMsg})`;
  }
  console.log(undoMsg);
  console.log('');

  let moves = 0, games = 1, gameMoves = 0, gameStart = Date.now(), blankRestarts = 0, dialogFixes = 0;
  const t0 = Date.now();
  // 上一步滑动后的确认截图: 直接给下一步用, 保证每步只截一次图
  let pending = null;
  // 上一手的状态 (撤回用): { board: 走之前的棋盘, dir: 走的方向 }
  let lastState = null;
  // 每个局面下"已经被证明走死"的方向, 按局面存档。
  // 关键: 不能简单地"局面一变就清空" —— 走死后我们会撤回原局面重试,
  // 那时必须还能查到原局面禁用了哪些方向, 否则会在几个死方向之间无限打转。
  const bansByBoard = new Map();
  const bansFor = (key) => {
    let s = bansByBoard.get(key);
    if (!s) {
      s = new Set();
      bansByBoard.set(key, s);
      if (bansByBoard.size > 600) bansByBoard.delete(bansByBoard.keys().next().value);   // 控内存
    }
    return s;
  };
  // 某个局面四个方向都试死过之后, 从这里再走死就不再撤回了 —— 否则会
  // "试死 -> 撤回 -> 换个方向 -> 又试死 -> ..." 无限打转, 永远等不到 App 判死局。
  // 用集合(而不是一个"当前局面"变量): 中途走死会被撤回, 局面来回复位, 用可变标志很容易被清错。
  const gaveUp = new Set();

  while (moves < MAX_MOVES) {
    let png, board, colors, unknown, covered;

    if (pending) {
      ({ png, board, colors, unknown, covered } = pending);
      pending = null;
    } else {
      png = await capturePng();
      ({ board, colors, unknown, covered } = readBoard(png));
    }

    if (unknown.length) {
      dumpUnknown(png, unknown);
      sh.close();
      process.exit(2);
    }
    const empty = board.filter(v => v === 0).length;
    const maxTile = Math.max(...board);

    // 游戏界面被面板盖住 (例如误点"菜单"弹出了设置面板): 按钮点不到, 必须先关掉。
    // "撤回" 按钮底色在游戏界面里是 #82DADD, 被面板盖住时是 #3ECBD1 —— 用它判断。
    if (!DISCOVER_ONLY && (covered || maxTile === 0)) {
      dialogFixes++;
      if (dialogFixes <= 4) {
        console.log(`  ⚠ ${covered ? '游戏界面被面板盖住了' : '棋盘区域全是空的'} (第 ${dialogFixes} 次), 关掉弹窗后重新识别`);
        await closeDialog();
        continue;
      }
      console.log('  ⚠ 界面一直不正常: 请检查手机屏幕 (是否有弹窗没关 / 是否回到了主界面)');
      break;
    }

    if (DISCOVER_ONLY) {
      console.log(`--- 识别结果 (空格 ${empty}, 最大 ${maxTile}) ---`);
      console.log(boardLib.boardToText(board));
      console.log('  颜色: ' + colors.join(' '));
      if (maxTile === 0) {
        console.log('\n⚠️ 棋盘区域里没有任何方块: 请先把手机上的 2048 打开到游戏界面, 再运行本脚本');
        sh.close();
        process.exit(3);
      }
      sh.close();
      process.exit(0);
    }

    const tt = Date.now();
    let dec;
    const boardKey = board.join(',');
    const banSet = bansByBoard.get(boardKey);
    const banned = banSet ? [...banSet] : [];
    const legalAll = legalDirs(board);
    const legal = banSet ? legalAll.filter(d => !banSet.has(d)) : legalAll;
    // 两种"没得走"要分开:
    //   boardDead = 棋盘本身死了 (四个方向都动不了) -> 值得撤回重来
    //   exhausted = 棋盘还有合法方向, 但同一局面下这些方向都已经试过并走死 -> 这局真结束
    const boardDead = legalAll.length === 0;
    const exhausted = !boardDead && legal.length === 0;
    if (exhausted) {
      // 同一局面的合法方向都试过且都走死 —— 但棋盘本身还有走法, App 还没判死局,
      // 此时右边那个按钮是"菜单"不是"重置", 点下去只会弹出设置面板。
      // 所以: 清掉该局面的禁用记录, 硬着头皮再走, 并标记这个局面不再撤回,
      //       让它自然走到 App 判死局为止 (不标记的话会一直在几个死方向间打转)。
      console.log(`  ⚠ 同一局面 ${legalAll.map(d => ai.DIR_NAMES[d]).join('/')} 都试过且都走死, ` +
        `但棋盘还有走法 -> 该局面不再撤回, 继续硬走 (等 App 判死局)`);
      bansByBoard.delete(boardKey);
      gaveUp.add(boardKey);
      dec = ai.getBestMove(board, BUDGET);
    } else if (boardDead) {
      console.log(`  棋盘已无合法方向${banned.length ? ` (本局面已试过 ${banned.map(d => ai.DIR_NAMES[d]).join('/')})` : ''}`);
      dec = { dir: null, dirName: '死局', depth: 0 };
    } else {
      // 正常决策 (非关键时刻用浅预算, 关键时刻在下面换成深评+试走)
      dec = ai.getBestMove(board, BUDGET, banned.length ? { exclude: banned } : undefined);
    }
    timing.think += Date.now() - tt;

    if (!dec.dir && dec.dir !== 0) {
      // ---- 死局 ----
      // 先用撤回救一次: 撤回最后一个方向, 换个方向重走 (棋盘和分数一起回退)
      if (USE_UNDO && UNDO_RESCUE && !exhausted && lastState && lastState.board.join(',') !== boardKey &&
          !gaveUp.has(lastState.board.join(',')) && banned.length < 4) {        const u = await undoTo(lastState.board);
        if (u.ok) {
          rescueCount++;
          const deadDir = lastState.dir;
          const baseKey = lastState.board.join(',');
          bansFor(baseKey).add(deadDir);   // 记在"走之前那个局面"名下
          // 被撤回的那一步不算数
          moves--; gameMoves--;
          lastState = null;
          pending = u;
          console.log(`  ↩ 死局救援: 撤回「${ai.DIR_NAMES[deadDir]}」, 改用其他方向 ` +
            `(本局第 ${rescueCount} 次救援, 该局面已禁用 ${[...bansFor(baseKey)].map(d => ai.DIR_NAMES[d]).join('/')})`);
          continue;
        }
        console.log(`  ⚠ 撤回没有回到上一步 (棋盘没回退), 按死局处理`);
        pending = u;
      } else if (USE_UNDO && UNDO_RESCUE && !lastState) {
        console.log(`  ⚠ 本步没有可撤回的上一步记录, 按死局处理`);
      }

      const dur = ((Date.now() - gameStart) / 1000).toFixed(0);
      console.log(`\n🏁 第 ${games} 局死局: ${gameMoves} 步, 最大方块 ${maxTile}, 用时 ${dur}s (总 ${moves} 步)` +
        (rescueCount ? `, 过程中撤回救援 ${rescueCount} 次` : ''));
      console.log(boardLib.boardToText(board));
      fs.writeFileSync(path.join(SHOT_DIR, `gameover-${Date.now()}.png`),
        require('pngjs').PNG.sync.write(boardLib.decode(png)));
      try {
        fs.appendFileSync(RESULT_LOG, JSON.stringify({
          endedAt: new Date().toISOString(), game: games, moves: gameMoves,
          maxTile, durationSec: +dur, totalMoves: moves, rescues: rescueCount,
        }) + '\n');
      } catch (_) { /* 记录失败不影响继续玩 */ }

      if (!RESTART) break;

      // 连续死局且一步都没走成 -> 多半是"重置"按钮坐标不对, 不能无限点下去
      if (gameMoves === 0) {
        blankRestarts++;
        if (blankRestarts >= 3) {
          console.log('\n⚠️ 连续 3 次开新局后棋盘仍是死局: "重置"按钮坐标可能已过期');
          console.log(`   当前设置: board.js 里的 UI.reset = (${boardLib.UI.reset.x}, ${boardLib.UI.reset.y})`);
          console.log('   请重新截图确认按钮位置 (GAMEOVER 后右侧那个按钮), 或换用 tools/mobile/calibrate.js');
          break;
        }
      } else {
        blankRestarts = 0;
      }

      await startNewGame();
      // 点完"重置"新局要等一下才画出来; 这里确认棋盘上真的有方块了再继续,
      // 否则会把过渡帧(整盘空白)误判成"0 步死局"
      let fresh = null;
      for (let i = 0; i < 5; i++) {
        await sleep(i === 0 ? RESTART_WAIT : 500);
        const p = await capturePng();
        const r = readBoard(p);
        if (Math.max(...r.board) > 0) { fresh = { png: p, ...r }; break; }
      }
      if (!fresh) {
        console.log('  ⚠ 点重置后棋盘一直是空的, 可能"重置"按钮坐标不对');
        break;
      }
      games++; gameMoves = 0; gameStart = Date.now();
      rescueCount = 0; undoCount = 0;
      pending = fresh; lastState = null; bansByBoard.clear(); gaveUp.clear();
      continue;
    }

    // ---- 关键时刻: 深评 + 真实试走 (见 chooseCritical 注释) ----
    let chosen = { dir: dec.dir, dirName: dec.dirName, depth: dec.depth, trial: false };
    if (UNDO_TRY !== 'rescue' && USE_UNDO && UNDO_EMPTIES > 0 && empty <= UNDO_EMPTIES && legal.length >= 2) {
      const ref = { value: null };
      const r = await chooseCritical(board, legal, ref);
      // 试走过程中状态对不上: 以实际读到的棋盘为准重来, 同时丢掉可能过期的撤回记录
      if (r.aborted) { pending = ref.value; lastState = null; continue; }
      trialCount++;
      chosen = r.chosen;
      if (r.allDead) console.log(`   (这一步仍然选了分数最高的方向, 但局面已经很危险)`);
    }

    const t = await playAndConfirm(chosen.dir, board);
    if (PROBE) { probeSum += t.ms; probeN++; if (t.ms > probeMax) probeMax = t.ms; }
    if (t.reason !== null) {
      console.log(`  ⚠ 第 ${moves + 1} 步 ${chosen.dirName} 校验失败 (重试 ${t.tries} 次): ${t.reason}`);
      console.log(`     期望: ${expectedAfter(board, chosen.dir).join(',')}`);
      console.log(`     实际: ${t.board.join(',')}`);
    } else {
      if (t.tries > 0) retryCount++;
      const v = spawnOf(t.board, expectedAfter(board, chosen.dir));
      if (v === 2) spawnTwos++; else if (v === 4) spawnFours++;
    }
    pending = t;
    lastState = { board, dir: chosen.dir };
    moves++; gameMoves++;

    if (moves % 10 === 0 || moves <= 5) {
      const per = (k) => (timing[k] / moves).toFixed(0).padStart(3);
      console.log(`步 ${String(moves).padStart(4)} ${chosen.trial ? `试走选${chosen.dirName}` : chosen.dirName}  ` +
        `空格 ${String(empty).padStart(2)}  最大 ${String(maxTile).padStart(4)}  ` +
        `深度${String(chosen.depth).padStart(2)}  截图${per('capture')} 识别${per('read')} 思考${per('think')} 滑动${per('swipe')} 等待${per('wait')}ms`);
    }
  }

  const dur = (Date.now() - t0) / 1000;
  console.log(`\n结束: ${moves} 步 / ${games} 局, 用时 ${dur.toFixed(0)}s (${(moves / dur).toFixed(2)} 步/秒)`);
  if (PROBE && probeN) {
    console.log(`滑动->确认: 平均 ${(probeSum / probeN).toFixed(0)}ms  最慢 ${probeMax}ms  (${probeN} 次采样)`);
  }
  console.log(`重试(等待不足)次数: ${retryCount} / ${moves} 步` +
    (USE_SHELL ? `  常驻通道发命令 ${sh.stats.runs} 次, 退回首用 ${inputFallback} 次` : '') +
    `  截图: 直连 ${cap.stats.raw} 次, 退回 adb.exe ${cap.stats.fallback} 次`);
  if (USE_UNDO) {
    console.log(`撤回: 共 ${undoCount} 次 (死局救援 ${rescueCount} 次, 关键时刻试走 ${trialCount} 次)`);
  }
  // 顺手复核生成概率: 每走一步都是一个样本
  const sv = spawnTwos + spawnFours;
  if (sv >= 20) {
    const rate = 100 * spawnFours / sv;
    console.log(`新方块统计: 2 x${spawnTwos}, 4 x${spawnFours} -> 生成 4 占 ${rate.toFixed(2)}% ` +
      `(95% 区间 ±${(196 * Math.sqrt((rate / 100) * (1 - rate / 100) / sv)).toFixed(2)}%, 当前 --p4 ${P4})`);
    try {
      const f = path.join(ROOT, 'mobile-spawn-stats.json');
      let all = { twos: 0, fours: 0, runs: 0, updatedAt: null };
      try { all = { ...all, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch (_) {}
      all.twos += spawnTwos; all.fours += spawnFours; all.runs += 1; all.updatedAt = new Date().toISOString();
      fs.writeFileSync(f, JSON.stringify(all, null, 2));
      const ar = 100 * all.fours / Math.max(1, all.twos + all.fours);
      console.log(`累计样本 ${all.twos + all.fours}: 生成 4 占 ${ar.toFixed(2)}% (存到 mobile-spawn-stats.json)`);
    } catch (_) { /* 统计失败不影响主流程 */ }
  }
  sh.close();
})().catch(e => { console.error('ERROR:', e.message); sh.close(); process.exit(1); });
