#!/usr/bin/env node
/**
 * 极简端到端测试：直接通过 CDP 驱动 Edge，不依赖 Playwright。
 *
 * 用法：node scripts/e2e.mjs <场景名>
 *   node scripts/e2e.mjs sticker    # 点图 → 存为表情 → 查库
 *
 * 为什么自己写：这台机器上的浏览器自动化工具偶发超时，
 * 而 Node 22 自带 WebSocket，连 CDP 只要几十行。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.NEST_BASE || 'http://127.0.0.1:8787';
const EDGE = process.env.NEST_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.NEST_CDP_PORT || 9333);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error('✗', msg);
  process.exitCode = 1;
}

function ok(msg) {
  console.log('✓', msg);
}

/** 起一个 headless Edge，返回 { proc, ws, eval, close } */
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'nest-e2e-'));
  const proc = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  // 等 CDP 端口就绪
  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await r.json();
      if (targets?.length) break;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!targets?.length) {
    proc.kill();
    throw new Error('Edge 没起来（CDP 端口不通）');
  }

  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => {
      if (pending.has(mid)) { pending.delete(mid); reject(new Error(`${method} 超时`)); }
    }, 20000);
  });

  await send('Page.enable');
  await send('Runtime.enable');

  /** 在页面里执行一段代码，返回值走 JSON */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || '页面脚本抛错');
    }
    return r.result?.value;
  };

  const goto = async (url) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      await sleep(120);
      const ready = await evaluate('document.readyState').catch(() => '');
      if (ready === 'complete') return;
    }
    throw new Error('页面加载超时');
  };

  const close = async () => {
    try { ws.close(); } catch {}
    try { proc.kill(); } catch {}
    await sleep(200);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  return { evaluate, goto, close };
}

/** 等某个条件成立（在页面里跑） */
async function waitFor(evaluate, expr, label, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(`Boolean(${expr})`).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`等不到：${label}`);
}

async function login(evaluate, goto, account = 'azhe') {
  await goto(BASE + '/');
  await evaluate(`fetch('/api/login', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({account:'${account}', password:'123456'})}).then(r=>r.status)`);
  await goto(BASE + '/');
  await waitFor(evaluate, `document.querySelector('#conv-list .conv')`, '会话列表加载');
}

/** 在页面里调自己的 API（cookie 自动带） */
const call = (path, init) => `fetch('${path}', ${init ? JSON.stringify(init) : 'undefined'}).then(r => r.json())`;

/* ------------------------------- 场景 ------------------------------- */

async function scenarioSticker() {
  const { evaluate, goto, close } = await launch();
  try {
    await login(evaluate, goto);

    // 点开会话 1（真实 UI），等图片渲染
    await evaluate(`document.querySelector('#conv-list .conv[data-conv="1"]').click()`);
    await waitFor(evaluate, `document.querySelector('#messages .bubble.is-media img')`, '图片消息');

    // 清空表情，从干净状态开始
    await evaluate(`(async () => {
      const { stickers } = await (await fetch('/api/stickers')).json();
      for (const st of stickers) {
        await fetch('/api/stickers/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sha: st.sha }),
        });
      }
      return true;
    })()`);
    const before = await evaluate(`(async () => (await ${call('/api/stickers')}).stickers.length)()`);
    if (before !== 0) fail(`开始时表情数应为 0，实际 ${before}`);

    // 走真实 UI：点最后一张图 → 灯箱 → 点「存为表情」
    const opened = await evaluate(`(() => {
      const img = document.querySelector('#messages .bubble.is-media img');
      img.click();
      return Boolean(document.querySelector('#lb-sticker'));
    })()`);
    if (!opened) fail('点图后没出现「存为表情」按钮');
    else ok('点图弹出灯箱，带「存为表情」按钮');

    await evaluate(`document.querySelector('#lb-sticker').click()`);
    await sleep(900);

    const after = await evaluate(`(async () => (await ${call('/api/stickers')}).stickers.length)()`);
    if (after === 1) ok('存为表情成功（库里 1 个）');
    else fail(`存为表情后库里是 ${after}，应该是 1`);

    // 刷新后还在（你报的第二个现象）
    await goto(BASE + '/');
    await waitFor(evaluate, `document.querySelector('#conv-list .conv[data-conv="1"]')`, '刷新后加载');
    const afterReload = await evaluate(`(async () => (await ${call('/api/stickers')}).stickers.length)()`);
    if (afterReload === 1) ok('刷新后表情还在');
    else fail(`刷新后变成 ${afterReload}`);
  } finally {
    await close();
  }
}

