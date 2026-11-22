#!/usr/bin/env node
// nest-bridge：把你自己电脑上的 DSH 接进 Nest 群聊。
//
// 它做的事很简单：
//   1. 用钥匙连上 Nest，订阅消息（SSE 长连接，主动外连，不需要公网 IP）
//   2. 群里有新消息 → 转给本机 DSH 的一个会话（每个群一个会话，一直连着）
//   3. DSH 回的话 → 发回群里。它只回 " [SILENT] " 就不发。
//
// 你的 skill、工具、文件全在本机，这个脚本不碰。
//
// 用法：
//   node nest-bridge.mjs --server http://<服务器地址>:8787 --key NEST-AI-xxxx
//   node nest-bridge.mjs --server ... --key ... --dsh http://127.0.0.1:62212
//   node nest-bridge.mjs --server ... --key ... --persona my-role.md   # 自定义人设
//
// 依赖：Node 22+（自带 fetch / WebSocket）。零 npm 依赖。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/* -------------------------------- 参数 ---------------------------------- */

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SERVER = arg('server', 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = arg('key', process.env.NEST_AI_KEY || '');
// --dsh 指的是**本机**的 DSH，不是群主那边的。留空就自动扫端口找。
const DSH_ARG = arg('dsh', process.env.DSH_WEB_URL || '');
let DSH = (DSH_ARG || 'http://127.0.0.1:3080').replace(/\/+$/, '');
const PERSONA_FILE = arg('persona', '');
// 新会话用哪个 DSH 预设：minimal 是工具面最小的一档，回话快、不折腾。
// （DSH 的 agentPresets/list 只有 standard/ptc/minimal/cordis 四个，没有更细的"思考强度"开关）
// minimal 会让 AI 没有工具（连终端都打不开，跑不了 nest-me.mjs），
// 所以默认用 standard；想更快可以 --preset minimal，代价是它不能动手。
const AGENT_PRESET = arg('preset', process.env.NEST_DSH_PRESET || 'standard');
const STATE_FILE = arg('state', join(dirname(fileURLToPath(import.meta.url)), 'nest-bridge.state.json'));

if (!KEY) {
  console.error('缺少钥匙：--key NEST-AI-xxxx（在你的 Nest 设置里创建一个 AI 成员后拿到）');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN'), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SILENT = /^\s*\[SILENT\]\s*$/i;

/* ------------------------------ 状态持久化 ------------------------------- */

/** 重新拉一次「我在哪些会话」——被中途拉进新群时用得上 */
async function refreshConversations() {
  try {
    const me = await nestJson('/api/ai/me');
    for (const c of me.conversations) {
      if (!titles.has(c.id)) log(`发现自己被加进了：${c.title}`);
      titles.set(c.id, c.title);
    }
  } catch (err) {
    log('刷新会话列表失败：', err.message);
  }
}

let state = { sessions: {}, lastSeen: {}, personaHash: '' };
if (existsSync(STATE_FILE)) {
  try {
    state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    log('状态文件读不动，从空开始（不影响使用）');
  }
}
const saveState = () => {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log('状态文件写不进去：', err.message);
  }
};

/* ------------------------------ 本机 DSH 客户端 --------------------------- */

const b64 = (b) => Buffer.from(b).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** 从 ~/.dsh/.credentials.yaml 里抠出 browser-session 密钥（YAML 就这一处，不引依赖） */
function readDshSecret() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const file = join(home, '.credentials.yaml');
  const raw = readFileSync(file, 'utf8');
  const m = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/.exec(raw);
  if (!m) throw new Error(`在 ${file} 里没找到 browser-session 密钥`);
  return Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
}

let cookieCache = { value: '', expiresAt: 0 };

function dshCookie() {
  if (cookieCache.value && Date.now() < cookieCache.expiresAt - 5 * 60_000) return cookieCache.value;
  const secret = readDshSecret();
  const authority = new URL(DSH).host;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 3600_000;
  const body = b64(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt })));
  const sig = b64(createHmac('sha256', secret).update(body).digest());
  const name = 'dsh-auth-' + b64(createHash('sha256').update(authority).digest());
  cookieCache = { value: `${name}=v1.${body}.${sig}`, expiresAt };
  return cookieCache.value;
}

