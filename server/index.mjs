// 服务端：node:http + SSE + node:sqlite，零第三方依赖。
// 传输选择：SSE（GET /api/stream）负责服务端 → 客户端推送，POST 负责上行。
// EventSource 自带重连，省掉 WebSocket 那套握手/心跳/重连代码，够 50 人的圈子用。
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { writeFile, stat, readFile } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';

import {
  DATA_DIR,
  all, get, run, tx, now, addMessage, getMessage, listMessages, isMember,
  conversationMembers, preview, publicUser, saveAttachment, hideMessage, capsOf, DEFAULT_CAPS,
  visibleMaxSeq, ROOT, MEDIA_DIR,
} from './db.mjs';
import {
  hashPassword, verifyPassword, newToken, parseCookies, sessionCookie, isSecureReq,
  newAiKey, aiKeyHash, newInvite,
} from './auth.mjs';
import { maybeReply } from './agent.mjs';
import { dshBaseUrl, rpc as dshRpc } from './dsh.mjs';
import { handleAdmin } from './admin.mjs';
import { loadAiConfig, describeAi } from './ai.mjs';

const PORT = Number(process.env.NEST_PORT || 8787);
// 默认监听所有网卡：同学在同一个局域网里要用 192.168.x.x:8787 连进来。
// 只绑 127.0.0.1 的话，别的机器根本连不上（踩过）。
// 想只给自己用就设 NEST_HOST=127.0.0.1。
const HOST = process.env.NEST_HOST || '0.0.0.0';
const PUBLIC_DIR = join(ROOT, 'public');

// 注册模式：open = 谁都能注册（局域网自用）；invite = 必须邀请码（公网暴露时必须）
// 设了 NEST_PUBLIC=1 就默认转成 invite，避免把注册口直接开到公网上。
const REGISTER_MODE = process.env.NEST_REGISTER || (process.env.NEST_PUBLIC === '1' ? 'invite' : 'open');
// 隧道进程把公网地址写在这里，界面和 server-info 从这读
const TUNNEL_FILE = join(DATA_DIR, '_tunnel.json');

/** 读隧道地址（没有就返回空） */
function readTunnel() {
  try {
    if (!existsSync(TUNNEL_FILE)) return null;
    const j = JSON.parse(readFileSync(TUNNEL_FILE, 'utf8'));
    if (!j || !j.url) return null;
    // 隧道进程死了但文件还在：超过 10 分钟没更新就当过期
    if (j.updatedAt && Date.now() - Number(j.updatedAt) > 10 * 60_000) return null;
    return j;
  } catch { return null; }
}

/** 反向隧道/反代后面的真实客户端 IP */
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// 按 IP 的简单限流：防有人在公网上刷登录/注册
const ipHits = new Map();
function ipLimited(req, bucket, max = 30, windowMs = 10 * 60_000) {
  const key = bucket + ':' + clientIp(req);
  const nowTs = Date.now();
  const rec = ipHits.get(key);
  if (!rec || nowTs - rec.start > windowMs) {
    ipHits.set(key, { start: nowTs, n: 1 });
    if (ipHits.size > 5000) {   // 别让这个表无限长
      for (const [k, v] of ipHits) if (nowTs - v.start > windowMs) ipHits.delete(k);
    }
    return false;
  }
  rec.n += 1;
  return rec.n > max;
}

/** 当前请求该不该给 cookie 加 Secure */
const cookieOpts = (req, extra = {}) => ({ ...extra, secure: isSecureReq(req) });


/* ---------------------------------- 基础 ---------------------------------- */

function json(res, code, data, headers = {}) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 1 << 20) {
  const raw = await readRaw(req, limit);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('bad json'), { code: 400 });
  }
}

/** 从 Authorization: Bearer 里取 AI 钥匙 */
function aiKeyFromReq(req) {
  const m = /^Bearer\s+(NEST-AI-[a-z0-9]+)\s*$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : '';
}

function currentUser(req) {
  // AI 成员走钥匙，不走 cookie：钥匙无效就直接拒绝，不回落成匿名
  const key = aiKeyFromReq(req);
  if (key) {
    const row = get(
      `SELECT k.id AS key_id, u.* FROM ai_keys k JOIN users u ON u.id = k.user_id
        WHERE k.key_hash = ? AND k.revoked = 0`,
      aiKeyHash(key)
    );
    if (!row) return null;
    run('UPDATE ai_keys SET last_used_at = ? WHERE id = ?', now(), row.key_id);
    return row;
  }

  const token = parseCookies(req.headers.cookie || '').sid;
  if (!token) return null;
  const row = get(
    `SELECT s.token, s.last_seen AS session_last_seen, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    token
  );
  if (!row) return null;
  // 30 天没动过就让会话失效（token 泄露后不会永久有效）
  if (now() - Number(row.session_last_seen || 0) > 30 * 86400_000) {
    run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  run('UPDATE sessions SET last_seen = ? WHERE token = ?', now(), token);
  return row;
}

function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw Object.assign(new Error('未登录'), { code: 401 });
  return u;
}

/* -------------------------------- SSE 总线 -------------------------------- */

const streams = new Map(); // userId -> Set<res>

function send(res, event) {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {}
}

function toUser(userId, event) {
  const set = streams.get(Number(userId));
  if (!set) return;
  for (const res of set) send(res, event);
}

function toConv(convId, event) {
  for (const m of all('SELECT user_id FROM members WHERE conv_id = ?', convId)) {
    toUser(m.user_id, event);
  }
}

function toAll(event) {
  for (const set of streams.values()) for (const res of set) send(res, event);
}

function setStatus(userId, status) {
  const row = get('SELECT status FROM users WHERE id = ?', userId);
  if (!row || row.status === status) return;
  run('UPDATE users SET status = ? WHERE id = ?', status, userId);
  toAll({ type: 'presence', userId: Number(userId), status });
}

function openStream(userId, res, req) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // 长连接：自己不设超时，否则 Node 默认的 requestTimeout(300s) 会把它掐掉，
  // 桥接就得每 5 分钟重连一次，断的那几秒里发的消息它会漏掉。
  res.setTimeout(0);
  req?.setTimeout?.(0);
  res.socket?.setTimeout?.(0);
  res.socket?.setKeepAlive?.(true, 30_000);

  res.write(': connected\n\n');
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);
  setStatus(userId, 'online');

  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {}
  }, 25_000);

  const close = () => {
    clearInterval(hb);
    const set = streams.get(userId);
    if (!set) return;
    set.delete(res);
    if (!set.size) {
      streams.delete(userId);
      setStatus(userId, 'offline');
    }
  };
  res.on('close', close);
  res.on('error', close);
}

/* -------------------------------- 会话视图 -------------------------------- */

/** 每个用户看到的「最后一条」可能不同：被自己删掉的不算 */
function lastMessageOf(convId, viewer = 0) {
  const hideSql = viewer
    ? ' AND m.id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id = ?)'
    : '';
  const row = get(
    `SELECT m.*, u.handle, u.nickname, u.avatar, u.kind
       FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.conv_id = ?${hideSql}
      ORDER BY m.id DESC LIMIT 1`,
    convId, ...(viewer ? [viewer] : [])
  );
  if (!row) return null;
  const blocks = JSON.parse(row.body);
  return {
    id: row.id,
    seq: row.seq,
    nickname: row.nickname,
    senderId: row.sender_id,
    createdAt: row.created_at,
    recalledAt: row.recalled_at,
    text: preview({ blocks, recalledAt: row.recalled_at }),
    kind: blocks[0]?.t || 'text',
  };
}

/* ------------------------- 记忆：读 nmem 的大脑导出 ------------------------- */

let brainCache = { at: 0, data: null };

/** 汇总这台电脑上 AI 的记忆规模（多个 AI 共用一份，见 docs/DECISIONS.md） */
function readBrainStats() {
  const file = join(homedir(), '.dsh', 'nmem', 'brain-export.json');
  try {
    const st = statSync(file);
    if (brainCache.data && brainCache.at === st.mtimeMs) return brainCache.data;

    const j = JSON.parse(readFileSync(file, 'utf8'));
    const neurons = j.neurons || [];
    const synapses = j.synapses || [];
    const fibers = j.fibers || [];

    // 情绪分布：神经元 metadata 里的 emotion_category
    const emo = {};
    for (const n of neurons) {
      const e = n.metadata?.emotion_category;
      if (e) emo[e] = (emo[e] || 0) + 1;
    }
    // 最近记住的东西（按 timestamp 倒序）
    const recent = neurons
      .filter((n) => n.metadata?.timestamp && n.content)
      .sort((a, b) => String(b.metadata.timestamp).localeCompare(String(a.metadata.timestamp)))
      .slice(0, 8)
      .map((n) => ({ text: String(n.content).slice(0, 80), type: n.type, at: n.metadata.timestamp }));

    brainCache = {
      at: st.mtimeMs,
      data: {
        neurons: neurons.length,
        synapses: synapses.length,
        fibers: fibers.length,
        emotions: Object.entries(emo).sort((a, b) => b[1] - a[1]).slice(0, 6),
        recent,
        exportedAt: j.exported_at || '',
        hasStarmap: existsSync(join(homedir(), '.dsh', 'nmem', 'starmap.html')),
      },
    };
    return brainCache.data;
  } catch {
    return { neurons: 0, synapses: 0, fibers: 0, emotions: [], recent: [], exportedAt: '', hasStarmap: false, missing: true };
  }
}

function buildConversations(userId) {  const rows = all(
    `SELECT c.*, m.pinned, m.muted, m.last_read_seq, m.role
       FROM members m JOIN conversations c ON c.id = m.conv_id
      WHERE m.user_id = ?`,
    userId
  );

  const list = rows.map((c) => {
    const members = conversationMembers(c.id);
    const last = lastMessageOf(c.id, userId);
    // 未读必须按「看得见的最后一条」算：被自己删掉的那条不该算进未读，
    // 否则角标清不掉（删掉的正好是最新一条时，MAX(seq) 永远追不上）。
    const maxSeq = visibleMaxSeq(c.id, userId);
    const lastRead = Math.min(Number(c.last_read_seq), maxSeq);
    const other = c.kind === 'dm' ? members.find((u) => u.id !== userId) : null;
    return {
      id: c.id,
      kind: c.kind,
      title: c.kind === 'dm' ? other?.nickname || '私聊' : c.title,
      avatar: c.kind === 'dm' ? other?.avatar || '' : c.avatar,
      announcement: c.announcement || '',
      pinned: !!c.pinned,
      muted: !!c.muted,
      role: c.role,
      unread: Math.max(0, maxSeq - lastRead),
      lastSeq: maxSeq,
      lastReadSeq: lastRead,
      lastMessage: last,
      members,
      _otherKind: other?.kind || '',
      _hasPeer: !!other,
    };
  })
    // 产品定位：只做人和 AI。真人之间的私聊不显示在列表里（旧数据也不显示）。
    // 对方已经不存在的私聊（删号留下的残骸）也不显示。
    .filter((c) => !(c.kind === 'dm' && (!c._hasPeer || c._otherKind === 'human')))
    .map(({ _otherKind, _hasPeer, ...c }) => c);

  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0);
  });
  return list;
}

/* --------------------------------- AI 成员 -------------------------------- */

async function triggerAgent(convId, message) {
  // 只替「系统内置」的 AI（owner_id = 0）回话。
  // 用户自己的 AI 由他自己的桥接回；服务端抢答会套上内置人格，说的根本不是它。
  const agent = get(
    `SELECT u.* FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.conv_id = ? AND u.kind = 'agent' AND u.owner_id = 0 LIMIT 1`,
    convId
  );
  if (!agent) return;
  const conv = get('SELECT * FROM conversations WHERE id = ?', convId);

  await maybeReply({
    conv, convId, agent: publicUser(agent), message,
    hooks: {
      onStart: (tempId, sender) =>
        toConv(convId, { type: 'message.start', conv: convId, tempId, sender }),
      onDelta: (tempId, text) =>
        toConv(convId, { type: 'message.delta', conv: convId, tempId, text }),
      onDone: (tempId, blocks) => {
        const saved = addMessage(convId, agent.id, blocks);
        toConv(convId, {
          type: 'message',
          conv: convId,
          message: saved,
          replaceTemp: tempId,
        });
      },
      // AI 这一轮选择潜水：把空气泡收掉，什么都不发
      onCancel: (tempId) =>
        toConv(convId, { type: 'message.cancel', conv: convId, tempId }),
    },
  });
}

// 用户连着发好几条时别一条一条地回：等他停手 1.5 秒，只回一次。
// 关键：同一会话同时只允许跑一个回合。DSH 回合可能跑几十秒，
// 期间再来消息只记「有新消息」，等这一轮结束再串一轮（中间的话由 pendingContext 带上）。
const agentTimers = new Map();
const agentBusy = new Set();
const pokeCooldown = new Map();   // 「谁在哪个会话刚拍过」→ 时间戳
const agentDirty = new Set();

function scheduleAgent(convId, message) {
  clearTimeout(agentTimers.get(convId));
  if (agentBusy.has(convId)) {
    agentDirty.add(convId);
    return;
  }
  const timer = setTimeout(() => runAgent(convId, message), 1500);
  agentTimers.set(convId, timer);
}

async function runAgent(convId, message) {
  agentTimers.delete(convId);
  if (agentBusy.has(convId)) {
    agentDirty.add(convId);
    return;
  }
  agentBusy.add(convId);
  try {
    await triggerAgent(convId, message);
  } catch (err) {
    console.error('[agent]', err);
  } finally {
    agentBusy.delete(convId);
    if (agentDirty.delete(convId)) {
      const last = get('SELECT id FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1', convId);
      const fresh = last ? getMessage(Number(last.id)) : null;
      if (fresh) scheduleAgent(convId, fresh);
    }
  }
}

/* --------------------------------- 资源 ---------------------------------- */

const EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

/**
 * 送文件。ReadStream 必须挂 error：没监听时一个 ENOENT/EMFILE 会变成
 * 未捕获异常，整个聊天服务直接退出（所有 SSE 一起断）。
 */
function pipeFile(res, target) {
  const stream = createReadStream(target);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {}
  });
  stream.pipe(res);
}

/** 下载桥接程序（不走 /api/，所以放在分发层） */
async function serveBridge(res) {
  const file = join(ROOT, 'bridge', 'nest-bridge.mjs');
  try {
    await stat(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('服务器上没有 bridge/nest-bridge.mjs');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-disposition': 'attachment; filename="nest-bridge.mjs"',
    'cache-control': 'no-cache',
  });
  pipeFile(res, file);
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR + sep)) {
    return json(res, 403, { error: 'forbidden' });
  }
  try {
    const st = await stat(target);
    if (!st.isFile()) throw new Error('not a file');

    // index.html 里给 js/css 带上文件修改时间做版本号。
    // 手机浏览器缓存很顽固，改完前端不刷新就是旧样子；带版本号后
    // 文件一变 URL 就变，浏览器自然去拿新的，不用用户清缓存。
    if (rel === 'index.html') {
      let html = await readFile(target, 'utf8');
      for (const asset of ['app.js', 'style.css']) {
        try {
          const ast = await stat(join(PUBLIC_DIR, asset));
          const v = Math.trunc(ast.mtimeMs).toString(36);
          html = html.replace(new RegExp(`/${asset.replace('.', '\\.')}(\\?[^"']*)?`, 'g'), `/${asset}?v=${v}`);
        } catch { /* 文件不在就算了 */ }
      }
      const buf = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': buf.length,
        'cache-control': 'no-cache',
        etag: `"${st.mtimeMs.toString(36)}"`,
      });
      return res.end(buf);
    }

    res.writeHead(200, {
      'content-type': EXT_MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
      'last-modified': new Date(st.mtimeMs).toUTCString(),
      etag: `"${st.mtimeMs.toString(36)}"`,
    });
    pipeFile(res, target);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

