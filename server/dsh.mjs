// DSH 驱动：让 Nest 里的 AI 成员就是一个真正的 DSH agent 会话。
// 协议要点（对照 qq-bridge/src/dsh-client.js 实测确认）：
//   · 鉴权：读 ~/.dsh/.credentials.yaml 的 browser-session 密钥，离线 HMAC 铸 cookie，
//     不用 launch token、不落盘、进程重启也不失效。
//   · unary RPC：POST /api/<method>，信封 {type:'client-request', rpcId, method, payload:{args}}，
//     其中 args 形如 { request: <body> } 或 { _request: <body> }。
//   · 事件流：WS /api/remote.mux，先发 {type:'open', streamId, endpoint:'session/follow', ...}，
//     再收 {type:'item', streamId, value:{type:'event', event:{...}}}。
//   · 文本：assistant/message 的 data.message.content[].text；assistant/chunk 若有则更好（可流式）。
import { readFileSync, existsSync } from 'node:fs';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { load as parseYaml } from '../vendor/js-yaml.mjs';

import { all, get, run, now } from './db.mjs';

const COOKIE_TTL_MS = 60 * 60 * 1000;
const B64 = (b) => Buffer.from(b).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/* -------------------------------- 配置/鉴权 ------------------------------- */

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function dshBaseUrl(cfg = {}) {
  const raw = cfg.baseUrl
    || process.env.NEST_DSH_BASE
    || process.env.DSH_WEB_URL
    || 'http://127.0.0.1:3080';
  return String(raw).replace(/\/+$/, '');
}

/** 读持久化签名密钥；文件不在或结构变了就返回 null（此时驱动不可用，回落剧本） */
let secretCache;
function browserSecret() {
  if (secretCache !== undefined) return secretCache;
  try {
    const doc = parseYaml(readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8'));
    const rec = doc?.records?.['client-connection/browser-session'];
    if (rec?.payload?.version !== 1) return (secretCache = null);
    const secret = Buffer.from(String(rec.payload.secret).replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    secretCache = secret.byteLength === 32 ? secret : null;
  } catch {
    secretCache = null;
  }
  return secretCache;
}

let cookieCache = { value: '', expiresAt: 0, base: '' };

export function mintCookie(base) {
  const secret = browserSecret();
  if (!secret) return '';
  if (cookieCache.base === base && Date.now() < cookieCache.expiresAt - 5 * 60 * 1000) {
    return cookieCache.value;
  }
  const authority = new URL(base).host;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + COOKIE_TTL_MS;
  const body = B64(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt })));
  const sig = B64(createHmac('sha256', secret).update(body).digest());
  const name = 'dsh-auth-' + B64(createHash('sha256').update(authority).digest());
  const value = `${name}=v1.${body}.${sig}`;
  cookieCache = { value, expiresAt, base };
  return value;
}

/* --------------------------------- unary RPC ------------------------------ */

export async function rpc(base, method, args, { timeoutMs = 20000 } = {}) {
  const cookie = mintCookie(base);
  if (!cookie) throw Object.assign(new Error('读不到 DSH 签名密钥'), { code: 'NO_CREDENTIALS' });

  const endpoint = method.replace(/\./g, '/');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: endpoint,
        payload: { args },
      }),
      signal: ac.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`DSH ${endpoint} HTTP ${res.status}`), { code: 'HTTP' });
    const json = await res.json();
    if (!json?.result) throw Object.assign(new Error(`DSH ${endpoint} 响应异常`), { code: 'BAD_RESPONSE' });
    if (!json.result.ok) {
      const err = json.result.error || {};
      throw Object.assign(new Error(`DSH ${endpoint} 拒绝：${err.code || ''} ${err.message || ''}`.trim()), {
        code: 'RPC_REJECTED',
      });
    }
    return json.result.value;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- 会话绑定 -------------------------------- */

/** 一个群 / 私聊绑定一个 DSH 会话，存在库里，重启后还能接上 */
export function getBoundSession(convId, agentId) {
  const row = get(
    `SELECT dsh_session_id, last_seen_msg_id, persona_hash
       FROM agent_sessions WHERE conv_id = ? AND agent_id = ?`,
    convId, agentId
  );
  return row || null;
}

export function bindSession(convId, agentId, sessionId) {
  run(
    `INSERT INTO agent_sessions (conv_id, agent_id, dsh_session_id, last_seen_msg_id, persona_hash, created_at)
     VALUES (?,?,?,0,'',?)
     ON CONFLICT(conv_id, agent_id) DO UPDATE
       SET dsh_session_id = excluded.dsh_session_id, persona_hash = ''`,
    convId, agentId, sessionId, now()
  );
}

/** 记下人设指纹；文件改了之后下一轮会重新注入 */
export function setPersonaHash(convId, agentId, hash) {
  run(
    'UPDATE agent_sessions SET persona_hash = ? WHERE conv_id = ? AND agent_id = ?',
    String(hash || ''), convId, agentId
  );
}

export function markSeen(convId, agentId, msgId) {
  run(
    `UPDATE agent_sessions SET last_seen_msg_id = MAX(last_seen_msg_id, ?)
      WHERE conv_id = ? AND agent_id = ?`,
    Number(msgId) || 0, convId, agentId
  );
}

/**
 * 把 AI 上次开口之后、群里发生的事压成一段上下文。
 * 这是「每个群就是一个对话」的另一半：DSH 会话只收到过被 @ 的句子，
 * 别人中间聊的内容得靠这里补进去，否则它对这个群一无所知。
 */