async function scenarioVoice() {
  const { evaluate, goto, close } = await launch();
  try {
    await login(evaluate, goto, '16636701225');
    await evaluate(`document.querySelector('#conv-list .conv[data-conv="16"]').click()`);
    await waitFor(evaluate, `document.querySelector('.bubble.is-voice.is-playable')`, '语音气泡');

    const cards = await evaluate(`document.querySelectorAll('.bubble.is-voice.is-playable').length`);
    ok(`语音气泡 ${cards} 个，都带媒体地址`);

    const played = await evaluate(`(() => {
      const b = document.querySelector('.bubble.is-voice.is-playable');
      b.click();
      return b.classList.contains('is-playing');
    })()`);
    if (played) ok('点击后进入播放态');
    else fail('点击后没进入播放态');

    await sleep(1500);
    const painted = await evaluate(`document.querySelectorAll('.bubble.is-voice.is-playable .bars i.on').length`);
    if (painted > 0) ok(`播放进度已点亮 ${painted} 根柱子`);
    else fail('播放进度没画出来');
  } finally {
    await close();
  }
}

async function scenarioFeatures() {
  const { evaluate, goto, close } = await launch();
  try {
    await login(evaluate, goto);

    /* ---- 1. 全局搜索（点侧栏搜索框 → 输入 → 点结果）---- */
    // 直接派发 focus：headless 里 .focus() 有时不触发（元素还没真正可见）
    await evaluate(`(() => { document.querySelector('#search').dispatchEvent(new FocusEvent('focus')); return true; })()`);
    await waitFor(evaluate, `document.querySelector('.gs-mask')`, '全局搜索弹层');
    await evaluate(`(() => {
      const inp = document.querySelector('#gs-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '部署');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(evaluate, `document.querySelector('.gs-hit')`, '搜索结果');
    const hitCount = await evaluate(`document.querySelectorAll('.gs-hit').length`);
    ok(`全局搜索出 ${hitCount} 条结果（跨会话）`);

    const firstConv = await evaluate(`document.querySelector('.gs-hit').dataset.gsConv`);
    await evaluate(`document.querySelector('.gs-hit').click()`);
    await sleep(900);
    const maskGone = await evaluate(`!document.querySelector('.gs-mask')`);
    if (maskGone) ok('点结果后搜索层关闭');
    else fail('搜索层没关');
    const switched = await evaluate(`document.querySelector('#conv-list .conv[data-conv="${firstConv}"]')?.classList.contains('is-active')`);
    if (switched) ok('已切到命中的会话');
    else fail('没切到命中的会话');

    /* ---- 2. 表情删除（用真图建表情：1×1 占位图会被界面当坏图过滤）---- */
    await evaluate(`(async () => {
      const res = await fetch('/media/f65ad35de17c662560670a9195f80791faa15998b23de374dd7ca2184b333e8f.png');
      const buf = await res.blob();
      const up = await (await fetch('/api/upload', { method: 'POST', body: buf, headers: { 'content-type': 'image/png' } })).json();
      await fetch('/api/stickers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: up.sha, ext: up.ext }) });
      return true;
    })()`);
    await evaluate(`document.querySelector('#conv-list .conv[data-conv="1"]').click()`);
    await sleep(600);
    // 打开表情面板 → 我的表情
    await evaluate(`document.querySelector('[data-act="emoji"]').click()`);
    await waitFor(evaluate, `document.querySelector('.ep-tabs')`, '表情面板');
    await evaluate(`document.querySelector('.ep-tabs [data-ep="sticker"]').click()`);
    await waitFor(evaluate, `document.querySelector('.ep-del')`, '表情删除按钮');
    const beforeDel = await evaluate(`(async () => (await (await fetch('/api/stickers')).json()).stickers.length)()`);
    await evaluate(`document.querySelector('.ep-del').click()`);
    await sleep(800);
    const afterDel = await evaluate(`(async () => (await (await fetch('/api/stickers')).json()).stickers.length)()`);
    if (afterDel === beforeDel - 1) ok(`删表情成功（${beforeDel} → ${afterDel}）`);
    else fail(`删表情后数量不对：${beforeDel} → ${afterDel}`);
    /* ---- 3. 语音转文字（右键语音气泡 → 转文字）---- */
    await login(evaluate, goto, '16636701225');
    await evaluate(`document.querySelector('#conv-list .conv[data-conv="16"]').click()`);
    await waitFor(evaluate, `document.querySelector('.bubble.is-voice.is-playable')`, '语音气泡');
    await evaluate(`(() => {
      const b = document.querySelector('.bubble.is-voice.is-playable');
      const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      return true;
    })()`);
    await waitFor(evaluate, `document.querySelector('.ctx-item[data-k="toText"]')`, '转文字菜单项');
    await evaluate(`document.querySelector('.ctx-item[data-k="toText"]').click()`);
    await waitFor(evaluate, `document.querySelector('.voice-text')`, '转写文字', 60000);
    const text = await evaluate(`document.querySelector('.voice-text').textContent`);
    ok(`转文字成功：${text.slice(0, 24)}`);
  } finally {
    await close();
  }
}

async function scenarioWizard() {
  const { evaluate, goto, close } = await launch();
  try {
    await login(evaluate, goto);

    // 打开我的 AI 成员
    await evaluate(`document.querySelector('#btn-settings').click()`);
    await sleep(400);
    await evaluate(`document.querySelector('#set-ai-manage').click()`);
    await waitFor(evaluate, `document.querySelector('.ai-modal')`, 'AI 成员弹窗');

    // 点「＋ 创建 AI」→ 第一步
    await evaluate(`document.querySelector('#ai-add').click()`);
    await waitFor(evaluate, `document.querySelector('#wiz-name')`, '向导第一步');
    ok('创建 AI 打开三步向导');

    // 第一步：起名
    await evaluate(`(() => {
      const inp = document.querySelector('#wiz-name');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '向导测试AI');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await evaluate(`document.querySelector('[data-wiz="next1"]').click()`);
    await waitFor(evaluate, `document.querySelector('#wiz-persona')`, '第二步人设');
    ok('第二步：人设');

    // 第二步：人设
    await evaluate(`(() => {
      const ta = document.querySelector('#wiz-persona');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '你是个测试人设。');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await evaluate(`document.querySelector('[data-wiz="next2"]').click()`);
    await waitFor(evaluate, `document.querySelector('.wiz-caps')`, '第三步能力');
    ok('第三步：能力选项');

    const caps = await evaluate(`document.querySelectorAll('[data-cap]').length`);
    ok(`自带能力 ${caps} 项`);

    // 关掉"主动说话"
    await evaluate(`(() => {
      const cb = document.querySelector('[data-cap="proactive"]');
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

    // 勾一个需要 DSH 插件的能力（语音）
    await evaluate(`(() => {
      const cb = document.querySelector('[data-dsh]');
      if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      return true;
    })()`);

    // 创建
    await evaluate(`document.querySelector('[data-wiz="create"]').click()`);
    await waitFor(evaluate, `document.querySelector('#wiz-prompt')`, '创建完成给出口令', 15000);
    const prompt = await evaluate(`document.querySelector('#wiz-prompt').value`);
    if (prompt.includes('NEST-AI-')) ok('口令里带钥匙');
    else fail('口令里没有钥匙');
    if (prompt.includes('nest-bridge.mjs')) ok('口令里带桥接命令');
    else fail('口令里没有桥接命令');
    if (/DSH|插件/.test(prompt)) ok('口令里带插件要求');
    else fail('口令里没有插件段');
    if (/192\.168|127\.0\.0\.1/.test(prompt)) ok('口令里带服务器地址');
    else fail('口令里没有服务器地址');

    // 摘要行
    const summary = await evaluate(`[...document.querySelectorAll('.wiz-sum-row')].map(e => e.textContent).join('|')`);
    if (summary.includes('要装的 DSH 插件')) ok('摘要显示要装几个插件：' + (summary.match(/要装的 DSH 插件[^|]*/) || [''])[0]);
    else fail('摘要缺插件行');

    // 关掉后列表里能看到
    await evaluate(`document.querySelector('[data-wiz="done"]').click()`);
    await sleep(800);
    const hasIt = await evaluate(`[...document.querySelectorAll('.ai-row-name')].map(e => e.textContent).join('|').includes('向导测试AI')`);
    if (hasIt) ok('新 AI 出现在成员列表里');
    else fail('列表里没有新建的 AI');

    // 收尾：把测试造的 AI 删掉（否则每跑一次就多一个）
    await evaluate(`(async () => {
      const { members } = await (await fetch('/api/ai/members')).json();
      const mine = (members || []).filter((m) => String(m.nickname).startsWith('向导测试AI'));
      for (const m of mine) {
        const r = await fetch('/api/ai/members/' + m.id + '/delete', { method: 'POST' });
        if (!r.ok) throw new Error('删除测试 AI 失败：HTTP ' + r.status);
      }
      return mine.length;
    })()`);
    ok('测试 AI 已清理');
  } finally {
    await close();
  }
}

const which = process.argv[2] || 'sticker';
const table = { sticker: scenarioSticker, voice: scenarioVoice, features: scenarioFeatures, wizard: scenarioWizard };
const fn = table[which];
if (!fn) {
  console.error('场景有：' + Object.keys(table).join(', '));
  process.exit(2);
}
fn().then(() => {
  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
}).catch((err) => {
  fail(err.message);
  process.exit(1);
});