async function serveMedia(req, res, name) {
  if (!/^[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(name)) {
    return json(res, 404, { error: 'not found' });
  }
  const target = join(MEDIA_DIR, name);

  // 按"上传时记下的真实 mime"下发。光看扩展名会出事：
  // Safari 录的语音是 mp4 容器，扩展名 .mp4 但其实是 audio/mp4，
  // 当成 video/mp4 发出去它就不肯播。
  const sha = name.slice(0, 64);
  const rec = get('SELECT mime FROM attachments WHERE sha = ?', sha);
  const mime = rec?.mime || EXT_MIME[extname(name).toLowerCase()] || 'application/octet-stream';

  try {
    const st = await stat(target);
    // Range：iOS 的 AVPlayer 会先问一段，不支持就整段不给播
    const range = String(req.headers.range || '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : st.size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'content-type': mime,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=31536000, immutable',
      });
      createReadStream(target, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'content-type': mime,
      'content-length': st.size,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    pipeFile(res, target);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

/* ------------------------------ 密保题库 / 限流 --------------------------- */

const SECURITY_QUESTIONS = {
  birthday: '你的生日是几月几号？（例如 0512）',
  primary: '你读的小学叫什么？',
  pet: '你第一只宠物叫什么名字？',
  city: '你在哪个城市出生？',
  food: '你最爱吃的一道菜是什么？',
  teacher: '给你印象最深的老师姓什么？',
  street: '你小时候住的街道叫什么？',
  film: '你最喜欢的电影是哪一部？',
};

/** 答案归一：去空格、转小写，避免「实验小学 」和「实验小学」对不上 */
const normalizeAnswer = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');

// 找回密码的失败限流：同一个手机号 30 分钟内错 5 次就锁
const recoverFails = new Map();

function isLocked(phone) {
  const rec = recoverFails.get(phone);
  return !!(rec && rec.until > Date.now());
}

function noteFail(phone) {
  const rec = recoverFails.get(phone) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) {
    rec.until = Date.now() + 30 * 60_000;
    rec.count = 0;
  }
  recoverFails.set(phone, rec);
}

function clearFails(phone) {
  recoverFails.delete(phone);
}

/* --------------------------------- 路由 ---------------------------------- */

// 消息块白名单校验：前端用 innerHTML 拼这些字段，服务端不校验就等于
// 让任何成员往别人浏览器里塞 HTML/JS（sha 里一个引号就能越出属性）。
const HEX64 = /^[0-9a-f]{64}$/;
const IMG_EXT = /^\.(png|jpg|jpeg|gif|webp)$/i;

/** 按文件头判断真实类型；认不出来返回 '' */
function sniffExt(buf) {
  const ascii = (from, to) => buf.toString('ascii', from, to);
  if (buf.length >= 8 && buf[0] === 0x89 && ascii(1, 4) === 'PNG') return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return '.gif';
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  if (buf.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand.startsWith('qt')) return '.mov';
    return '.mp4';
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return '.webm';
  if (buf.length >= 4 && ascii(0, 4) === 'OggS') return '.ogg';
  if (buf.length >= 3 && ascii(0, 3) === 'ID3') return '.mp3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return '.mp3';
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return '.wav';
  if (buf.length >= 5 && ascii(0, 4) === '%PDF') return '.pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return '.zip';
  return '';
}

function sanitizeBlocks(input) {
  const out = [];
  for (const b of input || []) {
    if (!b || typeof b.t !== 'string') continue;

    if (b.t === 'text') {
      const v = typeof b.v === 'string' ? b.v : '';
      if (v.trim()) out.push({ t: 'text', v: v.slice(0, 4000) });
      continue;
    }
    if (b.t === 'image' && HEX64.test(String(b.sha || ''))) {
      const w = Math.trunc(Number(b.w)) || 0;
      const h = Math.trunc(Number(b.h)) || 0;
      out.push({
        t: 'image',
        sha: String(b.sha),
        ext: IMG_EXT.test(String(b.ext || '')) ? String(b.ext).toLowerCase() : '.png',
        w: w > 0 && w < 20000 ? w : 0,
        h: h > 0 && h < 20000 ? h : 0,
      });
      continue;
    }
    if (b.t === 'poke') {
      const to = Math.trunc(Number(b.to)) || 0;
      if (to > 0) out.push({ t: 'poke', to });
      continue;
    }
    if (b.t === 'video' && HEX64.test(String(b.sha || ''))) {
      const w = Math.trunc(Number(b.w)) || 0;
      const h = Math.trunc(Number(b.h)) || 0;
      const dur = Math.min(600, Math.max(0, Math.trunc(Number(b.dur)) || 0));
      out.push({
        t: 'video',
        sha: String(b.sha),
        ext: ['.mp4', '.mov', '.webm'].includes(String(b.ext || '').toLowerCase()) ? String(b.ext).toLowerCase() : '.mp4',
        w: w > 0 && w < 20000 ? w : 0,
        h: h > 0 && h < 20000 ? h : 0,
        dur,
      });
      continue;
    }
    if (b.t === 'voice') {
      const sec = Math.min(60, Math.max(1, Math.trunc(Number(b.sec)) || 1));
      // 老格式（没文件的占位）继续兼容；有 sha 就是真语音
      if (HEX64.test(String(b.sha || ''))) {
        const ext = ['.webm', '.ogg', '.mp3', '.wav', '.mp4', '.m4a'].includes(String(b.ext || '').toLowerCase())
          ? String(b.ext).toLowerCase()
          : '.webm';
        // 固定 48 格：不足补 0，多了截掉，防脏数据
        const rawPeaks = Array.isArray(b.peaks)
          ? b.peaks.slice(0, 48).map((v) => Math.min(100, Math.max(0, Math.trunc(Number(v)) || 0)))
          : [];
        const peaks = rawPeaks.length === 48
          ? rawPeaks
          : [...rawPeaks, ...new Array(48 - rawPeaks.length).fill(0)];
        out.push({ t: 'voice', sec, sha: String(b.sha), ext, peaks });
      } else {
        out.push({ t: 'voice', sec });
      }
      continue;
    }
    if (b.t === 'file' && HEX64.test(String(b.sha || ''))) {
      out.push({
        t: 'file',
        sha: String(b.sha),
        ext: String(b.ext || '').slice(0, 8),
        name: String(b.name || '文件').slice(0, 120),
        size: Math.max(0, Math.trunc(Number(b.size)) || 0),
      });
      continue;
    }
    if (b.t === 'forward') {
      out.push({
        t: 'forward',
        from: String(b.from || '').slice(0, 40),
        text: String(b.text || '').slice(0, 500),
      });
    }
  }
  return out;
}

async function api(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  /* ---- 登录 / 注册 ---- */
  if (method === 'POST' && p === '/api/login') {
    if (ipLimited(req, 'login', 40)) return json(res, 429, { error: '登录太频繁了，等一会儿再试' });
    const body = await readJson(req);
    const account = String(body.account || body.handle || '').trim();
    const pw = String(body.password || '');
    if (!account) return json(res, 400, { error: '请输入手机号' });

    // 手机号优先；老演示账号（azhe 之类）继续用账号名登录
    const user = get('SELECT * FROM users WHERE phone = ?', account)
      || get('SELECT * FROM users WHERE handle = ?', account);

    if (!user || user.kind === 'agent' || !verifyPassword(pw, user.pw_hash)) {
      return json(res, 401, { error: '手机号或密码不对' });
    }
    const token = newToken();
    run('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?,?,?,?)',
      token, user.id, now(), now());
    return json(res, 200, { me: publicUser(user) }, { 'set-cookie': sessionCookie(token, cookieOpts(req)) });
  }

  /* 密保题库（公开，注册时下拉用） */
  if (method === 'GET' && p === '/api/questions') {
    return json(res, 200, {
      questions: Object.entries(SECURITY_QUESTIONS).map(([code, text]) => ({ code, text })),
    });
  }

  if (method === 'POST' && p === '/api/register') {
    if (ipLimited(req, 'register', 10)) {
      return json(res, 429, { error: '注册太频繁了，等一会儿再试' });
    }
    const body = await readJson(req);

    // 公网模式下必须凭邀请码注册（邀请码在管理台 /admin 生成）
    if (REGISTER_MODE === 'invite') {
      const code = String(body.invite || '').trim().toUpperCase();
      if (!code) return json(res, 403, { error: '这个服务器需要邀请码才能注册', code: 'need_invite' });
      const inv = get('SELECT * FROM invites WHERE code = ?', code);
      if (!inv) return json(res, 403, { error: '邀请码不对', code: 'bad_invite' });
      if (inv.used_by) return json(res, 403, { error: '这个邀请码已经被用过了', code: 'used_invite' });
    }
    const regInvite = REGISTER_MODE === 'invite' ? String(body.invite || '').trim().toUpperCase() : '';
    const phone = String(body.phone || '').trim();
    const nickname = String(body.nickname || '').trim().slice(0, 16);
    const password = String(body.password || '');
    const q1 = String(body.q1 || '');
    const q2 = String(body.q2 || '');
    const a1 = normalizeAnswer(body.a1);
    const a2 = normalizeAnswer(body.a2);

    if (!/^1[3-9]\d{9}$/.test(phone)) return json(res, 400, { error: '手机号格式不对' });
    if (!nickname) return json(res, 400, { error: '请填昵称' });
    if (password.length < 6) return json(res, 400, { error: '密码至少 6 位' });
    if (!SECURITY_QUESTIONS[q1] || !SECURITY_QUESTIONS[q2] || q1 === q2) {
      return json(res, 400, { error: '请选两个不同的密保问题' });
    }
    if (!a1 || !a2) return json(res, 400, { error: '密保答案不能为空' });
    if (get('SELECT 1 AS x FROM users WHERE phone = ?', phone)) {
      return json(res, 409, { error: '这个手机号已经注册过了' });
    }

    const handle = 'u_' + randomBytes(4).toString('hex');
    const info = run(
      `INSERT INTO users (handle, nickname, phone, pw_hash, sec_q1, sec_a1, sec_q2, sec_a2, status, kind, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      handle, nickname, phone, hashPassword(password),
      q1, hashPassword(a1), q2, hashPassword(a2), 'online', 'human', now()
    );
    const userId = Number(info.lastInsertRowid);
    if (regInvite) {
      run('UPDATE invites SET used_by = ? WHERE code = ?', userId, regInvite);
    }
    const token = newToken();
    run('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?,?,?,?)',
      token, userId, now(), now());
    return json(res, 200, { me: publicUser(get('SELECT * FROM users WHERE id = ?', userId)) },
      { 'set-cookie': sessionCookie(token, cookieOpts(req)) });
  }

  /* 找回密码第一步：给手机号，换回两个问题 */
  if (method === 'POST' && p === '/api/recover/questions') {
    if (ipLimited(req, 'recover', 20)) return json(res, 429, { error: '试太多次了，等一会儿再试' });
    const body = await readJson(req);
    const phone = String(body.phone || '').trim();
    if (isLocked(phone)) return json(res, 429, { error: '试太多次了，等 30 分钟再试' });

    const user = get('SELECT * FROM users WHERE phone = ?', phone);
    // 不区分「没注册」和「没设密保」，避免被用来探测手机号
    if (!user || !user.sec_q1) return json(res, 404, { error: '这个手机号没设置密保问题' });
    return json(res, 200, {
      q1: SECURITY_QUESTIONS[user.sec_q1] || user.sec_q1,
      q2: SECURITY_QUESTIONS[user.sec_q2] || user.sec_q2,
    });
  }

  /* 找回密码第二步：答对两个问题就能改密码 */
  if (method === 'POST' && p === '/api/recover/reset') {
    const body = await readJson(req);
    const phone = String(body.phone || '').trim();
    const newpw = String(body.password || '');
    if (isLocked(phone)) return json(res, 429, { error: '试太多次了，等 30 分钟再试' });
    if (newpw.length < 6) return json(res, 400, { error: '新密码至少 6 位' });

    const user = get('SELECT * FROM users WHERE phone = ?', phone);
    const ok = user && user.sec_q1
      && verifyPassword(normalizeAnswer(body.a1), user.sec_a1)
      && verifyPassword(normalizeAnswer(body.a2), user.sec_a2);
    if (!ok) {
      noteFail(phone);
      return json(res, 400, { error: '密保答案不对' });
    }

    run('UPDATE users SET pw_hash = ? WHERE id = ?', hashPassword(newpw), user.id);
    run('DELETE FROM sessions WHERE user_id = ?', user.id);   // 改密码后所有设备重新登录
    clearFails(phone);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/logout') {
    const token = parseCookies(req.headers.cookie || '').sid;
    if (token) run('DELETE FROM sessions WHERE token = ?', token);
    return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', { clear: true, secure: isSecureReq(req) }) });
  }

  /* ---- 引导数据 ---- */
  if (method === 'GET' && p === '/api/bootstrap') {
    const user = requireUser(req);
    return json(res, 200, {
      me: publicUser(user),
      conversations: buildConversations(user.id),
      agents: all(`SELECT * FROM users WHERE kind = 'agent'`).map(publicUser),
    });
  }

  /* ---- 历史消息 ---- */
  if (method === 'GET' && p === '/api/messages') {
    const user = requireUser(req);
    const convId = Number(url.searchParams.get('conv'));
    if (!isMember(convId, user.id)) return json(res, 403, { error: '不在该会话' });
    const before = Number(url.searchParams.get('before') || 0);
    const limit = Math.min(80, Math.max(1, Number(url.searchParams.get('limit') || 40)));
    const messages = listMessages(convId, { before, limit, viewer: user.id });
    return json(res, 200, {
      messages,
      hasMore: messages.length === limit && messages[0]?.id > 1,
    });
  }

  /* ---- 拍一拍（双击头像）---- */
  if (method === 'POST' && p === '/api/poke') {
    const user = requireUser(req);
    if (user.kind === 'agent') return json(res, 403, { error: 'AI 不能拍人' });
    const body = await readJson(req);
    const convId = Number(body.conv);
    const targetId = Number(body.userId);
    if (!isMember(convId, user.id)) return json(res, 403, { error: '不在该会话' });
    if (!isMember(convId, targetId)) return json(res, 400, { error: '这个人不在这个会话里' });
    if (targetId === user.id) return json(res, 400, { error: '不能拍自己' });

    // 别刷屏：同一个人 3 秒内只能拍一次
    const key = user.id + ':' + convId;
    const last = pokeCooldown.get(key) || 0;
    if (Date.now() - last < 3000) return json(res, 429, { error: '拍太快了' });
    pokeCooldown.set(key, Date.now());

    const target = get('SELECT nickname FROM users WHERE id = ?', targetId);
    const saved = addMessage(convId, user.id, [
      { t: 'poke', to: targetId, by: user.id, name: target?.nickname || '对方' },
    ]);
    toConv(convId, { type: 'message', conv: convId, message: saved });
    return json(res, 200, { ok: true, message: saved });
  }

  /* ---- 会话内搜索（只搜自己看得见的会话）---- */
  if (method === 'GET' && p === '/api/search') {
    const user = requireUser(req);
    const convParam = url.searchParams.get('conv');
    const convId = convParam ? Number(convParam) : 0;
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
    if (!q) return json(res, 400, { error: '搜什么？' });

    // 不带 conv = 全局搜（在"我参与的所有会话"里找），QQ NT 那种
    if (!convParam) {
      const globalLimit = Math.min(80, Math.max(1, Number(url.searchParams.get('limit') || 40)));
      const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      const blind = new Set(all('SELECT message_id FROM hidden_messages WHERE user_id = ?', user.id).map((r) => Number(r.message_id)));
      const myConvs = all('SELECT conv_id FROM members WHERE user_id = ?', user.id).map((r) => Number(r.conv_id));
      if (!myConvs.length) return json(res, 200, { hits: [], q, scope: 'global' });

      const rows = all(
        `SELECT id, conv_id, seq, sender_id, body, created_at FROM messages
          WHERE conv_id IN (${myConvs.join(',')}) AND COALESCE(recalled_at, 0) = 0 AND body LIKE ?
          ORDER BY created_at DESC LIMIT ?`,
        like, globalLimit * 6
      );

      // 一次算出所有会话的展示信息（标题/类型/头像），按 id 查
      const convCache = new Map(buildConversations(user.id).map((c) => [Number(c.id), c]));
      const hits = [];
      for (const r of rows) {
        if (blind.has(Number(r.id))) continue;
        let blocks = [];
        try { blocks = JSON.parse(r.body); } catch { continue; }
        const text = (blocks || []).filter((b) => b?.t === 'text').map((b) => b.v).join(' ');
        if (!text.toLowerCase().includes(q.toLowerCase())) continue;

        const conv = convCache.get(Number(r.conv_id)) || { id: Number(r.conv_id), title: '会话', kind: 'group' };
        const at = text.toLowerCase().indexOf(q.toLowerCase());
        const snippet = text.slice(Math.max(0, at - 24), at + q.length + 40).replace(/\s+/g, ' ').trim();
        hits.push({
          id: Number(r.id),
          conv: { id: conv.id, title: conv.title, kind: conv.kind, avatar: conv.avatar || '' },
          at: Number(r.created_at),
          sender: publicUser(get('SELECT * FROM users WHERE id = ?', r.sender_id) || {}),
          snippet,
        });
        if (hits.length >= globalLimit) break;
      }
      return json(res, 200, { hits, q, scope: 'global' });
    }

    if (!isMember(convId, user.id)) return json(res, 403, { error: '不在该会话' });
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 30)));

    // 消息体是 JSON，先用 LIKE 粗筛，再在内存里精确判断是哪一段文字命中
    const rows = all(
      `SELECT id, seq, sender_id, body, created_at FROM messages
        WHERE conv_id = ? AND COALESCE(recalled_at, 0) = 0 AND body LIKE ?
        ORDER BY seq DESC LIMIT ?`,
      convId, `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`, limit * 3
    );
    const blind = new Set(all('SELECT message_id FROM hidden_messages WHERE user_id = ?', user.id).map((r) => Number(r.message_id)));

    const hits = [];
    for (const r of rows) {
      if (blind.has(Number(r.id))) continue;
      let blocks = [];
      try { blocks = JSON.parse(r.body); } catch { continue; }
      const text = (blocks || []).filter((b) => b?.t === 'text').map((b) => b.v).join(' ');
      if (!text.toLowerCase().includes(q.toLowerCase())) continue;
      const at = text.toLowerCase().indexOf(q.toLowerCase());
      const snippet = text.slice(Math.max(0, at - 24), at + q.length + 40).replace(/\s+/g, ' ').trim();
      hits.push({
        id: Number(r.id),
        seq: Number(r.seq),
        at: Number(r.created_at),
        sender: publicUser(get('SELECT * FROM users WHERE id = ?', r.sender_id) || {}),
        snippet,
      });
      if (hits.length >= limit) break;
    }
    return json(res, 200, { hits, q });
  }

  /* ---- 发消息 ---- */
  if (method === 'POST' && p === '/api/message') {
    const user = requireUser(req);
    const body = await readJson(req);
    const convId = Number(body.conv);
    if (!isMember(convId, user.id)) return json(res, 403, { error: '不在该会话' });

    const member = get('SELECT * FROM members WHERE conv_id = ? AND user_id = ?', convId, user.id);
    if (Number(member.muted_until) > now()) return json(res, 403, { error: '你已被禁言' });

    const blocks = sanitizeBlocks(body.blocks).map((b) => {
      if (b.t !== 'poke') return b;
      const t = get('SELECT nickname FROM users WHERE id = ?', b.to);
      return { ...b, by: user.id, name: t?.nickname || '对方' };
    });
    if (!blocks.length) return json(res, 400, { error: '空消息' });

    // 禁言：到期前不许发言
    const muteRow = get('SELECT mute_until FROM members WHERE conv_id = ? AND user_id = ?', convId, user.id);
    if (muteRow && Number(muteRow.mute_until) > now()) {
      const left = Math.ceil((Number(muteRow.mute_until) - now()) / 60000);
      return json(res, 403, { error: `你被禁言了，还有 ${left} 分钟` });
    }

    const clientId = String(body.clientId || '').slice(0, 64);

    // 幂等：双击发送 / 网络重试用同一个 clientId，只落一条
    if (clientId) {
      const dup = get('SELECT id FROM messages WHERE sender_id = ? AND client_id = ?', user.id, clientId);
      if (dup) return json(res, 200, { message: getMessage(Number(dup.id)), duplicate: true });
    }

    let message;
    try {
      message = addMessage(convId, user.id, blocks, Number(body.replyTo) || 0, now(), clientId);
    } catch (err) {
      if (clientId && /UNIQUE|constraint/i.test(err.message)) {
        const dup = get('SELECT id FROM messages WHERE sender_id = ? AND client_id = ?', user.id, clientId);
        if (dup) return json(res, 200, { message: getMessage(Number(dup.id)), duplicate: true });
      }
      throw err;
    }

    run('UPDATE members SET last_read_seq = ? WHERE conv_id = ? AND user_id = ?',
      message.seq, convId, user.id);

    toConv(convId, { type: 'message', conv: convId, message, clientId: clientId || null });
    scheduleAgent(convId, message);
    return json(res, 200, { message });
  }

  /* ---- 删除（本地删除：只对我不再可见，别人照旧） ---- */
  if (method === 'POST' && p === '/api/hide') {
    const user = requireUser(req);
    const { id } = await readJson(req);
    const msg = getMessage(Number(id));
    if (!msg) return json(res, 404, { error: '消息不存在' });
    if (!isMember(msg.convId, user.id)) return json(res, 403, { error: '不在该会话' });
    hideMessage(user.id, msg.id);
    // 删掉的可能正好是最新一条：把已读水位推到「还看得见的最后一条」，
    // 否则未读角标刷完又出现、永远清不掉。
    const vis = visibleMaxSeq(msg.convId, user.id);
    run('UPDATE members SET last_read_seq = MAX(last_read_seq, ?) WHERE conv_id = ? AND user_id = ?',
      vis, msg.convId, user.id);
    return json(res, 200, { ok: true });
  }

  /* ---- 撤回 ---- */
  if (method === 'POST' && p === '/api/recall') {
    const user = requireUser(req);
    const { id } = await readJson(req);
    const msg = getMessage(Number(id));
    if (!msg) return json(res, 404, { error: '消息不存在' });
    if (!isMember(msg.convId, user.id)) return json(res, 403, { error: '不在该会话' });

    const isAdmin = !!get(
      `SELECT 1 AS x FROM members WHERE conv_id = ? AND user_id = ? AND role IN ('owner','admin')`,
      msg.convId, user.id
    );
    if (msg.sender.id !== user.id && !isAdmin) {
      return json(res, 403, { error: '只能撤回自己的消息' });
    }
    if (now() - Number(msg.createdAt) > 2 * 60 * 1000) {
      return json(res, 400, { error: '超过 2 分钟，撤不回了' });
    }

    run('UPDATE messages SET recalled_at = ? WHERE id = ?', now(), msg.id);
    toConv(msg.convId, { type: 'recall', conv: msg.convId, id: msg.id });
    return json(res, 200, { ok: true });
  }

  /* ---- 已读 ---- */
  if (method === 'POST' && p === '/api/read') {
    const user = requireUser(req);
    const { conv, seq } = await readJson(req);
    const convId = Number(conv);
    if (!isMember(convId, user.id)) return json(res, 403, { error: '不在该会话' });
    run('UPDATE members SET last_read_seq = MAX(last_read_seq, ?) WHERE conv_id = ? AND user_id = ?',
      Number(seq) || 0, convId, user.id);
    toConv(convId, { type: 'read', conv: convId, userId: user.id, seq: Number(seq) || 0 });
    return json(res, 200, { ok: true });
  }

  /* ---- 正在输入 ---- */
  if (method === 'POST' && p === '/api/typing') {
    const user = requireUser(req);
    const { conv } = await readJson(req);
    const convId = Number(conv);
    if (!isMember(convId, user.id)) return json(res, 403, { error: '不在该会话' });
    for (const m of all('SELECT user_id FROM members WHERE conv_id = ?', convId)) {
      if (m.user_id === user.id) continue;
      toUser(m.user_id, {
        type: 'typing', conv: convId,
        user: { id: user.id, nickname: user.nickname },
      });
    }
    return json(res, 200, { ok: true });
  }

  /* ---- 上传 ---- */
  if (method === 'POST' && p === '/api/upload') {
    const user = requireUser(req);
    const mime = String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
    const ext = {
      'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
      'image/gif': '.gif', 'image/webp': '.webp',
      'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
      'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3',
      'audio/mp4': '.mp4', 'audio/aac': '.mp4', 'audio/wav': '.wav', 'audio/wave': '.wav',
      'application/pdf': '.pdf', 'application/zip': '.zip',
    }[mime];
    if (!ext) return json(res, 415, { error: '只支持图片 / 视频 / 音频 / pdf / zip' });

    const ct = String(req.headers['content-type'] || '').toLowerCase();
    const isVideoMime = ct.startsWith('video/');
    const isAudioMime = ct.startsWith('audio/');
    const maxBytes = isVideoMime ? 60 * 1024 * 1024 : isAudioMime ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
    const raw = await readRaw(req, maxBytes);
    if (!raw.length) return json(res, 400, { error: '空文件' });

    // 不信 Content-Type，看魔数：伪造类型存成图片扩展名会被拒
    const sniffed = sniffExt(raw);
    const isImg = ['.png', '.jpg', '.gif', '.webp'].includes(sniffed);
    const isVid = ['.mp4', '.mov', '.webm'].includes(sniffed);
    const isAud = ['.ogg', '.mp3', '.wav', '.webm', '.mp4', '.m4a'].includes(sniffed);
    const declaredImg = ['.png', '.jpg', '.gif', '.webp'].includes(ext);
    const declaredVid = ['.mp4', '.mov', '.webm'].includes(ext);
    const declaredAud = ['.ogg', '.mp3', '.wav', '.webm', '.mp4', '.m4a'].includes(ext);
    // 音频和视频容器可能同魔数（webm/mp4），所以只要"声明的那类"和"嗅到的"有交集就放行
    const okKind =
      (isImg === declaredImg) ||
      (declaredVid && isVid) ||
      (declaredAud && isAud);
    if (!sniffed || !okKind) {
      return json(res, 415, { error: '文件内容与类型不符' });
    }

    // 每人 200MB 配额，防止无限塞满磁盘
    const QUOTA = 200 * 1024 * 1024;
    const used = Number(get('SELECT COALESCE(SUM(bytes),0) AS s FROM attachments WHERE owner_id = ?', user.id).s);
    if (used + raw.length > QUOTA) {
      return json(res, 413, { error: '个人空间已满（200MB），先删点旧文件' });
    }

    const sha = createHash('sha256').update(raw).digest('hex');
    await writeFile(join(MEDIA_DIR, sha + sniffed), raw);
    saveAttachment(sha, mime, raw.length, sniffed, user.id);
    return json(res, 200, {
      sha, ext: sniffed, mime, bytes: raw.length, url: `/media/${sha}${sniffed}`,
    });
  }

  /* ---- 建群 ---- */
  if (method === 'POST' && p === '/api/conversation') {
    const user = requireUser(req);
    if (user.kind === 'agent') return json(res, 403, { error: 'AI 不能建群' });
    const { title, memberIds } = await readJson(req);
    const info = run(
      'INSERT INTO conversations (kind, title, owner_id, created_at) VALUES (?,?,?,?)',
      'group', String(title || '新群').slice(0, 40), user.id, now()
    );
    const convId = Number(info.lastInsertRowid);
    run('INSERT INTO members (conv_id, user_id, role, joined_at) VALUES (?,?,?,?)',
      convId, user.id, 'owner', now());

    // 建群时直接勾好友（或自己的 AI）一起拉进来
    const wanted = Array.isArray(memberIds) ? memberIds.map(Number).filter(Boolean).slice(0, 50) : [];
    for (const uid of wanted) {
      if (uid === user.id) continue;
      const target = get('SELECT * FROM users WHERE id = ?', uid);
      if (!target) continue;
      const allowed = target.kind === 'agent'
        ? Number(target.owner_id) === Number(user.id)
        : !!get('SELECT 1 AS x FROM friendships WHERE user_id = ? AND friend_id = ?', user.id, uid);
      if (!allowed) continue;
      if (isMember(convId, uid)) continue;
      run('INSERT INTO members (conv_id, user_id, role, joined_at) VALUES (?,?,?,?)',
        convId, uid, 'member', now());
      toConv(convId, { type: 'system', conv: convId, text: `${target.nickname} 加入了群聊` });
    }
    return json(res, 200, { conv: { id: convId } });
  }

  // 把一个成员拉进群：只能拉「自己的 AI」或自己（做私聊）。A I 不能拉人。
  if (method === 'POST' && /^\/api\/conversation\/\d+\/members$/.test(p)) {
    const me = requireUser(req);
    if (me.kind === 'agent') return json(res, 403, { error: 'AI 不能拉人' });
    const convId = Number(p.split('/')[3]);
    if (!isMember(convId, me.id)) return json(res, 403, { error: '不在该会话' });

    const body = await readJson(req);
    const target = get('SELECT * FROM users WHERE id = ?', Number(body.userId));
    if (!target) return json(res, 404, { error: '没有这个用户' });
    // 只能拉「自己的 AI」或「自己的好友」
    if (target.kind === 'agent') {
      if (Number(target.owner_id) !== Number(me.id)) {
        return json(res, 403, { error: '只能拉自己创建的 AI' });
      }
    } else if (!get('SELECT 1 AS x FROM friendships WHERE user_id = ? AND friend_id = ?', me.id, target.id)) {
      return json(res, 403, { error: '只能拉好友进来' });
    }
    if (isMember(convId, target.id)) return json(res, 200, { ok: true, already: true });

    run('INSERT INTO members (conv_id, user_id, role, joined_at) VALUES (?,?,?,?)',
      convId, target.id, 'member', now());
    toConv(convId, {
      type: 'system',
      conv: convId,
      text: `${target.nickname} 加入了群聊`,
    });
    return json(res, 200, { ok: true, member: publicUser(target) });
  }

  /* ---- 群邀请码：让另一个号能进同一个群 ---- */
  if (method === 'POST' && /^\/api\/conversation\/\d+\/invite$/.test(p)) {
    const me = requireUser(req);
    if (me.kind === 'agent') return json(res, 403, { error: 'AI 不能发邀请' });
    const convId = Number(p.split('/')[3]);
    const conv = get('SELECT * FROM conversations WHERE id = ?', convId);
    if (!conv) return json(res, 404, { error: '没这个群' });
    if (!isMember(convId, me.id)) return json(res, 403, { error: '不在该群' });

    // 复用已有未作废的码，没有就新建
    let row = get('SELECT * FROM group_invites WHERE conv_id = ? AND revoked = 0', convId);
    if (!row) {
      let code = '';
      do {
        code = newInvite();
      } while (get('SELECT 1 AS x FROM group_invites WHERE code = ?', code));
      run('INSERT INTO group_invites (code, conv_id, created_by, created_at) VALUES (?,?,?,?)',
        code, convId, me.id, now());
      row = get('SELECT * FROM group_invites WHERE code = ?', code);
    }
    return json(res, 200, { code: row.code, convId, title: conv.title });
  }

  // 用群邀请码进群
  if (method === 'POST' && p === '/api/join') {
    const me = requireUser(req);
    if (me.kind === 'agent') return json(res, 403, { error: 'AI 不能自己进群' });
    const body = await readJson(req);
    const code = String(body.code || '').trim().toUpperCase();
    const inv = get('SELECT * FROM group_invites WHERE code = ? AND revoked = 0', code);
    if (!inv) return json(res, 404, { error: '邀请码不对或者已作废' });

    if (!isMember(inv.conv_id, me.id)) {
      run('INSERT INTO members (conv_id, user_id, role, joined_at) VALUES (?,?,?,?)',
        inv.conv_id, me.id, 'member', now());
      toConv(inv.conv_id, {
        type: 'system', conv: inv.conv_id, text: `${me.nickname} 加入了群聊`,
      });
    }
    const conv = get('SELECT * FROM conversations WHERE id = ?', inv.conv_id);
    return json(res, 200, { conv: { id: conv.id, title: conv.title } });
  }

  /* ---- 好友：手机号搜索 + 申请 + 同意 ---- */

  // 搜索限流：每人每小时最多查 20 次，防止拿手机号撞库
  const searchHits = new Map();
  function searchAllowed(userId) {
    const nowTs = Date.now();
    const arr = (searchHits.get(userId) || []).filter((t) => nowTs - t < 3600_000);
    if (arr.length >= 20) {
      searchHits.set(userId, arr);
      return false;
    }
    arr.push(nowTs);
    searchHits.set(userId, arr);
    return true;
  }

  function relationOf(meId, otherId) {
    if (meId === otherId) return 'self';
    if (get('SELECT 1 AS x FROM friendships WHERE user_id = ? AND friend_id = ?', meId, otherId)) return 'friend';
    const out = get('SELECT status FROM friend_requests WHERE from_id = ? AND to_id = ?', meId, otherId);
    if (out && out.status === 'pending') return 'pending_out';
    const inc = get('SELECT status FROM friend_requests WHERE from_id = ? AND to_id = ?', otherId, meId);
    if (inc && inc.status === 'pending') return 'pending_in';
    return 'none';
  }

  if (method === 'POST' && p === '/api/friends/search') {
    const me = requireUser(req);
    if (me.kind === 'agent') return json(res, 403, { error: 'AI 不能加好友' });
    if (!searchAllowed(me.id)) return json(res, 429, { error: '查得太频繁了，等一会儿再试' });

    const body = await readJson(req);
    // 手机号找人，或者用 @ID 找（AI 没有手机号，只能靠 ID）
    const raw = String(body.query ?? body.phone ?? '').trim();
    if (!raw) return json(res, 400, { error: '输入手机号或 @ID' });

    let u;
    if (/^1[3-9]\d{9}$/.test(raw)) {
      u = get('SELECT * FROM users WHERE phone = ? AND kind = ?', raw, 'human');
    } else {
      const handle = raw.replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_]{2,32}$/.test(handle)) {
        return json(res, 400, { error: '手机号格式不对，或者 ID 要写成 @ai_xxxx 这样' });
      }
      u = get('SELECT * FROM users WHERE LOWER(handle) = ?', handle);
    }
    // 找不到就说找不到，不回显任何其他信息
    if (!u) return json(res, 404, { error: '没找到这个手机号/ID 对应的账号' });
    if (u.id === me.id) return json(res, 400, { error: '这是你自己' });
    return json(res, 200, {
      user: { ...publicUser(u), relation: relationOf(me.id, u.id) },
    });
  }

  if (method === 'POST' && p === '/api/friends/request') {
    const me = requireUser(req);
    if (me.kind === 'agent') return json(res, 403, { error: 'AI 不能加好友' });
    const body = await readJson(req);
    const target = get('SELECT * FROM users WHERE id = ?', Number(body.userId));
    if (!target) return json(res, 404, { error: '没有这个用户' });
    if (target.id === me.id) return json(res, 400, { error: '不能加自己' });
    if (relationOf(me.id, target.id) === 'friend') return json(res, 400, { error: '你们已经是好友了' });
    // 别人的 AI：得它的主人同意（AI 自己没人操作）
    if (target.kind === 'agent' && Number(target.owner_id) !== Number(me.id)
        && !Number(target.owner_id)) {
      return json(res, 400, { error: '这个 AI 没有主人，加不了' });
    }

    // 对方也申请过我 → 直接成为好友
    const back = get('SELECT * FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = ?',
      target.id, me.id, 'pending');
    if (back) {
      tx(() => {
        run('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?,?,?)', me.id, target.id, now());
        run('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?,?,?)', target.id, me.id, now());
        run('UPDATE friend_requests SET status = ? WHERE id = ?', 'accepted', back.id);
      });
      return json(res, 200, { ok: true, friend: true });
    }

    run(
      `INSERT INTO friend_requests (from_id, to_id, message, status, created_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(from_id, to_id) DO UPDATE SET message = excluded.message, status = 'pending', created_at = excluded.created_at`,
      me.id, target.id, String(body.message || '').slice(0, 60), 'pending', now()
    );
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && p === '/api/friends/requests') {
    const me = requireUser(req);
    // 收件箱：发给我的 + 发给我名下 AI 的（主人的替它处理）
    const myAiIds = all("SELECT id FROM users WHERE owner_id = ? AND kind = 'agent'", me.id).map((r) => r.id);
    const toIds = [me.id, ...myAiIds];
    const marks = toIds.map(() => '?').join(',');
    const incoming = all(
      `SELECT r.id, r.message, r.created_at, r.to_id, u.id AS uid, u.nickname, u.avatar,
              t.nickname AS to_nickname, t.kind AS to_kind
         FROM friend_requests r
         JOIN users u ON u.id = r.from_id
         JOIN users t ON t.id = r.to_id
        WHERE r.to_id IN (${marks}) AND r.status = 'pending'
        ORDER BY r.created_at DESC`,
      ...toIds
    ).map((r) => ({ ...r, for_ai: Number(r.to_id) !== Number(me.id) }));
    const outgoing = all(
      `SELECT r.id, r.created_at, u.id AS uid, u.nickname, u.kind
         FROM friend_requests r JOIN users u ON u.id = r.to_id
        WHERE r.from_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC`,
      me.id
    );
    const friends = all(
      `SELECT u.* FROM friendships f JOIN users u ON u.id = f.friend_id
        WHERE f.user_id = ? ORDER BY f.created_at DESC`,
      me.id
    );
    return json(res, 200, { incoming, outgoing, friends: friends.map(publicUser) });
  }

  if (method === 'POST' && p === '/api/friends/accept') {
    const me = requireUser(req);
    const body = await readJson(req);
    // 允许替自己名下的 AI 点同意
    const row = get(
      `SELECT * FROM friend_requests
        WHERE id = ? AND status = 'pending'
          AND (to_id = ? OR to_id IN (SELECT id FROM users WHERE owner_id = ? AND kind = 'agent'))`,
      Number(body.id), me.id, me.id
    );
    if (!row) return json(res, 404, { error: '申请不存在或已处理' });

    tx(() => {
      run('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?,?,?)', row.to_id, row.from_id, now());
      run('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?,?,?)', row.from_id, row.to_id, now());
      run('UPDATE friend_requests SET status = ? WHERE id = ?', 'accepted', row.id);
    });
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/friends/reject') {
    const me = requireUser(req);
    const body = await readJson(req);
    const row = get(
      `SELECT * FROM friend_requests
        WHERE id = ? AND status = 'pending'
          AND (to_id = ? OR to_id IN (SELECT id FROM users WHERE owner_id = ? AND kind = 'agent'))`,
      Number(body.id), me.id, me.id
    );
    if (!row) return json(res, 404, { error: '申请不存在或已处理' });
    run('UPDATE friend_requests SET status = ? WHERE id = ?', 'rejected', row.id);
    return json(res, 200, { ok: true });
  }

  /* ---- 群设置：改名 / 改公告 / 解散（只有群主）---- */
  if (method === 'POST' && /^\/api\/conversation\/\d+\/(settings|dissolve)$/.test(p)) {
    const me = requireUser(req);
    if (me.kind === 'agent') return json(res, 403, { error: 'AI 不能管理群' });
    const m = /^\/api\/conversation\/(\d+)\/(settings|dissolve)$/.exec(p);
    const convId = Number(m[1]);
    const act = m[2];

    const mine = get('SELECT * FROM members WHERE conv_id = ? AND user_id = ?', convId, me.id);
    if (!mine) return json(res, 403, { error: '不在该群' });
    if (mine.role !== 'owner') return json(res, 403, { error: '只有群主能改群设置' });

    if (act === 'settings') {
      const body = await readJson(req);
      const title = body.title === undefined ? null : String(body.title).trim().slice(0, 40);
      const ann = body.announcement === undefined ? null : String(body.announcement).slice(0, 1000);
      if (title !== null && !title) return json(res, 400, { error: '群名不能是空的' });
      if (title !== null) run('UPDATE conversations SET title = ? WHERE id = ?', title, convId);
      if (ann !== null) {
        const before = get('SELECT announcement FROM conversations WHERE id = ?', convId);
        run('UPDATE conversations SET announcement = ? WHERE id = ?', ann, convId);
        // 内容真变了才 +1：不然改个群名也算"新公告"，大家又变未读
        if ((before?.announcement || '') !== ann) {
          run('UPDATE conversations SET announcement_version = announcement_version + 1 WHERE id = ?', convId);
        }
      }
      return json(res, 200, { ok: true });
    }

    // dissolve
    const conv = get('SELECT * FROM conversations WHERE id = ?', convId);
    if (!conv) return json(res, 404, { error: '没这个群' });
    if (conv.kind !== 'group') return json(res, 400, { error: '私聊不能解散' });
    tx(() => {
      run('DELETE FROM hidden_messages WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)', convId);
      run('DELETE FROM messages WHERE conv_id = ?', convId);
      run('DELETE FROM members WHERE conv_id = ?', convId);
      run('DELETE FROM conversations WHERE id = ?', convId);
    });
    return json(res, 200, { ok: true });
  }

  /** "https://github.com/owner/repo(.git)(/tree/branch)" → { id, owner, repo } */
// 扩展元数据的拉取源（自测时指到本地 mock，生产就是 GitHub raw）
const EXT_BASE = process.env.NEST_EXT_BASE || 'https://raw.githubusercontent.com';

function parseGithubRepo(input) {
  const raw = String(input || '').trim();
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/.exec(raw)
    || /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, '');
  if (!owner || !repo) return null;
  return { id: `${owner}/${repo}`.toLowerCase(), owner, repo };
}

/** 把任意 WAV 重写成规范布局（RIFF + WAVE + fmt16 + data），DSH 的转写接口只认这个 */
function canonicalizeWav(file) {
  try {
    const b = readFileSync(file);
    if (b.length < 44) return;
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return;
    if (b.toString('ascii', 12, 16) === 'fmt ' && b.toString('ascii', 36, 40) === 'data') return;

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
  } catch { /* 修不了就原样发 */ }
}

/* ---- 扫描本机已装的 DSH 插件（列在向导里，也能写进口令）---- */
function dshPluginList() {
  const home = (() => { try { return process.env.DSH_HOME || join(homedir(), '.dsh'); } catch { return ''; } })();
  const out = new Map();   // name -> { name, version, source }
  const add = (name, version, source) => {
    if (!name) return;
    const key = String(name).toLowerCase();
    const prev = out.get(key);
    // 优先级：profile 依赖 > 本地插件 > 内置
    const rank = { profile: 0, local: 1, builtin: 2 };
    if (prev && rank[prev.source] <= rank[source]) return;
    out.set(key, { name: String(name), version: String(version || ""), source });
  };

  // 1) profile 里直接声明的依赖（= 装过并启用的插件）
  try {
    const prof = join(home, 'profiles', 'desktop');
    const pkg = JSON.parse(readFileSync(join(prof, 'package.json'), 'utf8'));
    for (const [name, ver] of Object.entries(pkg.dependencies || {})) {
      add(name, String(ver || '').replace(/^[\^~]/, ''), 'profile');
    }
    // node_modules 里的内置可选插件（@deepseek-ai/dsh-*）
    const nm = join(prof, 'node_modules', '@deepseek-ai');
    if (existsSync(nm)) {
      for (const d of readdirSync(nm)) {
        if (!d.startsWith('dsh-') && !d.includes('speech') && !d.includes('memory')) continue;
        let v = '';
        try { v = JSON.parse(readFileSync(join(nm, d, 'package.json'), 'utf8')).version || ''; } catch {}
        add('@deepseek-ai/' + d, v, 'builtin');
      }
    }
  } catch { /* 没装 DSH 就跳过 */ }

  // 2) ~/.dsh/plugins 下用户自己放/链接的插件
  try {
    const dir = join(home, 'plugins');
    if (existsSync(dir)) {
      for (const d of readdirSync(dir)) {
        let v = '';
        try { v = JSON.parse(readFileSync(join(dir, d, 'package.json'), 'utf8')).version || ''; } catch {}
        add(d, v, 'local');
      }
    }
  } catch { /* ignore */ }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ---- 本机 DSH 能力探针（创建 AI 向导用：哪些能力需要装插件）---- */
function dshCapabilityList() {
  const base = (() => {
    try { return process.env.DSH_HOME || join(homedir(), '.dsh'); } catch { return ''; }
  })();
  const hasDir = (name) => {
    try { return existsSync(join(base, name)); } catch { return false; }
  };
  const readDeps = () => {
    try {
      const j = JSON.parse(readFileSync(join(base, 'profiles', 'desktop', 'package.json'), 'utf8'));
      return Object.keys(j.dependencies || {});
    } catch { return []; }
  };
  const deps = readDeps();
  const hasDep = (kw) => deps.some((d) => d.toLowerCase().includes(kw));

  return [
    {
      id: 'voice',
      name: '听懂语音',
      desc: '别人发语音，它也能看懂内容',
      plugin: 'speech-to-text（本机已缓存 SenseVoice 模型）',
      installed: hasDir('speech-to-text') || hasDep('speech'),
    },
    {
      id: 'longterm',
      name: '长期记忆',
      desc: '跨会话记得住人和事',
      plugin: 'graphmemory 或 nmem 记忆插件',
      installed: hasDir('graph-memory') || hasDir('nmem') || hasDep('memory'),
    },
  ];
}

if (method === 'GET' && p === '/api/dsh/capabilities') {
  requireUser(req);
  return json(res, 200, { capabilities: dshCapabilityList() });
}

if (method === 'GET' && p === '/api/dsh/plugins') {
  requireUser(req);
  const plugins = dshPluginList();
  return json(res, 200, { plugins });
}

/* ---- 能力扩展包（从 GitHub 拉一个 nest-extension.json）---- */
if (method === 'GET' && p === '/api/extensions') {
  requireUser(req);
  const rows = all('SELECT * FROM extensions ORDER BY installed_at DESC');
  return json(res, 200, {
    extensions: rows.map((r) => ({
      id: r.id, name: r.name, version: r.version, description: r.description,
      author: r.author, repoUrl: r.repo_url, prompt: r.prompt,
    })),
  });
}

if (method === 'POST' && p === '/api/extensions/install') {
  const me = requireUser(req);
  if (me.kind === 'agent') return json(res, 403, { error: 'AI 不能装扩展' });
  const body = await readJson(req);
  const rawUrl = String(body.url || '').trim();
  // 本地文件也能装（离线试写扩展用）：直接读那个 manifest
  const localPath = rawUrl.startsWith('file://') ? rawUrl.slice(7) : rawUrl;
  if (localPath && localPath.endsWith('.json')) {
    try {
      // 去掉 BOM：Windows 记事本/PowerShell 存出来的 UTF-8 常常带 BOM
      const m = JSON.parse(readFileSync(localPath, 'utf8').replace(/^\uFEFF/, ''));
      if (!m || !String(m.prompt || '').trim()) {
        return json(res, 400, { error: '文件里的 prompt 是空的' });
      }
      const lid = ('local/' + String(m.name || 'ext')).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5/_-]+/g, '-').slice(0, 60);
      run(
        'INSERT INTO extensions (id, name, version, description, prompt, author, repo_url, installed_at) VALUES (?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, ' +
        'description = excluded.description, prompt = excluded.prompt',
        lid, String(m.name || '本地扩展').slice(0, 40), String(m.version || '').slice(0, 20),
        String(m.description || '').slice(0, 300), String(m.prompt).slice(0, 8000),
        String(m.author || '').slice(0, 40), '', now()
      );
      return json(res, 200, { ok: true, id: lid, name: String(m.name || '本地扩展') });
    } catch (err) {
      return json(res, 400, { error: '读不了这个文件：' + (err.message || err) });
    }
  }
  const parsed = parseGithubRepo(String(body.url || ''));
  if (!parsed) return json(res, 400, { error: '给一个 GitHub 仓库地址，比如 https://github.com/you/nest-writing' });

  let manifest = null;
  let lastErr = '';
  for (const branch of ['main', 'master']) {
    const raw = EXT_BASE + '/' + parsed.id + '/' + branch + '/nest-extension.json';
    try {
      const r = await fetch(raw, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
      manifest = JSON.parse(await r.text());
      break;
    } catch (err) { lastErr = err.message || String(err); }
  }
  if (!manifest) {
    return json(res, 400, { error: '这个仓库没有可用的 nest-extension.json（' + lastErr + '）' });
  }

  const name = String(manifest.name || parsed.repo).slice(0, 40);
  const version = String(manifest.version || '').slice(0, 20);
  const description = String(manifest.description || '').slice(0, 300);
  const author = String(manifest.author || parsed.owner).slice(0, 40);
  const promptText = String(manifest.prompt || '').slice(0, 8000);
  if (!promptText.trim()) return json(res, 400, { error: 'nest-extension.json 里的 prompt 是空的' });

  run(
    'INSERT INTO extensions (id, name, version, description, prompt, author, repo_url, installed_at) VALUES (?,?,?,?,?,?,?,?) ' +
    'ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, ' +
    'description = excluded.description, prompt = excluded.prompt, author = excluded.author, repo_url = excluded.repo_url',
    parsed.id, name, version, description, promptText, author, 'https://github.com/' + parsed.id, now()
  );
  return json(res, 200, { ok: true, id: parsed.id, name });
}

if (method === 'POST' && p === '/api/extensions/remove') {
  const me = requireUser(req);
  if (me.kind === 'agent') return json(res, 403, { error: 'AI 不能删扩展' });
  const body = await readJson(req);
  run('DELETE FROM extensions WHERE id = ?', String(body.id || ''));
  run('DELETE FROM ai_extensions WHERE ext_id = ?', String(body.id || ''));
  return json(res, 200, { ok: true });
}

/* ---- 语音转文字（用本机 DSH 的离线 SenseVoice）---- */
  if (method === 'POST' && p === '/api/voice/transcribe') {
    const me = requireUser(req);
    const body = await readJson(req);
    const msg = getMessage(Number(body.id));
    if (!msg) return json(res, 404, { error: '消息不存在' });
    if (!isMember(msg.convId, me.id)) return json(res, 403, { error: '不在该会话' });

    const vb = (msg.blocks || []).find((b) => b.t === 'voice');
    if (!vb) return json(res, 400, { error: '这条不是语音' });
    if (!vb.sha) return json(res, 400, { error: '这条语音是老格式（没有音频文件），转不了' });

    const cached = get('SELECT text, lang FROM voice_texts WHERE sha = ?', vb.sha);
    if (cached) return json(res, 200, { text: cached.text, cached: true });

    const src = join(MEDIA_DIR, vb.sha + (vb.ext || '.webm'));
    if (!existsSync(src)) return json(res, 404, { error: '音频文件不在了' });

    const ffmpeg = process.env.NEST_FFMPEG || 'ffmpeg';
    const wav = join(os.tmpdir(), `nest-vt-${vb.sha.slice(0, 12)}.wav`);
    try {
      await new Promise((resolve, reject) => {
        execFile(ffmpeg, [
          '-y', '-i', src,
          '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav',
          // 不加 bitexact，ffmpeg 会在 fmt 和 data 之间插 LIST 块，DSH 只收规范布局
          '-fflags', '+bitexact', '-flags', '+bitexact', '-map_metadata', '-1',
          wav,
        ], { timeout: 60_000, windowsHide: true }, (err, _out, stderr) => {
          if (err) reject(new Error((stderr || err.message || '').slice(0, 160)));
          else resolve();
        });
      });
    } catch (err) {
      return json(res, 500, { error: '转码失败：' + err.message });
    }

    try {
      if (!existsSync(wav)) return json(res, 500, { error: '转码没产出文件' });
      canonicalizeWav(wav);
      const size = statSync(wav).size;
      if (size > 4 * 1024 * 1024) return json(res, 413, { error: '音频太大，转写接口上限 4MB' });

      const base = dshBaseUrl({});
      const out = await dshRpc(base, 'speech/transcribe', {
        request: { audioBase64: readFileSync(wav).toString('base64'), language: 'zh' },
      }, { timeoutMs: 180_000 });
      const text = String(out?.text || '').trim();
      if (!text) return json(res, 200, { text: '', note: '没听出内容' });
      run(
        'INSERT OR REPLACE INTO voice_texts (sha, text, lang, created_at) VALUES (?,?,?,?)',
        vb.sha, text, 'zh', now()
      );
      return json(res, 200, { text, seconds: Number(out?.audioSeconds) || 0 });
    } catch (err) {
      const msg2 = String(err.message || err);
      return json(res, 503, {
        error: msg2.includes('NO_CREDENTIALS') ? '读不到 DSH 签名密钥，转写不可用' : msg2.slice(0, 200),
      });
    } finally {
      try { rmSync(wav, { force: true }); } catch {}
    }
  }

  /* ---- 表情收藏：存到本地，面板里一点就发 ---- */
  if (method === 'GET' && p === '/api/stickers') {
    const me = requireUser(req);
    const rows = all(
      'SELECT sha, ext, created_at FROM stickers WHERE user_id = ? ORDER BY created_at DESC LIMIT 120',
      me.id
    );
    return json(res, 200, {
      stickers: rows.map((r) => ({ sha: r.sha, ext: r.ext, url: `/media/${r.sha}${r.ext}` })),
    });
  }

  if (method === 'POST' && p === '/api/stickers') {
    const me = requireUser(req);
    const body = await readJson(req);
    const sha = String(body.sha || '');
    const ext = String(body.ext || '.png').toLowerCase();
    if (!HEX64.test(sha) || !['.png', '.jpg', '.gif', '.webp'].includes(ext)) {
      return json(res, 400, { error: '这个存不了表情' });
    }
    if (!get('SELECT 1 AS x FROM attachments WHERE sha = ?', sha)) {
      return json(res, 404, { error: '这张图已经不在了' });
    }
    const count = Number(get('SELECT COUNT(*) AS n FROM stickers WHERE user_id = ?', me.id).n);
    if (count >= 120) return json(res, 400, { error: '表情太多啦（上限 120 个），先删几个' });
    run(
      'INSERT OR IGNORE INTO stickers (user_id, sha, ext, created_at) VALUES (?,?,?,?)',
      me.id, sha, ext, now()
    );
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/stickers/remove') {
    const me = requireUser(req);
    const body = await readJson(req);
    run('DELETE FROM stickers WHERE user_id = ? AND sha = ?', me.id, String(body.sha || ''));
    return json(res, 200, { ok: true });
  }

  /* ---- 群公告：读状态 ---- */
  if (method === 'POST' && /^\/api\/conversation\/\d+\/announcement\/read$/.test(p)) {
    const me = requireUser(req);
    const convId = Number(p.split('/')[3]);
    if (!isMember(convId, me.id)) return json(res, 403, { error: '不在该群' });
    const conv = get('SELECT announcement, announcement_version FROM conversations WHERE id = ?', convId);
    if (!conv) return json(res, 404, { error: '没这个群' });
    run(
      'INSERT INTO announcement_reads (conv_id, user_id, version, read_at) VALUES (?,?,?,?) ' +
      'ON CONFLICT(conv_id, user_id) DO UPDATE SET version = excluded.version, read_at = excluded.read_at',
      convId, me.id, Number(conv.announcement_version), now()
    );
    return json(res, 200, { ok: true, version: Number(conv.announcement_version) });
  }

  if (method === 'GET' && /^\/api\/conversation\/\d+\/announcement$/.test(p)) {
    const me = requireUser(req);
    const convId = Number(p.split('/')[3]);
    if (!isMember(convId, me.id)) return json(res, 403, { error: '不在该群' });
    const conv = get('SELECT announcement, announcement_version, kind FROM conversations WHERE id = ?', convId);
    if (!conv) return json(res, 404, { error: '没这个群' });
    const version = Number(conv.announcement_version || 0);
    const mine = get('SELECT version FROM announcement_reads WHERE conv_id = ? AND user_id = ?', convId, me.id);
    const members = conversationMembers(convId).filter((m) => m.kind === 'human');
    const reads = all('SELECT user_id, version FROM announcement_reads WHERE conv_id = ?', convId);
    const readMap = new Map(reads.map((r) => [Number(r.user_id), Number(r.version)]));
    const read = members.filter((m) => readMap.get(m.id) === version);
    const unread = members.filter((m) => readMap.get(m.id) !== version);

    const myRole = get('SELECT role FROM members WHERE conv_id = ? AND user_id = ?', convId, me.id);
    return json(res, 200, {
      announcement: conv.announcement || '',
      version,
      myRead: Number(mine?.version) === version && version > 0,
      // 只有群主看得到"谁没读"
      total: members.length,
      readCount: read.length,
      readNames: myRole?.role === 'owner' ? read.map((m) => m.nickname) : [],
      unreadNames: myRole?.role === 'owner' ? unread.map((m) => m.nickname) : [],
    });
  }

  /* ---- 群管理：踢人 / 禁言 / 转让（只有群主）---- */
  const groupAdmin = (p) => /^\/api\/conversation\/(\d+)\/(kick|mute|transfer)$/.exec(p);

  if (method === 'POST' && groupAdmin(p)) {
    const me = requireUser(req);
    if (me.kind === 'agent') return json(res, 403, { error: 'AI 不能管理群' });
    const [, convIdRaw, action] = groupAdmin(p);
    const convId = Number(convIdRaw);

    const mine = get('SELECT * FROM members WHERE conv_id = ? AND user_id = ?', convId, me.id);
    if (!mine) return json(res, 403, { error: '不在该群' });
    if (mine.role !== 'owner') return json(res, 403, { error: '只有群主能这么操作' });

    const body = await readJson(req);
    const targetId = Number(body.userId);
    const target = get('SELECT * FROM members WHERE conv_id = ? AND user_id = ?', convId, targetId);
    if (!target) return json(res, 404, { error: '这个人不在群里' });
    const targetUser = get('SELECT nickname FROM users WHERE id = ?', targetId);
    const targetName = targetUser?.nickname || '有人';

    if (action === 'kick') {
      if (targetId === me.id) return json(res, 400, { error: '不能踢自己（要退群请用别的入口）' });
      run('DELETE FROM members WHERE conv_id = ? AND user_id = ?', convId, targetId);
      toConv(convId, { type: 'system', conv: convId, text: `${targetName} 被移出了群聊` });
      return json(res, 200, { ok: true });
    }

    if (action === 'mute') {
      if (targetId === me.id) return json(res, 400, { error: '不能禁言自己' });
      const minutes = Math.max(0, Math.min(7 * 24 * 60, Number(body.minutes) || 0));
      const until = minutes ? now() + minutes * 60_000 : 0;
      run('UPDATE members SET mute_until = ? WHERE conv_id = ? AND user_id = ?', until, convId, targetId);
      return json(res, 200, { ok: true, muteUntil: until });
    }

    // transfer
    if (targetId === me.id) return json(res, 400, { error: '你已经是群主了' });
    tx(() => {
      run('UPDATE members SET role = ? WHERE conv_id = ? AND user_id = ?', 'member', convId, me.id);
      run('UPDATE members SET role = ? WHERE conv_id = ? AND user_id = ?', 'owner', convId, targetId);
      run('UPDATE conversations SET owner_id = ? WHERE id = ?', targetId, convId);
    });
    toConv(convId, {
      type: 'system', conv: convId,
      text: `群主已转让给 ${targetName}`,
    });
    return json(res, 200, { ok: true });
  }

  /* ---- 个人资料：真人改自己的；AI 用钥匙改自己的（改名看主人开关）---- */
  if (method === 'POST' && p === '/api/profile') {
    const me = requireUser(req);
    const body = await readJson(req);
    const isAi = me.kind === 'agent';

    const patch = {};
    if (body.nickname !== undefined) {
      const nickname = String(body.nickname).trim().slice(0, 16);
      if (!nickname) return json(res, 400, { error: '名字不能是空的' });
      if (isAi && !Number(me.self_rename)) {
        return json(res, 403, {
          error: '主人还没允许你自己改名',
          code: 'rename_locked',
        });
      }
      patch.nickname = nickname;
    }
    if (body.signature !== undefined) patch.signature = String(body.signature).slice(0, 60);
    if (body.avatar !== undefined) {
      const a = String(body.avatar);
      // 只接受本站上传出来的地址，避免塞外链
      if (a && !/^\/media\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(a)) {
        return json(res, 400, { error: '头像地址不对' });
      }
      patch.avatar = a;
    }
    if (!Object.keys(patch).length) return json(res, 400, { error: '没有要改的东西' });

    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    run(`UPDATE users SET ${sets} WHERE id = ?`, ...Object.values(patch), me.id);

    // 告诉同群的客户端刷新（改名/换头像要立刻看到）
    for (const c of all('SELECT conv_id FROM members WHERE user_id = ?', me.id)) {
      toConv(c.conv_id, { type: 'reload' });
    }
    return json(res, 200, { ok: true, me: publicUser(get('SELECT * FROM users WHERE id = ?', me.id)) });
  }

  /* ---- 看别人的资料（点开 AI 时用）---- */
  if (method === 'GET' && /^\/api\/profile\/\d+$/.test(p)) {
    const me = requireUser(req);
    const uid = Number(p.split('/')[3]);
    const u = get('SELECT * FROM users WHERE id = ?', uid);
    if (!u) return json(res, 404, { error: '没有这个人' });

    // 能看的前提：同群 / 好友 / 自己的 AI / 自己
    const shared = !!get(
      `SELECT 1 AS x FROM members a JOIN members b ON b.conv_id = a.conv_id
        WHERE a.user_id = ? AND b.user_id = ?`, me.id, uid
    );
    const friend = !!get('SELECT 1 AS x FROM friendships WHERE user_id = ? AND friend_id = ?', me.id, uid);
    const mine = Number(u.owner_id) === Number(me.id);
    if (uid !== me.id && !shared && !friend && !mine) {
      return json(res, 403, { error: '你们还不认识' });
    }

    return json(res, 200, {
      user: publicUser(u),
      isOwner: mine || uid === me.id,
      relation: uid === me.id ? 'self' : friend ? 'friend' : mine ? 'mine' : 'coworker',
    });
  }

  /* ---- 记忆概况（只给这个 AI 的主人看）---- */
  if (method === 'GET' && /^\/api\/ai\/\d+\/memory$/.test(p)) {
    const me = requireUser(req);
    const aiId = Number(p.split('/')[3]);
    const ai = get('SELECT * FROM users WHERE id = ? AND kind = ?', aiId, 'agent');
    if (!ai) return json(res, 404, { error: '没有这个 AI' });
    if (Number(ai.owner_id) !== Number(me.id)) return json(res, 403, { error: '只有它能的主人能看' });
    return json(res, 200, { ...readBrainStats(), shared: true, aiName: ai.nickname });
  }

  /* ---- 记忆星图：只给这个 AI 的主人看 ---- */
  const starmapOf = (path) => /^\/api\/ai\/(\d+)\/starmap(\/refresh)?$/.exec(path);

  if (method === 'GET' && starmapOf(p) && !starmapOf(p)[2]) {
    const me = requireUser(req);
    const aiId = Number(starmapOf(p)[1]);
    const ai = get('SELECT * FROM users WHERE id = ? AND kind = ?', aiId, 'agent');
    if (!ai || Number(ai.owner_id) !== Number(me.id)) return json(res, 403, { error: '只有它的主人能看' });

    const file = join(homedir(), '.dsh', 'nmem', 'starmap.html');
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<meta charset="utf-8"><body style="background:#04060f;color:#dfe8ff;font:14px system-ui;padding:40px">'
        + '还没有星图。在设置里点「刷新星图」，或者先跑一次桌面上的「记忆星图.cmd」。</body>');
      return;
    }
    const html = readFileSync(file, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }

  // 刷新：跑一遍 nmem 导出 → 计算坐标 → 生成 html
  if (method === 'POST' && starmapOf(p) && starmapOf(p)[2]) {
    const me = requireUser(req);
    const aiId = Number(starmapOf(p)[1]);
    const ai = get('SELECT * FROM users WHERE id = ? AND kind = ?', aiId, 'agent');
    if (!ai || Number(ai.owner_id) !== Number(me.id)) return json(res, 403, { error: '只有它的主人能刷新' });

    const base = join(homedir(), '.dsh', 'nmem');
    const nmemExe = join(base, 'venv', 'Scripts', 'nmem.exe');
    const py = join(base, 'venv', 'Scripts', 'python.exe');
    if (!existsSync(nmemExe) || !existsSync(py)) {
      return json(res, 400, { error: '这台机器上没装 nmem 的 venv，做不了' });
    }
    try {
      const runStep = (cmd, args) => new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd: base, timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
          if (err) reject(new Error(`${cmd} 失败：${(stderr || err.message).slice(0, 200)}`));
          else resolve(stdout);
        });
      });
      await runStep(nmemExe, ['brain', 'export', '-o', join(base, 'brain-export.json')]);
      await runStep(py, [join(base, 'starmap.py')]);
      await runStep(py, [join(base, 'starmap3d.py')]);
      brainCache = { at: 0, data: null };   // 让统计重新读
      return json(res, 200, { ok: true, ...readBrainStats() });
    } catch (err) {
      return json(res, 500, { error: err.message || '刷新失败' });
    }
  }

  /* ---- 联系人 ---- */
  if (method === 'GET' && p === '/api/contacts') {
    const user = requireUser(req);
    // 只给自己认识的人：好友 + 同群的人 + 自己名下的 AI。
    // 注册完还没进任何群的新人 => 通讯录是空的（谁都能看到全站用户是隐私问题）。
    const users = all(
      `SELECT u.*,
              (SELECT COUNT(*) FROM friendships f WHERE f.user_id = ? AND f.friend_id = u.id) AS is_friend
         FROM users u
        WHERE u.id <> ?
          AND (
            u.owner_id = ?
            OR EXISTS (SELECT 1 FROM friendships f WHERE f.user_id = ? AND f.friend_id = u.id)
            OR EXISTS (
              SELECT 1 FROM members a JOIN members b ON b.conv_id = a.conv_id
               WHERE a.user_id = ? AND b.user_id = u.id
            )
          )
        ORDER BY CASE u.kind WHEN 'agent' THEN 0 ELSE 1 END,
                 CASE u.status WHEN 'online' THEN 0 ELSE 1 END, u.id`,
      user.id, user.id, user.id, user.id, user.id
    );
    return json(res, 200, {
      contacts: users.map((u) => {
        // 让界面能说清「这个人为什么在列表里」
        const relation = Number(u.owner_id) === Number(user.id) && u.kind === 'agent'
          ? 'mine'
          : Number(u.is_friend) > 0 ? 'friend' : 'coworker';
        const dm = get(
          `SELECT c.id FROM conversations c
             JOIN members a ON a.conv_id = c.id AND a.user_id = ?
             JOIN members b ON b.conv_id = c.id AND b.user_id = ?
            WHERE c.kind = 'dm' LIMIT 1`,
          user.id, u.id
        );
        return { ...publicUser(u), dmId: dm ? Number(dm.id) : 0, relation };
      }),
    });
  }

  /* ---- 开私聊（没有就建） ---- */
  if (method === 'POST' && p === '/api/dm') {
    const user = requireUser(req);
    const { userId } = await readJson(req);
    const target = get('SELECT * FROM users WHERE id = ?', Number(userId));
    if (!target) return json(res, 404, { error: '用户不存在' });
    if (target.id === user.id) return json(res, 400, { error: '不能和自己私聊' });

    // 别人的 AI：得先成为好友（好友关系要它主人同意），不能同群就直接私聊
    if (target.kind === 'agent' && Number(target.owner_id) !== Number(user.id)) {
      const isFriend = get(
        'SELECT 1 AS x FROM friendships WHERE user_id = ? AND friend_id = ?', user.id, target.id
      );
      if (!isFriend) {
        return json(res, 403, {
          error: `${target.nickname} 是别人的 AI，先加好友才能私聊`,
          code: 'need_friend',
        });
      }
    }

    if (target.kind === 'human' && user.kind === 'human') {
      return json(res, 403, {
        error: 'Nest 里只和 AI 聊天。要找真人，请回 QQ 或微信。',
        code: 'human_dm_blocked',
      });
    }

    let dm = get(
      `SELECT c.id FROM conversations c
         JOIN members a ON a.conv_id = c.id AND a.user_id = ?
         JOIN members b ON b.conv_id = c.id AND b.user_id = ?
        WHERE c.kind = 'dm' LIMIT 1`,
      user.id, target.id
    );

    if (!dm) {
      const info = run(
        `INSERT INTO conversations (kind, title, owner_id, created_at) VALUES ('dm',?,?,?)`,
        `dm:${user.id}:${target.id}`, user.id, now()
      );
      const convId = Number(info.lastInsertRowid);
      for (const uid of [user.id, target.id]) {
        run('INSERT INTO members (conv_id, user_id, role, joined_at) VALUES (?,?,?,?)',
          convId, uid, 'member', now());
      }
      dm = { id: convId };
      toUser(target.id, { type: 'reload' });
    }

    const conv = buildConversations(user.id).find((c) => c.id === Number(dm.id));
    return json(res, 200, { conv });
  }

  /* ---- 邀请码 ---- */
  if (method === 'GET' && p === '/api/invites') {
    const me = requireUser(req);
    if (me.kind === 'agent') return json(res, 403, { error: 'AI 账号看不了邀请码' });
    const rows = all('SELECT code, used_by, created_at FROM invites ORDER BY created_at DESC');
    return json(res, 200, {
      invites: rows.map((r) => ({ code: r.code, used: !!r.used_by })),
      available: rows.filter((r) => !r.used_by).length,
    });
  }

  if (method === 'POST' && p === '/api/invites') {
    const me = requireUser(req);
    if (me.kind === 'agent') return json(res, 403, { error: 'AI 账号不能发邀请码' });
    let code = '';
    do {
      code = newInvite();
    } while (get('SELECT 1 AS x FROM invites WHERE code = ?', code));
    run('INSERT INTO invites (code, created_by, created_at) VALUES (?,?,?)', code, me.id, now());
    return json(res, 200, { code });
  }

  /* ---- 服务器自己的地址：给「接入命令」用 ---- */
  /* ---- 桥接脚本下载：AI 要跑在别人的电脑上，他得先拿到这个文件 ---- */
  if (method === 'GET' && p === '/api/bridge/download') {
    const file = join(ROOT, 'bridge', 'nest-bridge.mjs');
    try {
      const st = await stat(file);
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': st.size,
        'content-disposition': 'attachment; filename="nest-bridge.mjs"',
        'cache-control': 'no-store',
      });
      pipeFile(res, file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bridge not found');
    }
    return;
  }

  if (method === 'GET' && p === '/api/server-info') {
    const nets = os.networkInterfaces();
    const lan = [];
    for (const list of Object.values(nets)) {
      for (const n of list || []) {
        if (n.family !== 'IPv4' || n.internal) continue;
        // 100.64.0.0/10 是 Tailscale/运营商级 NAT 的地址，不是局域网，别写进提示
        const oct = n.address.split('.').map(Number);
        const isCgnat = oct[0] === 100 && oct[1] >= 64 && oct[1] <= 127;
        if (isCgnat) continue;
        lan.push(n.address);
      }
    }
    const humans = get("SELECT COUNT(*) AS n FROM users WHERE kind = 'human'");
    const tunnel = readTunnel();
    return json(res, 200, {
      port: PORT,
      lan,
      firstRun: Number(humans.n) === 0,   // 第一次用：引导注册（第一个注册的人会成为管理员）
      registerMode: REGISTER_MODE,        // open / invite：界面据此决定要不要邀请码输入框
      publicUrl: tunnel ? tunnel.url : '',  // 隧道就绪时给公网地址
      tunnel: tunnel ? { provider: tunnel.provider, since: tunnel.updatedAt } : null,
      tls: USE_TLS,
    });
  }

  /* ---- AI 成员管理（只有真人能建）---- */
  if (method === 'GET' && p === '/api/ai/members') {
    const me = requireUser(req);
    const rows = all('SELECT * FROM users WHERE owner_id = ? AND kind = ? ORDER BY id', me.id, 'agent');
    const members = rows.map((u) => ({
      ...publicUser(u),
      keyCount: Number(get('SELECT COUNT(*) AS n FROM ai_keys WHERE user_id = ? AND revoked = 0', u.id).n),
      lastUsedAt: Number(get('SELECT COALESCE(MAX(last_used_at),0) AS t FROM ai_keys WHERE user_id = ?', u.id).t),
      // 它现在在哪些群里 —— 没进群的 AI 收不到任何消息，必须让主人一眼看见
      dshPlugins: (() => {
        try { return JSON.parse(u.dsh_plugins || '[]'); } catch { return []; }
      })(),
      extensions: all(
        'SELECT e.id, e.name FROM extensions e JOIN ai_extensions x ON x.ext_id = e.id WHERE x.ai_id = ?',
        u.id
      ),
      groups: all(
        `SELECT c.id, c.title FROM conversations c
           JOIN members m ON m.conv_id = c.id
          WHERE m.user_id = ? AND c.kind = 'group'`,
        u.id
      ).map((c) => ({ id: c.id, title: c.title })),
    }));
    return json(res, 200, { members });
  }

  if (method === 'POST' && p === '/api/ai/members') {
    const me = requireUser(req);
    if (me.kind === 'agent') return json(res, 403, { error: 'AI 账号不能再建 AI' });
    const body = await readJson(req);
    const nickname = String(body.nickname || '').trim().slice(0, 16);
    if (!nickname) return json(res, 400, { error: '给它起个名字' });
    const persona = String(body.persona || '').slice(0, 4000);
    // 能力开关（记忆/情绪/主动说话）和扩展包，在建号这一步就一起定下来
    const capsIn = body.caps && typeof body.caps === 'object' ? body.caps : null;
    const capsJson = capsIn
      ? JSON.stringify({
          memory: capsIn.memory !== false,
          emotion: capsIn.emotion !== false,
          proactive: capsIn.proactive !== false,
        })
      : '';
    // 需要的 DSH 插件：{ spec, installed }，spec 可以是插件名也可以是 GitHub 地址
    const dshPlugins = Array.isArray(body.dshPlugins)
      ? body.dshPlugins
          .map((x) => ({
            spec: String(x?.spec || x || '').trim().slice(0, 200),
            installed: Boolean(x?.installed),
          }))
          .filter((x) => x.spec)
          .slice(0, 30)
      : [];
    const extIds = Array.isArray(body.extensions)
      ? [...new Set(body.extensions.map((x) => String(x || '')).filter(Boolean))].slice(0, 20)
      : [];

    const handle = 'ai_' + randomBytes(4).toString('hex');
    const info = run(
      `INSERT INTO users (handle, nickname, kind, owner_id, created_at, persona_text) VALUES (?,?,?,?,?,?)`,
      handle, nickname, 'agent', me.id, now(), persona
    );
    const aiId = Number(info.lastInsertRowid);
    if (capsJson) run('UPDATE users SET capabilities = ? WHERE id = ?', capsJson, aiId);
    if (dshPlugins.length) {
      run('UPDATE users SET dsh_plugins = ? WHERE id = ?', JSON.stringify(dshPlugins), aiId);
    }
    for (const extId of extIds) {
      if (!get('SELECT 1 AS x FROM extensions WHERE id = ?', extId)) continue;
      run('INSERT OR IGNORE INTO ai_extensions (ai_id, ext_id) VALUES (?,?)', aiId, extId);
    }
    const key = newAiKey();
    run('INSERT INTO ai_keys (user_id, key_hash, label, created_at) VALUES (?,?,?,?)',
      aiId, aiKeyHash(key), 'created', now());

    // 建号就给它开一条私聊：否则这个 AI 一个会话都没有，
    // 接进来的人一脸茫然（"我接上了，但没地方说话"）。
    const dmInfo = run(
      `INSERT INTO conversations (kind, title, owner_id, created_at) VALUES ('dm',?,?,?)`,
      `dm:${me.id}:${aiId}`, me.id, now()
    );
    const dmId = Number(dmInfo.lastInsertRowid);
    for (const uid of [me.id, aiId]) {
      run('INSERT INTO members (conv_id, user_id, role, joined_at) VALUES (?,?,?,?)',
        dmId, uid, 'member', now());
    }
    addMessage(dmId, aiId, [
      { t: 'text', v: `我来了。有事先在这儿说，也可以把${nickname}拉进群里跟大家一起聊。` },
    ]);

    return json(res, 200, {
      member: publicUser(get('SELECT * FROM users WHERE id = ?', aiId)),
      dm: { id: dmId },
      key, // 明文只在这里返回一次
    });
  }

  // 重新发钥匙：旧的全部作废
  if (method === 'POST' && /^\/api\/ai\/members\/\d+\/key$/.test(p)) {
    const me = requireUser(req);
    const aiId = Number(p.split('/')[4]);
    const ai = get('SELECT * FROM users WHERE id = ? AND owner_id = ? AND kind = ?', aiId, me.id, 'agent');
    if (!ai) return json(res, 404, { error: '没找到这个 AI 成员' });

    run('UPDATE ai_keys SET revoked = 1 WHERE user_id = ?', aiId);
    const key = newAiKey();
    run('INSERT INTO ai_keys (user_id, key_hash, label, created_at) VALUES (?,?,?,?)',
      aiId, aiKeyHash(key), 'rotated', now());
    return json(res, 200, { key });
  }

  // 彻底删除：连它在群里的发言一起抹掉（停用只是断线）
  if (method === 'POST' && /^\/api\/ai\/members\/\d+\/delete$/.test(p)) {
    const me = requireUser(req);
    const aiId = Number(p.split('/')[4]);
    const ai = get('SELECT * FROM users WHERE id = ? AND owner_id = ? AND kind = ?', aiId, me.id, 'agent');
    if (!ai) return json(res, 404, { error: '没找到这个 AI 成员' });

    // 删掉它跟别人的私聊（不删的话会剩一条没有对方的空私聊挂在列表里）
    for (const dm of all(
      `SELECT c.id FROM conversations c JOIN members m ON m.conv_id = c.id
        WHERE c.kind = 'dm' AND m.user_id = ?`, aiId
    )) {
      run(
        'DELETE FROM hidden_messages WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ?)',
        dm.id
      );
      run('DELETE FROM messages WHERE conv_id = ?', dm.id);
      run('DELETE FROM members WHERE conv_id = ?', dm.id);
      run('DELETE FROM conversations WHERE id = ?', dm.id);
    }

    run('DELETE FROM ai_keys WHERE user_id = ?', aiId);
    run('DELETE FROM agent_sessions WHERE agent_id = ?', aiId);
    run('DELETE FROM members WHERE user_id = ?', aiId);
    run('DELETE FROM messages WHERE sender_id = ?', aiId);
    run('DELETE FROM users WHERE id = ?', aiId);
    return json(res, 200, { ok: true });
  }

  // 停用：作废所有钥匙，AI 立刻掉线
  if (method === 'POST' && /^\/api\/ai\/members\/\d+\/revoke$/.test(p)) {
    const me = requireUser(req);
    const aiId = Number(p.split('/')[4]);
    const ai = get('SELECT * FROM users WHERE id = ? AND owner_id = ? AND kind = ?', aiId, me.id, 'agent');
    if (!ai) return json(res, 404, { error: '没找到这个 AI 成员' });
    run('UPDATE ai_keys SET revoked = 1 WHERE user_id = ?', aiId);
    return json(res, 200, { ok: true });
  }

  // 桥接程序启动时的自检：我是谁、我在哪些群
  if (method === 'GET' && p === '/api/ai/me') {
    const me = requireUser(req);
    if (me.kind !== 'agent') return json(res, 403, { error: '这是给 AI 账号用的接口' });
    const convs = all(
      `SELECT c.id, c.kind, c.title FROM conversations c
         JOIN members m ON m.conv_id = c.id WHERE m.user_id = ?`, me.id
    ).map((c) => {
      // 私聊的 title 是内部标识 dm:a:b，给桥接看的必须是对方昵称
      if (c.kind !== 'dm') return c;
      const other = conversationMembers(c.id).find((u) => u.id !== me.id);
      return { ...c, title: other?.nickname || '私聊' };
    });
    const personaText = String(me.persona_text || '');
    const myExtensions = all(
      'SELECT e.id, e.name, e.prompt FROM extensions e JOIN ai_extensions x ON x.ext_id = e.id WHERE x.ai_id = ?',
      me.id
    );
    return json(res, 200, {
      me: publicUser(me),
      conversations: convs,
      // 装在它身上的能力扩展（桥接会把 prompt 拼进系统提示）
      extensions: myExtensions.map((e) => ({ id: e.id, name: e.name, prompt: e.prompt })),
      // 桥接靠 hash 判断人设有没有被改过，改了就重新注入
      persona: {
        text: personaText,
        hash: createHash('sha256').update(personaText).digest('hex').slice(0, 16),
      },
      capabilities: capsOf(me),
    });
  }

  /* ---- AI 自己的能力开关（主人设）---- */
  if (method === 'POST' && /^\/api\/ai\/members\/\d+\/flags$/.test(p)) {
    const me = requireUser(req);
    const aiId = Number(p.split('/')[4]);
    const ai = get('SELECT * FROM users WHERE id = ? AND owner_id = ? AND kind = ?', aiId, me.id, 'agent');
    if (!ai) return json(res, 404, { error: '没找到这个 AI 成员' });
    const body = await readJson(req);
    if (body.self_rename !== undefined) {
      run('UPDATE users SET self_rename = ? WHERE id = ?', body.self_rename ? 1 : 0, aiId);
    }
    if (body.capabilities && typeof body.capabilities === 'object') {
      const cur = capsOf(get('SELECT * FROM users WHERE id = ?', aiId));
      const next = { ...cur };
      for (const k of Object.keys(DEFAULT_CAPS)) {
        if (body.capabilities[k] !== undefined) next[k] = !!body.capabilities[k];
      }
      run('UPDATE users SET capabilities = ? WHERE id = ?', JSON.stringify(next), aiId);
    }
    const fresh = get('SELECT * FROM users WHERE id = ?', aiId);
    // 让这个 AI 的桥接立刻重读开关（不然它要等到重启才知道）
    toUser(aiId, { type: 'reload' });
    return json(res, 200, {
      ok: true,
      self_rename: Number(fresh.self_rename),
      capabilities: capsOf(fresh),
    });
  }

  /* ---- AI 人设：在页面上填 ---- */
  if (method === 'POST' && /^\/api\/ai\/members\/\d+\/persona$/.test(p)) {
    const me = requireUser(req);
    const aiId = Number(p.split('/')[4]);
    const ai = get('SELECT * FROM users WHERE id = ? AND owner_id = ? AND kind = ?', aiId, me.id, 'agent');
    if (!ai) return json(res, 404, { error: '没找到这个 AI 成员' });
    const body = await readJson(req);
    const text = String(body.persona || '').slice(0, 4000);
    run('UPDATE users SET persona_text = ? WHERE id = ?', text, aiId);
    return json(res, 200, { ok: true });
  }

  /* ---- AI 状态 ---- */
  if (method === 'GET' && p === '/api/ai') {
    requireUser(req);
    const cfg = loadAiConfig();
    return json(res, 200, describeAi(cfg));
  }

  /* ---- 事件流 ---- */
  if (method === 'GET' && p === '/api/stream') {
    const user = requireUser(req);
    return openStream(user.id, res, req);
  }

  json(res, 404, { error: 'no such api' });
}

/* --------------------------------- 启动 ---------------------------------- */

// 手机要录音必须走 HTTPS（浏览器只在安全上下文里给麦克风）。
// 有证书文件就起 https，没有就 http——本地 localhost 调试不需要证书。
const TLS_CERT = process.env.NEST_TLS_CERT || '';
const TLS_KEY = process.env.NEST_TLS_KEY || '';
const TLS_PFX = process.env.NEST_TLS_PFX || '';
const TLS_PASS = process.env.NEST_TLS_PASS || '';
const USE_TLS = Boolean((TLS_CERT && TLS_KEY) || TLS_PFX);
const tlsOpts = TLS_PFX
  ? { pfx: readFileSync(TLS_PFX), passphrase: TLS_PASS }
  : USE_TLS ? { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) } : null;

const server = (USE_TLS ? https.createServer(tlsOpts, handler) : http.createServer(handler));

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/nest-bridge.mjs') return await serveBridge(res);
    // 管理台：独立入口、独立登录、独立界面（只有 role=admin 能进）
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      return await handleAdmin(req, res, url, currentUser(req));
    }
    if (url.pathname.startsWith('/media/')) return await serveMedia(req, res, url.pathname.slice(7));
    return await serveStatic(res, url.pathname);
  } catch (err) {
    const code = err.code && Number.isInteger(err.code) ? err.code : 500;
    if (code === 500) console.error('[nest]', err);
    if (!res.headersSent) json(res, code, { error: err.message || 'internal' });
    else res.end();
  }
}

// 默认 requestTimeout 是 300 秒：对 SSE 这种长连接是致命的（每 5 分钟断一次）
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

// ---- 自己找本机 DSH：它的端口每次启动都变，写死环境变量迟早失效 ----
async function refreshDshBase(why = '启动') {
  try {
    const { findDshBase, isDshPort } = await import('../scripts/lib/dsh.mjs');
    const cur = process.env.DSH_WEB_URL || '';
    if (cur) {
      const port = Number(new URL(cur).port || 80);
      if (await isDshPort(port)) return cur;
      console.log(`[nest] DSH（${why}）：${cur} 已不通，重新找…`);
    }
    const base = await findDshBase({ log: (m) => console.log('[nest] ' + m) });
    if (base) {
      process.env.DSH_WEB_URL = base;
      console.log(`[nest] DSH（${why}）：${base}`);
    } else if (why === '启动') {
      console.log('[nest] 没找到 DSH：聊天照常，内置 AI 不会响应');
    }
    return base;
  } catch (err) {
    console.log('[nest] 找 DSH 出错：' + (err.message || err));
    return '';
  }
}

if (!process.env.NEST_DSH_BASE && !process.env.DSH_WEB_URL) await refreshDshBase('启动');
setInterval(() => { refreshDshBase('巡检'); }, 60_000).unref?.();

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) lan.push(n.address);
  }
  const sch = USE_TLS ? 'https' : 'http';
  console.log(`[nest] 本机   ${sch}://127.0.0.1:${PORT}`);
  for (const ip of lan) console.log(`[nest] 局域网 ${sch}://${ip}:${PORT}   ← 手机用这个`);
  if (!USE_TLS) {
    console.log('[nest] 注意：手机要用麦克风录音必须 https，证书怎么弄见 docs/DEPLOY.md');
  }
  if (HOST === '0.0.0.0') {
    console.log('[nest] 已对局域网开放（同网段的人能打开登录页，仍需账号密码）');
    console.log('[nest] 只想自己用：设 NEST_HOST=127.0.0.1 再启动');
  }
});

process.on('SIGINT', () => {
  for (const set of streams.values()) for (const r of set) r.end();
  server.close(() => process.exit(0));
});
