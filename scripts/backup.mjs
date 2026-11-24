// 一键备份：把 data/ 打成 zip 放到大盘（默认 E:\nest-backup）
//
// 为什么不能直接压缩：服务器在跑的时候 data/nest.db 被占用，压缩会失败/压出坏库。
// 做法：先用 SQLite 的 VACUUM INTO 生成一份一致性快照（服务器不用停），
// 再连同 media/ 等一起打包。压完会校验条目数并做保留策略。
//
// 用法：
//   node scripts/backup.mjs                 # 备份到默认目录，保留 10 份
//   node scripts/backup.mjs --out E:\nest-backup --keep 20
//   node scripts/backup.mjs --data D:\qq-ai\chat\data

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ROOT = resolve(import.meta.dirname, '..');
const DATA = resolve(arg('data', join(ROOT, 'data')));
const OUT = resolve(arg('out', 'E:\\nest-backup'));
const KEEP = Number(arg('keep', '10'));

if (!existsSync(DATA)) {
  console.error('找不到数据目录：' + DATA);
  process.exit(1);
}

const stamp = (() => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();

const work = join(tmpdir(), 'nest-backup-' + stamp);
mkdirSync(work, { recursive: true });
const snapshotDb = join(work, 'nest.db');

console.log('▶ 备份 Nest');
console.log('  数据目录：' + DATA);
console.log('  输出目录：' + OUT);

// 1) 数据库一致性快照（VACUUM INTO 不会锁住服务器，只是读事务）
const src = join(DATA, 'nest.db');
if (existsSync(src)) {
  const db = new DatabaseSync(src);
  try {
    db.exec(`VACUUM INTO '${snapshotDb.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  console.log('  ✓ 数据库快照 ' + (statSync(snapshotDb).size / 1024 / 1024).toFixed(1) + ' MB');
} else {
  console.log('  ! 没有 nest.db，跳过数据库');
}

// 2) 拷贝除数据库热文件以外的数据
const staged = join(work, 'data');
mkdirSync(staged, { recursive: true });
let copied = 0;
for (const name of readdirSync(DATA)) {
  if (/^nest\.db(-wal|-shm)?$/.test(name)) continue; // 快照已经覆盖
  cpSync(join(DATA, name), join(staged, name), { recursive: true });
  copied++;
}
if (existsSync(snapshotDb)) cpSync(snapshotDb, join(staged, 'nest.db'));
console.log('  ✓ 其它数据 ' + copied + ' 项');

// 3) 打包（Windows 自带 bsdtar，-a 按扩展名选 zip）
mkdirSync(OUT, { recursive: true });
const zip = join(OUT, `nest-data-${stamp}.zip`);
execFileSync('tar', ['-a', '-cf', zip, '-C', work, 'data'], { stdio: 'inherit' });

// 4) 校验：条目数 + 里面有没有 nest.db
const list = execFileSync('tar', ['-tf', zip], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const hasDb = list.some((l) => l.replace(/\\/g, '/').endsWith('data/nest.db'));
const sizeMb = (statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`  ✓ 打包完成 ${sizeMb} MB，${list.length} 个条目，含 nest.db=${hasDb}`);
if (!hasDb) {
  console.error('  ✗ 备份里没有 nest.db，判为失败');
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

// 5) 保留策略
const olds = readdirSync(OUT)
  .filter((n) => /^nest-data-\d{8}-\d{6}\.zip$/.test(n))
  .map((n) => ({ n, at: statSync(join(OUT, n)).mtimeMs }))
  .sort((a, b) => b.at - a.at);
for (const o of olds.slice(KEEP)) {
  rmSync(join(OUT, o.n), { force: true });
  console.log('  · 清理旧备份 ' + o.n);
}

rmSync(work, { recursive: true, force: true });
console.log('✓ 备份完成：' + zip);
