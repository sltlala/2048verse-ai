'use strict';
// 常驻 adb shell 通道 —— 只用来发"输入类"命令 (swipe / tap), 省掉每次 ~76ms 的 adb 进程启动开销。
//
// 说明:
//   - `adb exec-out` 不转发 stdin (`adb exec-out sh` 里写命令没有任何反应), 所以用 `adb shell sh`。
//   - `adb shell` 走 PTY, 输出会把 \n 变成 \r\n —— 因此这条通道只发文本命令, 不传二进制。
//     截图仍然走一次性的 `adb exec-out screencap -p` (二进制安全, ~376ms, 其中 76ms 是进程启动)。
//   - 命令完成用哨兵行判断: 写完命令再 echo 一个唯一标记, 读到标记就说明命令真的执行完了。
const { spawn, spawnSync } = require('child_process');
const { ADB } = require('./shot');
const { firstDevice, rawExec } = require('./adbraw');

const SENTINEL = '@@OK';

class DeviceShell {
  constructor(opts = {}) {
    this.proc = null;
    this.out = '';
    this.queue = [];              // 等待哨兵的请求
    this.broken = false;
    this.timeoutMs = opts.timeoutMs || 5000;
    this.seq = 0;
    this.stats = { runs: 0 };
  }

  start() {
    this.proc = spawn(ADB, ['shell', 'sh'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stdout.setEncoding('latin1');
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.on('data', () => {});
    this.proc.on('error', () => { this.broken = true; });
    this.proc.on('exit', () => {
      this.broken = true;
      while (this.queue.length) { const q = this.queue.shift(); clearTimeout(q.timer); q.reject(new Error('adb shell 已退出')); }
    });
    return this;
  }

  _onData(d) {
    this.out += d.replace(/\r/g, '');
    let idx;
    while ((idx = this.out.indexOf(SENTINEL)) >= 0) {
      const before = this.out.slice(0, idx);          // 哨兵之前的都是这条命令的输出
      const nl = this.out.indexOf('\n', idx);
      this.out = nl < 0 ? '' : this.out.slice(nl + 1); // 丢掉哨兵那一行
      const q = this.queue.shift();
      if (q) { clearTimeout(q.timer); q.resolve(before.trim()); }
    }
    if (this.out.length > 65536) this.out = this.out.slice(-4096);   // 防止无哨兵输出堆积
  }

  // 执行一条命令, 等它在设备上跑完 (Promise<string>, 返回哨兵行后面的文字)
  run(cmd) {
    if (this.broken) return Promise.reject(new Error('通道不可用'));
    const id = 'S' + (++this.seq) + 'E';
    this.stats.runs++;
    return new Promise((resolve, reject) => {
      const q = { resolve: (s) => resolve(s), reject, cmd };
      q.timer = setTimeout(() => {
        const i = this.queue.indexOf(q);
        if (i >= 0) this.queue.splice(i, 1);
        this.broken = true;
        try { this.proc.kill(); } catch (_) {}
        reject(new Error('命令超时: ' + cmd.slice(0, 60)));
      }, this.timeoutMs);
      this.queue.push(q);
      this.proc.stdin.write(cmd + '; echo ' + SENTINEL + id + '\n');
    });
  }

  close() { try { this.proc.stdin.end(); this.proc.kill(); } catch (_) {} }
}

// 一次性截图 (二进制安全, 后备方案; 每次要付 ~76ms 的 adb.exe 进程启动开销)
function shotOnce() {
  const b = spawnSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 1 << 28 }).stdout;
  if (!(b && b.length > 8 && b[0] === 0x89)) throw new Error('截图数据异常');
  return b;
}

// 截图器: 优先直连 adb server 的 TCP 端口 (省掉 adb.exe 启动), 失败自动退回一次性调用
class Capture {
  constructor() {
    this.serial = null;
    this.mode = 'raw';      // raw = 直连 adb server; adb = 启动 adb.exe
    this.stats = { raw: 0, fallback: 0 };
  }

  async shot() {
    if (this.mode === 'raw') {
      try {
        if (!this.serial) this.serial = firstDevice();
        const b = await rawExec(this.serial, 'exec:screencap -p');
        if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) { this.stats.raw++; return b; }
        throw new Error('返回数据不是 PNG');
      } catch (e) {
        this.serial = null;
        this.stats.fallback++;
        if (this.stats.fallback >= 3) {
          this.mode = 'adb';
          console.log(`  ⚠ adb 直连连续失败 (${e.message}), 改用系统 adb 命令截图`);
        }
      }
    }
    return shotOnce();
  }
}

module.exports = { DeviceShell, Capture, shotOnce };
