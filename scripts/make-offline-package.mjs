// 打「手机本地世界」离线包：dist/nest-offline.tar.gz
//
// 内容（解压到手机容器 /root/nest-local 后即可跑）：
//   server/ public/ vendor/ scripts/      —— 服务器本体（零依赖）
//   bridge/nest-bridge.mjs                —— 桥接，把本机 DSH 接到本机服务器
//   package.json                          —— 版本号/type 声明
//   phone-setup.mjs                       —— 一键装机（起服务器、注册、建 AI、拿钥匙、起桥接）
//   phone-start.sh                        —— 幂等启动脚本（自启钩子会调用它）
//   install-autostart.sh                  —— 装自启（写 start.sh + 挂 DSH 启动钩子）
//
// 用法：node scripts/make-offline-package.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = join(ROOT, '_offline-stage');
const OUT = join(ROOT, 'dist', 'nest-offline.tar.gz');

const COPY_DIRS = ['server', 'public', 'vendor', 'scripts'];
const COPY_FILES = [
  ['bridge/nest-bridge.mjs', 'bridge/nest-bridge.mjs'],
  ['package.json', 'package.json'],
  ['mobile/phone-setup.mjs', 'phone-setup.mjs'],
  ['mobile/phone-start.sh', 'phone-start.sh'],
  ['mobile/install-autostart.sh', 'install-autostart.sh'],
];

console.log('▶ 打离线包…');
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

for (const dir of COPY_DIRS) {
  const src = join(ROOT, dir);
  if (!existsSync(src)) throw new Error(`缺目录：${dir}`);
  cpSync(src, join(STAGE, dir), { recursive: true });
}
for (const [from, to] of COPY_FILES) {
  const src = join(ROOT, from);
  if (!existsSync(src)) throw new Error(`缺文件：${from}`);
  const dest = join(STAGE, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

mkdirSync(join(ROOT, 'dist'), { recursive: true });
rmSync(OUT, { force: true });
// Windows 10+ / macOS / Linux 都自带 tar
execFileSync('tar', ['-czf', OUT, '-C', STAGE, '.'], { stdio: 'inherit' });
rmSync(STAGE, { recursive: true, force: true });

const kb = Math.round(statSync(OUT).size / 1024);
console.log(`✓ ${OUT}  (${kb} KB)`);
console.log('  手机端用法：推这个包到 /sdcard/Download/nest/ 后，在 DSHA 终端里跑 go.sh');
