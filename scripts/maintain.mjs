// 运维脚本：备份 + 清理。可以挂到计划任务里每天跑。
//   node scripts/maintain.mjs            备份 + 清理（默认保留 7 份备份、清理 90 天前的孤儿图片/过期会话）
//   node scripts/maintain.mjs --dry-run  只看会做什么，不动手
//   node scripts/maintain.mjs --backup-only
//
// 跨平台：只用 Node 内置能力，路径全部用 path.join 相对项目目录算。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DATA = join(ROOT, 'data');
const DB = process.env.NEST_DB || join(DATA, 'nest.db');
const MEDIA = join(DATA, 'media');
const BACKUPS = join(DATA, 'backups');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const BACKUP_ONLY = args.has('--backup-only');
const KEEP_BACKUPS = Number(process.env.NEST_BACKUP_KEEP || 7);
const MEDIA_TTL_DAYS = Number(process.env.NEST_MEDIA_TTL_DAYS || 90);
const SESSION_TTL_DAYS = Number(process.env.NEST_SESSION_TTL_DAYS || 60);

const log = (...a) => console.log(...a);
const bytes = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB');

if (!existsSync(DB)) {
  console.error(`找不到数据库：${DB}`);
  process.exit(1);
}

/* ---------------- 备份 ---------------- */
mkdirSync(BACKUPS, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = join(BACKUPS, `nest-${stamp}.db`);

if (DRY) {
  log(`[dry-run] 会备份到 ${basename(target)}`);
} else {
  // VACUUM INTO 是 SQLite 官方在线备份方式：不会读到写了一半的页
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  log(`备份完成：${basename(target)}（${bytes(statSync(target).size)}）`);
}

// 只留最近 N 份
const files = readdirSync(BACKUPS)
  .filter((f) => f.startsWith('nest-') && f.endsWith('.db'))
  .map((f) => ({ f, t: statSync(join(BACKUPS, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
for (const old of files.slice(KEEP_BACKUPS)) {
  if (DRY) log(`[dry-run] 会删旧备份 ${old.f}`);
  else { unlinkSync(join(BACKUPS, old.f)); log(`删旧备份 ${old.f}`); }
}

if (BACKUP_ONLY) process.exit(0);

/* ---------------- 清理 ---------------- */
const db = new DatabaseSync(DB);
const now = Date.now();
let removedFiles = 0;
let removedBytes = 0;

try {
  // 1) 过期会话
  const cutoff = now - SESSION_TTL_DAYS * 86400_000;
  const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE last_seen < ?').get(cutoff);
  if (Number(sessions.n) > 0) {
    if (DRY) log(`[dry-run] 会清掉 ${sessions.n} 个超过 ${SESSION_TTL_DAYS} 天的登录会话`);
    else {
      db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(cutoff);
      log(`清掉 ${sessions.n} 个过期登录会话`);
    }
  }

  // 2) 孤儿图片：附件表里有，但没有任何消息引用它的 sha
  const mediaCutoff = now - MEDIA_TTL_DAYS * 86400_000;
  const candidates = db.prepare('SELECT sha, ext, bytes, created_at FROM attachments WHERE created_at < ?').all(mediaCutoff);
  // 所有消息里出现过的 sha（够用：消息体是 JSON，直接扫一遍）
  const referenced = new Set();
  for (const row of db.prepare('SELECT body FROM messages WHERE body LIKE ?').all('%"sha"%')) {
    for (const m of String(row.body).matchAll(/"sha"\s*:\s*"([a-f0-9]{64})"/g)) referenced.add(m[1]);
  }
  for (const a of candidates) {
    if (referenced.has(a.sha)) continue;
    const file = join(MEDIA, a.sha + a.ext);
    if (DRY) { log(`[dry-run] 会删孤儿图片 ${basename(file)}（${bytes(a.bytes)}）`); continue; }
    try { unlinkSync(file); } catch { /* 已经不在了 */ }
    db.prepare('DELETE FROM attachments WHERE sha = ?').run(a.sha);
    removedFiles += 1;
    removedBytes += Number(a.bytes) || 0;
  }
  log(`孤儿图片：删 ${removedFiles} 个，释放 ${bytes(removedBytes)}`);

  // 3) 磁盘上存在但库里没有记录的野文件
  if (existsSync(MEDIA)) {
    const known = new Set(db.prepare('SELECT sha, ext FROM attachments').all().map((r) => r.sha + r.ext));
    let stray = 0;
    for (const f of readdirSync(MEDIA)) {
      if (known.has(f)) continue;
      const p = join(MEDIA, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (now - st.mtimeMs < 86400_000) continue;   // 一天内的不动，可能正在写
      if (DRY) log(`[dry-run] 会删野文件 ${f}`);
      else { unlinkSync(p); stray += 1; }
    }
    if (stray) log(`野文件：删 ${stray} 个`);
  }

  // 4) 数据库体积报告
  const total = db.prepare("SELECT COALESCE(SUM(bytes),0) AS s FROM attachments").get();
  const msgs = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
  log(`现状：消息 ${msgs.n} 条，附件 ${bytes(Number(total.s))}，数据库 ${bytes(statSync(DB).size)}`);
} finally {
  db.close();
}

if (!DRY) {
  // 顺手把备份也复制一份到 media 之外？不需要——data/backups 已经跟库在一起。
  log('完成');
}