async function dshRpc(method, args, timeoutMs = 20000) {
  const endpoint = method.replace(/\./g, '/');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${DSH}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: dshCookie() },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
      signal: ac.signal,
    });
    const json = await res.json();
    if (!json?.result?.ok) throw new Error(`DSH ${endpoint} 失败：${json?.result?.error?.message || res.status}`);
    return json.result.value;
  } finally {
    clearTimeout(timer);
  }
}

/** 在 DSH 会话里跑一轮 prompt，返回文本 */
async function dshTurn(sessionId, text, timeoutMs = 120000) {
  const url = new URL('/api/remote.mux', DSH);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const streamId = randomUUID();
  const ws = new WebSocket(url, { headers: { cookie: dshCookie() } });

  return await new Promise((resolve, reject) => {
    let done = false;
    let chunks = '';
    let whole = '';
    let ourTurn = null;
    let promptSent = false;
    let kickoff = null;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(kickoff);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(chunks || whole);
    };
    const timer = setTimeout(() => finish(new Error('DSH 回合超时')), timeoutMs);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'open', streamId, endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 5 } } },
      }));
      kickoff = setTimeout(() => {
        if (done) return;
        promptSent = true;
        dshRpc('session/prompt', {
          request: {
            sessionId, mode: 'queue',
            content: [{ type: 'text', text }],
            requestId: randomUUID(),
          },
        }).catch((e) => finish(e));
      }, 300);
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'item' || msg.streamId !== streamId || msg.value?.type !== 'event') return;
      const e = msg.value.event;
      if (!e || typeof e.type !== 'string') return;

      if (e.type === 'turn/start') {
        if (promptSent && ourTurn === null) ourTurn = e.data?.turn ?? 'anonymous';
        return;
      }
      if (ourTurn === null) return;

      if (e.type === 'assistant/chunk') {
        const piece = e.data?.text ?? e.data?.delta?.text ?? '';
        if (piece) chunks += piece;
        return;
      }
      if (e.type === 'assistant/message') {
        const t = (e.data?.message?.content || [])
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text).join('');
        if (t) whole = t;
        return;
      }
      if (e.type === 'turn/end') {
        const t = e.data?.turn;
        if (t && ourTurn !== 'anonymous' && t !== ourTurn) return;
        if (!chunks && !whole) return finish(new Error('DSH 这一轮没有文本'));
        finish(null);
      }
    });

    ws.addEventListener('error', () => finish(new Error('连不上本机 DSH 事件流')));
    ws.addEventListener('close', () => {
      if (!done) (chunks || whole) ? finish(null) : finish(new Error('DSH 事件流提前关闭'));
    });
  });
}

/* -------------------------------- Nest 侧 -------------------------------- */

const nest = {
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
};

