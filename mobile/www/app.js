// Nest 安卓客户端 · 启动逻辑
//
// 三种情况：
//   1. 有默认服务器（config.js）→ 直接进
//   2. 上次用过的服务器 → 直接进
//   3. 连不上 / 都没有 → 显示地址页，并说明为什么没进去
//
// 关键：不管探测请求怎么卡（手机 VPN 拦截、DNS 假地址、信号差），
// 都必须在一个固定时间内退回地址页，绝不能让用户看着"正在进入"卡死。

const KEY = 'nest.server.urls';
const KEY_LAST = 'nest.server.last';
const PROBE_MS = 8000;

const preset = String(window.NEST_DEFAULT_SERVER || '').trim();
const $ = (sel) => document.querySelector(sel);

function normalize(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  try { return new URL(url).origin; } catch { return ''; }
}

/** 一个输入框里可以写多个地址（空格、逗号、换行都行），自动挑能连上的 */
function splitTargets(raw) {
  return [...new Set(String(raw || '').split(/[\s,，;；]+/).map(normalize).filter(Boolean))];
}

/** 快速探活：只用来在「局域网 / 公网」之间选路，超时很短，连不上就当没这条 */


/** 并行测一遍，快的先到；都连不上返回第一个（交给 WebView 自己报错，返回键能救） */


﻿const KEY_POOL = 'nest.server.pool';

function loadPool() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY_POOL) || '[]');
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
      let u = '';
      let sid = '';
      let host = '';
      if (typeof item === 'string') u = item;
      else if (item && typeof item === 'object') {
        u = typeof item.u === 'string' ? item.u : (item.u && typeof item.u.u === 'string' ? item.u.u : '');
        sid = String(item.sid || '');
        host = String(item.host || '');
      }
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push({ u, sid, host });
    }
    return out.slice(0, 12);
  } catch {
    return [];
  }
}





function savePool(entries) {
  try {
    const byUrl = new Map(loadPool().map((e) => [e.u, e]));
    for (const e of entries || []) {
      const url = typeof e === 'string' ? e : (e && typeof e.u === 'string' ? e.u : (e && e.u && typeof e.u.u === 'string' ? e.u.u : ''));
      if (!url) continue;
      const old = byUrl.get(url) || { u: url, sid: '', host: '' };
      const sid = (e && typeof e === 'object' && typeof e.sid === 'string' && e.sid) || old.sid || '';
      const host = (e && typeof e === 'object' && typeof e.host === 'string' && e.host) || old.host || '';
      byUrl.set(url, { u: url, sid, host });
    }
    localStorage.setItem(KEY_POOL, JSON.stringify([...byUrl.values()].slice(0, 12)));
  } catch { /* ignore */ }
}





/** 探一条地址：回来带 sid（服务器身份）和耗时，用来在同服务器的多条路里挑最快 */
async function probeOne(rawUrl, ms = 2500) {
  const url = String(typeof rawUrl === "object" && rawUrl ? rawUrl.u || rawUrl.url || "" : rawUrl || "");
  const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url + '/api/server-info', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { url, ok: false };
    const info = await res.json().catch(() => ({}));
    const spent = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
    return { url, ok: true, sid: String(info.sid || ''), host: String(info.host || ''), ms: spent };
  } catch {
    return { url, ok: false };
  }
}

/**
 * 选路：候选 = 这次填的地址 + 以前用过的地址，全部并行探活；
 * 然后用「和你点的那条属于同一台服务器（sid 相同）」的地址里挑最快的。
 * 这样在家自动走局域网，出门自动走公网，也不会串到另一台服务器（比如手机本地世界）。
 */
async function chooseRoute(entered) {
  const candidates = [...new Set([...entered, ...loadPool().map((e) => e.u)].map((u) => String(u || '')))].filter(Boolean).slice(0, 8);
  const results = await Promise.all(candidates.map((u) => probeOne(u)));
  const ok = results.filter((r) => r.ok);
  if (!ok.length) return { url: '', group: entered, reachable: false };

  // 把这次探到的身份记进池子，下次公网探不通也能归到同一台服务器
  savePool(ok.map((r) => ({ u: r.url, sid: r.sid, host: r.host = r.host || '' })));
  const anchor = entered.map((u) => ok.find((r) => r.url === u)).find(Boolean) || ok[0];
  const sameSid = anchor.sid ? ok.filter((r) => r.sid === anchor.sid) : ok;
  const pool = sameSid.length ? sameSid : ok;
  const best = pool.slice().sort((a, b) => a.ms - b.ms)[0];
  return { url: best.url, group: pool.map((r) => r.url), reachable: true };
}

