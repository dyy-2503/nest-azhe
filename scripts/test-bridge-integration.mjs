// 桥接集成测试：真实 Nest 服务器 + 假 DSH（HTTP + WebSocket）
// 覆盖：时间戳、去重、新会话补历史、AI 发图/发表情、标记剥离
// 用法：node --no-warnings scripts/test-bridge-integration.mjs
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(os.tmpdir(), 'nest-bridge-it-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* ---------------- 假 DSH：HTTP RPC + WebSocket 事件流 ---------------- */
function startMockDsh(port, replyFor, prompts) {
  const streams = new Map();   // streamId -> { socket, sessionId }
  let turns = 0;
  const sockets = new Set();

  const rpc = (res, value) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: { ok: true, value } }));
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(200); res.end('mock-dsh'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let j = null; try { j = JSON.parse(body || '{}'); } catch {}
      const method = j?.method || (req.url || '').replace(/^\/api\//, '');
      const args = j?.payload?.args || {};
      if (method === 'session/create') return rpc(res, { sessionId: 'mock-session-1', agentPreset: 'standard' });
      if (method === 'session/list') return rpc(res, { sessions: [] });
      if (method === 'session/prompt') {
        const text = (args.request?.content || []).map((b) => b.text || '').join('');
        prompts.push(text);
        rpc(res, { ok: true });
        const reply = replyFor(text);
        const stream = [...streams.values()].pop();
        if (!stream) return;
        turns += 1;
        const turn = 'turn-' + turns;
        const send = (ev) => sendWs(stream.socket, JSON.stringify({ type: 'item', streamId: stream.streamId, value: { type: 'event', event: ev } }));
        setTimeout(() => {
          send({ type: 'turn/start', data: { turn } });
          send({ type: 'assistant/chunk', data: { text: reply } });
          send({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } });
          send({ type: 'turn/end', data: { turn } });
        }, 30);
        return;
      }
      return rpc(res, {});
    });
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        off += maskLen;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(off + len);
        if (opcode === 8) { try { socket.end(); } catch {} sockets.delete(socket); return; }
        if (opcode === 9) { /* ping 忽略 */ }
        if (opcode === 1) {
          let msg = null; try { msg = JSON.parse(payload.toString('utf8')); } catch {}
          if (msg?.type === 'open' && msg.streamId) {
            const sessionId = msg.payload?.args?.request?.address?.sessionId || '';
            streams.set(msg.streamId, { socket, streamId: msg.streamId, sessionId });
          }
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });

  function sendWs(socket, text) {
    const payload = Buffer.from(text);
    let head;
    if (payload.length < 126) head = Buffer.from([0x81, payload.length]);
    else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
    try { socket.write(Buffer.concat([head, payload])); } catch {}
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      close() { for (const s of sockets) { try { s.destroy(); } catch {} } server.close(); },
    }));
  });
}

/* ---------------- 真实 Nest 服务器 ---------------- */
async function startNest(port, dbFile) {
  const proc = spawn(process.execPath, ['--no-warnings', 'server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, NEST_PORT: String(port), NEST_DB: dbFile, DSH_WEB_URL: '', NEST_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/server-info'); if (r.ok) return { proc, base, log: () => log }; } catch {}
    await sleep(250);
  }
  throw new Error('Nest 没起来：\n' + log);
}