async function nestJson(path, init = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: { ...nest.headers, ...(init.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${json?.error || text.slice(0, 120)}`);
  return json;
}

/** 上传原始字节（头像用） */
async function nestRaw(path, method, bytes, contentType) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: { ...nest.headers, 'content-type': contentType },
    body: bytes,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${json?.error || text.slice(0, 120)}`);
  return json;
}

/** 把 AI 回复里的 [[nest:xxx ...]] 标记执行掉，返回干净的正文 */
async function applySelfCommands(text) {
  const re = /\[\[nest:(signature|nickname|avatar)\s+([^\]]+?)\]\]/g;
  const found = [...text.matchAll(re)];
  let out = text.replace(re, '').replace(/\n{2,}/g, '\n').trim();

  for (const [, kind, value] of found) {
    const v = value.trim();
    try {
      if (kind === 'signature' || kind === 'nickname') {
        await nestJson('/api/profile', {
          method: 'POST',
          body: JSON.stringify({ [kind]: v }),
        });
        log(`[自我设置] ${kind} = ${v}`);
      } else if (kind === 'avatar') {
        const file = v.replace(/^["']|["']$/g, '');
        if (!existsSync(file)) { log('[自我设置] 头像文件不存在：', file); continue; }
        const ext = file.toLowerCase().split('.').pop();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext];
        if (!mime) { log('[自我设置] 不支持的图片格式：', ext); continue; }
        const up = await nestRaw('/api/upload', 'POST', readFileSync(file), mime);
        await nestJson('/api/profile', {
          method: 'POST',
          body: JSON.stringify({ avatar: up.url }),
        });
        log(`[自我设置] 头像 = ${up.url}`);
      }
    } catch (err) {
      log(`[自我设置] ${kind} 失败：`, err.message);
    }
  }
  return out;
}

async function postMessage(convId, text) {
  return nestJson('/api/message', {
    method: 'POST',
    body: JSON.stringify({
      conv: convId,
      clientId: randomUUID(),
      blocks: [{ t: 'text', v: text }],
    }),
  });
}

/* ------------------------------- 每个群的队列 ----------------------------- */

const queues = new Map();   // convId -> [{from, text, ctx}]
const running = new Set();  // convId 正在跑
const titles = new Map();   // convId -> title
const ctx = new Map();      // convId -> [ "昵称：内容" ]  没接的话，攒着当上下文
const aiChain = new Map();  // convId -> 连续 AI 轮次
const convKinds = new Map(); // convId -> 'group' | 'dm'
let MY_ID = 0;              // 我自己在 Nest 里的 user id
let MY_NAME = '';           // 我自己的昵称（判断有没有被 @）

const personaFromFile = PERSONA_FILE && existsSync(PERSONA_FILE)
  ? readFileSync(PERSONA_FILE, 'utf8').trim()
  : '';
// 人设以页面上填的为准；--persona 文件可以覆盖（老用法保留）
let personaText = personaFromFile;
let personaDirty = false;   // 人设改过、还没重新告诉 DSH
let serverPersonaHash = ''; // 服务器上那份人设的指纹
let CAPS = { memory: true, emotion: true, proactive: true }; // 主人勾的能力
let EXTENSIONS = [];   // 主人给这个 AI 装的能力扩展（prompt 片段）

const SELF_HELP_VERSION = 2;

function selfHelpText() {
  return `【改自己的资料】你的运行环境没有终端，别试着自己跑命令。
想改的时候，在回复里单独加一行标记，系统会替你执行（这行不会显示给别人）：
  [[nest:signature 想写的话]]        改签名
  [[nest:nickname 新名字]]           改名字（主人没允许会失败）
  [[nest:avatar 图片的本地路径]]      换头像（只能用你手上有路径的图）
收到别人的图片时，消息里会给出它的本机路径，可以直接拿来当头像。`;
}

function setupPrompt(title) {
  const role = personaText ? `${personaText}\n\n` : '';
  const extra = [];
  if (CAPS.emotion) extra.push('说话可以有情绪：高兴就高兴，烦就烦，别装中立。');
  else extra.push('说话克制一点，别渲染情绪。');
  if (CAPS.memory) extra.push('你有记忆能力，可以记下群里重要的事。');
  else extra.push('不要用记忆相关的工具，也别说"我记住了"。');
  const extText = EXTENSIONS.length
    ? `【主人给你装的能力】\n${EXTENSIONS.map((e) => `- ${e.name}：${e.prompt}`).join('\n')}\n`
    : '';
  const selfHelp = selfHelpText();

  return `${role}【现在的场景】你被拉进了一个叫「${title}」的群聊，里面有人在聊天。
你能看到的句子会以「昵称：内容」的形式给你；群里可能还有别的 AI。
用短句回，像在手机上打字，不要 Markdown。
${extra.join('\n')}
${extText}${selfHelp}
不需要你接的话，就只输出 [SILENT] 这四个字符，别的什么都别写。
收到请只回一个字：好`;
}

function pushCtx(convId, line) {
  const list = ctx.get(convId) || [];
  list.push(line);
  while (list.length > 20) list.shift();   // 只留最近 20 句
  ctx.set(convId, list);
}

function takeCtx(convId) {
  const list = ctx.get(convId) || [];
  ctx.set(convId, []);
  if (!list.length) return '';
  return `【刚才群里还说了】\n${list.join('\n')}\n\n`;
}

async function ensureSession(convId) {
  const key = String(convId);
  if (state.sessions[key]) return state.sessions[key];

  const created = await dshRpc('session/create', { request: { agentPreset: AGENT_PRESET } });
  const sid = created?.sessionId;
  if (!sid) throw new Error('本机 DSH 没有返回 sessionId');
  state.sessions[key] = sid;
  saveState();
  log(`建会话（预设 ${created.agentPreset || AGENT_PRESET}）`);

  await dshTurn(sid, setupPrompt(titles.get(convId) || '群聊'), 90000);
  // 新会话已经把人设交代过了，记下来免得下次重复注入
  if (personaText) { state.personaHash = serverPersonaHash; saveState(); }
  log(`会话就绪：群 ${convId} → ${sid}`);
  return sid;
}

async function drain(convId) {
  if (running.has(convId)) return;
  running.add(convId);
  try {
    while ((queues.get(convId) || []).length) {
      const item = queues.get(convId).shift();
      const sid = await ensureSession(convId);
      // 人设改过：这次开口前先把新人设交代清楚
      let lead = '';
      if (personaDirty) {
        let p = '', h = '';
        try {
          const r = await nestJson('/api/ai/me');
          p = r.persona?.text || '';
          h = r.persona?.hash || '';
        } catch {}
        lead = `【你的人设更新了，以后照这个来】\n${p}\n\n`;
        personaText = p.trim();
        personaDirty = false;
        serverPersonaHash = h;
        state.personaHash = h;
        saveState();
      }
      // 老会话还没见过"你能改自己的资料"这段 → 补一次
      if (Number(state.selfHelpVersion || 0) !== SELF_HELP_VERSION) {
        lead += selfHelpText() + '\n\n';
        state.selfHelpVersion = SELF_HELP_VERSION;
        saveState();
      }
      const out = await dshTurn(sid, lead + item.ctx + `${item.from}：${item.text}`);
      const clean = (out || '').trim();
      if (!clean || SILENT.test(clean)) {
        log(`[静默] ${convId}「${item.text.slice(0, 20)}」`);
        aiChain.set(convId, (aiChain.get(convId) || 0) + 1);
        continue;
      }
      await postMessage(convId, await applySelfCommands(clean));
      aiChain.set(convId, (aiChain.get(convId) || 0) + 1);
      log(`[回] ${convId} ${clean.slice(0, 40)}`);
      await sleep(400);
    }
  } catch (err) {
    log('处理失败：', err.message);
  } finally {
    running.delete(convId);
  }
}

function enqueue(convId, from, text) {
  const q = queues.get(convId) || [];
  q.push({ from, text, ctx: takeCtx(convId) });
  queues.set(convId, q);
  // 连着来好几句就攒一下
  setTimeout(() => drain(convId), 800);
}

/* --------------------------------- 主循环 -------------------------------- */

/** 本机正在监听的端口（跨平台，拿不到就返回空数组） */
function listeningPorts() {
  const found = new Set();
  try {
    if (process.platform === 'win32') {
      const txt = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 5000 });
      for (const line of txt.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const m = /^\s*TCP\s+\S*[:.](\d+)\s/mi.exec(line);
        if (m) found.add(Number(m[1]));
      }
    } else {
      const cmd = process.platform === 'darwin' ? 'lsof' : 'ss';
      const args = process.platform === 'darwin'
        ? ['-iTCP', '-sTCP:LISTEN', '-nP']
        : ['-ltn'];
      const txt = execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
      for (const line of txt.split(/\r?\n/)) {
        const m = /[:.](\d+)\s+(?:\(LISTEN\)|LISTEN|\S*\*)/.exec(line) || /:(\d+)\s/.exec(line);
        if (m) found.add(Number(m[1]));
      }
    }
  } catch {
    // 系统命令不可用就退回小范围扫描
  }
  return [...found].filter((p) => p > 0 && p < 65536);
}

