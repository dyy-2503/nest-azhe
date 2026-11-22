// 造一份「像真的」的初始数据：3 个人 + 1 个 AI 成员 + 一个群 + 一个私聊。
// 用法：npm run seed        首次灌数据
//       npm run reset       删库重灌
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const RESET = process.argv.includes('--reset');
const DB = process.env.NEST_DB || join(import.meta.dirname, '..', 'data', 'nest.db');

if (RESET) {
  for (const p of [DB, DB + '-wal', DB + '-shm']) {
    if (existsSync(p)) unlinkSync(p);
  }
  console.log('[seed] 已清空数据库');
}

const { db, run, get, addMessage, saveAttachment, now, MEDIA_DIR } = await import('./db.mjs');
const { hashPassword } = await import('./auth.mjs');

/* ------------------------------ 生成一张 PNG ------------------------------ */
// 之所以手写：不想为一个占位图引入依赖。真上传走 /api/upload。
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(w, h, shader) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = shader(x / w, y / h);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 蓝紫渐变 + 斜纹，像一个设计稿缩略图 */
function bannerShader(u, v) {
  const t = (u + v) / 2;
  const r = Math.round(12 + 120 * t);
  const g = Math.round(110 + 90 * (1 - t));
  const b = Math.round(255 - 40 * t);
  const stripe = (Math.floor((u * 24 + v * 6)) % 2 === 0) ? 12 : 0;
  return [r + stripe, g, b];
}

/* --------------------------------- 用户 ---------------------------------- */

const USERS = [
  { handle: 'azhe', nickname: '阿哲', sig: '与其修别人的壳，不如造自己的', kind: 'human' },
  { handle: 'xiaoman', nickname: '小满', sig: '今天也在假装很忙', kind: 'human' },
  { handle: 'laomao', nickname: '老猫', sig: '别问，问就是在排查', kind: 'human' },
  { handle: 'adai', nickname: '阿呆', sig: '坐在你们群里的那个 AI', kind: 'agent' },
];

