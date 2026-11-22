// 手机本地世界的安装脚本（在手机 proot 容器里用 node 跑）
//
// 做的事（可重复执行，第二次不会重复建号）：
//   1. 在本机 8787 起一个 Nest 服务器（数据放 ./data）
//   2. 注册本机账号（open 模式，不需要邀请码）
//   3. 建一个本地 AI，拿到钥匙
//   4. 用这把钥匙 + 本机 DSH(3080) 起桥接
//   5. 打印结果
//
// 用法：cd /root/nest-local && node phone-setup.mjs

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA = join(ROOT, 'data');
const PORT = Number(process.env.NEST_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = process.env.NEST_LOCAL_PHONE || '13900000001';
const PASSWORD = process.env.NEST_LOCAL_PASSWORD || 'nest123';
const AI_NAME = process.env.NEST_LOCAL_AI || '小肥鱼本机';
const DSH_URL = process.env.NEST_LOCAL_DSH || 'http://127.0.0.1:3080';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnDetached(cmd, args, env, logFile) {
  mkdirSync(DATA, { recursive: true });
  const fd = openSync(logFile, 'a');
  const p = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  p.unref();
  return p.pid;
}

async function api(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') || '' };
}

async function waitServer(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await api('/api/server-info');
      if (r.status === 200) return r.json;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return null;
}

/* ------------------------------ 1. 服务器 ------------------------------ */

log('▶ 启动本机服务器…');
let info = await waitServer(1500);
if (!info) {
  mkdirSync(DATA, { recursive: true });
  const pid = spawnDetached(
    process.execPath,
    ['server/index.mjs'],
    { NEST_PORT: String(PORT), NEST_DATA_DIR: DATA, NEST_HOST: '0.0.0.0' },
    join(DATA, 'server.log'),
  );
  log(`  已启动（PID ${pid}），等它就绪…`);
  info = await waitServer();
}
if (!info) {
  console.error('✗ 服务器没起来，看 data/server.log');
  process.exit(1);
}
log(`  ✓ 服务器就绪 ${BASE}（firstRun=${info.firstRun}）`);

/* ------------------------------ 2. 本机账号 ------------------------------ */

log('▶ 准备本机账号…');
let cookie = '';
let me = null;

const login = async () => {
  const r = await api('/api/login', { method: 'POST', body: { account: PHONE, password: PASSWORD } });
  if (r.status === 200) {
    cookie = r.setCookie.split(';')[0];
    me = r.json;
    return true;
  }
  return false;
};

if (!(await login())) {
  log('  账号不存在，注册一个…');
  const reg = await api('/api/register', {
    method: 'POST',
    body: {
      phone: PHONE,
      nickname: '手机本机',
      password: PASSWORD,
      q1: 'birthday',
      q2: 'primary',
      a1: '0512',
      a2: '实验',
    },
  });
  log(`  注册返回 HTTP ${reg.status}${reg.json?.error ? ' ' + reg.json.error : ''}`);
  if (!(await login())) {
    console.error('✗ 注册后还是登不上，看 data/server.log');
    process.exit(1);
  }
}
log(`  ✓ 已登录：${me.nickname}（手机号 ${PHONE}，密码 ${PASSWORD}）`);

/* ------------------------------ 3. 本地 AI ------------------------------ */

log('▶ 准备本地 AI…');
const members = await api('/api/ai/members', { cookie });
const list = members.json?.members || [];
let ai = list.find((m) => String(m.nickname) === AI_NAME) || list[0];
let key = '';

if (!ai) {
  const created = await api('/api/ai/members', {
    method: 'POST',
    cookie,
    body: { nickname: AI_NAME, persona: '你自己编', caps: { memory: true, emotion: true, proactive: true } },
  });
  ai = created.json?.member || created.json?.ai || created.json;
  key = created.json?.key || created.json?.aiKey || '';
  log(`  新建 AI：${ai?.nickname || AI_NAME}（HTTP ${created.status}）`);
} else {
  log(`  已有 AI：${ai.nickname}（id ${ai.id}）`);
}

// 没有 key 就发一把新的（钥匙只在创建/发钥匙时返回一次）
if (!key) {
  const k = await api(`/api/ai/members/${ai.id}/key`, { method: 'POST', cookie });
  key = k.json?.key || k.json?.aiKey || '';
  log(`  重新发钥匙（HTTP ${k.status}）`);
}
if (!key) {
  console.error('✗ 拿不到钥匙，看接口返回');
  process.exit(1);
}

/* ------------------------------ 4. 桥接 ------------------------------ */

log('▶ 启动桥接（把这个 AI 接到本机服务器）…');
const bridgePid = join(DATA, 'bridge.pid');
let running = false;
if (existsSync(bridgePid)) {
  const old = Number(readFileSync(bridgePid, 'utf8').trim());
  try { process.kill(old, 0); running = true; } catch { running = false; }
}
let pid = 0;
if (!running) {
  pid = spawnDetached(
    process.execPath,
    ['bridge/nest-bridge.mjs', '--server', BASE, '--key', key, '--dsh', DSH_URL],
    {},
    join(DATA, 'bridge.log'),
  );
  log(`  已启动（PID ${pid}）`);
} else {
  log('  桥接已经在跑，跳过');
}

await sleep(2500);
const tail = (f, n = 6) => {
  try { return readFileSync(join(DATA, f), 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return '(没有日志)'; }
};

log('\n================ 结果 ================');
log(`本地服务器：${BASE}`);
log(`本机账号　：${PHONE} / ${PASSWORD}`);
log(`本地 AI　 ：${ai?.nickname || AI_NAME}（id ${ai?.id}）`);
log(`钥匙　　　：${key}`);
log('\n--- 服务器日志 ---');
log(tail('server.log'));
log('\n--- 桥接日志 ---');
log(tail('bridge.log'));
log('\n下一步：手机上打开 Nest → 换一个服务器 → 填 http://127.0.0.1:' + PORT + ' → 用上面的手机号密码登录');
