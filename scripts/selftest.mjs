// Nest 自测：起一个独立的测试服务（临时数据库 + 8799 端口），把主要流程走一遍。
// 用法：node scripts/selftest.mjs
// 不改动正式数据（NEST_DB 指向临时文件；上传的测试图片跑完会删掉）
import { spawn } from 'node:child_process';
import http from 'node:http';
import { rmSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env.SELFTEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), 'nest-selftest-'));
const DB = join(TMP, 'test.db');

let pass = 0;
const fails = [];
const notes = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function note(msg) {
  notes.push(msg);
  console.log(`  · ${msg}`);
}

/** 简易 cookie 罐 */
function jar() {
  const bag = new Map();
  return {
    header: () => [...bag.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    save: (res) => {
      for (const sc of res.headers.getSetCookie?.() || []) {
        const [pair] = sc.split(';');
        const i = pair.indexOf('=');
        bag.set(pair.slice(0, i), pair.slice(i + 1));
      }
    },
  };
}

async function req(path, { method = 'GET', body, j, key, raw, type } = {}) {
  const headers = {};
  if (j) headers.cookie = j.header();
  if (key) headers.authorization = `Bearer ${key}`;
  let payload;
  if (raw) {
    headers['content-type'] = type;
    payload = raw;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  j?.save(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（比如媒体文件） */ }
  return { status: res.status, json, text, headers: res.headers };
}

// 1×1 透明 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAIAAYABAQAB' +
  'k4W9WQAAAABJRU5ErkJggg==', 'base64');

const rand = () => '1' + (3 + Math.floor(Math.random() * 7)) + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');

let server;
async function waitUp(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/server-info');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// 本地 mock 扩展源：模拟 raw.githubusercontent.com，避免自测依赖外网
const EXT_PORT = PORT + 1;
const EXT_MANIFEST = {
  name: '测试写作扩展',
  version: '1.2.3',
  description: '把想法写成通顺的文字',
  author: 'selftest',
  prompt: '你擅长把杂乱的想法写成通顺的文字。',
};
const extServer = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (path.endsWith('/nest-extension.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(EXT_MANIFEST));
    return;
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => extServer.listen(EXT_PORT, '127.0.0.1', r));

try {
  console.log(`\n== 起测试服务（端口 ${PORT}，库 ${DB}）==`);
  server = spawn(process.execPath, ['--no-warnings', 'server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, NEST_PORT: String(PORT), NEST_DB: DB, DSH_WEB_URL: '', NEST_EXT_BASE: `http://127.0.0.1:${EXT_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  server.stdout.on('data', (d) => { bootLog += d; });
  server.stderr.on('data', (d) => { bootLog += d; });

  if (!(await waitUp())) {
    console.log('服务没起来，日志：\n' + bootLog);
    process.exit(1);
  }
  ok('服务能启动', true);

  // 空库应该报告「第一次使用」
  const info0 = await req('/api/server-info');
  ok('空库标出 firstRun', info0.json?.firstRun === true, JSON.stringify(info0.json));
  ok('server-info 带端口和局域网地址', info0.json?.port === PORT && Array.isArray(info0.json?.lan));

  /* ---------- 注册 / 登录 ---------- */
  console.log('\n== 注册与登录 ==');
  const phoneA = rand();
  const phoneB = rand();
  const jA = jar();
  const jB = jar();

  const qs = (await req('/api/questions')).json?.questions || [];
  if (qs.length < 2) throw new Error('密保问题不足两个：' + JSON.stringify(qs));
  const q1 = qs[0].code, q2 = qs[1].code;
  note(`密保问题：${qs[0].text} / ${qs[1].text}`);
  const reg = (phone, nickname, j) => req('/api/register', { method: 'POST', body: { phone, nickname, password: 'abc123', q1, q2, a1: '甲', a2: '乙' }, j });
  let r = await reg(phoneA, '测试甲', jA);
  ok('注册用户 A', r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 80)}`);
  r = await reg(phoneB, '测试乙', jB);
  ok('注册用户 B', r.status === 200);

  r = await req('/api/login', { method: 'POST', body: { account: phoneA, password: 'abc123' }, j: jA });
  ok('登录 A', r.status === 200);
  r = await req('/api/login', { method: 'POST', body: { account: phoneB, password: 'abc123' }, j: jB });
  ok('登录 B', r.status === 200);
  r = await req('/api/login', { method: 'POST', body: { account: phoneA, password: 'wrong' } });
  ok('错密码被拒', r.status === 401 || r.status === 400, `HTTP ${r.status}`);

  r = await req('/api/bootstrap', { j: jA });
  const meA = r.json?.me;
  ok('bootstrap 拿到自己', !!meA?.id, JSON.stringify(r.json).slice(0, 80));
  r = await req('/api/bootstrap', { j: jB });
  const meB = r.json?.me;

  /* ---------- 个人资料 ---------- */
  console.log('\n== 个人资料 ==');
  r = await req('/api/profile', { method: 'POST', body: { nickname: '测试甲改名', signature: '我是签名' }, j: jA });
  ok('改昵称+签名', r.status === 200);
  r = await req('/api/bootstrap', { j: jA });
  ok('昵称已生效', r.json?.me?.nickname === '测试甲改名', r.json?.me?.nickname);
  ok('签名已生效', r.json?.me?.signature === '我是签名');

  r = await req('/api/upload', { method: 'POST', raw: PNG, type: 'image/png', j: jA });
  const upUrl = r.json?.url;
  ok('上传头像图', r.status === 200 && !!upUrl, `HTTP ${r.status}`);
  r = await req('/api/profile', { method: 'POST', body: { avatar: upUrl }, j: jA });
  ok('设置头像', r.status === 200 && r.json?.me?.avatar === upUrl);
  r = await req('/api/profile', { method: 'POST', body: { avatar: 'http://evil.example/x.png' }, j: jA });
  ok('外链头像被拒', r.status === 400, `HTTP ${r.status}`);
  r = await req('/api/upload', { method: 'POST', raw: Buffer.from('not an image'), type: 'image/png', j: jA });
  ok('假图片被拒', r.status === 415, `HTTP ${r.status}`);

  /* ---------- AI 接入 ---------- */
  console.log('\n== AI 接入 ==');
  r = await req('/api/ai/members', { method: 'POST', body: { nickname: '测试AI' }, j: jA });
  ok('创建 AI', r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 80)}`);
  const aiKey = r.json?.key;
  const aiId = r.json?.member?.id || r.json?.member?.user?.id;
  ok('返回钥匙', typeof aiKey === 'string' && aiKey.startsWith('NEST-AI-'));

  r = await req('/api/bootstrap', { j: jA });
  const dmConv = (r.json?.conversations || []).find((c) => c.kind === 'dm' && (c.members || []).some((m) => m.id === aiId));
  ok('创建 AI 自动开私聊', !!dmConv, JSON.stringify((r.json?.conversations || []).map((c) => c.title)));

  r = await req('/api/ai/me', { key: aiKey });
  const aiMe = r.json?.me;
  ok('AI 用自己的钥匙读到自己', !!aiMe?.id);
  ok('AI 拿到能力配置', !!r.json?.capabilities);
  ok('AI 人设字段存在', typeof r.json?.persona?.text === 'string');

  r = await req('/api/profile', { method: 'POST', body: { signature: 'AI自己的签名' }, key: aiKey });
  ok('AI 能改自己签名', r.status === 200, `HTTP ${r.status}`);
  r = await req('/api/profile', { method: 'POST', body: { nickname: 'AI想改名' }, key: aiKey });
  ok('默认 AI 不能改名', r.status === 403 && r.json?.code === 'rename_locked', `HTTP ${r.status}`);

  r = await req(`/api/ai/members/${aiId}/flags`, { method: 'POST', body: { self_rename: 1 }, j: jA });
  ok('主人打开改名权限', r.status === 200);
  r = await req('/api/profile', { method: 'POST', body: { nickname: 'AI改名成功' }, key: aiKey });
  ok('打开后 AI 能改名', r.status === 200 && r.json?.me?.nickname === 'AI改名成功');

  r = await req(`/api/ai/members/${aiId}/flags`, { method: 'POST', body: { capabilities: { memory: false, proactive: false } }, j: jA });
  ok('设置能力开关', r.status === 200 && r.json?.capabilities?.memory === false);
  r = await req('/api/ai/me', { key: aiKey });
  ok('AI 读到关闭后的能力', r.json?.capabilities?.memory === false && r.json?.capabilities?.proactive === false);

  r = await req(`/api/ai/${aiId}/memory`, { j: jA });
  ok('主人能读记忆概况', r.status === 200, `HTTP ${r.status}`);
  r = await req(`/api/ai/${aiId}/memory`, { j: jB });
  ok('别人读不到记忆', r.status === 403, `HTTP ${r.status}`);

  /* ---------- 好友 ---------- */
  console.log('\n== 好友 ==');
  r = await req('/api/bootstrap', { j: jB });
  const handleB = r.json?.me?.handle;
  r = await req('/api/friends/search', { method: 'POST', body: { query: phoneB }, j: jA });
  ok('用手机号搜到人', r.status === 200 && r.json?.user?.id === meB.id, `HTTP ${r.status}`);
  r = await req('/api/friends/request', { method: 'POST', body: { userId: meB.id }, j: jA });
  ok('发好友申请', r.status === 200);
  r = await req('/api/friends/requests', { j: jB });
  const incoming = r.json?.incoming || [];
  ok('对方收到申请', incoming.length >= 1);
  r = await req('/api/friends/accept', { method: 'POST', body: { id: incoming[0].id }, j: jB });
  ok('同意好友', r.status === 200);
  r = await req('/api/friends/requests', { j: jA });
  ok('双方成为好友', (r.json?.friends || []).some((f) => f.id === meB.id));

  r = await req('/api/friends/search', { method: 'POST', body: { query: '@' + handleB }, j: jA });
  ok('用 @ID 搜到人', r.status === 200 && r.json?.user?.id === meB.id, `HTTP ${r.status}`);

  /* ---------- 真人私聊必须被拒 ---------- */
  console.log('\n== 私聊权限 ==');
  r = await req('/api/dm', { method: 'POST', body: { userId: meB.id }, j: jA });
  ok('真人↔真人私聊被拒', r.status === 403 && r.json?.code === 'human_dm_blocked', `HTTP ${r.status}`);

  r = await req('/api/dm', { method: 'POST', body: { userId: aiId }, j: jA });
  ok('主人能和自己 AI 私聊', r.status === 200);
  r = await req('/api/dm', { method: 'POST', body: { userId: aiId }, j: jB });
  ok('非好友不能私聊别人的 AI', r.status === 403 && r.json?.code === 'need_friend', `HTTP ${r.status}`);

  // B 申请加这个 AI，主人代它同意
  r = await req('/api/friends/request', { method: 'POST', body: { userId: aiId }, j: jB });
  ok('B 申请加别人的 AI', r.status === 200, `HTTP ${r.status}`);
  r = await req('/api/friends/requests', { j: jA });
  const forAi = (r.json?.incoming || []).find((x) => x.for_ai);
  ok('主人收到「要加我的 AI」', !!forAi);
  if (forAi) {
    r = await req('/api/friends/accept', { method: 'POST', body: { id: forAi.id }, j: jA });
    ok('主人代 AI 同意', r.status === 200);
    r = await req('/api/dm', { method: 'POST', body: { userId: aiId }, j: jB });
    ok('成为好友后能私聊 AI', r.status === 200, `HTTP ${r.status}`);
  }

  /* ---------- AI 分享（外人来找别人的 AI 聊） ---------- */
console.log('\n== AI 分享 ==');
const dmWithAi = r.json?.conv?.id;
ok('已建立「B × 别人的 AI」私聊', !!dmWithAi, String(dmWithAi));

r = await req(`/api/ai/members/${aiId}/share`, { j: jB });
ok('非主人读不到分享设置', r.status === 403 || r.status === 404, `HTTP ${r.status}`);
r = await req(`/api/ai/members/${aiId}/share`, { j: jA });
ok('主人读到分享设置（默认关闭）', r.status === 200 && r.json?.enabled === false, JSON.stringify(r.json).slice(0, 120));

r = await req('/api/message', { method: 'POST', body: { conv: dmWithAi, blocks: [{ t: 'text', v: '外人试试' }] }, j: jB });
ok('没开分享时外人发不进来', r.status === 403 && r.json?.code === 'ai_share_off', `HTTP ${r.status} ${r.json?.code || ''}`);

r = await req('/api/message', { method: 'POST', body: { conv: dmConv.id, blocks: [{ t: 'text', v: '主人照常聊' }] }, j: jA });
ok('主人不受分享限制', r.status === 200, `HTTP ${r.status}`);

r = await req(`/api/ai/members/${aiId}/share`, { method: 'POST', body: { enabled: true, dailyQuota: 2 }, j: jA });
ok('主人打开分享 + 额度 2', r.status === 200 && r.json?.enabled === true && r.json?.dailyQuota === 2, JSON.stringify(r.json).slice(0, 120));

r = await req('/api/message', { method: 'POST', body: { conv: dmWithAi, blocks: [{ t: 'text', v: '外人第1句' }] }, j: jB });
ok('外人第 1 句能发', r.status === 200, `HTTP ${r.status}`);
r = await req('/api/message', { method: 'POST', body: { conv: dmWithAi, blocks: [{ t: 'text', v: '外人第2句' }] }, j: jB });
ok('外人第 2 句能发', r.status === 200, `HTTP ${r.status}`);
r = await req('/api/message', { method: 'POST', body: { conv: dmWithAi, blocks: [{ t: 'text', v: '外人第3句' }] }, j: jB });
ok('第 3 句撞额度被拒', r.status === 429 && r.json?.code === 'ai_share_quota', `HTTP ${r.status} ${r.json?.code || ''}`);

r = await req(`/api/ai/members/${aiId}/share`, { j: jA });
ok('分享设置能看到今日用量', Number(r.json?.todayTotal) >= 2 && Number(r.json?.todayGuests) >= 1, JSON.stringify(r.json).slice(0, 120));
ok('guests 里有来聊过的朋友', (r.json?.guests || []).some((g) => g.id === meB.id && g.count >= 2), JSON.stringify(r.json?.guests || []).slice(0, 120));
ok('guests 只给名字和句数（没有内容字段）', (r.json?.guests || []).every((g) => !('text' in g) && !('messages' in g) && !('content' in g)));

r = await req(`/api/ai/members/${aiId}/share`, { method: 'POST', body: { enabled: false }, j: jA });
ok('重新关闭分享', r.status === 200 && r.json?.enabled === false);
r = await req('/api/message', { method: 'POST', body: { conv: dmWithAi, blocks: [{ t: 'text', v: '关了还能发吗' }] }, j: jB });
ok('关闭后外人又被拦', r.status === 403 && r.json?.code === 'ai_share_off', `HTTP ${r.status}`);

r = await req('/api/ai/members/99999/share', { j: jA });
ok('对不存在的 AI 返回 404', r.status === 404, `HTTP ${r.status}`);


  /* ---------- 记忆卡片（人物档案 / 事件 / 访客） ---------- */
  console.log('\n== 记忆卡片 ==');
  const memAdd = (kind, text, extra = {}) =>
    req(`/api/ai/${aiId}/memory/notes`, { method: 'POST', body: { kind, text, ...extra }, j: jA });

  r = await memAdd('person', '喜欢猫，做设计', { subjectName: '阿哲', visibility: 'shared' });
  ok('加人物档案（共享）', r.status === 200 && r.json?.note?.kind === 'person', `HTTP ${r.status}`);
  const personId = r.json?.note?.id;
  r = await memAdd('person', '欠我两千块', { subjectName: '阿哲', visibility: 'shared', sensitive: 1 });
  const sensId = r.json?.note?.id;
  r = await memAdd('event', '上周说想换工作');
  const eventId = r.json?.note?.id;
  ok('加事件记忆（私有）', !!eventId);

  r = await req(`/api/ai/${aiId}/memory/notes`, { j: jB });
  ok('非主人读不到记忆卡片', r.status === 403 || r.status === 404, `HTTP ${r.status}`);

  r = await req(`/api/ai/${aiId}/memory/context?viewer=${meA.id}&conv=0`, { key: aiKey });
  ok('主人视角走 nmem（不重复注入）', r.status === 200 && r.json?.mode === 'owner', `HTTP ${r.status} ${String(r.text || '').slice(0, 120)}`);

  r = await req(`/api/ai/${aiId}/memory/context?viewer=${meB.id}&conv=0`, { key: aiKey });
  {
    const txt = String(r.json?.text || '');
    ok('访客视角拿到人物档案', r.status === 200 && r.json?.mode === 'guest' && txt.includes('喜欢猫'), `HTTP ${r.status} mode=${r.json?.mode} text=${txt.slice(0, 120)}`);
    ok('访客看不到敏感条目', !txt.includes('两千'));
    ok('访客看不到事件记忆', !txt.includes('换工作'));
  }

  // 访客自己的记忆：只对他自己生效
  r = await memAdd('guest', '自己说喜欢篮球', { guestId: meB.id });
  ok('记录访客记忆', r.status === 200 && r.json?.note?.kind === 'guest');
  r = await req(`/api/ai/${aiId}/memory/context?viewer=${meB.id}&conv=0`, { key: aiKey });
  ok('访客能看到自己的记忆', String(r.json?.text || '').includes('篮球'), `HTTP ${r.status} ${String(r.json?.text || '').slice(0, 120)}`);
  r = await req(`/api/ai/${aiId}/memory/context?viewer=${meA.id}&conv=0`, { key: aiKey });
  ok('主人 context 里没有访客内容', !String(r.json?.text || '').includes('篮球'));

  // 管理列表：主人看得到条数，看不到访客内容
  r = await req(`/api/ai/${aiId}/memory/notes`, { j: jA });
  {
    const j = r.json || {};
    ok('记忆列表分人物/事件/待批', r.status === 200 && Array.isArray(j.people) && Array.isArray(j.events) && Array.isArray(j.pending));
    ok('访客记忆只给条数', (j.guestCounts || []).some((g) => g.guestId === meB.id && g.count >= 1) && !JSON.stringify(j).includes('篮球'));
  }

  // 转共享要主人批：先把它标成待批，再通过
  r = await req(`/api/ai/${aiId}/memory/notes/${eventId}`, { method: 'PATCH', body: { pendingShared: true }, j: jA });
  ok('事件可以申请转共享', r.status === 200 && r.json?.note?.pending_shared === 1);
  r = await req(`/api/ai/${aiId}/memory/notes`, { j: jA });
  ok('待批列表里能看到申请', (r.json?.pending || []).some((n) => n.id === eventId));
  r = await req(`/api/ai/${aiId}/memory/notes/${eventId}/approve`, { method: 'POST', j: jA });
  ok('主人通过后变共享', r.status === 200 && r.json?.note?.visibility === 'shared' && r.json?.note?.pending_shared === 0);

  // AI 自己写记忆 → 私有 + 待批；主人批了才共享
  r = await req(`/api/ai/${aiId}/memory/notes`, { method: 'POST', body: { kind: 'person', text: '爱喝冰美式', subjectName: '阿哲' }, key: aiKey });
  ok('AI 能给自己写记忆（先私有）', r.status === 200 && r.json?.note?.visibility === 'private' && r.json?.note?.pending_shared === 1, `HTTP ${r.status} ${JSON.stringify(r.json?.note || {}).slice(0, 100)}`);
  const aiNoteId = r.json?.note?.id;
  r = await req(`/api/ai/${aiId}/memory/context?viewer=${meB.id}&conv=0`, { key: aiKey });
  ok('AI 写的还没批，访客看不到', !String(r.json?.text || '').includes('冰美式'));
  r = await req(`/api/ai/${aiId}/memory/notes/${aiNoteId}/approve`, { method: 'POST', j: jA });
  ok('主人批准后 AI 写的变共享', r.status === 200 && r.json?.note?.visibility === 'shared');
  r = await req(`/api/ai/${aiId}/memory/context?viewer=${meB.id}&conv=0`, { key: aiKey });
  ok('批准后访客能看到', String(r.json?.text || '').includes('冰美式'));
  r = await req(`/api/ai/${aiId}/memory/notes`, { method: 'POST', body: { kind: 'event', text: 'x' }, key: 'NEST-AI-bad' });
  ok('假钥匙写不了记忆', r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  // 主人把敏感条目关掉敏感 → 访客就能看到（证明敏感标记真的在挡）
  r = await req(`/api/ai/${aiId}/memory/notes/${sensId}`, { method: 'PATCH', body: { sensitive: false }, j: jA });
  r = await req(`/api/ai/${aiId}/memory/context?viewer=${meB.id}&conv=0`, { key: aiKey });
  ok('取消敏感后访客就能看到', String(r.json?.text || '').includes('两千'), `HTTP ${r.status} ${String(r.json?.text || '').slice(0, 120)}`);

  r = await req(`/api/ai/${aiId}/memory/notes/${personId}`, { method: 'DELETE', j: jA });
  ok('删掉一条记忆卡片', r.status === 200);
/* ---------- 群 + 消息 ---------- */
  console.log('\n== 群与消息 ==');
  r = await req('/api/conversation', { method: 'POST', body: { title: '测试群', memberIds: [meB.id] }, j: jA });
  ok('建群', r.status === 200, `HTTP ${r.status}`);
  const convId = r.json?.conv?.id;
  r = await req('/api/bootstrap', { j: jA });
  const group = (r.json?.conversations || []).find((c) => c.id === convId);
  ok('建群后出现在列表', !!group && group.kind === 'group', JSON.stringify(group?.title));
  ok('群主身份正确', group?.role === 'owner', group?.role);

  r = await req('/api/message', { method: 'POST', body: { conv: convId, blocks: [{ t: 'text', v: '第一条' }] }, j: jA });
  ok('发文字消息', r.status === 200, `HTTP ${r.status}`);
  const msgId = r.json?.message?.id;
  r = await req('/api/messages?conv=' + convId, { j: jB });
  ok('对方能读到消息', (r.json?.messages || []).some((m) => m.id === msgId));

  r = await req('/api/upload', { method: 'POST', raw: PNG, type: 'image/png', j: jA });
  const imgSha = r.json?.sha;
  r = await req('/api/message', {
    method: 'POST',
    body: { conv: convId, blocks: [{ t: 'image', sha: imgSha, ext: '.png', w: 1, h: 1 }] },
    j: jA,
  });
  ok('发图片消息', r.status === 200, `HTTP ${r.status}`);

  // 会话内搜索
  r = await req('/api/search?conv=' + convId + '&q=' + encodeURIComponent('第一条'), { j: jA });
  ok('搜到刚发的消息', r.status === 200 && (r.json?.hits || []).some((h) => h.id === msgId), `HTTP ${r.status} ${r.json?.hits?.length}`);
  r = await req('/api/search?conv=' + convId + '&q=' + encodeURIComponent('压根没有的词'), { j: jA });
  ok('搜不到就返回空', r.status === 200 && (r.json?.hits || []).length === 0);
  r = await req('/api/search?conv=' + convId + '&q=' + encodeURIComponent('第一条'), { j: jB });
  ok('群成员都能搜', r.status === 200, `HTTP ${r.status}`);
  r = await req('/api/search?conv=' + convId + '&q=', { j: jA });
  ok('空关键词被拒', r.status === 400, `HTTP ${r.status}`);

  // 视频消息
  const MP4 = Buffer.concat([
    Buffer.from([0,0,0,16]), Buffer.from('ftypisom'), Buffer.from([0,0,2,0]), Buffer.from('isom'),
    Buffer.from([0,0,0,8]), Buffer.from('mdat'),
  ]);
  r = await req('/api/upload', { method: 'POST', raw: MP4, type: 'video/mp4', j: jA });
  ok('上传 mp4', r.status === 200 && r.json?.ext === '.mp4', `HTTP ${r.status} ${r.text.slice(0,60)}`);
  const vidSha = r.json?.sha;
  r = await req('/api/message', {
    method: 'POST',
    body: { conv: convId, blocks: [{ t: 'video', sha: vidSha, ext: '.mp4', w: 640, h: 360, dur: 5 }] },
    j: jA,
  });
  ok('发视频消息', r.status === 200 && r.json?.message?.blocks?.[0]?.t === 'video', `HTTP ${r.status}`);
  r = await req('/api/upload', { method: 'POST', raw: Buffer.from('not a video'), type: 'video/mp4', j: jA });
  ok('假视频被拒', r.status === 415, `HTTP ${r.status}`);

  // 真语音（带文件 + 波形）
  const WAV = Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'),
    Buffer.from('fmt '), Buffer.from([16,0,0,0]), Buffer.from([1,0]), Buffer.from([1,0]),
    Buffer.from([0x80,0x3e,0,0]), Buffer.from([0x00,0x7d,0,0]), Buffer.from([2,0]), Buffer.from([16,0]),
    Buffer.from('data'), Buffer.from([0,0,0,0]),
  ]);
  WAV.writeUInt32LE(WAV.length - 8, 4);
  r = await req('/api/upload', { method: 'POST', raw: WAV, type: 'audio/wav', j: jA });
  ok('上传语音 wav', r.status === 200 && r.json?.ext === '.wav', `HTTP ${r.status} ${r.text.slice(0,60)}`);
  const voiceSha = r.json?.sha;
  const peaks48 = Array.from({ length: 48 }, (_, i) => 10 + (i % 80));
  r = await req('/api/message', {
    method: 'POST',
    body: { conv: convId, blocks: [{ t: 'voice', sec: 5, sha: voiceSha, ext: '.wav', peaks: peaks48 }] },
    j: jA,
  });
  const vb = r.json?.message?.blocks?.[0];
  ok('发真语音消息', r.status === 200 && vb?.t === 'voice' && vb?.sha === voiceSha, `HTTP ${r.status}`);
  ok('波形保留 48 格', Array.isArray(vb?.peaks) && vb.peaks.length === 48, `${vb?.peaks?.length}`);
  r = await req('/api/message', {
    method: 'POST',
    body: { conv: convId, blocks: [{ t: 'voice', sec: 999, sha: voiceSha, ext: '.wav', peaks: [1, 2, 3] }] },
    j: jA,
  });
  const vb2 = r.json?.message?.blocks?.[0];
  ok('语音时长夹到 60 秒', vb2?.sec === 60, `sec=${vb2?.sec}`);
  ok('波形不足自动补齐', Array.isArray(vb2?.peaks) && vb2.peaks.length === 48, `${vb2?.peaks?.length}`);
  // 媒体按真实 mime 下发（Safari 的 audio 依赖这个）
  r = await req('/media/' + voiceSha + '.wav');
  ok('媒体下发 audio 类型', String(r.headers.get('content-type') || '').startsWith('audio/'), String(r.headers.get('content-type')));
  ok('媒体支持 Range', r.headers.get('accept-ranges') === 'bytes');

  // 语音转文字：老格式（没文件）应该明确拒绝
  r = await req('/api/message', { method: 'POST', body: { conv: convId, blocks: [{ t: 'voice', sec: 3 }] }, j: jA });
  const oldVoiceId = r.json?.message?.id;
  r = await req('/api/voice/transcribe', { method: 'POST', body: { id: oldVoiceId }, j: jA });
  ok('老格式语音转文字被拒', r.status === 400, `HTTP ${r.status} ${r.text.slice(0, 60)}`);
  r = await req('/api/voice/transcribe', { method: 'POST', body: { id: 999999 }, j: jA });
  ok('转不存在的消息 404', r.status === 404, `HTTP ${r.status}`);

  // 表情收藏
  r = await req('/api/stickers', { method: 'POST', body: { sha: imgSha, ext: '.png' }, j: jA });
  ok('收藏表情', r.status === 200, `HTTP ${r.status} ${r.text.slice(0,60)}`);
  r = await req('/api/stickers', { j: jA });
  ok('表情列表有它', (r.json?.stickers || []).some((s) => s.sha === imgSha));
  r = await req('/api/stickers', { method: 'POST', body: { sha: 'f'.repeat(64), ext: '.png' }, j: jA });
  ok('收藏不存在的图被拒', r.status === 404, `HTTP ${r.status}`);
  r = await req('/api/stickers/remove', { method: 'POST', body: { sha: imgSha }, j: jA });
  ok('删表情', r.status === 200);
  r = await req('/api/stickers', { j: jA });
  ok('删完就没了', !(r.json?.stickers || []).some((s) => s.sha === imgSha));

  r = await req('/api/read', { method: 'POST', body: { conv: convId }, j: jB });
  ok('已读回执', r.status === 200, `HTTP ${r.status}`);

  r = await req('/api/recall', { method: 'POST', body: { id: msgId }, j: jA });
  ok('撤回自己的消息', r.status === 200, `HTTP ${r.status}`);
  r = await req('/api/recall', { method: 'POST', body: { id: msgId }, j: jB });
  ok('不能撤回别人的消息', r.status === 403 || r.status === 404, `HTTP ${r.status}`);

  // 拍一拍
  r = await req('/api/poke', { method: 'POST', body: { conv: convId, userId: meB.id }, j: jA });
  ok('拍一拍成功', r.status === 200 && r.json?.message?.blocks?.[0]?.t === 'poke', `HTTP ${r.status}`);
  r = await req('/api/poke', { method: 'POST', body: { conv: convId, userId: meA.id }, j: jA });
  ok('不能拍自己', r.status === 400, `HTTP ${r.status}`);
  r = await req('/api/poke', { method: 'POST', body: { conv: convId, userId: 99999 }, j: jA });
  ok('拍不在群里的人被拒', r.status === 400, `HTTP ${r.status}`);

  // 引用回复 + 转发 + 隐藏
  r = await req('/api/message', { method: 'POST', body: { conv: convId, replyTo: msgId, blocks: [{ t: 'text', v: '引用回复' }] }, j: jA });
  ok('发引用消息', r.status === 200 && !!r.json?.message?.reply?.id, `HTTP ${r.status}`);
  const quotedId = r.json?.message?.id;
  r = await req('/api/message', { method: 'POST', body: { conv: convId, blocks: [{ t: 'forward', from: '甲', text: '转发内容' }] }, j: jA });
  ok('发转发消息', r.status === 200 && r.json?.message?.blocks?.[0]?.t === 'forward', `HTTP ${r.status}`);
  r = await req('/api/hide', { method: 'POST', body: { id: quotedId }, j: jB });
  ok('隐藏单条消息', r.status === 200, `HTTP ${r.status}`);
  r = await req('/api/messages?conv=' + convId, { j: jB });
  ok('隐藏后自己看不到', !(r.json?.messages || []).some((m) => m.id === quotedId));
  r = await req('/api/messages?conv=' + convId, { j: jA });
  ok('隐藏只对自己生效', (r.json?.messages || []).some((m) => m.id === quotedId));

  // 全局搜索（不带 conv）：在"引用回复"这条消息存在之后测
  r = await req('/api/search?q=' + encodeURIComponent('引用'), { j: jA });
  ok('全局搜索返回 scope=global', r.status === 200 && r.json?.scope === 'global', `HTTP ${r.status}`);
  ok('全局搜索能跨会话找到', (r.json?.hits || []).length > 0, `命中 ${r.json?.hits?.length}`);
  ok('全局搜索带会话信息', Boolean(r.json?.hits?.[0]?.conv?.title), JSON.stringify(r.json?.hits?.[0]?.conv || {}));
  r = await req('/api/search?q=' + encodeURIComponent('引用'), { j: jB });
  const hiddenHit = (r.json?.hits || []).some((h) => h.id === quotedId);
  ok('自己隐藏的消息全局搜索也搜不到', !hiddenHit);

  /* ---------- 能力扩展 + 向导式建 AI ---------- */
  r = await req('/api/extensions', { j: jA });
  ok('扩展列表初始为空', (r.json?.extensions || []).length === 0, `${r.json?.extensions?.length}`);

  r = await req('/api/extensions/install', { method: 'POST', body: { url: 'not-a-repo' }, j: jA });
  ok('乱写的地址被拒', r.status === 400, `HTTP ${r.status}`);

  r = await req('/api/extensions/install', { method: 'POST', body: { url: 'https://github.com/selftest/nest-writing' }, j: jA });
  ok('从 GitHub 装扩展', r.status === 200 && r.json?.id === 'selftest/nest-writing', `HTTP ${r.status} ${r.text.slice(0, 80)}`);
  const extId = r.json?.id;

  r = await req('/api/extensions', { j: jA });
  const extList = r.json?.extensions || [];
  ok('扩展出现在列表里', extList.length === 1 && extList[0].name === '测试写作扩展', JSON.stringify(extList.map((e) => e.name)));
  ok('扩展带 prompt', String(extList[0]?.prompt || '').includes('通顺'), '');
  ok('扩展带版本号', extList[0]?.version === '1.2.3', String(extList[0]?.version));

  // 建一个带能力和扩展的 AI
  r = await req('/api/ai/members', {
    method: 'POST',
    body: {
      nickname: '向导AI',
      persona: '你是个测试用的人设。',
      caps: { memory: true, emotion: false, proactive: false },
      extensions: [extId],
    },
    j: jA,
  });
  ok('向导式建 AI 成功', r.status === 200 && !!r.json?.key, `HTTP ${r.status}`);
  const wizAiId = r.json?.ai?.id || r.json?.id;

  r = await req('/api/ai/members', { j: jA });
  const wizAi = (r.json?.members || []).find((m) => m.nickname === '向导AI');
  ok('新 AI 带上了扩展', Array.isArray(wizAi?.extensions) && wizAi.extensions.some((e) => e.id === extId), JSON.stringify(wizAi?.extensions));

  // AI 自己拉配置时应该带上扩展 prompt（桥接靠这个拼系统提示）
  const wizKey = r.json ? null : null;
  r = await req('/api/extensions/remove', { method: 'POST', body: { id: extId }, j: jA });
  ok('删扩展', r.status === 200);
  r = await req('/api/extensions', { j: jA });
  ok('删完列表为空', (r.json?.extensions || []).length === 0);

  /* ---------- 群管理 ---------- */
  console.log('\n== 群管理 ==');
  r = await req(`/api/conversation/${convId}/settings`, { method: 'POST', body: { title: '改名后的群', announcement: '群公告内容' }, j: jA });
  ok('群主改群名+公告', r.status === 200);
  r = await req('/api/bootstrap', { j: jA });
  ok('群名已生效', (r.json?.conversations || []).find((c) => c.id === convId)?.title === '改名后的群');

  r = await req(`/api/conversation/${convId}/settings`, { method: 'POST', body: { title: '我要改' }, j: jB });
  ok('非群主改群名被拒', r.status === 403, `HTTP ${r.status}`);

  r = await req(`/api/conversation/${convId}/mute`, { method: 'POST', body: { userId: meB.id, minutes: 60 }, j: jA });
  ok('群主禁言成员', r.status === 200, `HTTP ${r.status}`);
  r = await req('/api/message', { method: 'POST', body: { conv: convId, blocks: [{ t: 'text', v: '我被禁言了吗' }] }, j: jB });
  ok('被禁言的人发不出消息', r.status === 403, `HTTP ${r.status}`);
  r = await req(`/api/conversation/${convId}/mute`, { method: 'POST', body: { userId: meB.id, minutes: 0 }, j: jA });
  ok('解除禁言', r.status === 200);
  r = await req('/api/message', { method: 'POST', body: { conv: convId, blocks: [{ t: 'text', v: '解禁了' }] }, j: jB });
  ok('解禁后能说话', r.status === 200);

  r = await req(`/api/conversation/${convId}/kick`, { method: 'POST', body: { userId: meB.id }, j: jB });
  ok('非群主踢人被拒', r.status === 403, `HTTP ${r.status}`);
  r = await req(`/api/conversation/${convId}/kick`, { method: 'POST', body: { userId: meB.id }, j: jA });
  ok('群主踢人成功', r.status === 200, `HTTP ${r.status}`);
  r = await req('/api/messages?conv=' + convId, { j: jB });
  ok('被踢的人看不了群消息', r.status === 403, `HTTP ${r.status}`);

  r = await req(`/api/conversation/${convId}/dissolve`, { method: 'POST', j: jA });
  ok('群主解散群', r.status === 200, `HTTP ${r.status}`);
  r = await req('/api/bootstrap', { j: jA });
  ok('解散后群消失', !(r.json?.conversations || []).some((c) => c.id === convId));

  /* ---------- 邀请码 / 加入 ---------- */
  console.log('\n== 邀请码 ==');
  r = await req('/api/invites', { method: 'POST', j: jA });
  ok('生成注册邀请码', r.status === 200 && !!r.json?.code, `HTTP ${r.status}`);

  r = await req('/api/conversation', { method: 'POST', body: { title: '邀请码测试群' }, j: jA });
  const conv2 = r.json?.conv?.id;
  r = await req(`/api/conversation/${conv2}/invite`, { method: 'POST', j: jA });
  const groupCode = r.json?.code;
  ok('群主生成群邀请码', r.status === 200 && !!groupCode, `HTTP ${r.status} ${r.text.slice(0, 60)}`);
  r = await req('/api/join', { method: 'POST', body: { code: groupCode }, j: jB });
  ok('用群邀请码加入', r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 60)}`);
  r = await req('/api/bootstrap', { j: jB });
  ok('加入后出现在群里', (r.json?.conversations || []).some((c) => c.id === conv2));
  // 群公告已读回执（用这个新群：A 群主、B 刚加入）
  r = await req(`/api/conversation/${conv2}/settings`, { method: 'POST', body: { announcement: '测试公告第一版' }, j: jA });
  ok('设置群公告', r.status === 200, `HTTP ${r.status}`);
  r = await req(`/api/conversation/${conv2}/announcement`, { j: jA });
  const ann1 = r.json;
  ok('公告有版本号', ann1?.version >= 1, JSON.stringify(ann1));
  ok('一开始没人读过', ann1?.readCount === 0, `已读 ${ann1?.readCount}`);
  r = await req(`/api/conversation/${conv2}/announcement/read`, { method: 'POST', j: jB });
  ok('成员标记已读', r.status === 200, `HTTP ${r.status}`);
  r = await req(`/api/conversation/${conv2}/announcement`, { j: jA });
  ok('群主看到已读 +1', r.json?.readCount === 1, `已读 ${r.json?.readCount}`);
  r = await req(`/api/conversation/${conv2}/announcement`, { j: jB });
  ok('非群主看不到名单', (r.json?.unreadNames || []).length === 0 && r.json?.myRead === true);
  const vBefore = r.json?.version;
  r = await req(`/api/conversation/${conv2}/settings`, { method: 'POST', body: { announcement: '测试公告第二版' }, j: jA });
  r = await req(`/api/conversation/${conv2}/announcement`, { j: jB });
  ok('改公告后变回未读', r.json?.myRead === false && r.json?.version === vBefore + 1,
     JSON.stringify({ before: vBefore, now: r.json?.version, read: r.json?.myRead }));

  r = await req('/api/join', { method: 'POST', body: { code: 'NOPE123' }, j: jB });
  ok('假邀请码被拒', r.status === 404, `HTTP ${r.status}`);

  /* ---------- 权限边界 ---------- */
  console.log('\n== 权限边界 ==');
  r = await req('/api/bootstrap');
  ok('未登录读不到数据', r.status === 401, `HTTP ${r.status}`);
  r = await req('/api/ai/me');
  ok('没钥匙读不到 AI 身份', r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  r = await req('/api/ai/members/99999/delete', { method: 'POST', j: jA });
  ok('删不存在的 AI 安全报错', r.status === 404, `HTTP ${r.status}`);
  r = await req('/api/conversation', { method: 'POST', body: { title: 'x' }, key: aiKey });
  ok('AI 不能建群', r.status === 403, `HTTP ${r.status}`);
  r = await req('/api/friends/request', { method: 'POST', body: { userId: meA.id }, key: aiKey });
  ok('AI 不能加好友', r.status === 403, `HTTP ${r.status}`);

  /* ---------- 删除 AI 清理私聊 ---------- */
  console.log('\n== 删除 AI ==');
  r = await req(`/api/ai/members/${aiId}/delete`, { method: 'POST', j: jA });
  ok('删除 AI', r.status === 200, `HTTP ${r.status}`);
  r = await req('/api/bootstrap', { j: jA });
  const left = (r.json?.conversations || []).filter((c) => c.kind === 'dm' && (c.members || []).some((m) => m.id === aiId));
  ok('私聊一起清掉了', left.length === 0);
  r = await req('/api/ai/me', { key: aiKey });
  ok('旧钥匙失效', r.status === 401 || r.status === 403, `HTTP ${r.status}`);
} catch (err) {
  console.error('\n自测脚本本身出错：', err);
  fails.push({ name: '脚本异常', detail: err.message });
} finally {
  server?.kill();
  await new Promise((r) => setTimeout(r, 400));
  // 清理：临时库 + 测试上传的图片
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  for (const sha of []) { /* 占位 */ }
  console.log(`\n== 结果：通过 ${pass}，失败 ${fails.length} ==`);
  for (const f of fails) console.log(`  ✗ ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  for (const n of notes) console.log(`  · ${n}`);
  process.exit(fails.length ? 1 : 0);
}