const ids = {};
for (const u of USERS) {
  const exist = get('SELECT * FROM users WHERE handle = ?', u.handle);
  if (exist) {
    ids[u.handle] = exist.id;
    continue;
  }
  const info = run(
    `INSERT INTO users (handle, nickname, signature, status, kind, pw_hash, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    u.handle, u.nickname, u.sig, u.kind === 'agent' ? 'online' : 'offline', u.kind,
    u.kind === 'agent' ? '' : hashPassword('123456'), now()
  );
  ids[u.handle] = Number(info.lastInsertRowid);
}

/* --------------------------------- 邀请码 -------------------------------- */

for (const code of ['NEST-2026', 'NEST-DEMO', 'NEST-HOME']) {
  if (!get('SELECT 1 AS x FROM invites WHERE code = ?', code)) {
    run('INSERT INTO invites (code, created_by, created_at) VALUES (?,?,?)',
      code, ids.azhe, now());
  }
}

/* ---------------------------------- 群 ----------------------------------- */

let group = get(`SELECT * FROM conversations WHERE kind = 'group' AND title = ?`, '深夜写码互助会');
let groupId;
if (group) {
  groupId = group.id;
} else {
  const info = run(
    `INSERT INTO conversations (kind, title, owner_id, announcement, created_at)
     VALUES (?,?,?,?,?)`,
    'group', '深夜写码互助会', ids.azhe,
    '本群主要活动：互相看着对方写的 bug 发呆。', now()
  );
  groupId = Number(info.lastInsertRowid);
}

const ROLES = { azhe: 'owner', xiaoman: 'admin', laomao: 'member', adai: 'member' };
for (const [handle, role] of Object.entries(ROLES)) {
  if (!get('SELECT 1 AS x FROM members WHERE conv_id = ? AND user_id = ?', groupId, ids[handle])) {
    run('INSERT INTO members (conv_id, user_id, role, joined_at) VALUES (?,?,?,?)',
      groupId, ids[handle], role, now());
  }
}

/* --------------------------------- 私聊 ---------------------------------- */

let dm = get(`SELECT * FROM conversations WHERE kind = 'dm' AND title = ?`, 'dm:azhe:adai');
let dmId;
if (dm) {
  dmId = dm.id;
} else {
  const info = run(
    `INSERT INTO conversations (kind, title, owner_id, created_at) VALUES (?,?,?,?)`,
    'dm', 'dm:azhe:adai', ids.azhe, now()
  );
  dmId = Number(info.lastInsertRowid);
  for (const h of ['azhe', 'adai']) {
    run('INSERT INTO members (conv_id, user_id, role, joined_at) VALUES (?,?,?,?)',
      dmId, ids[h], 'member', now());
  }
}

/* -------------------------------- 一张图 --------------------------------- */

const png = makePng(360, 200, bannerShader);
const { createHash } = await import('node:crypto');
const sha = createHash('sha256').update(png).digest('hex');
writeFileSync(join(MEDIA_DIR, sha + '.png'), png);
saveAttachment(sha, 'image/png', png.length, '.png');

/* -------------------------------- 聊天记录 -------------------------------- */

const already = Number(get('SELECT COUNT(*) AS c FROM messages WHERE conv_id = ?', groupId).c);
if (already === 0) {
  const t0 = now() - 1000 * 60 * 96; // 96 分钟前
  const at = (min) => t0 + min * 60 * 1000;
  let seq = 0;
  const say = (handle, blocks, min, replyTo = 0) =>
    addMessage(groupId, ids[handle], blocks, replyTo, at(min));

  say('laomao', [{ t: 'text', v: '那个 hook 又断了，今天第三次。' }], 0);
  say('azhe', [{ t: 'text', v: '还是 `[Hook] receive path stale` 那套？' }], 1.4);
  say('laomao', [
    { t: 'text', v: '对。QQ 一更新，注入面就得重来一遍。修得动，但没意义。' },
  ], 2.6);
  say('xiaoman', [{ t: 'text', v: '所以你要自己写一个？' }], 5);
  const m5 = say('azhe', [
    { t: 'text', v: '嗯。与其天天修别人的壳，不如自己造一个 —— 顺带把 AI 直接塞进群里。' },
  ], 6.2);
  say('azhe', [{ t: 'image', sha, w: 360, h: 200, caption: '第一版界面草图' }], 6.5);
  say('adai', [
    { t: 'text', v: '这个我有话说 —— 你要的其实不是聊天软件，是一个不会跑路的家。' },
  ], 9);
  say('xiaoman', [{ t: 'text', v: '笑死，说得还挺对 😂' }], 11);
  say('laomao', [{ t: 'voice', sec: 6, text: '那 AI 能常驻群里吗' }], 14);
  const m9 = say('azhe', [
    { t: 'text', v: '能，而且它会是群里最会接话的那个。' },
  ], 15.5);
  say('xiaoman', [{ t: 'text', v: '@阿呆 你在吗' }], 30);
  say('adai', [{ t: 'text', v: '在。我一直都在，只是你们不说话的时候我在假装看代码。' }], 31);
  say('laomao', [{ t: 'text', v: '这比我同事像人多了' }], 33);
  say('azhe', [{ t: 'text', v: '今晚先把三栏和流式跑通，明天再说群管理。' }], 40);
  say('xiaoman', [{ t: 'text', v: '那我先去睡，明天验收 👋' }], 44);

  // 一条回复示例
  say('azhe', [{ t: 'text', v: '晚安，梦里没有 hook。' }], 45, m9.id);
}

const dmCount = Number(get('SELECT COUNT(*) AS c FROM messages WHERE conv_id = ?', dmId).c);
if (dmCount === 0) {
  const t1 = now() - 1000 * 60 * 20;
  addMessage(dmId, ids.azhe, [{ t: 'text', v: '在吗' }], 0, t1);
  addMessage(dmId, ids.adai, [{ t: 'text', v: '在。你要开始了吗？' }], 0, t1 + 60_000);
  addMessage(dmId, ids.azhe, [{ t: 'text', v: '开始了。三栏已经能跑。' }], 0, t1 + 120_000);
  addMessage(dmId, ids.adai, [
    { t: 'text', v: '那就别回头了。记得给消息编 seq，不然多端同步你迟早要重写。' },
  ], 0, t1 + 130_000);
}

console.log('[seed] 完成');
console.log('  演示账号: azhe / xiaoman / laomao  密码都是 123456');
console.log('  邀请码  : NEST-2026（未使用）');
console.log(`  群「深夜写码互助会」 id=${groupId}  私聊 id=${dmId}`);
