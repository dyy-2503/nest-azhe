// 远程访问隧道：把本机 8787 暴露成一个 https 公网地址，朋友在外面也能打开。
//
// 为什么是 SSH 反向隧道：这台机器从 GitHub 拉 cloudflared 很慢，而 Windows 自带 OpenSSH，
// serveo / localhost.run 提供免注册（或只登记公钥）的 SSH 反向隧道，零下载。
//
// 固定地址的行为（很重要）：
//   1) 在 serveo 登记过 SSH 公钥后，可以用 --name 要一个固定子域名
//   2) serveo 同一时刻只允许一个连接占用某个名字；如果我们被强制杀掉，名字会在它那边
//      挂一会儿才释放，此时再连会报 "remote port forwarding failed"
//   3) 所以这里的策略是：固定名连不上就先用随机地址保证在线，过一会儿再自动抢回固定名
//
// 用法：
//   node scripts/tunnel.mjs                  # 用 data/_tunnel_name.txt 里的固定名
//   node scripts/tunnel.mjs --name xxx       # 临时指定固定名
//   node scripts/tunnel.mjs --provider lhr   # 换 localhost.run

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DATA = join(ROOT, 'data');
const STATE_FILE = join(DATA, '_tunnel.json');
const LOG_FILE = join(DATA, '_tunnel.log');
const NAME_FILE = join(DATA, '_tunnel_name.txt');
// 优雅重启：外部 touch 这个文件，隧道会先正常断开（serveo 立刻释放固定名），
// 然后由守护进程重新拉起——比直接 kill 好，后者会让 serveo 把名字占住好几分钟
const RESTART_FLAG = join(DATA, '_tunnel_restart.flag');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const PORT = Number(arg('port', process.env.NEST_PORT || 8787));
// provider 顺序：一个被限流/拒绝时自动换下一个（serveo 偶尔会对频繁重连的 IP 临时拒绝）
const PROVIDER_ORDER = (process.env.NEST_TUNNEL_PROVIDERS || 'ts,lhr,serveo')
  .split(',').map((x) => x.trim()).filter(Boolean);
const FORCED = arg('provider', process.env.NEST_TUNNEL_PROVIDER || '');
// 上次成功的 provider 优先（存在 data/_tunnel_provider.txt）
const PROVIDER_HINT_FILE = join(DATA, '_tunnel_provider.txt');
let lastGood = '';
try { lastGood = readFileSync(PROVIDER_HINT_FILE, 'utf8').trim(); } catch { lastGood = ''; }
let providerIdx = Math.max(0, PROVIDER_ORDER.indexOf(lastGood));
const currentProvider = () => (FORCED || PROVIDER_ORDER[providerIdx % PROVIDER_ORDER.length]);
let providerFails = 0;
const SSH = process.env.NEST_SSH || 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const SSH_KEY = process.env.NEST_SSH_KEY || '';

// 固定名字：命令行 > 环境变量 > 文件（开机自启时只有文件）
const TUNNEL_NAME = (() => {
  const direct = arg('name', process.env.NEST_TUNNEL_NAME || '');
  if (direct) return direct.trim();
  try { return readFileSync(NAME_FILE, 'utf8').trim(); } catch { return ''; }
})();

// Tailscale Funnel：地址固定 https://<机器名>.<tailnet>.ts.net，没有警告页也不限速。
// 它不是"隧道进程"，而是 tailscaled 的配置，所以这条路上不 spawn ssh。
const TS_EXE = process.env.NEST_TAILSCALE || 'C:\\Program Files\\Tailscale\\tailscale.exe';

const PROVIDERS = {
  ts: { kind: 'funnel' },
  serveo: {
    host: 'serveo.net',
    user: 'serveo',
    re: /https:\/\/([a-z0-9.-]*?(?:serveousercontent\.com|serveo\.net))/i,
  },
  lhr: {
    host: 'localhost.run',
    user: 'nokey',
    re: /https:\/\/([a-z0-9.-]+\.lhr\.life)/i,
  },
};

function log(line) {
  const stamp = new Date().toTimeString().slice(0, 8);
  const text = `[${stamp}] ${line}`;
  console.log(text);
  try {
    mkdirSync(DATA, { recursive: true });
    appendFileSync(LOG_FILE, text + '\n', 'utf8');
  } catch { /* ignore */ }
}

