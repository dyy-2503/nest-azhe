// 管理台：独立入口 /admin、独立登录、独立界面。
// 只有 users.role = 'admin' 能进；普通用户登录页根本看不到这里。
import { all, get, run, now } from './db.mjs';
import { verifyPassword, newToken, parseCookies, sessionCookie, isSecureReq, newInvite } from './auth.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (ts) => (ts ? new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false }) : '—');
const maskPhone = (p) => (p && p.length === 11 ? `${p.slice(0, 3)}****${p.slice(7)}` : p || '—');

/* --------------------------------- 样式 ---------------------------------- */

const CSS = `
:root{--bg:#0f1216;--panel:#171b21;--line:#262c35;--text:#e6e9ef;--dim:#8b95a3;--accent:#4f9cf9;--danger:#e5674d;--ok:#3ecf8e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"Segoe UI","Noto Sans SC",sans-serif}
a{color:var(--accent);text-decoration:none}
.top{display:flex;align-items:center;gap:12px;padding:14px 22px;background:var(--panel);border-bottom:1px solid var(--line)}
.top h1{font-size:16px;margin:0;font-weight:600}
.top .badge{font-size:11px;padding:2px 8px;border-radius:20px;background:rgba(79,156,249,.15);color:var(--accent)}
.top .spacer{flex:1}
.top .who{font-size:12px;color:var(--dim)}
.wrap{max-width:1080px;margin:0 auto;padding:22px}
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.card b{display:block;font-size:22px;font-weight:600}
.card span{font-size:12px;color:var(--dim)}
section{margin-bottom:26px}
section h2{font-size:13px;color:var(--dim);font-weight:600;margin:0 0 8px;letter-spacing:.04em;text-transform:uppercase}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:9px 12px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)}
th{font-size:11.5px;color:var(--dim);font-weight:500;background:#1b2027}
tr:last-child td{border-bottom:0}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--line);margin-right:6px;vertical-align:1px}
.dot.on{background:var(--ok)}
.dim{color:var(--dim)}
.tag{font-size:10.5px;padding:1px 6px;border-radius:4px;background:#232a33;color:var(--dim)}
.tag.admin{background:rgba(79,156,249,.18);color:var(--accent)}
button{font:inherit;cursor:pointer;border:0;border-radius:7px;padding:5px 11px;background:#232a33;color:var(--text)}
button:hover{background:#2c343f}
button.danger{color:var(--danger)}
button.primary{background:var(--accent);color:#0b1016;font-weight:600}
.login{max-width:340px;margin:14vh auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px}
.login h1{font-size:18px;margin:0 0 4px}
.login p{font-size:12px;color:var(--dim);margin:0 0 18px}
.login label{display:block;font-size:12px;color:var(--dim);margin-bottom:12px}
.login input{width:100%;margin-top:5px;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
.login input:focus{outline:none;border-color:var(--accent)}
.login button{width:100%;padding:10px;margin-top:6px}
.err{color:var(--danger);font-size:12px;margin:10px 0 0;min-height:16px}
`;

/* --------------------------------- 页面 ---------------------------------- */

function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Nest 管理台</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

function loginPage(err = '') {
  return page('登录', `
  <form class="login" method="post" action="/admin/login">
    <h1>Nest 管理台</h1>
    <p>只有管理员账号能进。普通用户请用主界面登录。</p>
    <label>账号或手机号<input name="account" autocomplete="username" autofocus></label>
    <label>密码<input name="password" type="password" autocomplete="current-password"></label>
    <p class="err">${esc(err)}</p>
    <button class="primary" type="submit">进入管理台</button>
  </form>`);
}

