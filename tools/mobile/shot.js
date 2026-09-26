'use strict';
// Android 截图工具: 通过 adb 抓取手机屏幕并保存为 PNG
// 用法: node tools/mobile/shot.js [输出文件名]
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ADB = process.env.ADB || 'D:\\Program_software\\platform-tools\\adb.exe';
const OUT_DIR = path.join(ROOT, 'mobile-shots');

function adb(args, opts = {}) {
  return execFileSync(ADB, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function listDevices() {
  const out = adb(['devices', '-l']).toString('utf8');
  return out.split(/\r?\n/).slice(1).map(l => l.trim()).filter(Boolean)
    .map(l => {
      const m = l.match(/^(\S+)\s+(\S+)(.*)$/);
      return m ? { serial: m[1], state: m[2], extra: m[3].trim() } : { raw: l };
    });
}

function shot(file) {
  // exec-out 直接返回二进制 (若被某些设备/系统插入 CRLF 会作废, 故用 screencap 到文件再 pull)
  const buf = adb(['exec-out', 'screencap', '-p']);
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return buf;   // PNG 头正常
  // 回退: 存到设备再拉回
  const tmpRem = '/sdcard/_adb_shot.png';
  adb(['shell', 'screencap', '-p', tmpRem]);
  const tmpLocal = path.join(OUT_DIR, '.pull.png');
  adb(['pull', tmpRem, tmpLocal]);
  adb(['shell', 'rm', tmpRem]);
  const b = fs.readFileSync(tmpLocal);
  fs.unlinkSync(tmpLocal);
  return b;
}

function screenSize() {
  const out = adb(['shell', 'wm', 'size']).toString('utf8');
  const m = out.match(/(\d+)x(\d+)/);
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : null;
}

if (require.main === module) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const devices = listDevices();
  console.log('=== 连接的设备 ===');
  if (!devices.length) {
    console.log('  (无设备) 请用 USB 连接手机并开启 USB 调试, 然后在手机上允许此电脑的调试请求');
    process.exit(1);
  }
  devices.forEach(d => console.log('  ' + (d.serial || JSON.stringify(d)) + '  ' + (d.state || '') + '  ' + (d.extra || '')));

  const ready = devices.find(d => d.state === 'device');
  if (!ready) {
    console.log('\n设备未授权: 请查看手机屏幕上的"允许 USB 调试"弹窗并点允许');
    process.exit(1);
  }

  const size = screenSize();
  if (size) console.log(`\n屏幕分辨率: ${size.w} x ${size.h}`);

  const name = process.argv[2] || `shot_${Date.now()}.png`;
  const file = path.join(OUT_DIR, name);
  const buf = shot(file);
  fs.writeFileSync(file, buf);
  console.log(`\n已保存截图: ${path.relative(ROOT, file)}  (${Math.round(buf.length / 1024)} KB)`);
}

module.exports = { adb, listDevices, shot, screenSize, ADB };
