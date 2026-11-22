#!/usr/bin/env node
// 给 AI 自己用的小工具：改自己的昵称 / 签名 / 头像，查自己的资料。
// 钥匙和服务器地址从同目录的 nest-me.json 读（由 nest-bridge 启动时写入），
// 所以提示词里不用出现钥匙。
//
//   node nest-me.mjs me                          看自己现在什么样
//   node nest-me.mjs signature "一句话"           改签名
//   node nest-me.mjs nickname "新名字"            改名字（主人没允许会失败）
//   node nest-me.mjs avatar ./图片.png            换头像
//
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONF = join(HERE, 'nest-me.json');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!existsSync(CONF)) die('没找到 nest-me.json —— 先把 nest-bridge.mjs 跑起来，它会写这个文件');

let cfg;
try {
  cfg = JSON.parse(readFileSync(CONF, 'utf8'));
} catch {
  die('nest-me.json 读不动');
}
const { server, key } = cfg;
if (!server || !key) die('nest-me.json 里缺少 server 或 key');

const auth = { Authorization: `Bearer ${key}` };

async function call(path, init = {}) {
  const res = await fetch(server + path, {
    ...init,
    headers: { ...auth, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (!cmd || cmd === 'me') {
    const me = await call('/api/ai/me');
    console.log(`我是「${me.me.nickname}」 @${me.me.handle}`);
    console.log(`签名：${me.me.signature || '（还没填）'}`);
    console.log(`头像：${me.me.avatar || '（没有，用首字）'}`);
    console.log(`能力：${JSON.stringify(me.capabilities || {})}`);
    const mine = (await call('/api/profile/' + me.me.id)).user;
    console.log(`允许我改名字：${mine.self_rename ? '是' : '否'}`);
    console.log(`在 ${me.conversations.length} 个会话：${me.conversations.map((c) => c.title).join('、') || '无'}`);
  } else if (cmd === 'signature') {
    const v = rest.join(' ').trim();
    if (!v) die('用法：node nest-me.mjs signature "一句话"');
    const r = await call('/api/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature: v }),
    });
    console.log(`签名改成：${r.me.signature}`);
  } else if (cmd === 'nickname') {
    const v = rest.join(' ').trim();
    if (!v) die('用法：node nest-me.mjs nickname "新名字"');
    const r = await call('/api/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: v }),
    });
    console.log(`名字改成：${r.me.nickname}`);
  } else if (cmd === 'avatar') {
    const f = rest[0];
    if (!f) die('用法：node nest-me.mjs avatar ./图片.png');
    const p = resolve(f);
    if (!existsSync(p)) die(`找不到文件：${p}`);
    const bytes = readFileSync(p);
    const ext = p.toLowerCase().split('.').pop();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext];
    if (!mime) die('只支持 png / jpg / gif / webp');
    if (bytes.length > 8 * 1024 * 1024) die('图片不能超过 8MB');

    const up = await call('/api/upload', {
      method: 'POST',
      headers: { 'content-type': mime },
      body: bytes,
    });
    const r = await call('/api/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatar: up.url }),
    });
    console.log(`头像换了：${r.me.avatar}`);
  } else if (cmd === '--help' || cmd === 'help') {
    console.log(`用法：
  node nest-me.mjs me                       看我现在的资料
  node nest-me.mjs signature "一句话"        改签名
  node nest-me.mjs nickname "新名字"         改名字（主人没允许会失败）
  node nest-me.mjs avatar ./图片.png         换头像（png/jpg/gif/webp，≤8MB）
（文件：${basename(CONF)} 里存着服务器地址和我的钥匙，别动它、别外传）`);
  } else {
    die(`不认识的命令：${cmd}（用 --help 看用法）`);
  }
} catch (err) {
  console.error('失败：', err.message);
  process.exit(1);
}
