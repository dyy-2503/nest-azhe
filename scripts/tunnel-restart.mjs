// 优雅重启隧道：让隧道自己断开（固定名立刻释放），守护进程会把它重新拉起来。
// 用途：改完 data/_tunnel_name.txt 或者隧道卡住时。
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const flag = join(ROOT, 'data', '_tunnel_restart.flag');
const state = join(ROOT, 'data', '_tunnel.json');

console.log('请求隧道优雅重启…');
writeFileSync(flag, String(Date.now()), 'utf8');

// 最多等 20 秒（隧道每 2 秒检查一次标志）
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (!existsSync(flag)) break;
}
try { if (existsSync(flag)) rmSync(flag); } catch {}
console.log('已发出重启请求；隧道会在几秒内重连（看 data/_tunnel.json 或界面里的远程地址）');