const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:19222/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const errs = [];
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails?.exception?.description || '').slice(0, 140));
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
const ev = async (x, timeoutNote) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 140) }; return r.result?.value; };
await send('Page.enable'); await send('Runtime.enable');
await send('Page.reload'); await sleep(6000);
console.log('  页面:', String(await ev('location.href')).slice(0, 45));
console.log('  身份:', await ev(`document.querySelector('.rail-name, .me-name')?.textContent || '(取不到)'`));
console.log('  安全上下文:', await ev('window.isSecureContext'), '| 麦克风:', await ev('!!navigator.mediaDevices?.getUserMedia'));
console.log('  列表:', await ev(`JSON.stringify({
  local: document.querySelectorAll('#conv-list .conv:not(.world-entry)').length,
  entries: document.querySelectorAll('#conv-list .conv.world-entry').length,
  head: document.querySelector('.conv-world-head')?.textContent || '',
  rows: [...document.querySelectorAll('#conv-list .conv')].map((c) => c.querySelector('.conv-name span')?.textContent || ''),
})`));
console.log('  错误:', JSON.stringify(errs.slice(0, 3)));
const r = await send('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync('D:/qq-ai/chat/docs/phone-local-world.png', Buffer.from(r.data, 'base64'));
console.log('  截图: phone-local-world.png');
ws.close();