/** 试一个端口：能列出会话就说明是 DSH */
async function isDsh(port) {
  DSH = `http://127.0.0.1:${port}`;
  cookieCache = { value: '', expiresAt: 0 };
  try {
    await dshRpc('session/list', { _request: {} }, 1200);
    return true;
  } catch {
    return false;
  }
}

/**
 * 自动找本机 DSH。
 * DSH 的端口是启动时随机分配的（这台机器是 62212），猜 3080 基本没用。
 * 所以先向系统要「正在监听的端口」，再逐个试，谁认得出 session/list 就是它。
 */
async function discoverDsh() {
  if (DSH_ARG) {
    log(`本机 DSH（指定）：${DSH}`);
    return;
  }

  const ports = listeningPorts();
  if (ports.length) {
    log(`本机有 ${ports.length} 个端口在监听，挨个试一下哪个是 DSH…`);
    // 分批并发，别把机器点炸
    for (let i = 0; i < ports.length; i += 8) {
      const batch = ports.slice(i, i + 8);
      const hits = await Promise.all(batch.map(async (p) => ((await isDsh(p)) ? p : 0)));
      const hit = hits.find(Boolean);
      if (hit) {
        DSH = `http://127.0.0.1:${hit}`;
        log(`找到本机 DSH：${DSH}`);
        return;
      }
    }
  }

  // 兜底：常见的几个端口
  for (const port of [3080, 3081, 3082, 62212, 8788]) {
    if (await isDsh(port)) {
      DSH = `http://127.0.0.1:${port}`;
      log(`找到本机 DSH：${DSH}`);
      return;
    }
  }

  DSH = 'http://127.0.0.1:3080';
  log('没自动找到本机 DSH。请确认 dsh web 在跑，然后用 --dsh 指定它的地址（比如 --dsh http://127.0.0.1:62212）');
}

