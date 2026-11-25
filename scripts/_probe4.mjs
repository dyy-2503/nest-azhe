async function target() { const l = await (await fetch('http://127.0.0.1:19222/json/list', { signal: AbortSignal.timeout(5000) })).json(); return l.find((t) => t.type === 'page'); }
async function ev(expr, ms = 15000) {
  const page = await target(); const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const result = await new Promise((resolve) => { const timer = setTimeout(() => resolve({ timeout: true }), ms);
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(timer); resolve(m.result); } });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } })); });
  try { ws.close(); } catch {}
  return result?.result?.value ?? (result?.timeout ? 'TIMEOUT' : null);
}
console.log('  页面:', (await target()).url);
console.log('  App 内 fetch 本地世界:', await ev(`fetch('http://127.0.0.1:8787/api/server-info').then(r => 'ok ' + r.status).catch(e => 'err ' + e.message)`));
