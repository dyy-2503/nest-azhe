const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:19222/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 140) }; return r.result?.value; };
await send('Runtime.enable');
console.log('  当前:', String(await ev('location.href')).slice(0, 50));
console.log('  点返回:', await ev(`(() => { const b = document.querySelector('#crossworld-back'); if (!b) return 'no-bar'; b.click(); return 'clicked'; })()`));
const t0 = Date.now();
for (let i = 0; i < 30; i++) {
  await sleep(400);
  const u = String(await ev('location.href'));
  if (u.includes('127.0.0.1:8787')) { console.log('  已回来:', u.slice(0, 45), '| 耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's'); break; }
}
console.log('  本地身份:', await ev(`document.querySelector('.rail-name, .me-name')?.textContent || '—'`));
ws.close();