function consolePage(user, msg = '') {
  const stats = {
    humans: Number(get("SELECT COUNT(*) AS n FROM users WHERE kind = 'human'").n),
    agents: Number(get("SELECT COUNT(*) AS n FROM users WHERE kind = 'agent'").n),
    convs: Number(get('SELECT COUNT(*) AS n FROM conversations').n),
    msgs: Number(get('SELECT COUNT(*) AS n FROM messages').n),
    aiOnline: Number(get(
      `SELECT COUNT(DISTINCT k.user_id) AS n FROM ai_keys k
        WHERE k.revoked = 0 AND k.last_used_at > ?`, now() - 120_000
    ).n),
  };

  const ais = all(
    `SELECT u.id, u.nickname, u.owner_id, o.nickname AS owner,
            (SELECT COUNT(*) FROM ai_keys k WHERE k.user_id = u.id AND k.revoked = 0) AS keys,
            (SELECT COALESCE(MAX(last_used_at),0) FROM ai_keys k WHERE k.user_id = u.id) AS lastUsed
       FROM users u LEFT JOIN users o ON o.id = u.owner_id
      WHERE u.kind = 'agent' ORDER BY u.id`
  ).map((a) => ({
    ...a,
    groups: all(
      `SELECT c.title FROM conversations c JOIN members m ON m.conv_id = c.id
        WHERE m.user_id = ? AND c.kind = 'group'`, a.id
    ).map((g) => g.title),
  }));

  const users = all(
    `SELECT id, nickname, handle, phone, role, kind, created_at,
            (SELECT COALESCE(MAX(last_seen),0) FROM sessions s WHERE s.user_id = users.id) AS lastSeen
       FROM users WHERE kind = 'human' ORDER BY id`
  );

  const invites = all('SELECT code, used_by, created_at FROM invites ORDER BY created_at DESC LIMIT 20');

  const aiRows = ais.map((a) => {
    const online = a.lastUsed && now() - a.lastUsed < 120_000;
    return `<tr>
      <td><b>${esc(a.nickname)}</b></td>
      <td class="dim">${esc(a.owner || '系统')}</td>
      <td><span class="dot ${online ? 'on' : ''}"></span>${online ? '在线' : (a.lastUsed ? '离线' : '从未连接')}</td>
      <td>${a.keys}</td>
      <td>${a.groups.length ? a.groups.map((g) => `<span class="tag">${esc(g)}</span>`).join(' ') : '<span class="dim">没进群</span>'}</td>
      <td>${a.keys ? `<form method="post" action="/admin/action" style="margin:0">
            <input type="hidden" name="act" value="revoke"><input type="hidden" name="uid" value="${a.id}">
            <button class="danger" type="submit">作废钥匙</button></form>` : '<span class="dim">—</span>'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="dim">还没有 AI 成员</td></tr>';

  const userRows = users.map((u) => `<tr>
      <td><b>${esc(u.nickname)}</b> ${u.role === 'admin' ? '<span class="tag admin">管理员</span>' : ''}</td>
      <td class="dim">${esc(maskPhone(u.phone))}</td>
      <td class="dim">${esc(u.handle)}</td>
      <td class="dim">${fmt(u.lastSeen)}</td>
      <td><form method="post" action="/admin/action" style="margin:0">
            <input type="hidden" name="act" value="role">
            <input type="hidden" name="uid" value="${u.id}">
            <input type="hidden" name="role" value="${u.role === 'admin' ? 'user' : 'admin'}">
            <button type="submit">${u.role === 'admin' ? '取消管理员' : '设为管理员'}</button></form></td>
    </tr>`).join('') || '<tr><td colspan="5" class="dim">还没有真人用户</td></tr>';

  const inviteRows = invites.map((i) => `<tr>
      <td><code>${esc(i.code)}</code></td>
      <td>${i.used_by ? '<span class="dim">已用</span>' : '<span style="color:var(--ok)">可用</span>'}</td>
      <td class="dim">${fmt(i.created_at)}</td>
    </tr>`).join('') || '<tr><td colspan="3" class="dim">还没有邀请码</td></tr>';

  return page('管理台', `
  <div class="top">
    <h1>Nest 管理台</h1><span class="badge">管理员</span>
    <span class="spacer"></span>
    <span class="who">${esc(user.nickname)}</span>
    <form method="post" action="/admin/logout" style="margin:0"><button type="submit">退出</button></form>
  </div>
  <div class="wrap">
    ${msg ? `<p style="color:var(--ok);margin-top:0">${esc(msg)}</p>` : ''}
    <div class="cards">
      <div class="card"><b>${stats.humans}</b><span>真人用户</span></div>
      <div class="card"><b>${stats.agents}</b><span>AI 成员</span></div>
      <div class="card"><b>${stats.aiOnline}</b><span>AI 在线</span></div>
      <div class="card"><b>${stats.convs}</b><span>会话</span></div>
      <div class="card"><b>${stats.msgs}</b><span>消息</span></div>
    </div>

    <section>
      <h2>AI 接入</h2>
      <table><thead><tr><th>AI</th><th>主人</th><th>状态</th><th>钥匙</th><th>所在群</th><th></th></tr></thead>
      <tbody>${aiRows}</tbody></table>
    </section>

    <section>
      <h2>真人用户</h2>
      <table><thead><tr><th>昵称</th><th>手机号</th><th>内部 ID</th><th>上次活跃</th><th>权限</th></tr></thead>
      <tbody>${userRows}</tbody></table>
    </section>

    <section>
      <h2>邀请码
        <form method="post" action="/admin/action" style="display:inline;margin-left:8px">
          <input type="hidden" name="act" value="invite">
          <button type="submit">生成一个</button>
        </form>
      </h2>
      <table><thead><tr><th>码</th><th>状态</th><th>生成时间</th></tr></thead><tbody>${inviteRows}</tbody></table>
    </section>
  </div>`);
}

/* -------------------------------- 分发 ---------------------------------- */

async function readForm(req) {
  let raw = '';
  for await (const c of req) raw += c;
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

// 管理台登录限流：公网暴露时防止被暴力猜密码
const adminHits = new Map();
function adminLimited(req, max = 10, windowMs = 10 * 60_000) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  const ts = Date.now();
  const rec = adminHits.get(ip);
  if (!rec || ts - rec.start > windowMs) { adminHits.set(ip, { start: ts, n: 1 }); return false; }
  rec.n += 1;
  return rec.n > max;
}

const redirect = (res, to) => {
  res.writeHead(302, { location: to });
  res.end();
};

/** @param user 当前登录用户（可能是 null / 非管理员） */
export async function handleAdmin(req, res, url, user) {
  const method = req.method;
  const p = url.pathname;

  // 登录
  if (method === 'POST' && p === '/admin/login') {
    if (adminLimited(req)) {
      res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' });
      res.end(loginPage('试太多次了，等 10 分钟再试'));
      return;
    }
    const f = await readForm(req);
    const account = String(f.account || '').trim();
    const pw = String(f.password || '');
    const row = get('SELECT * FROM users WHERE phone = ?', account)
      || get('SELECT * FROM users WHERE handle = ?', account);

    if (!row || row.role !== 'admin' || !verifyPassword(pw, row.pw_hash)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end(loginPage('账号或密码不对，或者这个账号不是管理员'));
      return;
    }
    const token = newToken();
    run('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?,?,?,?)',
      token, row.id, now(), now());
    res.writeHead(302, { location: '/admin', 'set-cookie': sessionCookie(token, { secure: isSecureReq(req) }) });
    res.end();
    return;
  }

  if (method === 'POST' && p === '/admin/logout') {
    const token = parseCookies(req.headers.cookie || '').sid;
    if (token) run('DELETE FROM sessions WHERE token = ?', token);
    res.writeHead(302, { location: '/admin', 'set-cookie': sessionCookie('', { clear: true, secure: isSecureReq(req) }) });
    res.end();
    return;
  }

  // 管理动作
  if (method === 'POST' && p === '/admin/action') {
    if (!user || user.role !== 'admin') return redirect(res, '/admin');
    const f = await readForm(req);
    const uid = Number(f.uid) || 0;

    if (f.act === 'revoke' && uid) {
      run('UPDATE ai_keys SET revoked = 1 WHERE user_id = ?', uid);
      return redirect(res, '/admin?msg=' + encodeURIComponent('已作废该 AI 的全部钥匙'));
    }
    if (f.act === 'invite') {
      let code = '';
      do {
        code = newInvite();
      } while (get('SELECT 1 AS x FROM invites WHERE code = ?', code));
      run('INSERT INTO invites (code, created_by, created_at) VALUES (?,?,?)', code, user.id, now());
      return redirect(res, '/admin?msg=' + encodeURIComponent('新邀请码：' + code));
    }
    if (f.act === 'role' && uid && user.id !== uid) {
      const next = f.role === 'admin' ? 'admin' : 'user';
      run('UPDATE users SET role = ? WHERE id = ?', next, uid);
      return redirect(res, '/admin?msg=' + encodeURIComponent('权限已更新'));
    }
    return redirect(res, '/admin');
  }

  // 页面
  if (method === 'GET' && (p === '/admin' || p === '/admin/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (!user || user.role !== 'admin') {
      res.end(loginPage());
      return;
    }
    res.end(consolePage(user, url.searchParams.get('msg') || ''));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}
