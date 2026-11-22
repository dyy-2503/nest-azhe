// Nest 桌面客户端 · 主进程
//
// 三件事：
//   1. 起窗口（先显示"开始页"，选模式）
//   2. 当服务器：用打包进来的 server/index.mjs 在本机起服务
//   3. 我的 AI：用打包进来的 bridge/nest-bridge.mjs 把 AI 接上线
//
// Electron 自带 Node，所以不用用户另外装 Node —— 这也是选 Electron 的原因。

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');

const isSmoke = process.argv.includes('--smoke');
const isSmokeHost = process.argv.includes('--smoke-host');

/** 核心代码目录：开发时是仓库根，打包后在 resources/app-core */
const CORE = app.isPackaged
  ? join(process.resourcesPath, 'app-core')
  : join(__dirname, '..');

const SETTINGS_FILE = () => join(app.getPath('userData'), 'settings.json');
const DATA_DIR = () => join(app.getPath('userData'), 'nest-data');

let win = null;
let serverProc = null;
let bridgeProc = null;
let serverPort = 8787;
const logs = { server: [], bridge: [] };

/* ------------------------------ 设置读写 ------------------------------ */

function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE(), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2), 'utf8');
  } catch { /* ignore */ }
  return next;
}

/* ------------------------------ 进程工具 ------------------------------ */

/**
 * 用 Electron 自带的 Node 跑一个 .mjs 脚本。
 * ELECTRON_RUN_AS_NODE=1 让 electron 可执行文件变成纯 node。
 */
function spawnNode(script, args, env = {}) {
  return spawn(process.execPath, [script, ...args], {
    cwd: CORE,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NEST_DATA_DIR: DATA_DIR(),
      ...env,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function pump(proc, which) {
  const push = (chunk) => {
    const text = chunk.toString('utf8');
    logs[which].push(text);
    if (logs[which].length > 400) logs[which].splice(0, 200);
    win?.webContents.send('nest:log', { which, text });
  };
  proc.stdout.on('data', push);
  proc.stderr.on('data', push);
}

function httpGet(url, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

/** 等服务起来（最多 20 秒） */
async function waitServer(port, ms = 20000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      const r = await httpGet(`http://127.0.0.1:${port}/api/server-info`);
      if (r.status === 200) return JSON.parse(r.body);
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/* ------------------------------ 窗口 ------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#f7f8fa',
    title: 'Nest',
    ...(app.isPackaged ? {} : { icon: join(__dirname, 'build', 'icon.ico') }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(join(__dirname, 'ui', 'index.html'));

  // 外链用系统浏览器打开，不要在应用里跳走
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

/* ------------------------------ 动作 ------------------------------ */

async function startServer(port) {
  if (serverProc) return { ok: true, port: serverPort };
  serverPort = Number(port) || 8787;
  mkdirSync(DATA_DIR(), { recursive: true });
  // 服务器的数据库放在客户端自己的 userData 下，卸载/升级不丢
  serverProc = spawnNode('server/index.mjs', [], {
    NEST_PORT: String(serverPort),
    NEST_DB: join(DATA_DIR(), 'nest.db'),
  });
  pump(serverProc, 'server');
  serverProc.on('exit', (code) => {
    serverProc = null;
    win?.webContents.send('nest:status', { server: 'stopped', code });
  });
  const info = await waitServer(serverPort);
  if (!info) return { ok: false, error: '服务器没起来，看日志' };
  win?.webContents.send('nest:status', { server: 'running', info, port: serverPort });
  return { ok: true, port: serverPort, info };
}

function stopServer() {
  if (!serverProc) return { ok: true };
  try { serverProc.kill(); } catch { /* ignore */ }
  serverProc = null;
  return { ok: true };
}

function startBridge({ serverUrl, key }) {
  if (bridgeProc) return { ok: true, already: true };
  if (!serverUrl || !key) return { ok: false, error: '要填服务器地址和钥匙' };
  bridgeProc = spawnNode('bridge/nest-bridge.mjs', [
    '--server', serverUrl,
    '--key', key,
  ]);
  pump(bridgeProc, 'bridge');
  bridgeProc.on('exit', (code) => {
    bridgeProc = null;
    win?.webContents.send('nest:status', { bridge: 'stopped', code });
  });
  win?.webContents.send('nest:status', { bridge: 'running' });
  return { ok: true };
}

function stopBridge() {
  if (!bridgeProc) return { ok: true };
  try { bridgeProc.kill(); } catch { /* ignore */ }
  bridgeProc = null;
  return { ok: true };
}

/* ------------------------------ IPC ------------------------------ */

ipcMain.handle('nest:settings', () => readSettings());
ipcMain.handle('nest:save', (_e, patch) => writeSettings(patch));
ipcMain.handle('nest:core', () => ({
  core: CORE,
  packaged: app.isPackaged,
  version: app.getVersion(),
  dataDir: DATA_DIR(),
}));
ipcMain.handle('nest:startServer', async (_e, port) => startServer(port));
ipcMain.handle('nest:stopServer', () => stopServer());
ipcMain.handle('nest:startBridge', (_e, cfg) => startBridge(cfg || {}));
ipcMain.handle('nest:stopBridge', () => stopBridge());
ipcMain.handle('nest:openUrl', (_e, url) => {
  if (!url) return { ok: false };
  // 站内地址在客户端窗口里打开，保持"像 App"的体验
  if (/^https?:\/\//i.test(url)) {
    win?.loadURL(url);
    return { ok: true };
  }
  return { ok: false };
});
ipcMain.handle('nest:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  return { ok: true };
});
ipcMain.handle('nest:back', () => {
  win?.loadFile(join(__dirname, 'ui', 'index.html'));
  return { ok: true };
});
ipcMain.handle('nest:logs', (_e, which) => logs[which] || []);
ipcMain.handle('nest:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

/* ------------------------------ 生命周期 ------------------------------ */

app.whenReady().then(async () => {
  createWindow();

  // 冒烟测试：加载完成 → 打印 → 退出（CI / 本地验证用）
  if (isSmoke) {
    win.webContents.once('did-finish-load', async () => {
      const checks = await win.webContents.executeJavaScript(`(() => ({
        title: document.title,
        cards: document.querySelectorAll('.card').length,
        hasBridge: !!document.querySelector('#bridge-key'),
      }))()`);
      console.log('SMOKE', JSON.stringify(checks));
      setTimeout(() => app.exit(checks.cards >= 3 ? 0 : 1), 300);
    });
  }

  // 冒烟测试（服务器）：验证打包进来的 core 能起服务
  if (isSmokeHost) {
    win.webContents.once('did-finish-load', async () => {
      const port = 8899;
      const r = await startServer(port);
      let pageOk = false;
      try {
        const page = await httpGet(`http://127.0.0.1:${port}/`);
        pageOk = page.status === 200 && /<title>Nest/.test(page.body);
      } catch { /* ignore */ }
      console.log('SMOKE-HOST', JSON.stringify({
        started: r.ok,
        firstRun: r.info?.firstRun,
        lan: r.info?.lan,
        pageOk,
        core: CORE,
        dataDir: DATA_DIR(),
      }));
      stopServer();
      setTimeout(() => app.exit(r.ok && pageOk ? 0 : 1), 500);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBridge();
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopBridge();
  stopServer();
});
