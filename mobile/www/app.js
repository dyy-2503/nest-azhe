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
const PROBE_MS = 5000;

const preset = String(window.NEST_DEFAULT_SERVER || '').trim();
const $ = (sel) => document.querySelector(sel);

function normalize(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  try { return new URL(url).origin; } catch { return ''; }
}

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string') : [];
  } catch { return []; }
}

function saveHistory(url) {
  const list = [url, ...loadHistory().filter((u) => u !== url)].slice(0, 5);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    localStorage.setItem(KEY_LAST, url);
  } catch { /* ignore */ }
}

function go(url) {
  saveHistory(url);
  location.replace(url + '/');
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

/* ------------------------------ 自动进入 ------------------------------ */

async function autoEntry() {
  const last = normalize(localStorage.getItem(KEY_LAST) || '');
  const target = last || normalize(preset);
  if (!target) return false;

  $('#entering').hidden = false;
  $('#entering-url').textContent = target;

  const result = await probe(target);
  if (result.ok) {
    go(target);
    return true;
  }
  showAddressPage(result.reason, target);
  return true;
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
      const r = await probe(url);
      if (r.ok) go(url);
      else { $('#hint-offline').hidden = false; $('#hint-offline').textContent = r.reason; }
    });
    wrap.appendChild(b);
  }
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#url');
  const url = normalize(input.value);
  if (!url) {
    input.setCustomValidity('地址看起来不对，例如 https://nest-xxx.ts.net');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  $('#hint-offline').hidden = true;
  const r = await probe(url);
  if (r.ok) go(url);
  else {
    $('#hint-offline').hidden = false;
    $('#hint-offline').textContent = r.reason;
  }
});

$('#url').addEventListener('input', (e) => e.target.setCustomValidity(''));

/* 直接进入：探活失败也可以硬进（用户自己判断） */
$('#force-enter').addEventListener('click', (e) => {
  e.preventDefault();
  const url = normalize($('#url').value) || normalize(preset);
  if (url) go(url);
});

/* 换服务器：清掉"上次用的"，回到地址页 */
$('#switch-server').addEventListener('click', (e) => {
  e.preventDefault();
  try { localStorage.removeItem(KEY_LAST); } catch { /* ignore */ }
  showAddressPage('');
});

/* ------------------------------ 启动 ------------------------------ */

(async function boot() {
  $('#main').hidden = true;
  const handled = await autoEntry();
  if (!handled) {
    showAddressPage('');
    if (preset) $('#url').value = normalize(preset);
  }
})();
