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
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 160) }; return r.result?.value; };
await send('Page.enable'); await send('Runtime.enable');
await sleep(1500);
console.log('  页面:', String(await ev('location.href')).slice(0, 40));
console.log('  身份:', await ev(`fetch('/api/bootstrap',{credentials:'same-origin'}).then(async (r) => r.ok ? (await r.json()).me.nickname : r.status)`));
console.log('  安全上下文:', await ev('window.isSecureContext'), '| 麦克风:', await ev('!!navigator.mediaDevices?.getUserMedia'));
console.log('  列表:', await ev(`JSON.stringify({
  local: document.querySelectorAll('#conv-list .conv:not(.world-entry)').length,
  entries: document.querySelectorAll('#conv-list .conv.world-entry').length,
  head: document.querySelector('.conv-world-head')?.textContent || '',
  rows: [...document.querySelectorAll('#conv-list .conv')].map((c) => (c.querySelector('.conv-name span')?.textContent || '')),
})`));
console.log('  世界:', await ev(`fetch('/api/worlds',{credentials:'same-origin'}).then(async (r) => r.ok ? JSON.stringify((await r.json()).worlds.map((w) => w.title + '/' + w.status + '/' + (w.convs||[]).length)) : r.status)`));
console.log('  错误:', JSON.stringify(errs.slice(0, 3)));
ws.close();
