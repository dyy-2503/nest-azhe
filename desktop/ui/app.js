// Nest 客户端 · 开始页逻辑
// 页面只通过 window.nest（preload 暴露的接口）跟主进程打交道。

const $ = (sel) => document.querySelector(sel);
const api = window.nest;

const state = { logTab: 'server', serverRunning: false, bridgeRunning: false };

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.classList.remove('ok', 'err');
  if (kind) el.classList.add(kind);
}

/* ------------------------------ 初始化 ------------------------------ */

(async function init() {
  const settings = (await api.settings()) || {};
  const core = (await api.core()) || {};
  $('#version').textContent = 'v' + (core.version || '0.1.0');
  $('#core-info').textContent = core.packaged ? '已安装版' : '开发模式';

  if (settings.hostPort) $('#host-port').value = settings.hostPort;
  if (settings.joinUrl) $('#join-url').value = settings.joinUrl;
  if (settings.bridgeServer) $('#bridge-server').value = settings.bridgeServer;
  if (settings.bridgeKey) $('#bridge-key').value = settings.bridgeKey;

  // 事件：主进程推来的日志 / 状态
  api.onLog(({ which, text }) => {
    if (which === state.logTab) appendLog(text);
  });
  api.onStatus((s) => {
    if (s.server === 'running') {
      state.serverRunning = true;
      $('#btn-host').hidden = true;
      $('#btn-host-stop').hidden = false;
      $('#btn-host-open').hidden = false;
      const lan = s.info?.lan?.[0];
      const port = s.port;
      setStatus($('#host-status'), `运行中：http://127.0.0.1:${port}` + (lan ? ` · 局域网 http://${lan}:${port}` : ''), 'ok');
    }
    if (s.server === 'stopped') {
      state.serverRunning = false;
      $('#btn-host').hidden = false;
      $('#btn-host-stop').hidden = true;
      $('#btn-host-open').hidden = true;
      setStatus($('#host-status'), '已停止');
    }
    if (s.bridge === 'running') {
      state.bridgeRunning = true;
      $('#btn-bridge').hidden = true;
      $('#btn-bridge-stop').hidden = false;
      setStatus($('#bridge-status'), '运行中：AI 应该已经在线（回 Nest 看「在线」）', 'ok');
    }
    if (s.bridge === 'stopped') {
      state.bridgeRunning = false;
      $('#btn-bridge').hidden = false;
      $('#btn-bridge-stop').hidden = true;
      setStatus($('#bridge-status'), '已停止');
    }
  });

  // 端口上已经有 Nest 在跑？（守护进程或上次开的）
  const localInfo = await probeLocal(Number($('#host-port').value) || 8787);
  if (localInfo) markAlreadyRunning(localInfo);

  await refreshLog();
})();

/** 本机端口上是不是已经有一个 Nest 在跑（守护进程 / 之前开的那个） */
async function probeLocal(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/server-info', {
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 已经有 Nest 在跑：别让用户再点一次"启动"然后撞端口冲突 */
function markAlreadyRunning(info) {
  $('#btn-host').hidden = true;
  $('#btn-host-open').hidden = false;
  const port = info?.port || Number($('#host-port').value) || 8787;
  setStatus($('#host-status'), '这台电脑上已经有一个 Nest 在跑（端口 ' + port + '），点「打开」直接用', 'ok');
}

/* ------------------------------ 日志 ------------------------------ */

async function refreshLog() {
  const lines = (await api.logs(state.logTab)) || [];
  $('#log-view').textContent = lines.join('');
  $('#log-view').scrollTop = $('#log-view').scrollHeight;
}

function appendLog(text) {
  const el = $('#log-view');
  el.textContent += text;
  el.scrollTop = el.scrollHeight;
}

document.querySelectorAll('.log-tabs [data-log]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.log-tabs [data-log]').forEach((b) => b.classList.toggle('on', b === btn));
    state.logTab = btn.dataset.log;
    await refreshLog();
  });
});

$('#btn-back').addEventListener('click', () => api.back());

/* ------------------------------ ① 当服务器 ------------------------------ */

$('#btn-host').addEventListener('click', async () => {
  const port = Number($('#host-port').value) || 8787;
  setStatus($('#host-status'), '正在启动…');
  await api.save({ hostPort: port });
  const r = await api.startServer(port);
  if (!r.ok) {
    const busy = /EADDRINUSE|already in use/i.test(String(r.error || ''));
    if (busy) {
      $('#btn-host-open').hidden = false;
      setStatus($('#host-status'), '端口 ' + port + ' 已经被占用了（可能已经有一个 Nest 在跑），点「打开」试试', 'err');
    } else {
      setStatus($('#host-status'), '启动失败：' + (r.error || '看日志'), 'err');
    }
    return;
  }
  // 服务器起来了，直接在主窗口打开它
  await api.openUrl(`http://127.0.0.1:${r.port}/`);
});

$('#btn-host-stop').addEventListener('click', async () => {
  await api.stopServer();
  setStatus($('#host-status'), '已停止');
});

$('#btn-host-open').addEventListener('click', async () => {
  const port = Number($('#host-port').value) || 8787;
  await api.openUrl(`http://127.0.0.1:${port}/`);
});

/* ------------------------------ ② 加入 ------------------------------ */

$('#btn-join').addEventListener('click', async () => {
  const url = ($('#join-url').value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    setStatus($('#join-status'), '地址要以 http:// 或 https:// 开头', 'err');
    return;
  }
  await api.save({ joinUrl: url });
  setStatus($('#join-status'), '打开中…');
  await api.openUrl(url + '/');
});

/* ------------------------------ ③ 我的 AI ------------------------------ */

$('#btn-bridge').addEventListener('click', async () => {
  const serverUrl = ($('#bridge-server').value || '').trim().replace(/\/+$/, '');
  const key = ($('#bridge-key').value || '').trim();
  if (!/^https?:\/\//i.test(serverUrl)) {
    setStatus($('#bridge-status'), '服务器地址要以 http:// 或 https:// 开头', 'err');
    return;
  }
  if (!/^NEST-AI-/.test(key)) {
    setStatus($('#bridge-status'), '钥匙不对（应该以 NEST-AI- 开头）', 'err');
    return;
  }
  await api.save({ bridgeServer: serverUrl, bridgeKey: key });
  setStatus($('#bridge-status'), '启动中…');
  const r = await api.startBridge({ serverUrl, key });
  if (!r.ok) setStatus($('#bridge-status'), '启动失败：' + (r.error || '看日志'), 'err');
});

$('#btn-bridge-stop').addEventListener('click', async () => {
  await api.stopBridge();
  setStatus($('#bridge-status'), '已停止');
});

/* ------------------------------ 外链 ------------------------------ */

$('#link-repo').addEventListener('click', (e) => {
  e.preventDefault();
  api.openExternal('https://github.com/dyy-2503/nest-azhe');
});