export function pendingContext(convId, agentId, beforeMsgId) {
  const bound = getBoundSession(convId, agentId);
  const since = Number(bound?.last_seen_msg_id || 0);
  const rows = all(
    `SELECT m.id, m.body, u.nickname
       FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.conv_id = ? AND m.id > ? AND m.id < ? AND m.recalled_at = 0
        AND u.id <> ?
      ORDER BY m.id ASC LIMIT 40`,
    convId, since, Number(beforeMsgId) || 0, agentId
  );
  if (!rows.length) return '';
  const lines = rows.map((r) => {
    const text = (JSON.parse(r.body) || [])
      .filter((b) => b.t === 'text').map((b) => b.v).join(' ').trim();
    return text ? `${r.nickname}：${text}` : `${r.nickname}：发了一条非文字消息`;
  });
  return `【刚才群里还说了】\n${lines.join('\n')}\n\n`;
}

export async function createSession(base, cfg) {
  const body = {};
  if (cfg.preset) body.agentPreset = cfg.preset;
  const value = await rpc(base, 'session/create', { request: body });
  const sessionId = value?.sessionId;
  if (!sessionId) throw new Error('DSH 没有返回 sessionId');
  return sessionId;
}

/* -------------------------------- 跑一个回合 ------------------------------ */

function blocksToText(content) {
  return (content || [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * 在一个 DSH 会话里跑一次 prompt，把回复文本收回来。
 * 策略：chunk 优先（能流式），没有 chunk 就用 assistant/message 的整条文本。
 * 用 turn/start → turn/end 配对来界定「我们这一回合」，避免 follow 快照里的历史回合误触结束。
 */
export async function runTurn(base, sessionId, text, { onDelta, timeoutMs = 90000 } = {}) {
  const cookie = mintCookie(base);
  if (!cookie) throw Object.assign(new Error('读不到 DSH 签名密钥'), { code: 'NO_CREDENTIALS' });

  const url = new URL('/api/remote.mux', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const streamId = randomUUID();

  let ws;
  try {
    ws = new WebSocket(url, { headers: { cookie } });
  } catch (err) {
    throw Object.assign(new Error('WebSocket 不支持自定义头：' + err.message), { code: 'NO_WS_HEADERS' });
  }

  return await new Promise((resolve, reject) => {
    let done = false;
    let chunkText = '';
    let messageText = '';
    let ourTurn = null;
    let promptSent = false;
    let kickoff = null;   // 延迟投喂 prompt 的定时器，finish 时必须清掉

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(kickoff);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(chunkText || messageText);
    };

    const timer = setTimeout(() => {
      finish(Object.assign(new Error(`DSH 回合超时（${timeoutMs}ms）`), { code: 'TIMEOUT' }));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 5 } } },
      }));
      // 给 follow 一点建立时间，再投喂 prompt
      kickoff = setTimeout(() => {
        if (done) return;
        promptSent = true;
        rpc(base, 'session/prompt', {
          request: {
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
            requestId: randomUUID(),
          },
        }).catch((err) => finish(err));
      }, 300);
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'item' || msg.streamId !== streamId) return;
      const v = msg.value;
      if (v?.type !== 'event') return;
      const e = v.event;
      if (!e || typeof e.type !== 'string') return;

      // 快照里可能带历史回合：只在 prompt 发出后才认第一个 turn/start。
      // 事件不带 turn 字段时用 'anonymous' 占位，否则后面所有事件都会被吞掉、只能等超时。
      if (e.type === 'turn/start') {
        if (promptSent && ourTurn === null) ourTurn = e.data?.turn ?? 'anonymous';
        return;
      }
      if (ourTurn === null) return;

      if (e.type === 'assistant/chunk') {
        const piece = e.data?.text ?? e.data?.delta?.text ?? '';
        if (piece) {
          chunkText += piece;
          onDelta?.(piece);
        }
        return;
      }
      if (e.type === 'assistant/message') {
        const t = blocksToText(e.data?.message?.content);
        if (t) messageText = t;
        return;
      }
      if (e.type === 'turn/end') {
        const t = e.data?.turn;
        // 有 turn 才校验；缺字段时按「就是这一轮」处理
        if (t && ourTurn !== 'anonymous' && t !== ourTurn) return;
        const err = e.data?.reason && e.data.reason !== 'completed' ? e.data.reason : null;
        if (!chunkText && !messageText) {
          finish(Object.assign(new Error(`DSH 回合结束但没有文本（${err || 'unknown'}）`), { code: 'EMPTY' }));
          return;
        }
        finish(null);
      }
    });

    ws.addEventListener('error', () => {
      finish(Object.assign(new Error('DSH 事件流连接失败'), { code: 'WS_ERROR' }));
    });
    ws.addEventListener('close', () => {
      if (!done) {
        if (chunkText || messageText) finish(null);
        else finish(Object.assign(new Error('DSH 事件流提前关闭'), { code: 'WS_CLOSED' }));
      }
    });
  });
}

/* --------------------------------- 对外门面 ------------------------------- */

/** 探活：能列出会话就说明驱动可用 */
export async function dshAlive(base) {
  try {
    await rpc(base, 'session/list', { _request: {} }, { timeoutMs: 4000 });
    return true;
  } catch {
    return false;
  }
}

export { existsSync };
