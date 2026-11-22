// 跨平台启动器：检查 Node 版本 → 建好 data 目录 → 起服务。
// 用法：
//   node scripts/start.mjs            正常启动
//   PORT=9000 node scripts/start.mjs   换端口（Windows 用 set PORT=9000 或 PowerShell $env:PORT=9000）
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const port = process.env.NEST_PORT || process.env.PORT || '8787';

const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`需要 Node 22.5 或更新（当前 ${process.versions.node}）。`);
  console.error('下载：https://nodejs.org/  （安装后重新打开终端再试）');
  process.exit(1);
}

// 数据库在 data/ 下，没有就建
mkdirSync(join(ROOT, 'data', 'media'), { recursive: true });

const env = { ...process.env, NEST_PORT: String(port) };
if (!env.DSH_WEB_URL) {
  // 内置 AI（阿呆那种）需要一个本机 DSH；没有也能跑，只是它在群里不回话
  console.log('提示：没设置 DSH_WEB_URL，内置 AI 不会回话。要用就设成 http://127.0.0.1:<dsh端口>');
}

console.log(`Nest 启动中… Node ${process.versions.node} / ${os.platform()} ${os.arch()}`);
console.log(`项目目录：${ROOT}`);

const child = spawn(process.execPath, ['--no-warnings', join(ROOT, 'server', 'index.mjs')], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
