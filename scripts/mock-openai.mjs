// 本地假 OpenAI 服务，只为一件事：在没有真实 key 的情况下验证流式协议接线。
// 用法：node scripts/mock-openai.mjs [port]
// 特性：/v1/chat/completions，stream:true，按字符吐 SSE，行为与真实服务一致。
import http from 'node:http';

const PORT = Number(process.argv[2] || 8899);

const REPLIES = [
  '这个是环境变量没同步，本地有线上没有。',
  '先别改，把日志最后 20 行贴出来看看。',
  '我赌是异步顺序的问题，加个 await 试试。',
];

const server = http.createServer(async (req, res) => {
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }

  let raw = '';
  for await (const c of req) raw += c;

  let body = {};
  try { body = JSON.parse(raw); } catch {}
  const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
  const echo = REPLIES[Math.floor(Math.random() * REPLIES.length)];

  console.log('[mock] model=%s messages=%d lastUser=%s',
    body.model, (body.messages || []).length, (lastUser?.content || '').slice(0, 40));

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // 先给一条只带 role 的增量，模拟真实服务
  send({ choices: [{ delta: { role: 'assistant' } }] });
  for (const ch of echo) {
    await new Promise((r) => setTimeout(r, 25));
    send({ choices: [{ delta: { content: ch } }] });
  }
  send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] http://127.0.0.1:${PORT}/v1/chat/completions`);
});
