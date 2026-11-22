#!/usr/bin/env node
/**
 * Nest 的守护进程：管着「服务端」和「AI 桥接」两条命。
 *
 * 为什么需要它：
 *   1. DSH 一重启，它派生的子进程会被一起带走，Nest 就没了（今天挂过两次）。
 *   2. DSH 的端口每次启动都变，写死在环境变量里迟早失效。
 *
 * 它做三件事：
 *   · 启动前自己找到本机 DSH 的端口（scripts/lib/dsh.mjs）
 *   · 拉起 server/index.mjs 和 bridge/nest-bridge.mjs，谁挂了就重启谁（指数退避）
 *   · 日志写到 data/_supervisor.log，出一行带时间戳
 *
 * 用法：
 *   node scripts/supervise.mjs            # 前台跑（看日志）
 *   node scripts/supervise.mjs --daemon   # 后台跑（开机自启用）
 *   node scripts/supervise.mjs --no-bridge  # 只守服务端
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDshBase } from './lib/dsh.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'data', '_supervisor.log');
const NODE = process.execPath;
const DAEMON = process.argv.includes('--daemon');
const NO_BRIDGE = process.argv.includes('--no-bridge');
// --tunnel：同时把服务暴露到公网（SSH 反向隧道，免账号免下载）
const WITH_TUNNEL = process.argv.includes('--tunnel') || process.env.NEST_TUNNEL === '1';

mkdirSync(join(ROOT, 'data'), { recursive: true });

const PID_FILE = join(ROOT, 'data', '_supervisor.pid');

/** 只允许一个守护进程：开机自启和手动启动撞上时，后来的直接退出 */
function acquireLock() {
  try {
    const old = Number(String(readFileSync(PID_FILE, 'utf8')).trim());
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0);           // 还活着
        logLine(`已有守护进程在跑（PID ${old}），本次退出`);
        process.exit(0);
      } catch { /* 死了，接管 */ }
    }
  } catch { /* 没锁文件，正常 */ }
  writeFileSync(PID_FILE, String(process.pid));
}

function releaseLock() {
  try {
    const cur = Number(String(readFileSync(PID_FILE, 'utf8')).trim());
    if (cur === process.pid) unlinkSync(PID_FILE);
  } catch {}
}

function logLine(msg) {
  try { appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)} ${msg}\n`); } catch {}
}

function log(msg) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  try { appendFileSync(LOG, line + '\n'); } catch {}
  if (!DAEMON) console.log(line);
}

/** 桥接的钥匙存在 bridge/nest-me.json 里（AI 第一次连过来时写的） */
function bridgeKey() {
  const f = join(ROOT, 'bridge', 'nest-me.json');
  if (!existsSync(f)) return '';
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return typeof j.key === 'string' ? j.key : '';
  } catch { return ''; }
}

class Child {
  constructor(name, args, env = {}) {
    this.name = name;
    this.args = args;
    this.env = env;
    this.proc = null;
    this.restarts = 0;
    this.stopped = false;
    this.startedAt = 0;
  }

  start() {
    if (this.stopped) return;
    const t0 = Date.now();
    this.startedAt = t0;
    this.proc = spawn(NODE, this.args, {
      cwd: ROOT,
      env: { ...process.env, ...this.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const forward = (stream, tag) => {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) log(`[${tag}] ${line.trim().slice(0, 300)}`);
        }
      });
    };
    forward(this.proc.stdout, this.name);
    forward(this.proc.stderr, this.name);

    this.proc.on('exit', (code, signal) => {
      if (this.stopped) return;
      const lived = Date.now() - t0;
      // 活够 30 秒就算"稳定过"，重启计数清零，避免偶发崩溃把退避拉到很大
      if (lived > 30_000) this.restarts = 0;
      const wait = Math.min(30_000, 1000 * 2 ** this.restarts);
      this.restarts += 1;
      log(`[${this.name}] 退出（code=${code} signal=${signal}，活了 ${Math.round(lived / 1000)}s），${Math.round(wait / 1000)}s 后重启`);
      setTimeout(() => this.start(), wait);
    });
  }

  stop() {
    this.stopped = true;
    try { this.proc?.kill(); } catch {}
  }
}

const children = [];

async function main() {
  acquireLock();
  log('===== 守护进程启动 =====');

  // 先找 DSH：找不到也要把服务端拉起来（本地账号、聊天记录不依赖 DSH，只是 AI 不响应）
  const base = await findDshBase({ log });
  if (base) {
    log(`DSH：${base}`);
    process.env.DSH_WEB_URL = base;
  } else {
    log('没找到本机 DSH——服务照常跑，但内置 AI 不会响应；DSH 起来后重启本守护进程即可');
  }

  const serverEnv = { DSH_WEB_URL: base || '' };
  if (WITH_TUNNEL) {
    // 一旦对公网开放，注册就必须凭邀请码，否则谁都能注册进来
    serverEnv.NEST_PUBLIC = '1';
    if (!process.env.NEST_REGISTER) serverEnv.NEST_REGISTER = 'invite';
  }
  const server = new Child('server', ['--no-warnings', 'server/index.mjs'], serverEnv);
  children.push(server);
  server.start();

  if (!NO_BRIDGE) {
    const key = bridgeKey();
    if (key) {
      const bridge = new Child('bridge', [
        '--no-warnings', 'bridge/nest-bridge.mjs',
        '--server', 'http://127.0.0.1:8787',
        '--key', key,
      ]);
      children.push(bridge);
      // 等一会儿再起桥接，避免它比服务端先进去（会一直重连）
      setTimeout(() => bridge.start(), 1500);
    } else {
      log('没有找到桥接钥匙（bridge/nest-me.json），跳过桥接');
    }
  }

  if (WITH_TUNNEL) {
    const tunnel = new Child('tunnel', ['--no-warnings', 'scripts/tunnel.mjs', '--port', '8787'], {});
    children.push(tunnel);
    setTimeout(() => tunnel.start(), 2500);
  }

  const shutdown = (sig) => {
    log(`收到 ${sig}，停掉子进程`);
    for (const c of children) c.stop();
    releaseLock();
    setTimeout(() => process.exit(0), 300);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => shutdown(sig));
  }
}

main().catch((err) => {
  log('守护进程崩了：' + (err?.stack || err));
  releaseLock();
  process.exit(1);
});
