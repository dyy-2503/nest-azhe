// 「世界」：把别的 Nest 服务器挂到本机，让一个会话列表里能同时看到
// 本地会话和远端服务器上的会话。
//
// 两种状态：
//   在线   —— 能连上远端 /api/server-info，会话列表取回来合并显示；
//   离线   —— 连不上（对方关机/没网），列表里灰掉，点它只提示，不做请求。
//
// 会话点击的交互：本机只负责"显示 + 跳转"。点远端会话会直接跳到那台服务器的
// 网页（带 #conv=<id> 深链），由那台服务器自己的界面继续聊——这样不用在本机
// 复制一套消息渲染和发送逻辑。
//
// 账号怎么来：加世界时用手机号+密码登录一次远端，把远端下发的会话 cookie 存
// 在本地库里（这台服务器是私有部署，数据就在自己家里的机器上）。

import { all, get, run, now } from './db.mjs';

const CACHE_TTL = 15_000; // 会话列表缓存 15 秒，避免每次刷新列表都打远端
const cache = new Map(); // worldId -> { at, snapshot }

const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '');

/** 连远端时统一带上 8 秒超时，别把本地请求拖死 */
function timed(ms = 8000) {
  return AbortSignal.timeout(ms);
}

function cookieFrom(res) {
  // Node 20+ 有 getSetCookie；老实现退回单值
  try {
    const list = res.headers.getSetCookie?.() || [];
    if (list.length) return list.map((c) => String(c).split(';')[0]).join('; ');
  } catch { /* ignore */ }
  const raw = res.headers.get('set-cookie') || '';
  return raw ? raw.split(';')[0] : '';
}

async function readError(res) {
  try {
    const j = await res.json();
    return j?.error || j?.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** 离线时用上次成功缓存的会话列表，列表里灰着显示，而不是整行消失 */
function cachedConvs(world) {
  try {
    const raw = world.convs_json || '';
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 远端是否活着 */
export async function probeWorld(world) {
  try {
    const res = await fetch(trimBase(world.base_url) + '/api/server-info', { signal: timed(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 拿远端会话列表（带缓存） */
export async function worldSnapshot(world, { force = false } = {}) {
  const id = Number(world.id);
  const hit = cache.get(id);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL) return hit.snapshot;

  const base = trimBase(world.base_url);
  let snapshot;
  try {
    const res = await fetch(base + '/api/bootstrap', {
      headers: world.cookie ? { cookie: world.cookie } : {},
      signal: timed(8000),
    });
    if (res.status === 401 || res.status === 403) {
      snapshot = { status: 'need-login', error: '登录已失效，请重新添加这个服务器', convs: [] };
    } else if (!res.ok) {
      snapshot = { status: 'offline', error: await readError(res), convs: cachedConvs(world) };
    } else {
      const data = await res.json();
      const convs = (data.conversations || []).map((c) => ({
        id: Number(c.id),
        kind: c.kind,
        title: c.title,
        avatar: c.avatar || '',
        unread: Number(c.unread) || 0,
        // 只留列表要用的字段，别把整份成员表搬过来
        lastText: c.lastMessage?.text || '',
        lastAt: Number(c.lastMessage?.createdAt) || 0,
        lastSenderId: Number(c.lastMessage?.senderId) || 0,
      }));
      snapshot = { status: 'online', error: '', convs, me: data.me?.nickname || '' };
      run('UPDATE worlds SET last_ok_at = ?, convs_json = ? WHERE id = ?', now(), JSON.stringify(convs), id);
    }
  } catch (err) {
    snapshot = { status: 'offline', error: String(err?.message || err).slice(0, 120), convs: cachedConvs(world) };
  }

  cache.set(id, { at: Date.now(), snapshot });
  return snapshot;
}

export function invalidateWorld(id) {
  cache.delete(Number(id));
}

export function listWorlds() {
  return all('SELECT * FROM worlds ORDER BY id');
}

/** 登录远端并把世界存下来（同一个地址重复添加就覆盖账号） */
export async function addWorld({ baseUrl, account, password, title }) {
  const base = trimBase(baseUrl);
  if (!/^https?:\/\//i.test(base)) throw new Error('地址要以 http:// 或 https:// 开头');
  if (!account || !password) throw new Error('要填远端账号和密码');

  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
    signal: timed(8000),
  });
  if (!res.ok) throw new Error(await readError(res));

  const cookie = cookieFrom(res);
  if (!cookie) throw new Error('远端没给登录凭据');

  // 用凭据读一次身份，顺便确认能进
  let meName = '';
  try {
    const boot = await fetch(base + '/api/bootstrap', { headers: { cookie }, signal: timed(8000) });
    if (boot.ok) meName = (await boot.json())?.me?.nickname || '';
  } catch { /* 身份拿不到也不影响挂载 */ }

  const host = (() => {
    try { return new URL(base).host; } catch { return base; }
  })();
  const label = String(title || '').trim() || `${meName || account} @ ${host}`;

  const exist = get('SELECT * FROM worlds WHERE base_url = ?', base);
  if (exist) {
    run(
      'UPDATE worlds SET account = ?, cookie = ?, title = ?, last_ok_at = ? WHERE id = ?',
      account, cookie, label, now(), Number(exist.id)
    );
    invalidateWorld(exist.id);
    return get('SELECT * FROM worlds WHERE id = ?', Number(exist.id));
  }

  const info = run(
    'INSERT INTO worlds (base_url, account, cookie, title, created_at, last_ok_at) VALUES (?,?,?,?,?,?)',
    base, account, cookie, label, now(), now()
  );
  return get('SELECT * FROM worlds WHERE id = ?', Number(info.lastInsertRowid));
}

export function removeWorld(id) {
  const wid = Number(id);
  const row = get('SELECT * FROM worlds WHERE id = ?', wid);
  if (!row) return false;
  run('DELETE FROM worlds WHERE id = ?', wid);
  invalidateWorld(wid);
  return true;
}

/** 给前端用的完整快照：每个世界 + 它的会话（在线的才有） */
export async function worldsForClient() {
  const rows = listWorlds();
  const out = await Promise.all(rows.map(async (w) => {
    const snap = await worldSnapshot(w);
    return {
      id: Number(w.id),
      baseUrl: w.base_url,
      title: w.title,
      account: w.account,
      status: snap.status,
      error: snap.error || '',
      // 离线时也把上次缓存的会话带上——列表里灰着显示，而不是整行消失
      convs: snap.convs || [],
    };
  }));
  return out;
}
