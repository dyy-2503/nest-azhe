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
function fastProbe(url, ms = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), ms);
    try {
      fetch(url + '/api/server-info', { cache: 'no-store' })
        .then((r) => finish(r.ok))
        .catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** 并行测一遍，快的先到；都连不上返回第一个（交给 WebView 自己报错，返回键能救） */
async function pickFastest(targets) {
  const list = targets.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  const results = await Promise.all(list.map(async (u) => ({ u, ok: await fastProbe(u) })));
  const hit = results.find((r) => r.ok);
  return hit ? hit.u : list[0];
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
  }, 12000);
}

/** 进入：可以是多个地址，先挑能连上的那条再跳 */
async function enterTargets(rawTargets) {
  const targets = (Array.isArray(rawTargets) ? rawTargets : splitTargets(rawTargets)).filter(Boolean);
  if (!targets.length) {
    showAddressPage('地址看起来不对，例如 http://192.168.1.172:8787 或 https://xxx.ts.net');
    return;
  }
  saveHistory(targets);
  const urlEl = $('#entering-url');
  if (urlEl && targets.length > 1) urlEl.textContent = '正在挑最快的路…';
  const target = await pickFastest(targets);
  if (urlEl) urlEl.textContent = target;
  armEnterWatchdog(target);
  location.replace(target + '/');
}

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

function renderRecent() {
  const list = loadHistory();
  const box = $('#recent');
  const wrap = $('#recent-list');
  wrap.innerHTML = '';
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  for (const url of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'recent-item';
    b.textContent = url;
    b.addEventListener('click', async () => {
      // 历史里可能同时还存着局域网地址（同一个服务器的两条路），一起测
      const group = splitTargets(localStorage.getItem(KEY_LAST) || '');
      const targets = group.includes(url) ? group : [url];
      b.disabled = true;
      const old = b.textContent;
      b.textContent = '连接中…';
      try {
        await enterTargets(targets);
      } finally {
        b.disabled = false;
        b.textContent = old;
      }
    });
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
  const savedGroup = String(localStorage.getItem(KEY_LAST) || '').trim();
  showAddressPage('');
  if (savedGroup) $('#url').value = savedGroup;
});

/* ------------------------------ 启动 ------------------------------ */

(function boot() {
  // 从聊天页点「换一个服务器」回来：清掉上次的地址，停在地址页
  if (/[?&]switch=1/.test(location.search)) {
    // 不清 KEY_LAST：把它预填回输入框（可能是一组地址），用户点「进入」还是整组、照样自动挑快路
    const savedGroup = String(localStorage.getItem(KEY_LAST) || '').trim();
    showAddressPage('');
    if (savedGroup) $('#url').value = savedGroup;
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
