// 预加载脚本：只把需要的能力暴露给页面（contextIsolation 开着，页面拿不到 Node）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nest', {
  // 设置
  settings: () => ipcRenderer.invoke('nest:settings'),
  save: (patch) => ipcRenderer.invoke('nest:save', patch),
  core: () => ipcRenderer.invoke('nest:core'),

  // 当服务器
  startServer: (port) => ipcRenderer.invoke('nest:startServer', port),
  stopServer: () => ipcRenderer.invoke('nest:stopServer'),

  // 我的 AI
  startBridge: (cfg) => ipcRenderer.invoke('nest:startBridge', cfg),
  stopBridge: () => ipcRenderer.invoke('nest:stopBridge'),

  // 导航
  openUrl: (url) => ipcRenderer.invoke('nest:openUrl', url),
  openExternal: (url) => ipcRenderer.invoke('nest:openExternal', url),
  back: () => ipcRenderer.invoke('nest:back'),

  // 日志与事件
  logs: (which) => ipcRenderer.invoke('nest:logs', which),
  onLog: (cb) => ipcRenderer.on('nest:log', (_e, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('nest:status', (_e, payload) => cb(payload)),
});
