// 桥接纯函数单测：imageMeta（识别图片格式+尺寸）、stamp（时间戳格式）
// 用法：node scripts/test-bridge-helpers.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'bridge', 'nest-bridge.mjs'), 'utf8');

function extractFunc(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  // 从函数名后的第一个 { 开始做花括号配平
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${name} 花括号不配平`);
}

function extractStamp() {
  const m = /const stamp = \(ts\) => \{[\s\S]*?\n\};/.exec(src);
  if (!m) throw new Error('找不到 stamp');
  return m[0].replace(/^const stamp = /, '');
}

const imageMeta = new Function(extractFunc('imageMeta') + '\nreturn imageMeta;')();
const stamp = new Function(extractStamp().replace(/^\(ts\) =>/, 'return (ts) =>'))();

let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); } };

// 1x1 PNG
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAIAAYABAQABk4W9WQAAAABJRU5ErkJggg==', 'base64');
let m = imageMeta(png);
ok('PNG 识别', m && m.mime === 'image/png' && m.ext === '.png');
ok('PNG 尺寸 1x1', m && m.w === 1 && m.h === 1, JSON.stringify(m));

// GIF 89a 7x5
const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([7, 0, 5, 0, 0, 0, 0, 0])]);
m = imageMeta(gif);
ok('GIF 识别', m && m.mime === 'image/gif' && m.ext === '.gif');
ok('GIF 尺寸 7x5', m && m.w === 7 && m.h === 5, JSON.stringify(m));

// JPEG：SOI + SOF0(17x9)
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x09, 0x00, 0x11, 0x01, 0x01, 0x00]);
m = imageMeta(jpeg);
ok('JPEG 识别', m && m.mime === 'image/jpeg' && m.ext === '.jpg', JSON.stringify(m));
ok('JPEG 尺寸 17x9', m && m.w === 17 && m.h === 9, JSON.stringify(m));

// WebP VP8X 100x50
const webp = Buffer.alloc(32);
webp.write('RIFF', 0, 'ascii'); webp.write('WEBP', 8, 'ascii'); webp.write('VP8X', 12, 'ascii');
webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(49, 27, 3);
m = imageMeta(webp);
ok('WebP 识别', m && m.mime === 'image/webp', JSON.stringify(m));
ok('WebP 尺寸 100x50', m && m.w === 100 && m.h === 50, JSON.stringify(m));

// 非图片
ok('文本不算图片', imageMeta(Buffer.from('hello world, not an image')) === null);
ok('空数据不算图片', imageMeta(Buffer.alloc(0)) === null);

// 时间戳
const t = stamp(new Date('2026-11-27T18:23:00+08:00').getTime());
ok('时间戳格式 [MM-DD HH:MM]', /^\[\d{2}-\d{2} \d{2}:\d{2}\]$/.test(t), t);
const t2 = stamp(0);
ok('时间戳空值不崩', /^\[\d{2}-\d{2} \d{2}:\d{2}\]$/.test(t2), t2);

// selfHelp 里必须有发图指令
ok('selfHelp 提到 nest:image', src.includes('[[nest:image'));
ok('selfHelp 提到 nest:sticker', src.includes('[[nest:sticker'));
ok('selfHelp 版本 >= 3', /const SELF_HELP_VERSION = 3;/.test(src));

console.log('\n== 结果：通过 ' + pass + '，失败 ' + fails.length + ' ==');
if (fails.length) process.exit(1);