function writeState(patch) {
  let state = {};
  if (existsSync(STATE_FILE)) {
    try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { state = {}; }
  }
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, ...patch, updatedAt: Date.now() }, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function clearState() {
  try { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); } catch { /* ignore */ }
}

let child = null;
let stopping = false;
let url = '';
let attempts = 0;
let mode = TUNNEL_NAME ? 'named' : 'random';   // named = 正在用固定名，random = 降级中
let namedRetryTimer = null;
let lastOut = '';   // 最近一次 ssh 输出（判断是不是"名字没释放"）

/** 上一次进程被强杀时，子 ssh 会变成孤儿继续占着固定子域名；启动时先清掉它 */
function killOrphanSsh() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const st = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const old = Number(st.sshPid) || 0;
    if (!old) return;
    try { process.kill(old); } catch { /* 早没了 */ }
  } catch { /* ignore */ }
}


/** 跑一个 tailscale 子命令，返回 { ok, out } */
function tsRun(args) {
  try {
    const out = execFileSync(TS_EXE, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: (err.stdout || '') + (err.stderr || '') || err.message };
  }
}

/** Funnel 的公网地址：https://<DNSName>（去掉末尾的点） */
function funnelUrl() {
  const r = tsRun(['status', '--json']);
  if (!r.ok) return '';
  try {
    const j = JSON.parse(r.out);
    const dns = String(j?.Self?.DNSName || '').replace(/\.$/, '');
    return dns ? 'https://' + dns : '';
  } catch { return ''; }
}

/** 确保 Funnel 指向本机端口，并返回地址 */
function ensureFunnel() {
  const st = tsRun(['funnel', 'status']);
  const active = st.ok && st.out.includes(`proxy http://127.0.0.1:${PORT}`);
  if (!active) tsRun(['funnel', '--bg', String(PORT)]);
  return funnelUrl();
}

function startFunnel() {
  const url2 = ensureFunnel();
  if (url2) {
    url = url2;
    log(`公网地址已就绪：${url}（Tailscale Funnel ✓）`);
    writeState({ provider: 'ts', url, port: PORT, pid: process.pid, stable: true });
    attempts = 0;
    providerFails = 0;
    try { writeFileSync(PROVIDER_HINT_FILE, 'ts', 'utf8'); } catch { /* ignore */ }
  } else {
    log('Funnel 没起来（Tailscale 没登录？跑 tailscale up 登录一次）');
    providerFails += 1;
    if (providerFails >= 2 && !FORCED) { providerIdx += 1; providerFails = 0; mode = 'random'; log(`切换到 ${currentProvider()}`); }
    setTimeout(start, 15_000);
    return;
  }
  // 每 60 秒确认一次 Funnel 还在（tailscaled 重启/配置丢失时自动补上）
  setInterval(() => {
    if (stopping) return;
    const again = ensureFunnel();
    if (again && again !== url) {
      url = again;
      writeState({ provider: 'ts', url, port: PORT, pid: process.pid, stable: true });
      log(`公网地址已更新：${url}`);
    }
  }, 60_000);
}