async function api(base, path, { method = 'GET', body, cookie, key } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (key) headers.authorization = 'Bearer ' + key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

/* ---------------- 主流程 ---------------- */
const nestPort = await freePort();
const dshPort = await freePort();
const prompts = [];
const pngPath = join(tmp, 'pic.png');
const stickerPath = join(tmp, 'sticker.png');
writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAIAAYABAQABk4W9WQAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(stickerPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAIAAYABAQABk4W9WQAAAABJRU5ErkJggg==', 'base64'));

const nest = await startNest(nestPort, join(tmp, 'it.db'));
const replies = [];
const mockDsh = await startMockDsh(dshPort, (promptText) => {
  if (promptText.includes('【你是谁】') || promptText.includes('收到请只回一个字')) return '好';
  if (promptText.includes('最近的记录')) return '好';
  if (promptText.includes('第一条测试消息')) return '收到，图在这\n[[nest:image ' + pngPath + ']]';
  if (promptText.includes('第二条测试消息')) return '嗯\n[[nest:sticker ' + stickerPath + ']]';
  return '好';
}, prompts);

// 主人 + AI + 私聊
const qs = (await api(nest.base, '/api/questions')).json.questions;
await api(nest.base, '/api/register', { method: 'POST', body: { phone: '13600000001', nickname: '主人', password: 'abc123', q1: qs[0].code, q2: qs[1].code, a1: 'a', a2: 'b' } });
const owner = (await api(nest.base, '/api/login', { method: 'POST', body: { account: '13600000001', password: 'abc123' } })).cookie;
const ai = (await api(nest.base, '/api/ai/members', { method: 'POST', body: { nickname: '小肥鱼' }, cookie: owner })).json;
const aiKey = ai.key;
const conv = ((await api(nest.base, '/api/ai/me', { key: aiKey })).json.conversations || []).find((c) => c.kind === 'dm');
if (!conv) throw new Error('AI 没有私聊会话');

// DSH 凭据：假 DSH 不验，但桥接启动会读这个文件
const dshHome = join(tmp, 'dshhome');
mkdirSync(dshHome, { recursive: true });
writeFileSync(join(dshHome, '.credentials.yaml'), 'client-connection/browser-session:\n  secret: ' + Buffer.from('test-secret-32-bytes-abcdefghij').toString('base64url') + '\n');

const stateFile = join(tmp, 'bridge-state.json');
const bridge = spawn(process.execPath, ['--no-warnings', 'bridge/nest-bridge.mjs', '--server', nest.base, '--key', aiKey, '--dsh', 'http://127.0.0.1:' + dshPort, '--state', stateFile], {
  cwd: ROOT,
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (d) => { bridgeLog += d; });
bridge.stderr.on('data', (d) => { bridgeLog += d; });

async function waitFor(fn, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(300);
  }
  console.log('  超时等待：' + what);
  return false;
}

const connected = await waitFor(() => bridgeLog.includes('已连上消息流'), 15000, '桥接连上消息流');
ok('桥接启动并连上消息流', connected, bridgeLog.slice(-300));

async function sendAndWait(text) {
  const before = (await api(nest.base, '/api/messages?conv=' + conv.id + '&limit=1', { cookie: owner })).json?.messages?.[0]?.id || 0;
  await api(nest.base, '/api/message', { method: 'POST', body: { conv: conv.id, blocks: [{ t: 'text', v: text }], clientId: randomUUID() }, cookie: owner });
  let reply = null;
  await waitFor(async () => {
    const msgs = (await api(nest.base, '/api/messages?conv=' + conv.id + '&after=' + before, { cookie: owner })).json?.messages || [];
    const aiMsg = [...msgs].reverse().find((m) => m.sender.kind === 'agent');
    if (aiMsg) { reply = aiMsg; return true; }
    return false;
  }, 25000, 'AI 回复 ' + text);
  return reply;
}

// 第一条：AI 应该发文字 + 一张图
const r1 = await sendAndWait('第一条测试消息');
const t1 = (r1?.blocks || []).filter((b) => b.t === 'text').map((b) => b.v).join('');
ok('AI 正常回复', !!r1 && t1.includes('收到'), t1.slice(0, 80));
ok('图片标记已从正文剥离', !t1.includes('nest:image'), t1.slice(0, 120));
const p1 = prompts.find((x) => x.includes('第一条测试消息')) || '';
ok('提示词带时间戳', /\[\d{2}-\d{2} \d{2}:\d{2}\] 主人：第一条测试消息/.test(p1), p1.slice(-160));
ok('新会话已补历史', prompts.some((x) => x.includes('最近的记录')));
ok('setup 提示只发一次', prompts.filter((x) => x.includes('【你是谁】')).length === 1, '次数=' + prompts.filter((x) => x.includes('【你是谁】')).length);

// 等图片消息落库
let imgMsg = null;
await waitFor(async () => {
  const msgs = (await api(nest.base, '/api/messages?conv=' + conv.id + '&limit=20', { cookie: owner })).json?.messages || [];
  imgMsg = [...msgs].reverse().find((m) => m.sender.kind === 'agent' && (m.blocks || []).some((b) => b.t === 'image'));
  return !!imgMsg;
}, 8000, 'AI 发的图片消息');
ok('AI 发出了图片消息', !!imgMsg, JSON.stringify(imgMsg?.blocks || []).slice(0, 120));

// 第二条：表情（w/h 应为 0），且不能重复第一条
const r2 = await sendAndWait('第二条测试消息');
const t2 = (r2?.blocks || []).filter((b) => b.t === 'text').map((b) => b.v).join('');
ok('AI 第二条正常回复', !!r2 && t2.includes('嗯'), t2.slice(0, 80));
const p2 = prompts.find((x) => x.includes('第二条测试消息')) || '';
ok('旧消息不会重复塞', !p2.includes('第一条测试消息'), p2.slice(-200));
ok('第二条带时间戳', /\[\d{2}-\d{2} \d{2}:\d{2}\] 主人：第二条测试消息/.test(p2));

let stickerMsg = null;
await waitFor(async () => {
  const msgs = (await api(nest.base, '/api/messages?conv=' + conv.id + '&limit=20', { cookie: owner })).json?.messages || [];
  stickerMsg = [...msgs].reverse().find((m) => m.sender.kind === 'agent' && (m.blocks || []).some((b) => b.t === 'image' && b.w === 0 && b.h === 0));
  return !!stickerMsg;
}, 8000, 'AI 发的表情消息');
ok('AI 发出了表情消息（无边框）', !!stickerMsg, JSON.stringify(stickerMsg?.blocks || []).slice(0, 120));

// 收尾
try { bridge.kill(); } catch {}
try { mockDsh.close(); } catch {}
try { nest.proc.kill(); } catch {}
await sleep(400);
try { rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log('\n== 结果：通过 ' + pass + '，失败 ' + fails.length + ' ==');
if (fails.length) { console.log('  失败项：' + fails.join('、')); process.exit(1); }
