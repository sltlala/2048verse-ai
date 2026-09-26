'use strict';
// 直接跟 adb server (127.0.0.1:5037) 说协议, 省掉每次启动 adb.exe 的 ~76ms
// 协议: 每条请求 = 4 位十六进制长度 + 内容; 服务端先回 OKAY/FAIL, 再回数据
const net = require('net');
const { execFileSync } = require('child_process');
const { ADB } = require('./shot');

const PORT = 5037;

function adbRequest(payload) {
  const body = Buffer.from(payload, 'latin1');
  const head = Buffer.from(body.length.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, body]);
}

function firstDevice() {
  const out = execFileSync(ADB, ['devices']).toString();
  const m = out.split(/\r?\n/).find(l => /\tdevice$/.test(l));
  if (!m) throw new Error('没有已授权的设备');
  return m.split('\t')[0];
}

// 在一条 TCP 连接上依次握手, 然后把 shell/exec 的输出流交给 onStream
function openStream(serial, service, onData, onEnd, onError) {
  const sock = net.connect(PORT, '127.0.0.1');
  let stage = 0;
  let buf = Buffer.alloc(0);
  let streaming = false;

  sock.on('connect', () => sock.write(adbRequest('host:transport:' + serial)));
  sock.on('error', (e) => onError(e));
  sock.on('data', (d) => {
    if (streaming) { onData(d); return; }
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    if (buf.length < 4) return;
    const status = buf.toString('latin1', 0, 4);
    if (status !== 'OKAY') {
      const msg = buf.length > 8 ? buf.toString('latin1', 8) : '';
      onError(new Error('adb 返回 ' + status + ' ' + msg.trim()));
      sock.destroy();
      return;
    }
    buf = buf.subarray(4);
    if (stage === 0) { stage = 1; sock.write(adbRequest(service)); return; }
    streaming = true;
    if (buf.length) onData(buf);
    buf = Buffer.alloc(0);
  });
  sock.on('end', () => { if (streaming) onEnd(); });
  sock.on('close', () => { if (streaming) onEnd(); });
  return sock;
}

// 一次性取完整输出 (Promise<Buffer>)
function rawExec(serial, service, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    const timer = setTimeout(() => finish(reject, new Error('adb 直连超时')), timeoutMs);
    const sock = openStream(serial, service,
      (d) => chunks.push(d),
      () => { clearTimeout(timer); finish(resolve, Buffer.concat(chunks)); },
      (e) => { clearTimeout(timer); finish(reject, e); });
    sock.on('close', () => { clearTimeout(timer); finish(resolve, Buffer.concat(chunks)); });
  });
}

module.exports = { firstDevice, rawExec, openStream, PORT };