function start() {
  const PROVIDER = currentProvider();
  const p = PROVIDERS[PROVIDER];
  if (PROVIDER === 'ts') { startFunnel(); return; }
  if (!p) {
    log(`不认识的 provider：${PROVIDER}（可选：${Object.keys(PROVIDERS).join(' / ')}）`);
    process.exit(1);
  }
  attempts += 1;
  // 固定名只有 serveo 认（localhost.run 的自定义域名要付费账号），别的 provider 走随机
  const useName = PROVIDER === 'serveo' && mode === 'named' && TUNNEL_NAME ? TUNNEL_NAME : '';
  log(`连接 ${p.host} 建隧道（第 ${attempts} 次）→ 127.0.0.1:${PORT}` + (useName ? `，固定名 ${useName}` : '（随机地址）'));

  const args = [
    // 用 127.0.0.1 而不是 localhost：localhost 可能先解析成 ::1，服务只监听 IPv4 会 502（踩过）
    ...(SSH_KEY ? ['-i', SSH_KEY] : []),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-R', useName ? `${useName}:80:127.0.0.1:${PORT}` : `80:127.0.0.1:${PORT}`,
    `${p.user}@${p.host}`,
  ];

  child = spawn(SSH, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // 记住 ssh 的 PID：重启时用它清孤儿，否则固定名会被占几分钟
  try { writeState({ sshPid: child.pid }); } catch { /* ignore */ }
  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    lastOut = (lastOut + chunk.toString('utf8')).slice(-4000);
    const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    const m = clean.match(p.re);
    if (m && m[1]) {
      const got = m[1].startsWith('http') ? m[1] : 'https://' + m[1];
      if (got !== url) {
        url = got;
        const stable = Boolean(useName) && got.includes(useName);
        log(`公网地址已就绪：${url}` + (stable ? '（固定地址 ✓）' : useName ? '（固定名没拿到，先用随机）' : ''));
        writeState({ provider: PROVIDER, url, port: PORT, pid: process.pid, stable });
        attempts = 0;
        providerFails = 0;
        try { writeFileSync(PROVIDER_HINT_FILE, PROVIDER, 'utf8'); } catch { /* ignore */ }
        // 降级状态下抢到了随机地址，过 3 分钟再试固定名
        if (stable && namedRetryTimer) { clearTimeout(namedRetryTimer); namedRetryTimer = null; }
        if (!stable && TUNNEL_NAME) scheduleNamedRetry(300);
      }
    }
    for (const line of clean.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || p.re.test(t) || /Warning: Permanently added/i.test(t)) continue;
      if (t.length < 300) log('  ssh| ' + t);
    }
    if (clean.length > 4000) buf = clean.slice(-2000);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('exit', (code) => {
    const wasNamed = Boolean(useName);
    child = null;
    url = '';
    clearState();
    if (stopping) { log('隧道已关闭'); process.exit(0); }
    // serveo 对"名字还没释放"的报错是 remote port forwarding failed：
    // 这不算 provider 挂了，只降级成随机地址，过 5 分钟再抢回固定名
    const nameHold = Boolean(useName) && /remote port forwarding failed/i.test(lastOut);
    if (nameHold) {
      mode = 'random';
      log('固定名还占着（serveo 没释放），先降级随机地址，5 分钟后再抢');
      scheduleNamedRetry(300);
    } else if (wasNamed) {
      mode = 'random';
      log('固定名这次没拿到，先降级随机地址');
    }
    if (!nameHold) providerFails += 1;
    if (!nameHold && !url && providerFails >= 2 && !FORCED) {
      providerIdx += 1;
      providerFails = 0;
      log(`当前 provider 连续失败，切换到 ${currentProvider()}`);
    }
    const wait = Math.min(30, 2 + attempts * 2);
    log(`隧道断了（code=${code}），${wait}s 后重连`);
    setTimeout(start, wait * 1000);
  });
  child.on('error', (err) => {
    log('起 ssh 失败：' + err.message);
    if (!stopping) setTimeout(start, 5000);
  });
}

/** 降级中：过一会儿把固定名抢回来（换连接） */
function scheduleNamedRetry(sec) {
  if (namedRetryTimer || !TUNNEL_NAME) return;
  namedRetryTimer = setTimeout(() => {
    namedRetryTimer = null;
    if (stopping || mode === 'named') return;
    log(`尝试抢回固定名 ${TUNNEL_NAME}…`);
    mode = 'named';
    attempts = 0;
    if (child) {
      // 优雅地关掉当前连接再重连（直接杀会让 serveo 端挂更久）
      try { child.stdin.write('~.'); } catch { /* ignore */ }
      setTimeout(() => { try { child && child.kill(); } catch { /* ignore */ } }, 800);
    } else {
      start();
    }
  }, sec * 1000);
}

function stop() {
  stopping = true;
  clearState();
  // 先发 SSH 的退出序列 "~."，让 serveo 立刻释放名字（否则固定名会被占几分钟）
  try { child && child.stdin.write('~.'); } catch { /* ignore */ }
  setTimeout(() => { try { child && child.kill(); } catch { /* ignore */ } }, 600);
  log('收到退出信号，正在关闭隧道');
  setTimeout(() => process.exit(0), 1500);
}

// 轮询重启标志
setInterval(() => {
  if (stopping) return;
  if (existsSync(RESTART_FLAG)) {
    try { unlinkSync(RESTART_FLAG); } catch { /* ignore */ }
    log('收到优雅重启请求，先断开再让守护进程拉起');
    stop();
  }
}, 2000);

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

killOrphanSsh();
log(`隧道进程启动（顺序=${PROVIDER_ORDER.join(" → ")}${FORCED ? `，锁定 ${FORCED}` : ""}，端口=${PORT}` + (TUNNEL_NAME ? `，固定名=${TUNNEL_NAME}` : '') + '）');
start();
