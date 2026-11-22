// Nest 安卓客户端 · 地址页
// 只做一件事：记住服务器地址，然后跳过去（跳过去之后就是网页版本身）

const KEY = 'nest.server.urls';

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
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
  return list;
}

function normalize(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;   // 用户只输 IP 时补个协议
  try {
    const u = new URL(url);
    // 只保留 origin，路径丢掉（避免 /index.html 之类）
    return u.origin;
  } catch {
    return '';
  }
}

function renderRecent() {
  const list = loadHistory();
  const box = document.getElementById('recent');
  const wrap = document.getElementById('recent-list');
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

function go(url) {
  saveHistory(url);
  // 整页跳转到服务器（之后的界面就是这个服务器上的 Nest 网页版）
  location.href = url + '/';
}

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = normalize(document.getElementById('url').value);
  const input = document.getElementById('url');
  if (!url) {
    input.setCustomValidity('地址看起来不对，例如 https://nest-xxx.ts.net');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  go(url);
});

document.getElementById('url').addEventListener('input', (e) => e.target.setCustomValidity(''));
renderRecent();