async function main() {
  log(`连接 ${SERVER} …`);
  const me = await nestJson('/api/ai/me');
  MY_ID = me.me.id;
  MY_NAME = me.me.nickname;
  log(`我是「${me.me.nickname}」，在 ${me.conversations.length} 个会话：${me.conversations.map((c) => c.title).join('、') || '（还没被拉进群）'}`);
  for (const c of me.conversations) { titles.set(c.id, c.title); if (c.kind) convKinds.set(c.id, c.kind); }

  // 人设：页面上填的那份。改过的话，下一次开口前先重新注入一遍
  const serverPersona = me.persona || { text: '', hash: '' };
  if (!personaFromFile) personaText = String(serverPersona.text || '').trim();
  serverPersonaHash = serverPersona.hash || '';
  if (me.capabilities) CAPS = { ...CAPS, ...me.capabilities };
    if (Array.isArray(me.extensions)) EXTENSIONS = me.extensions;
  if (personaText && state.personaHash !== serverPersonaHash) {
    personaDirty = true;
    if (state.personaHash) log('人设改过了，下次发言前会重新告诉 DSH');
  } else if (!personaText) {
    state.personaHash = serverPersonaHash;
  }
  if (personaText) log(`人设：${personaText.slice(0, 40)}${personaText.length > 40 ? '…' : ''}`);

  // 找本机 DSH（--server 是群主的服务器，--dsh 才是自己电脑上的）
  await discoverDsh();

  // 给 AI 自己用的小工具准备配置（钥匙不写进提示词，只落在这个文件里）
  try {
    writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'nest-me.json'),
      JSON.stringify({ server: SERVER, key: KEY, aiId: MY_ID, nickname: MY_NAME }, null, 2));
  } catch (err) {
    log('写 nest-me.json 失败：', err.message);
  }

  // 预设换了必须重建会话：老会话是拿旧预设建的，工具集不会跟着变
  if (state.presetUsed && state.presetUsed !== AGENT_PRESET) {
    log(`预设从 ${state.presetUsed} 换成 ${AGENT_PRESET}，重建全部会话（旧会话的工具集不会更新）`);
    state.sessions = {};
    saveState();
  }
  state.presetUsed = AGENT_PRESET;
  saveState();

  // 兜底：reload 事件可能因为断线错过，每 2 分钟自己重读一次
  setInterval(() => { refreshFromServer().catch(() => {}); }, 120_000);

  // 订阅：用 fetch 自己解析 SSE，这样才能带上 Authorization 头
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${SERVER}/api/stream`, { headers: nest.headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      log('已连上消息流');

      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let ev;
            try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
            await handleEvent(ev);
          }
        }
      }
      log('消息流断了，重连中…');
    } catch (err) {
      log(`消息流出错：${err.message}，${Math.min(30, attempt * 2)} 秒后重连`);
    }
    await sleep(Math.min(30000, attempt * 2000));
  }
}

/** 从服务器重读一遍：能力、人设、会话列表 */
async function refreshFromServer() {
  try {
    const me = await nestJson('/api/ai/me');
    if (me.capabilities) CAPS = { ...CAPS, ...me.capabilities };
    if (Array.isArray(me.extensions)) EXTENSIONS = me.extensions;
    const p = me.persona || {};
    if (p.hash && p.hash !== state.personaHash) {
      serverPersonaHash = p.hash;
      personaDirty = true;
    }
    for (const c of me.conversations) { titles.set(c.id, c.title); if (c.kind) convKinds.set(c.id, c.kind); }
    saveState();
    log(`能力已更新：${JSON.stringify(CAPS)}`);
  } catch (err) {
    log('重读配置失败：', err.message);
  }
}

// 语音转写：DSH desktop profile 自带离线 SenseVoice（speech/transcribe）。
// 它只收"16kHz 单声道 PCM16 WAV"，所以必须先过一遍 ffmpeg。
const FFMPEG = arg('ffmpeg', process.env.NEST_FFMPEG || 'ffmpeg');
const voiceTextCache = new Map();   // sha -> 转写结果，避免同一条反复转

function runCmd(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').slice(0, 200)));
      else resolve(stdout);
    });
  });
}

/** 把任意 WAV 重写成规范布局：RIFF + WAVE + fmt(16) + data，不带任何附加块 */
function canonicalizeWav(file) {
  try {
    const b = readFileSync(file);
    if (b.length < 44) return;
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return;
    // 已经是规范布局就不动
    if (b.toString('ascii', 12, 16) === 'fmt ' && b.toString('ascii', 36, 40) === 'data') return;

    // 逐块扫描，抓 fmt 和 data
    let off = 12;
    let fmt = null;
    let data = null;
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4);
      const size = b.readUInt32LE(off + 4);
      const body = b.subarray(off + 8, Math.min(b.length, off + 8 + size));
      if (id === 'fmt ') fmt = body;
      if (id === 'data') { data = body; break; }
      off += 8 + size + (size % 2);
    }
    if (!fmt || !data || fmt.length < 16) return;

    const out = Buffer.alloc(44 + data.length);
    out.write('RIFF', 0, 'ascii');
    out.writeUInt32LE(36 + data.length, 4);
    out.write('WAVE', 8, 'ascii');
    out.write('fmt ', 12, 'ascii');
    out.writeUInt32LE(16, 16);
    fmt.copy(out, 20, 0, 16);
    out.write('data', 36, 'ascii');
    out.writeUInt32LE(data.length, 40);
    data.copy(out, 44);
    writeFileSync(file, out);
  } catch { /* 修不了就原样发，让 DSH 报错去 */ }
}

async function transcribeVoice(b) {
  if (voiceTextCache.has(b.sha)) return voiceTextCache.get(b.sha);
  let out = '';
  try {
    const local = await saveMedia(b, 'voice');
    if (!local) throw new Error('下载语音失败');
    const wav = local.replace(/\.[^./\\]+$/, '') + '.16k.wav';
    if (!existsSync(wav)) {
      await runCmd(FFMPEG, [
        '-y', '-i', local,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav',
        // 不加这三样，ffmpeg 会在 fmt 和 data 之间插一个 LIST 块，
        // DSH 的转写接口只收"规范布局"的 WAV，会直接拒
        '-fflags', '+bitexact', '-flags', '+bitexact', '-map_metadata', '-1',
        wav,
      ]);
      canonicalizeWav(wav);
    }
    const size = readFileSync(wav).length;
    if (size > 4 * 1024 * 1024) throw new Error('音频太大，转写限 4MB');
    const audioBase64 = readFileSync(wav).toString('base64');
    const r = await dshRpc('speech/transcribe', { request: { audioBase64, language: 'zh' } }, 120_000);
    out = String(r?.text || '').trim();
    log(`[语音] ${b.sec}s → ${out ? out.slice(0, 30) : '(空)'}`);
  } catch (err) {
    log('[语音] 转写失败：', err.message);
    out = '';
  }
  voiceTextCache.set(b.sha, out);
  return out;
}

/** 把一条消息的所有块变成 AI 能读的一段话；图片会落到本地，给出路径 */
async function describeBlocks(blocks) {
  const parts = [];
  for (const b of blocks || []) {
    if (b.t === 'text') { parts.push(b.v); continue; }
    if (b.t === 'image') {
      const url = `${SERVER}/media/${b.sha}${b.ext || '.png'}`;
      const local = await saveMedia(b, 'image');
      parts.push(local ? `[发了张图片，已存到本机 ${local}]` : `[发了张图片：${url}]`);
      continue;
    }
    if (b.t === 'file') {
      parts.push(`[发了个文件「${b.name}」：${SERVER}/media/${b.sha}${b.ext || ''}]`);
      continue;
    }
    if (b.t === 'video') {
      const local = await saveMedia(b, 'video');
      parts.push(local ? `[发了个视频，已存到本机 ${local}]` : `[发了个视频：${SERVER}/media/${b.sha}${b.ext || '.mp4'}]`);
      continue;
    }
    if (b.t === 'voice') {
      if (!b.sha) { parts.push(`[一条 ${b.sec} 秒的语音]`); continue; }
      const text = await transcribeVoice(b);
      if (text) {
        parts.push(`[发了 ${b.sec} 秒语音，本机离线转写（可能有错字）：「${text}」]`);
      } else {
        parts.push(`[发了 ${b.sec} 秒语音，但本机转写不可用——你听不见音频内容，可以直说听不见请对方打字]`);
      }
      continue;
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** 把图片下载到本地，AI 才能用文件工具打开看 */
async function saveMedia(b, kind = 'image') {
  const sub = kind === 'video' ? '.nest-videos' : kind === 'voice' ? '.nest-voices' : '.nest-images';
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), sub);
    const name = String(b.sha) + (b.ext || '.png');
    const file = join(dir, name);
    if (existsSync(file)) return file;
    const res = await fetch(`${SERVER}/media/${name}`, { headers: nest.headers });
    if (!res.ok) return '';
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch {
    return '';
  }
}

async function handleEvent(ev) {
  // 主人在页面上改了开关/人设 → 立刻重读，不用重启桥接
  if (ev.type === 'reload') { await refreshFromServer(); return; }
  if (ev.type !== 'message' || !ev.message) return;
  const m = ev.message;
  if (m.sender.id === MY_ID) return;               // 别回自己

  const convId = ev.conv || m.convId;
  if (!convId) return;

  // 启动之后才被拉进新群的话，这里一开始是不知道的。
  // 不能直接丢——刷新一次会话列表，刷新后还没有才真的不管。
  if (!titles.has(convId)) {
    await refreshConversations();
    if (!titles.has(convId)) {
      log(`[忽略] 收到 ${convId} 的消息，但它不在我的会话里`);
      return;
    }
  }

  if (state.lastSeen[convId] && m.id <= Number(state.lastSeen[convId])) return;
  state.lastSeen[convId] = m.id;
  saveState();

  const text = (await describeBlocks(m.blocks)).trim();
  if (!text) return;
  const from = m.sender.nickname;

  // 别的 AI 说话：不自动接，但记进上下文，等下次轮到我时一起带过去。
  // 例外：它 @ 了我 —— 而且 AI 之间来回不超过 3 轮。
  if (m.sender.kind === 'agent') {
    const mentioned = MY_NAME && text.includes('@' + MY_NAME);
    if (!mentioned || (aiChain.get(convId) || 0) >= 3) {
      pushCtx(convId, `${from}：${text}`);
      log(`[旁听] ${convId} ${from}：${text.slice(0, 24)}`);
      return;
    }
    log(`[被点名] ${convId} ${from}：${text.slice(0, 24)}`);
    enqueue(convId, from, text);
    return;
  }

  // 真人说话：链归零
  aiChain.set(convId, 0);

  // 主人关了「主动说话」→ 只接被 @ 的（私聊不受影响：私聊里本来就是对着它说）
  if (CAPS.proactive === false && convKinds.get(convId) !== 'dm') {
    const called = MY_NAME && text.includes('@' + MY_NAME);
    if (!called) {
      pushCtx(convId, `${from}：${text}`);
      return;
    }
  }
  enqueue(convId, from, text);
}

process.on('unhandledRejection', (err) => log('未处理的异常：', err?.message || err));

main().catch((err) => {
  console.error('启动失败：', err.message);
  process.exit(1);
});