async function enterTargets(rawTargets) {
  const entered = (Array.isArray(rawTargets) ? rawTargets : splitTargets(rawTargets))
    .map((u) => String(typeof u === 'object' && u ? u.u || u.url || '' : u || ''))
    .filter(Boolean);
  if (!entered.length) {
    showAddressPage('地址看起来不对，例如 http://192.168.1.172:8787 或 https://xxx.ts.net');
    return;
  }
  savePool([...entered.map((u) => ({ u })), ...loadPool()]);
  const urlEl = $('#entering-url');
  if (urlEl && entered.length > 1) urlEl.textContent = '正在挑最快的路…';
  const routed = await chooseRoute(entered);
  const url = routed.url;
  const group = routed.group;
  if (!routed.reachable) {
    // 公网/局域网都探不通：别硬跳到慢地址干等，回地址页并提示用本机世界
    const localWorld = loadPool().map((e) => e.u).find((u) => isLocalUrl(u));
    showAddressPage(
      localWorld
        ? '那台服务器现在连不上（可能关机了 / 不在同一网络）。可以先用下面「本机世界」：AI 跑在手机上，不需要电脑。'
        : '现在一台服务器都连不上。检查地址、电脑是否开机、是否在同一网络。'
    );
    return;
  }
  saveHistory(group.length ? group : entered);
  try { localStorage.setItem(KEY_CUR, url); } catch { /* ignore */ }
  if (urlEl) urlEl.textContent = url;
  if (!/^https?:\/\//.test(url)) {
    showAddressPage('地址解析异常，重新选一次世界');
    return;
  }
  armEnterWatchdog(url);
  location.replace(url + '/');
}

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string') : [];
  } catch { return []; }
}

function saveHistory(targets) {
  const urls = Array.isArray(targets) ? targets : [targets];
  const list = [...urls, ...loadHistory().filter((u) => !urls.includes(u))].slice(0, 8);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    // 「上次用的」记整组，下次启动照样能自动选快的那条
    localStorage.setItem(KEY_LAST, urls.join(' '));
  } catch { /* ignore */ }
}

/** 进入看门狗：导航成功时这个页面会被换掉，定时器随之消失；
 *  定时器真响了说明还卡在壳页面 → 说明连不上，退回地址页并给出原因。 */
let enterTimer = null;
function armEnterWatchdog(url) {
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => {
    showAddressPage('进不去 ' + url + '：网络不通，或者那台服务器没开机。换个地址，或者点「连不上？直接进」。', url);
  }, 20000);  // 公网走隧道首屏可能 12~18 秒，别太早判死
}

/** 进入：可以是多个地址，先挑能连上的那条再跳 */


function showAddressPage(reason, failedUrl) {
  $('#entering').hidden = true;
  $('#main').hidden = false;
  if (failedUrl) $('#url').value = failedUrl;
  const hint = $('#hint-offline');
  if (reason) {
    hint.hidden = false;
    hint.textContent = reason;
  }
  renderRecent();
}

/* ------------------------------ 探活 ------------------------------ */

/**
 * 探测服务器是否可达。无论发生什么，PROBE_MS 之后一定会结束。
 * 返回 { ok: true } 或 { ok: false, reason }
 */
function probe(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    // 硬超时：不依赖 fetch 的 abort 行为（某些系统 WebView 里不生效）
    const timer = setTimeout(() => {
      finish({ ok: false, reason: `连不上 ${url}（${PROBE_MS / 1000} 秒没响应）` });
    }, PROBE_MS);

    try {
      fetch(url + '/api/server-info', { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then((info) => finish({ ok: true, info }))
        .catch((err) => {
          const msg = String(err && err.message || err);
          finish({
            ok: false,
            reason: /Failed to fetch|NetworkError|Load failed/i.test(msg)
              ? `连不上 ${url}：可能是手机 VPN 拦了、或者在别的网络里。`
              : `连不上 ${url}：${msg}`,
          });
        });
    } catch (err) {
      finish({ ok: false, reason: `连不上 ${url}：${err && err.message || err}` });
    }
  });
}

/* ------------------------------ 地址页 ------------------------------ */

﻿const KEY_CUR = 'nest.server.current';

function isLocalUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url);
}

function isLanUrl(url) {
  try {
    const h = new URL(url).hostname;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  } catch {
    return false;
  }
}

function worldTitleFor(routes) {
  if (routes.some((r) => isLocalUrl(r.url))) return '本机世界';
  const host = routes.map((r) => r.host).find(Boolean);
  if (host) return host;
  try {
    return new URL(routes[0].url).hostname;
  } catch {
    return routes[0].url;
  }
}

