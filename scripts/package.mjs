// 打包成可分发的软件包：dist/nest-v<version>.zip
//
// 只带"跑起来需要的东西"：
//   server/ public/ bridge/ scripts/ docs/ package.json README LICENSE start.cmd install.cmd .gitignore
// 不带：
//   data/（你的聊天记录）、tools/（本地工具）、bridge 里的密钥、
//   node_modules（本项目零依赖）、任何 *.key / *.pfx
//
// 用法：node scripts/package.mjs
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
const version = pkg.version || '0.0.0';
const DIST = join(ROOT, 'dist');
const STAGE = join(DIST, `nest-v${version}`);
const OUT = join(DIST, `nest-v${version}.zip`);

// 需要进包的东西
const INCLUDE = ['server', 'public', 'bridge', 'scripts', 'docs', 'vendor', 'package.json', 'README.md', 'LICENSE', 'start.cmd', 'install.cmd', 'start.sh', '.gitignore'];
// 这些文件/目录绝不进包（密钥、用户数据、本地状态）
const EXCLUDE = [
  'bridge/nest-me.json',
  'bridge/_key.txt',
  'bridge/nest-bridge.state.json',
  'bridge/.nest-images',
  'bridge/.nest-videos',
  'bridge/.nest-voices',
  'data',
  'tools',
  'dist',
  'node_modules',
];

const shouldSkip = (rel) => {
  const norm = rel.replace(/\\/g, '/');
  return EXCLUDE.some((ex) => norm === ex || norm.startsWith(ex + '/'));
};

function copyTree(src, dst, relBase = '') {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) {
      const rel = relBase ? `${relBase}/${name}` : name;
      if (shouldSkip(rel)) continue;
      copyTree(join(src, name), join(dst, name), rel);
    }
  } else {
    cpSync(src, dst);
  }
}

console.log(`打包 Nest v${version}`);
rmSync(STAGE, { recursive: true, force: true });
rmSync(OUT, { force: true });
mkdirSync(STAGE, { recursive: true });

for (const item of INCLUDE) {
  const src = join(ROOT, item);
  if (!existsSync(src)) { console.log('  跳过（不存在）:', item); continue; }
  if (shouldSkip(item)) { console.log('  排除:', item); continue; }
  copyTree(src, join(STAGE, item), item);
  console.log('  +', item);
}

// 包里放一个空 data 目录（首次运行要写）
mkdirSync(join(STAGE, 'data'), { recursive: true });
writeFileSync(join(STAGE, 'data', '.gitkeep'), '', 'utf8');

// 校验：包里不能出现密钥
let leaks = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/nest-me\.json|_key\.txt|\.pfx$|\.pem$/i.test(name)) leaks.push(full.replace(STAGE, ''));
  }
})(STAGE);
if (leaks.length) {
  console.error('!! 包里混进了敏感文件：', leaks);
  process.exit(1);
}

// 打 zip（Windows 自带 tar 支持 zip）
const r = spawnSync('tar', ['-a', '-c', '-f', OUT, '-C', DIST, `nest-v${version}`], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('打包失败：tar 返回', r.status);
  process.exit(1);
}
rmSync(STAGE, { recursive: true, force: true });

const mb = (statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`\n完成：${OUT}  (${mb} MB)`);
console.log('分发方式：把这个 zip 发出去，对方解压 → 双击 install.cmd');
