// 数据层：node:sqlite（Node 22 内置，免原生编译）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..');
// 数据目录可外置：桌面客户端把它指到用户目录（安装目录通常是只读的 Program Files）
export const DATA_DIR = process.env.NEST_DATA_DIR || join(ROOT, 'data');
export const MEDIA_DIR = join(DATA_DIR, 'media');
mkdirSync(MEDIA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.NEST_DB || join(DATA_DIR, 'nest.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA busy_timeout = 3000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  handle     TEXT    NOT NULL UNIQUE,
  nickname   TEXT    NOT NULL,
  avatar     TEXT    NOT NULL DEFAULT '',
  signature  TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'offline',
  kind       TEXT    NOT NULL DEFAULT 'human',   -- human | agent
  pw_hash    TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by INTEGER,
  used_by    INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL,                 -- dm | group
  title        TEXT    NOT NULL DEFAULT '',
  avatar       TEXT    NOT NULL DEFAULT '',
  owner_id     INTEGER,
  announcement TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  conv_id       INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'member',
  joined_at     INTEGER NOT NULL,
  muted_until   INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  muted         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conv_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  sender_id   INTEGER NOT NULL,
  body        TEXT    NOT NULL,                  -- JSON: MessageBlock[]
  reply_to    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER NOT NULL DEFAULT 0,
  recalled_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_conv_seq ON messages (conv_id, seq);
CREATE INDEX IF NOT EXISTS ix_msg_conv ON messages (conv_id, id);

CREATE TABLE IF NOT EXISTS attachments (
  sha        TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  ext        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 「删除」是本地删除：只对删它的那个人不可见，别人还看得见（和 QQ 一致）
CREATE TABLE IF NOT EXISTS hidden_messages (
  user_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  hidden_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

-- 每个会话绑定一个 DSH agent 会话（驱动为 dsh 时用）
CREATE TABLE IF NOT EXISTS agent_sessions (
  conv_id         INTEGER NOT NULL,
  agent_id        INTEGER NOT NULL,
  dsh_session_id  TEXT    NOT NULL,
  last_seen_msg_id INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (conv_id, agent_id)
);

-- AI 成员的接入钥匙：同学把这把钥匙填进他自己机器上的桥接程序。
-- 只存哈希，明文只在创建那一刻返回一次。
CREATE TABLE IF NOT EXISTS ai_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  key_hash     TEXT    NOT NULL UNIQUE,
  label        TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  revoked      INTEGER NOT NULL DEFAULT 0
);

-- 群邀请码：手机上一个新号靠它进到同一个群里（否则两个新号永远互相看不见）
CREATE TABLE IF NOT EXISTS group_invites (
  code       TEXT PRIMARY KEY,
  conv_id    INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);

-- 好友：双向各存一行，查起来简单
CREATE TABLE IF NOT EXISTS friendships (
  user_id    INTEGER NOT NULL,
  friend_id  INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

-- 好友申请：对方同意才算成
CREATE TABLE IF NOT EXISTS friend_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL,
  to_id      INTEGER NOT NULL,
  message    TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'pending',   -- pending | accepted | rejected
  created_at INTEGER NOT NULL,
  UNIQUE (from_id, to_id)
);
`);

export const now = () => Date.now();

// 轻量迁移：老库补列（CREATE TABLE IF NOT EXISTS 不会给已有表加字段）
{
  const cols = db.prepare('PRAGMA table_info(agent_sessions)').all();
  if (!cols.some((c) => c.name === 'last_seen_msg_id')) {
    db.exec('ALTER TABLE agent_sessions ADD COLUMN last_seen_msg_id INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.some((c) => c.name === 'persona_hash')) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN persona_hash TEXT NOT NULL DEFAULT ''");
  }

  // AI 成员归属于某个真人（0 = 系统内置）；真人自己没有任何归属
  const ucols = db.prepare('PRAGMA table_info(users)').all();  if (!ucols.some((c) => c.name === 'owner_id')) {
    db.exec('ALTER TABLE users ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0');
  }
  // 手机号 + 密保：注册新体系的字段（老演示账号这两块是空的）
  for (const [col, ddl] of [
    ['phone', "ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''"],
    ['sec_q1', "ALTER TABLE users ADD COLUMN sec_q1 TEXT NOT NULL DEFAULT ''"],
    ['sec_a1', "ALTER TABLE users ADD COLUMN sec_a1 TEXT NOT NULL DEFAULT ''"],
    ['sec_q2', "ALTER TABLE users ADD COLUMN sec_q2 TEXT NOT NULL DEFAULT ''"],
    ['sec_a2', "ALTER TABLE users ADD COLUMN sec_a2 TEXT NOT NULL DEFAULT ''"],
    ['role', "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"],
  ]) {
    if (!ucols.some((c) => c.name === col)) db.exec(ddl);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_users_phone
             ON users (phone) WHERE phone <> ''`);

  // 没有任何管理员时，让最早注册的那个真人当管理员（不写死用户名，换台机器也能用）
  const hasAdmin = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get();
  if (!Number(hasAdmin.n)) {
    const first = db.prepare("SELECT id FROM users WHERE kind = 'human' ORDER BY id LIMIT 1").get();
    if (first) db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(first.id);
  }

  const mcols = db.prepare('PRAGMA table_info(messages)').all();
  if (!mcols.some((c) => c.name === 'client_id')) {
    db.exec("ALTER TABLE messages ADD COLUMN client_id TEXT NOT NULL DEFAULT ''");
  }
  // 发送幂等：同一发送者的同一个 clientId 只允许存在一条
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_client
             ON messages (sender_id, client_id) WHERE client_id <> ''`);

  const acols = db.prepare('PRAGMA table_info(attachments)').all();
  if (!acols.some((c) => c.name === 'owner_id')) {
    db.exec('ALTER TABLE attachments ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0');
  }

  // 禁言：到期时间戳，0 = 没被禁
  const mcols2 = db.prepare('PRAGMA table_info(members)').all();
  if (!mcols2.some((c) => c.name === 'mute_until')) {
    db.exec('ALTER TABLE members ADD COLUMN mute_until INTEGER NOT NULL DEFAULT 0');
  }

  // AI 的人设：在页面上填，桥接启动时取走
  if (!ucols.some((c) => c.name === 'persona_text')) {
    db.exec("ALTER TABLE users ADD COLUMN persona_text TEXT NOT NULL DEFAULT ''");
  }

  // AI 能不能自己改昵称（默认不能，得主人点头）
  if (!ucols.some((c) => c.name === 'self_rename')) {
    db.exec('ALTER TABLE users ADD COLUMN self_rename INTEGER NOT NULL DEFAULT 0');
  }

  // 这个 AI 需要哪些 DSH 插件（JSON 数组：{spec, installed}），建号时定的，之后生成接入口令要用
  if (!ucols.some((c) => c.name === 'dsh_plugins')) {
    db.exec("ALTER TABLE users ADD COLUMN dsh_plugins TEXT NOT NULL DEFAULT ''");
  }
  // 群公告版本号：每改一次 +1，用来判断"谁看过这一版"
  const ccols = db.prepare('PRAGMA table_info(conversations)').all();
  if (!ccols.some((c) => c.name === 'announcement_version')) {
    db.exec('ALTER TABLE conversations ADD COLUMN announcement_version INTEGER NOT NULL DEFAULT 0');
  }
  // 表情收藏：把聊天里看到的好图存下来，面板里一点就发
  // 能力扩展包：从 GitHub 仓库里读一个 nest-extension.json（只有元数据 + prompt，
  // 不下载也不执行任何代码），装进来之后可以分配给某个 AI
  db.exec(`CREATE TABLE IF NOT EXISTS extensions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    repo_url TEXT NOT NULL DEFAULT '',
    installed_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ai_extensions (
    ai_id INTEGER NOT NULL,
    ext_id TEXT NOT NULL,
    PRIMARY KEY (ai_id, ext_id)
  )`);

  // 语音转写缓存：同一条语音只转一次（按文件 sha 去重）
  db.exec(`CREATE TABLE IF NOT EXISTS voice_texts (
    sha TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'zh',
    created_at INTEGER NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS stickers (
    user_id INTEGER NOT NULL,
    sha TEXT NOT NULL,
    ext TEXT NOT NULL DEFAULT '.png',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, sha)
  )`);

  // 别的 Nest 服务器（"世界"）：本地把远端服务器当成一个可挂载的会话来源
db.exec(`CREATE TABLE IF NOT EXISTS worlds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_url TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  cookie TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER NOT NULL DEFAULT 0,
  convs_json TEXT NOT NULL DEFAULT ''
)`);

// AI 分享：主人决定"别人能不能找它聊"，以及每个访客每天的额度
db.exec(`CREATE TABLE IF NOT EXISTS ai_share (
  ai_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  daily_quota INTEGER NOT NULL DEFAULT 30,
  allow_plugins INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
)`);

db.exec(`CREATE TABLE IF NOT EXISTS announcement_reads (
    conv_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (conv_id, user_id)
  )`);

  // AI 的可选能力（JSON）：记忆 / 情绪 / 主动说话…
  // 世界：缓存最后一次成功拿到的会话列表，离线时列表也能灰着显示
if (!all("PRAGMA table_info(worlds)").some((c) => c.name === 'convs_json')) {
  db.exec("ALTER TABLE worlds ADD COLUMN convs_json TEXT NOT NULL DEFAULT ''");
}

if (!ucols.some((c) => c.name === 'capabilities')) {
    db.exec("ALTER TABLE users ADD COLUMN capabilities TEXT NOT NULL DEFAULT ''");
  }
}

export function all(sql, ...p) {
  return db.prepare(sql).all(...p);
}
export function get(sql, ...p) {
  return db.prepare(sql).get(...p);
}
export function run(sql, ...p) {
  return db.prepare(sql).run(...p);
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

/** AI 的默认能力：全开（老数据没有这一列时也按全开算） */
export const DEFAULT_CAPS = { memory: true, emotion: true, proactive: true };

export function capsOf(u) {
  let raw = {};
  try { raw = JSON.parse(u?.capabilities || '{}'); } catch { raw = {}; }
  return { ...DEFAULT_CAPS, ...raw };
}

export function publicUser(u) {
  if (!u) return null;
  const out = {
    id: u.id,
    handle: u.handle,
    nickname: u.nickname,
    avatar: u.avatar || '',
    signature: u.signature || '',
    status: u.status || 'offline',
    kind: u.kind || 'human',
  };
  // 人设只挂在 AI 成员身上，只有它们需要；真人永远是空串
  if (out.kind === 'agent') {
    out.persona_text = u.persona_text || '';
    out.self_rename = Number(u.self_rename) || 0;
    out.capabilities = capsOf(u);
  }
  return out;
}

/** 一段消息的纯文本摘要，用于会话列表与引用块 */
export function preview(msg) {
  if (msg.recalledAt) return '消息已撤回';
  const blocks = msg.blocks || [];
  if (!blocks.length) return '';
  const text = blocks.filter((b) => b.t === 'text').map((b) => b.v).join('');
  if (text.trim()) {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > 48 ? one.slice(0, 48) + '…' : one;
  }
  const kind = blocks[0].t;
  if (kind === 'image') return '[图片]';
  if (kind === 'voice') return '[语音]';
  if (kind === 'file') return '[文件]';
  if (kind === 'sticker') return '[表情]';
  if (kind === 'video') return '[视频]';
  if (kind === 'forward') return '[聊天记录]';
  if (kind === 'poke') return '[拍了拍]';
  return '';
}

function hydrate(row) {
  const msg = {
    id: row.id,
    convId: row.conv_id,
    seq: row.seq,
    sender: {
      id: row.sender_id,
      handle: row.handle,
      nickname: row.nickname,
      avatar: row.avatar || '',
      kind: row.kind || 'human',
    },
    blocks: JSON.parse(row.body),
    replyTo: row.reply_to || 0,
    createdAt: row.created_at,
    editedAt: row.edited_at || 0,
    recalledAt: row.recalled_at || 0,
  };
  if (msg.replyTo) {
    const r = get(
      `SELECT m.id, m.body, m.recalled_at, u.nickname
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.id = ? AND m.conv_id = ?`,
      msg.replyTo, row.conv_id
    );
    if (r) {
      msg.reply = {
        id: r.id,
        nickname: r.nickname,
        text: preview({ blocks: JSON.parse(r.body) }),
        recalled: !!r.recalled_at,
      };
    }
  }
  return msg;
}

export function getMessage(id) {
  const row = get(
    `SELECT m.*, u.handle, u.nickname, u.avatar, u.kind
       FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.id = ?`,
    id
  );
  return row ? hydrate(row) : null;
}

/** 追加一条消息：seq 在会话内单调递增（多端同步 / 未读计数的地基） */
export function addMessage(convId, senderId, blocks, replyTo = 0, createdAt = now(), clientId = '') {
  return tx(() => {
    const { s } = get('SELECT COALESCE(MAX(seq),0) AS s FROM messages WHERE conv_id = ?', convId);
    const seq = Number(s) + 1;
    const info = run(
      `INSERT INTO messages (conv_id, seq, sender_id, body, reply_to, created_at, client_id)
       VALUES (?,?,?,?,?,?,?)`,
      convId, seq, senderId, JSON.stringify(blocks), replyTo, createdAt, String(clientId || '')
    );
    return getMessage(Number(info.lastInsertRowid));
  });
}

/** 某个用户在某个会话里「看得见」的最大 seq（隐藏消息不算，未读要用它算） */
export function visibleMaxSeq(convId, userId) {
  const row = get(
    `SELECT COALESCE(MAX(seq),0) AS s FROM messages
      WHERE conv_id = ?
        AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id = ?)`,
    convId, userId
  );
  return Number(row.s);
}

export function listMessages(convId, { before = 0, after = 0, limit = 40, viewer = 0 } = {}) {
  // 隐藏掉「被我删过」的消息
  const hideSql = viewer
    ? ' AND m.id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id = ?)'
    : '';
  const hideArgs = viewer ? [viewer] : [];

  // after：断线重连后的增量补拉（只取比它新的），升序返回
  if (after) {
    const rows = all(
      `SELECT m.*, u.handle, u.nickname, u.avatar, u.kind
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conv_id = ? AND m.id > ?${hideSql}
       ORDER BY m.id ASC LIMIT ?`,
      convId, after, ...hideArgs, limit + 1
    );
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).map(hydrate), hasMore };
  }

  const rows = before
    ? all(
        `SELECT m.*, u.handle, u.nickname, u.avatar, u.kind
           FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.conv_id = ? AND m.id < ?${hideSql}
          ORDER BY m.id DESC LIMIT ?`,
        convId, before, ...hideArgs, limit
      )
    : all(
        `SELECT m.*, u.handle, u.nickname, u.avatar, u.kind
           FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.conv_id = ?${hideSql}
          ORDER BY m.id DESC LIMIT ?`,
        convId, ...hideArgs, limit
      );
  const list = rows.reverse().map(hydrate);
  list.hasMore = rows.length >= limit && rows.length > 0;
  return list;
}

/** 本地删除：对这个用户隐藏，不动消息本体 */
export function hideMessage(userId, messageId) {
  run(
    `INSERT INTO hidden_messages (user_id, message_id, hidden_at) VALUES (?,?,?)
     ON CONFLICT(user_id, message_id) DO NOTHING`,
    userId, messageId, now()
  );
}

export function conversationMembers(convId) {
  return all(
    `SELECT u.id, u.handle, u.nickname, u.avatar, u.status, u.kind, m.role, m.mute_until
       FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.conv_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.id`,
    convId
  );
}

export function isMember(convId, userId) {
  return !!get('SELECT 1 AS x FROM members WHERE conv_id = ? AND user_id = ?', convId, userId);
}

// 修复历史附件：早先按客户端声明的 MIME 入库，叫 .jpg 的动图被记成 image/jpeg，
// 严格的浏览器/图片工具会当成坏图。按扩展名把 MIME 纠正一遍（幂等）。
function fixAttachmentMimes() {
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
  };
  try {
    for (const [ext, mime] of Object.entries(map)) {
      run('UPDATE attachments SET mime = ? WHERE ext = ? AND mime <> ?', mime, ext, mime);
    }
  } catch (e) {
    console.error('[nest] 修复附件 MIME 失败', e.message);
  }
}
// 等模块初始化完成后跑（run/语句在下面才建好）
setTimeout(fixAttachmentMimes, 0);

export function saveAttachment(sha, mime, bytes, ext, ownerId = 0) {
  // 内容寻址：同一份文件只存一次。owner 记录首次上传者（配额按它统计）。
  run(
    `INSERT INTO attachments (sha, mime, bytes, ext, owner_id, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(sha) DO UPDATE SET mime = excluded.mime, ext = excluded.ext`,
    sha, mime, bytes, ext, Number(ownerId) || 0, now()
  );
  return get('SELECT * FROM attachments WHERE sha = ?', sha);
}