/** 世界选择器：把用过的服务器按「同一台机器(sid)」归组，显示名字 + 哪条路通 */
﻿/** 世界选择器：把用过的服务器按「同一台机器(sid)」归组，显示名字 + 哪条路通 */
async function renderRecent() {
  const box = $('#recent');
  const wrap = $('#recent-list');
  const poolEntries = loadPool();
  const known = [...new Set([...loadHistory(), ...poolEntries.map((e) => e.u)])].slice(0, 12);
  if (!known.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  wrap.innerHTML = '<p class="label" style="opacity:.55">正在找能连的服务器…</p>';

  const results = await Promise.all(known.map((u) => probeOne(u, 1800)));
  const groups = new Map();
  const orphansDead = [];
  const cur = String(localStorage.getItem(KEY_CUR) || '');

  const pushGroup = (sid, route) => {
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(route);
  };

  for (const r of results) {
    if (r.ok) {
      pushGroup(r.sid || ('url:' + r.url), r);
      continue;
    }
    // 探不通：如果以前记过它的身份，就归回同一台服务器（比如公网那条现在很慢/不通）
    const knownEntry = poolEntries.find((e) => e.u === r.url);
    if (knownEntry && knownEntry.sid) {
      pushGroup(knownEntry.sid, { url: r.url, ok: false, sid: knownEntry.sid, host: knownEntry.host || '', ms: Infinity });
    } else {
      orphansDead.push(r);
    }
  }

  wrap.innerHTML = '';
  if (!groups.size && !orphansDead.length) {
    wrap.innerHTML = '<p class="label" style="color:var(--danger)">现在一台服务器都连不上</p>';
    return;
  }

  const list = [...groups.values()].sort((a, b) => {
    const al = a.some((r) => isLocalUrl(r.url)) ? 0 : 1;
    const bl = b.some((r) => isLocalUrl(r.url)) ? 0 : 1;
    return al - bl;
  });

  for (const routes of list) {
    const good = routes.filter((r) => r.ok);
    const isNow = routes.some((r) => cur && r.url === cur) || (isLocalUrl(cur) && routes.some((r) => isLocalUrl(r.url)));
    const lanGood = good.filter((r) => isLanUrl(r.url) || isLocalUrl(r.url));
    const wanGood = good.filter((r) => !isLanUrl(r.url) && !isLocalUrl(r.url));
    const sub = [];
    if (lanGood.length) sub.push('局域网 ' + Math.round(Math.min(...lanGood.map((r) => r.ms))) + 'ms');
    else if (wanGood.length) sub.push('公网 ' + Math.round(Math.min(...wanGood.map((r) => r.ms)) / 100) / 10 + 's');
    if (lanGood.length && routes.some((r) => !isLanUrl(r.url) && !isLocalUrl(r.url))) sub.push('公网备用');
    if (!good.length) sub.push(routes.some((r) => !isLanUrl(r.url) && !isLocalUrl(r.url)) ? '现在连不上' : '连不上');

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'recent-item' + (good.length ? '' : ' is-dead');
    b.innerHTML = '<b>' + worldTitleFor(routes) + (isNow ? '  · 当前' : '') + '</b><span>' + sub.join(' · ') + '</span>';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await enterTargets(routes.map((r) => r.url));
      } finally {
        b.disabled = false;
      }
    });
    wrap.appendChild(b);
  }

  for (const r of orphansDead) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'recent-item is-dead';
    b.innerHTML = '<b>' + (isLocalUrl(r.url) ? '本机世界' : r.url.replace(/^https?:\/\//, '')) + '</b><span>现在连不上</span>';
    b.addEventListener('click', () => enterTargets([r.url]));
    wrap.appendChild(b);
  }
}





$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#url');
  const targets = splitTargets(input.value);
  if (!targets.length) {
    input.setCustomValidity('地址看起来不对，例如 http://192.168.1.172:8787 或 https://xxx.ts.net');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  $('#hint-offline').hidden = true;

  const btn = $('#form').querySelector('button[type="submit"], button');
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '连接中…'; }
  try {
    await enterTargets(targets);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
});

$('#url').addEventListener('input', (e) => e.target.setCustomValidity(''));

/* 直接进入：探活失败也可以硬进（用户自己判断） */
$('#force-enter').addEventListener('click', (e) => {
  e.preventDefault();
  const targets = splitTargets($('#url').value);
  const first = targets[0] || splitTargets(preset)[0];
  if (!first) return;
  saveHistory(targets.length ? targets : [first]);
  armEnterWatchdog(first);
  location.replace(first + '/');
});

/* 换服务器：清掉"上次用的"，回到地址页 */
$('#switch-server').addEventListener('click', (e) => {
  e.preventDefault();
  showAddressPage('');
});

/* ------------------------------ 启动 ------------------------------ */

(function boot() {
  // 从聊天页点「换一个服务器」回来：清掉上次的地址，停在地址页
  if (/[?&]switch=1/.test(location.search)) {
    showAddressPage('');
    return;
  }
  // 有服务器地址就直接跳，不做探活：
  // 探活会白白多等几秒（手机走代理时尤其慢），而 WebView 自己会显示加载/报错。
  const saved = splitTargets(localStorage.getItem(KEY_LAST) || '');
  const targets = saved.length ? saved : splitTargets(preset);
  if (targets.length) {
    $('#entering').hidden = false;
    $('#entering-url').textContent = targets.join('  ·  ');
    // 先渲染"正在进入"，再挑路跳转：多个地址（局域网 + 公网）时自动选能连的、快的
    requestAnimationFrame(() => setTimeout(() => enterTargets(targets), 30));
    return;
  }
  showAddressPage('');
})();
