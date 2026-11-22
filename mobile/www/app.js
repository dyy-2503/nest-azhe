// Nest 安卓客户端 · 启动逻辑
//
// 三种情况：
//   1. 有默认服务器（config.js 里写了）→ 直接进，闪现一秒"正在进入"
//   2. 上次用过的服务器 → 直接进（记住用户的选择）
//   3. 都没有 → 显示地址页，手动填一次
// 任何情况下地址页都有"换一个服务器"的入口。
//
// 跳过去之后就是服务器上的网页版本身，这个 App 只是"门"。

const KEY = 'nest.server.urls';
const KEY_LAST = 'nest.server.last';

const preset = String(window.NEST_DEFAULT_SERVER || '').trim();

function normalize(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
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

const $ = (sel) => document.querySelector(sel);

/* ------------------------------ 自动进入 ------------------------------ */

function autoEntry() {
  const last = normalize(localStorage.getItem(KEY_LAST) || '');
  const target = last || normalize(preset);
  if (!target) return false;

  // 显示一个很短的"正在进入"，避免白屏
  const box = $('#entering');
  box.hidden = false;
  $('#entering-url').textContent = target;
  const start = Date.now();
  // 先试一下能不能连上（连不上就退回地址页，别让用户卡在空白页）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  fetch(target + '/api/server-info', { signal: ctrl.signal, mode: 'cors' })
    .then((r) => {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(() => {
      const wait = Math.max(0, 600 - (Date.now() - start));
      setTimeout(() => go(target), wait);
    })
    .catch(() => {
      clearTimeout(timer);
      box.hidden = true;
      $('#url').value = last || '';
      $('#hint-offline').hidden = false;
      renderRecent();
    });
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
    b.addEventListener('click', () => go(url));
    wrap.appendChild(b);
  }
}

$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#url');
  const url = normalize(input.value);
  if (!url) {
    input.setCustomValidity('地址看起来不对，例如 https://nest-xxx.ts.net');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  go(url);
});

$('#url').addEventListener('input', (e) => e.target.setCustomValidity(''));

/* 换服务器：清掉"上次用的"，回到地址页 */
$('#switch-server').addEventListener('click', (e) => {
  e.preventDefault();
  try { localStorage.removeItem(KEY_LAST); } catch { /* ignore */ }
  $('#entering').hidden = true;
  $('#main').hidden = false;
  renderRecent();
});

/* ------------------------------ 启动 ------------------------------ */

(function boot() {
  $('#main').hidden = true;
  if (!autoEntry()) {
    $('#entering').hidden = true;
    $('#main').hidden = false;
    if (preset) $('#url').value = normalize(preset);
    renderRecent();
  }
})();
