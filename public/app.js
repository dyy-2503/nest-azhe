// 客户端：无框架、无构建。DOM 增量更新 + EventSource 推送。
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* --------------------------------- 常量 --------------------------------- */

const AV_COLORS = ['#5B8DEF', '#7C5CFF', '#0EB845', '#FFA715', '#FF7329', '#F566C8', '#0099FF', '#22B8CF'];

// QQ 的「输名字出表情」机制：打 /微笑 出来 😊。
// 原版靠 emoji 表里的 associateWords 字段做联想，这里用同一套思路的极简版。
const EMOJI = [
  ['微笑', '😊'], ['呲牙', '😁'], ['笑哭', '😂'], ['大笑', '😄'], ['调皮', '😜'],
  ['害羞', '😳'], ['憨笑', '😇'], ['白眼', '🙄'], ['酷', '😎'], ['doge', '🐶'],
  ['大哭', '😭'], ['憋屈', '😖'], ['崩溃', '😫'], ['无语', '😑'], ['发怒', '😡'],
  ['亲亲', '😘'], ['色', '😍'], ['思考', '🤔'], ['震惊', '😱'], ['困', '😴'],
  ['赞', '👍'], ['踩', '👎'], ['抱拳', '🙏'], ['鼓掌', '👏'], ['OK', '👌'],
  ['加油', '💪'], ['牵手', '🤝'], ['挥手', '👋'], ['吃瓜', '🍉'], ['奶茶', '🧋'],
  ['玫瑰', '🌹'], ['烟花', '🎉'], ['咖啡', '☕'], ['红包', '🧧'], ['火', '🔥'],
  ['星星', '✨'], ['爱心', '❤️'], ['便便', '💩'], ['骷髅', '💀'], ['月亮', '🌙'],
];

const state = {
  me: null,
  convs: [],
  worlds: [], // 别的 Nest 服务器（会话列表合并显示）
  activeId: null,
  messages: new Map(),   // convId -> Message[]
  seen: new Set(),       // 已渲染过的 message.id，防重
  live: new Map(),       // tempId -> { el, textEl, conv }
  typing: new Map(),     // convId -> { nickname, until, timer }
  filter: '',
  es: null,
  drafts: new Map(),
  membersOpen: false,
  tab: 'message',   // message | contact
  contacts: [],
  pending: [],      // 待发送图片：{file, url, w, h}
  replyTo: null,    // 正在回复的消息
  sending: false,   // 发送锁：带图上传期间挡住重复提交
  wasDown: false,   // SSE 断过线，重连后需要补拉
  serverInfo: null, // 服务器地址（拼接入命令用）
  friendIncoming: [], // 待处理的好友申请
  hasMore: new Map(),   // convId -> 还有更早的消息吗
  loadingMore: false,
};

/* --------------------------------- 工具 --------------------------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad2 = (n) => String(n).padStart(2, '0');

function hm(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const sameDay = (a, b) => {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today.getTime() - 864e5);
  if (sameDay(ts, today.getTime())) return hm(ts);
  if (sameDay(ts, y.getTime())) return '昨天';
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const listTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (sameDay(ts, now.getTime())) return hm(ts);
  if (sameDay(ts, now.getTime() - 864e5)) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function avatarHtml(user, extraClass = '') {
  const name = user?.nickname || '?';
  const isAgent = user?.kind === 'agent';
  const color = AV_COLORS[(Number(user?.id) || name.length) % AV_COLORS.length];
  // 有自定义头像就用图，没有才用"首字 + 色块"
  if (user?.avatar) {
    return `<div class="avatar has-img ${isAgent ? 'is-agent' : ''} ${extraClass}"
      style="background-image:url('${esc(user.avatar)}')"></div>`;
  }
  const style = isAgent ? '' : `background:${color}`;
  return `<div class="avatar ${isAgent ? 'is-agent' : ''} ${extraClass}" style="${style}">${esc(name.slice(0, 1))}</div>`;
}

/** 文本块渲染：转义 + @高亮 + 链接 */
function renderText(text) {
  let out = esc(text);
  out = out.replace(/(^|[\s(（])@([\w\u4e00-\u9fa5_-]{1,20})/g, '$1<span class="mention">@$2</span>');
  out = out.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  return out;
}

/* ---------------------------------- API --------------------------------- */

async function api(path, { method = 'GET', body, raw, type } = {}) {
  const init = { method, credentials: 'same-origin' };
  if (raw) {
    init.body = raw;
    init.headers = { 'content-type': type };
  } else if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

/* --------------------------------- 渲染 --------------------------------- */

function meConv() {
  return state.convs.find((c) => c.id === state.activeId) || null;
}

function convPeer(c) {
  if (c.kind !== 'dm' || !state.me) return null;
  return c.members.find((m) => m.id !== state.me.id) || null;
}

function convIsAgent(c) {
  if (c.kind === 'dm') return convPeer(c)?.kind === 'agent';
  return c.members.some((m) => m.kind === 'agent');
}

/** 把键盘高度写进 CSS 变量 --kb（iOS 上 innerHeight 不跟着键盘变） */
function watchKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', kb > 80 ? kb + 'px' : '0px');
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
}

function renderRail() {
  const av = $('#me-avatar');
  // 有自定义头像就用图；这一处以前只画首字，所以换了头像左上角不变
  if (state.me.avatar) {
    av.textContent = '';
    av.classList.add('has-img');
    av.style.background = `url('${state.me.avatar}') center/cover`;
  } else {
    av.textContent = (state.me.nickname || '?').slice(0, 1);
    av.classList.remove('has-img');
    av.style.background = AV_COLORS[state.me.id % AV_COLORS.length];
  }

  const total = state.convs.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0);
  const badge = $('#rail-badge');
  badge.hidden = total === 0;

  document.title = total ? `(${total}) Nest` : 'Nest';
}

﻿/** 一个本地会话的行（原来是内联在 renderConvList 里） */
function convRowHtml(c) {
  const peer = convPeer(c);
  const isAgent = convIsAgent(c);
  const avatarUser = c.kind === 'dm'
    ? { id: peer?.id ?? c.id, nickname: c.title, kind: peer?.kind, avatar: peer?.avatar }
    : { id: c.id + 100, nickname: c.title, kind: 'group', avatar: c.avatar };
  const last = c.lastMessage;
  const preview = last
    ? (last.senderId === state.me.id && !last.recalledAt ? '我: ' : '') + last.text
    : '还没有消息';
  const badge = c.unread > 0
    ? (c.muted ? '<i class="mute-dot"></i>' : `<i class="unread">${c.unread > 99 ? '99+' : c.unread}</i>`)
    : '';
  return `
    <div class="conv ${c.id === state.activeId ? 'is-active' : ''}" data-conv="${c.id}">
      ${avatarHtml(avatarUser)}
      <div class="conv-main">
        <div class="conv-name">
          <span>${esc(c.title)}</span>
          ${isAgent && c.kind === 'dm' ? '<i class="tag-ai">AI</i>' : ''}
          ${c.pinned ? '<i class="pin-flag">置顶</i>' : ''}
        </div>
      <div class="conv-preview">${esc(preview)}</div>
      </div>
      <div class="conv-side">
        <span class="conv-time">${listTime(last?.createdAt)}</span>
        ${badge}
      </div>
    </div>`;
}

/** 别的服务器上的会话：带世界标签；离线时灰掉、点它只提示 */
function worldConvRowHtml(world, c) {
  const offline = world.status !== 'online';
  const worldName = String(world.title || '').split(' @ ')[0] || '另一个服务器';
  const preview = c.lastText || '还没有消息';
  const badge = c.unread > 0 ? `<i class="unread">${c.unread > 99 ? '99+' : c.unread}</i>` : '';
  return `
    <div class="conv is-world world-entry${offline ? ' is-offline' : ''}" data-world="${world.id}" data-rconv="${c.id}"
      title="${offline ? esc(world.error || '离线') + '（连不上）' : '这条会话在 ' + esc(worldName) + '，点一下跳过去聊'}">
      ${avatarHtml({ id: c.id + 9000, nickname: c.title, kind: c.kind === 'group' ? 'group' : 'agent', avatar: c.avatar })}
      <div class="conv-main">
        <div class="conv-name">
          <span>${esc(c.title)}</span>
          <i class="tag-world">${esc(worldName)}</i>
        </div>
      <div class="conv-preview">${offline ? '连不上 · ' : '去那边聊 · '}${esc(preview)}</div>
      </div>
      <div class="conv-side">
        <span class="conv-time">${listTime(c.lastAt)}</span>
        <span class="world-jump" aria-hidden="true">↗</span>
        ${badge}
      </div>
    </div>`;
}

function renderConvList() {
  const box = $('#conv-list');
  const q = state.filter.trim().toLowerCase();

  const local = state.convs
    .filter((c) => {
      if (!q) return true;
      if (c.title.toLowerCase().includes(q)) return true;
      return c.members.some((m) => m.nickname.toLowerCase().includes(q));
    })
    .map((c) => ({ type: 'local', conv: c, at: c.lastMessage?.createdAt || 0, pinned: !!c.pinned }));

  const remote = [];
  for (const w of state.worlds || []) {
    for (const c of w.convs || []) {
      if (q && !String(c.title || '').toLowerCase().includes(q)) continue;
      remote.push({ type: 'remote', world: w, conv: c, at: c.lastAt || 0, pinned: false });
    }
  }

  const items = [...local, ...remote].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.at - a.at;
  });

  if (!items.length) {
    box.innerHTML = q
      ? '<div class="empty-hint" style="height:120px"><p>没有匹配的会话</p></div>'
      : '<div class="empty-hint" style="height:160px"><p>还没有会话</p><p class="empty-sub">点右上角 ＋ 建个群，或者在设置里用邀请码进群</p></div>';
    return;
  }

  box.innerHTML = items
    .map((it) => (it.type === 'local' ? convRowHtml(it.conv) : worldConvRowHtml(it.world, it.conv)))
    .join('');
}

/** 拉取"世界"（别的 Nest 服务器）的会话，用来合并进列表 */
async function loadWorlds() {
  try {
    const d = await api('/api/worlds');
    state.worlds = d.worlds || [];
  } catch {
    state.worlds = [];
  }

// 世界（别的服务器）的未读/最后一条会变，每 60 秒静默刷新一次列表
let refreshWorldsTick = null;
function startWorldsRefresh() {
  if (refreshWorldsTick) return;
  refreshWorldsTick = setInterval(async () => {
    if (document.hidden) return;
    await loadWorlds();
    if (state.tab === 'message') renderConvList();
    updateWorldsHint();
  }, 60_000);
}
}

function renderHead() {
  const c = meConv();
  if (!c) return;
  $('#chat-name').textContent = c.title;
  const peer = convPeer(c);
  let sub = '';
  if (c.kind === 'group') {
    const ai = c.members.filter((m) => m.kind === 'agent').length;
    const online = c.members.filter((m) => m.status === 'online').length;
    sub = `${c.members.length} 位成员 · ${online} 在线${ai ? ` · ${ai} 个 AI` : ''}`;
  } else {
    sub = peer?.status === 'online' ? '在线' : '离线';
  }
  $('#chat-sub').textContent = sub;
}

/** QQ 的做法：跨天显示日期，同一天间隔超过 5 分钟补一条时间分隔 */
function dividerKind(prev, ts) {
  if (!prev) return 'day';
  if (!sameDay(prev.createdAt, ts)) return 'day';
  return ts - prev.createdAt > 5 * 60 * 1000 ? 'time' : null;
}

function pill(text) {
  const el = document.createElement('div');
  el.className = 'date-pill';
  el.innerHTML = `<span>${esc(text)}</span>`;
  return el;
}

function datePill(ts) {
  const el = document.createElement('div');
  el.className = 'date-pill';
  el.innerHTML = `<span>${dayLabel(ts)}</span>`;
  return el;
}

function blockHtml(b) {
  if (b.t === 'image') {
    const ext = /^\.(png|jpg|jpeg|gif|webp)$/i.test(String(b.ext || '')) ? b.ext : '.png';
    return `<div class="bubble is-media"><img src="/media/${esc(b.sha)}${esc(ext)}" alt="图片" loading="lazy"></div>`;
  }
  if (b.t === 'voice') {
    const sec = Math.min(60, Math.max(1, Number(b.sec) || 1));
    // 48 根柱子（每根 2px + 1px 间隙 ≈ 144px）是固定成本，宽度得够，
    // 按老的 14 根公式算会溢出 90px，把整个消息区撑出横向滚动条
    const w = 96 + Math.min(96, sec * 6);
    const src = b.sha
      ? (Array.isArray(b.peaks) && b.peaks.length === 48
          ? b.peaks
          : Array.from({ length: 48 }, (_, i) => 20 + ((i * 37) % 70)))
      : Array.from({ length: 14 }, (_, i) => 20 + ((i * 5 + 3) % 13) * 5);
    const bars = src.map((v) => `<i style="height:${Math.max(3, Math.round((v / 100) * 26))}px"></i>`).join('');
    const playable = b.sha
      ? ` data-voice="1" data-src="/media/${esc(b.sha)}${esc(b.ext || '.webm')}" data-sec="${sec}"`
      : '';
    return `<div class="bubble is-voice${b.sha ? ' is-playable' : ''}" style="width:${Math.round(w)}px"${playable}>
      <div class="voice"><span class="vplay">${b.sha ? '▶' : '🔈'}</span><div class="bars">${bars}</div><span class="sec">${sec}"</span></div>
    </div>`;
  }
  if (b.t === 'file') {
    const ext = (b.name || '').split('.').pop().slice(0, 4).toUpperCase() || 'FILE';
    return `<div class="bubble is-file"><div class="file-card">
      <div class="fi">${esc(ext)}</div>
      <div><div class="fname">${esc(b.name || '文件')}</div>
      <div class="fsize">${fmtSize(b.size)}</div></div></div></div>`;
  }
  if (b.t === 'forward') {
    return `<div class="bubble is-file"><div class="fwd-card">
      <div class="fwd-head">聊天记录</div>
      <div class="fwd-body"><b>${esc(b.from || '')}</b>：${esc(b.text || '')}</div>
    </div></div>`;
  }
  return `<div class="bubble">${renderText(b.v || '')}</div>`;
}

function pokeHtml(m) {
  const b = (m.blocks || []).find((x) => x.t === 'poke');
  if (!b) return '';
  return `<div class="poke-line"><span>${esc(m.sender.nickname)}</span> 拍了拍 <b data-poke-uid="${Number(b.to)}">${esc(b.name || '对方')}</b></div>`;
}

function bubbleHtml(m) {
  const quote = m.reply
    ? `<div class="reply-quote" data-quote-id="${Number(m.reply.id)}" title="跳到原消息"><b>${esc(m.reply.nickname)}</b><span>${esc(m.reply.text)}</span></div>`
    : '';
  const blocks = m.blocks || [];
  if (!blocks.length) return '<div class="bubble"></div>';

  if (blocks[0].t === 'poke') return pokeHtml(m) || '<div class="bubble"></div>';

  const imgs = blocks.filter((b) => b.t === 'image');
  const texts = blocks.filter((b) => b.t === 'text');

  if (imgs.length) {
    const rest = texts.length
      ? `<div class="bubble">${texts.map((b) => renderText(b.v || '')).join('')}</div>`
      : '';
    return mediaHtml(imgs, quote) + rest;
  }

  const vids = blocks.filter((b) => b.t === 'video');
  if (vids.length) {
    const v = vids[0];
    const ext = /^\.(mp4|mov|webm)$/i.test(String(v.ext || '')) ? v.ext : '.mp4';
    const w = Number(v.w) || 0;
    const h = Number(v.h) || 0;
    const ar = w > 0 && h > 0 ? ` style="aspect-ratio:${w} / ${h}"` : '';
    return `<div class="bubble is-media is-video"${ar}><video src="/media/${esc(v.sha)}${esc(ext)}" controls playsinline preload="metadata"></video></div>`;
  }

  const first = blocks[0];
  if (first.t === 'voice' || first.t === 'file' || first.t === 'forward') return blockHtml(first);

  return `<div class="bubble">${quote}${texts.map((b) => renderText(b.v || '')).join('')}</div>`;
}

/** 图片气泡：单图用 aspect-ratio 占位（避免加载前塌成一条），多图走九宫格 */
function mediaHtml(imgs, quote = '') {
  if (imgs.length === 1) {
    const b = imgs[0];
    const ext = /^\.(png|jpg|jpeg|gif|webp)$/i.test(String(b.ext || '')) ? b.ext : '.png';
    const w = Number(b.w) || 0;
    const h = Number(b.h) || 0;
    const ar = w > 0 && h > 0 ? ` style="aspect-ratio:${w} / ${h}"` : '';
    // 没有尺寸信息的图 = 从"我的表情"发出去的贴纸，按贴纸尺寸渲染（不铺满气泡）
    const isSticker = !w && !h;
    const cls = isSticker ? 'bubble is-sticker' : 'bubble is-media';
    return `<div class="${cls}"${isSticker ? '' : ar}><img src="/media/${esc(b.sha)}${esc(ext)}" alt="${isSticker ? '表情' : '图片'}" loading="lazy"></div>`;
  }
  const cols = imgs.length <= 4 ? 2 : 3;
  return `<div class="img-grid c${cols}">${imgs
    .map((b) => {
      const ext = /^\.(png|jpg|jpeg|gif|webp)$/i.test(String(b.ext || '')) ? b.ext : '.png';
      return `<img src="/media/${esc(b.sha)}${esc(ext)}" alt="图片" loading="lazy">`;
    })
    .join('')}</div>`;
}

function messageEl(m, prev) {
  // 拍一拍：整行居中，不从属任何一方
  if ((m.blocks || [])[0]?.t === 'poke') {
    const el = document.createElement('div');
    el.className = 'poke-row';
    el.dataset.id = m.id;
    el.innerHTML = pokeHtml(m);
    return el;
  }
  if (m.recalledAt) {
    const el = document.createElement('div');
    el.className = 'recalled';
    el.textContent = `${m.sender.nickname} 撤回了一条消息`;
    return el;
  }
  const mine = m.sender.id === state.me.id;
  // 带引用的消息自成一块，不跟上一条折叠——否则引用块会被挤在别人消息下面看不清
  const grouped = !!prev && !prev.recalledAt && prev.sender.id === m.sender.id
    && !m.replyTo
    && sameDay(prev.createdAt, m.createdAt)
    && m.createdAt - prev.createdAt < 5 * 60 * 1000;

  const row = document.createElement('div');
  row.className = `msg${mine ? ' me' : ''}${grouped ? ' is-grouped' : ''}`;
  row.dataset.id = m.id;
  row.dataset.sender = m.sender.id;
  row.dataset.senderKind = m.sender.kind || 'human';

  // 折叠时不生成头像和 meta 节点本身 —— 只靠 CSS 隐藏的话，任何一条规则没命中就露出来
  const gutter = grouped
    ? '<div class="av-gutter" style="width:34px;height:1px;flex:none"></div>'
    : avatarHtml(m.sender);
  const meta = grouped
    ? ''
    : `<div class="msg-meta"><b>${esc(m.sender.nickname)}</b><span>${hm(m.createdAt)}</span></div>`;

  const transcript = m._voiceText
    ? `<div class="voice-text" title="本机离线转写，可能有错字">${esc(m._voiceText)}</div>`
    : '';
  row.innerHTML = `
    ${gutter}
    <div class="msg-body">
      ${meta}
      ${bubbleHtml(m)}
      ${transcript}
    </div>`;
  if (grouped) row.style.marginBottom = '6px';
  return row;
}

function renderMessages(convId, { scroll = true } = {}) {
  const box = $('#messages');
  const list = state.messages.get(convId) || [];
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty-hint"><p>还没有消息，说点什么</p></div>';
    return;
  }

  // 顶部「加载更早」：还有更早的就给个入口，没有就不占地方
  if (state.hasMore?.get(convId)) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'load-more';
    more.id = 'load-earlier';
    more.textContent = state.loadingMore ? '加载中…' : '加载更早的消息';
    more.disabled = !!state.loadingMore;
    more.addEventListener('click', () => loadEarlier(convId));
    box.appendChild(more);
  }

  const frag = document.createDocumentFragment();
  let prev = null;
  for (const m of list) {
    const kind = dividerKind(prev, m.createdAt);
    if (kind === 'day') frag.appendChild(pill(dayLabel(m.createdAt)));
    else if (kind === 'time') frag.appendChild(pill(hm(m.createdAt)));
    frag.appendChild(messageEl(m, prev));
    prev = m;
  }
  box.appendChild(frag);
  if (scroll) box.scrollTop = box.scrollHeight;
}

/* -------------------------------- 会话切换 ------------------------------- */

/**
 * 新用户的空状态：没有任何会话时别摆一个点不动的输入框，
 * 直接告诉他下一步能干什么。
 */
function showOnboarding() {
  $('#chat-name').textContent = '还没有会话';
  $('#chat-sub').textContent = '';
  const box = $('#messages');
  box.innerHTML = `
    <div class="onboard">
      <div class="onboard-emoji">👋</div>
      <h2>${esc(state.me?.nickname || '你好')}，欢迎进来</h2>
      <p>你现在还没有任何会话。<br>建一个群把朋友拉进来，或者先看看通讯录里有没有人。</p>
      <div class="onboard-actions">
        <button type="button" class="onboard-primary" id="onboard-new">创建一个群</button>
        <button type="button" class="onboard-ghost" id="onboard-contact">去通讯录</button>
      </div>
    </div>`;
  $('#composer').hidden = true;
  $('#onboard-new').addEventListener('click', () => $('#btn-new-group').click());
  $('#onboard-contact').addEventListener('click', () => switchTab('contact'));
}

/** 增量补拉：把 afterId 之后的消息全部取回来（每页 200 条，最多 5 页） */
async function fetchAfter(convId, afterId) {
  const out = [];
  let cursor = afterId;
  for (let round = 0; round < 5; round++) {
    const r = await api(`/api/messages?conv=${convId}&after=${cursor}&limit=200`);
    const list = r.messages || [];
    out.push(...list);
    if (!r.hasMore || !list.length) break;
    cursor = list[list.length - 1].id;
  }
  return out;
}

async function openConv(convId) {
  if (state.activeId === convId) return;
  // 存草稿
  if (state.activeId) state.drafts.set(state.activeId, $('#input').value);

  // 窄屏：选中会话后把抽屉收起来
  if (window.innerWidth <= 820) document.body.classList.add('list-collapsed');

  state.activeId = convId;
  state.membersOpen = false;
  $('#emoji-panel').hidden = true;
  $('#composer').hidden = false;   // 从空状态进来时要还回来

  const c = meConv();
  if (!c) return;
  c.unread = 0;
  renderRail();
  renderConvList();
  renderHead();

  $('#input').value = state.drafts.get(convId) || '';
  autoGrow();
  updateSend();
  // 触屏设备不自动聚焦：否则一进会话键盘就弹出来，把消息挡掉一半
  if (!matchMedia('(pointer: coarse)').matches) $('#input').focus();

  try {
    const cached = state.messages.get(convId) || [];
    const maxId = cached.length ? cached[cached.length - 1].id : 0;
    let messages;
    if (maxId) {
      // 有缓存：只补 after=最后一条，断了多久都能补齐（服务器是缓存，别丢中间的消息）
      const fresh = await fetchAfter(convId, maxId);
      if (state.activeId !== convId) return;
      const merged = new Map();
      for (const m of cached) merged.set(m.id, m);
      for (const m of fresh) merged.set(m.id, m);
      messages = [...merged.values()].sort((a, b) => a.id - b.id);
      if (fresh.length) toast('补上了 ' + fresh.length + ' 条消息');
    } else {
      const rows = await api(`/api/messages?conv=${convId}&limit=40`);
      // 请求期间用户可能已经切走：迟到的响应不能覆盖当前会话（否则 A 的消息会渲染进 B）
      if (state.activeId !== convId) return;
      messages = rows.messages;
      state.hasMore?.set(convId, !!rows.hasMore);
    }
    state.messages.set(convId, messages);
    messages.forEach((m) => state.seen.add(m.id));
    renderMessages(convId);
    const lastSeq = messages.length ? messages[messages.length - 1].seq : c.lastSeq;
    api('/api/read', { method: 'POST', body: { conv: convId, seq: lastSeq } }).catch(() => {});
  } catch (err) {
    console.error(err);
  }
}

/* ---- 图片灯箱 ---- */

function openLightbox(src, sticker) {
  const el = document.createElement('div');
  el.className = 'lightbox';
  el.innerHTML = `<div class="lb-close">×</div><img alt="">`
    + (sticker ? '<button type="button" class="lb-act" id="lb-sticker">存为表情</button>' : '');
  el.querySelector('img').src = src;
  document.body.appendChild(el);

  const close = () => {
    el.remove();
    document.removeEventListener('keydown', onEsc);
  };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  el.addEventListener('click', (e) => {
    if (e.target.closest('#lb-sticker')) return;
    close();
  });
  document.addEventListener('keydown', onEsc);

  const btn = el.querySelector('#lb-sticker');
  if (btn) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api('/api/stickers', { method: 'POST', body: { sha: sticker.sha, ext: sticker.ext } });
        toast('已存进表情');
        buildEmojiPanel();
        close();
      } catch (err) {
        toast(err.message || '存不了');
      }
    });
  }
}

/* ---- 加载更早：往前翻一页，并且保持当前视野不跳 ---- */

async function loadEarlier(convId) {
  const list = state.messages.get(convId) || [];
  if (!list.length || state.loadingMore) return;

  state.loadingMore = true;
  const box = $('#messages');
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  renderMessages(convId, { scroll: false });

  try {
    const { messages, hasMore } = await api(
      `/api/messages?conv=${convId}&before=${list[0].id}&limit=40`
    );
    if (!messages.length) {
      state.hasMore.set(convId, false);
      return;
    }
    const merged = [...messages, ...list];
    state.messages.set(convId, merged);
    state.hasMore.set(convId, !!hasMore);
    for (const m of messages) state.seen.add(m.id);

    renderMessages(convId, { scroll: false });
    // 新内容加在上面：把滚动位置往下推同样多，视觉上不跳
    box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  } catch (err) {
    toast(err.message || '加载失败');
  } finally {
    state.loadingMore = false;
    const btn = document.getElementById('load-earlier');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '加载更早的消息';
    }
  }
}

/* -------------------------------- 实时推送 ------------------------------- */

function setConn(text, bad) {
  const el = $('#conn');
  el.textContent = text;
  el.classList.toggle('is-bad', !!bad);
}

function connect() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/stream');
  state.es = es;
  es.onopen = () => {
    setConn('已连接', false);
    // 断线期间服务端不会补发（没有 Last-Event-ID 回放），所以重连后自己补拉一次，
    // 否则手机切网/休眠回来后中间那几条消息就永久缺失。
    if (state.wasDown) {
      state.wasDown = false;
      resync();
    }
  };
  es.onerror = () => {
    setConn('重连中…', true);
    state.wasDown = true;
  };
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handleEvent(ev);
  };
}

/** 重连补拉：会话列表 + 当前会话最近 40 条，按 id 合并去重 */
async function resync() {
  try {
    const data = await api('/api/bootstrap');
    const activeId = state.activeId;
    state.me = data.me;
    state.convs = data.conversations;
    sortConvs();
    renderConvList();
    if (!activeId) return;

    const cached = state.messages.get(activeId) || [];
    const maxId = cached.length ? cached[cached.length - 1].id : 0;
    const fresh = maxId
      ? await fetchAfter(activeId, maxId)
      : (await api(`/api/messages?conv=${activeId}&limit=40`)).messages;
    if (state.activeId !== activeId) return;
    const merged = new Map();
    for (const m of cached) merged.set(m.id, m);
    for (const m of fresh) merged.set(m.id, m);
    const list = [...merged.values()].sort((a, b) => a.id - b.id);
    state.messages.set(activeId, list);
    for (const m of list) state.seen.add(m.id);
    renderMessages(activeId, { scroll: false });
  } catch (err) {
    console.warn('[resync] 失败', err);
  }
}

// 流式气泡兜底：80 秒还没收尾（回合失败/断线）就撤掉，别永远停在"正在输入"
setInterval(() => {
  const t = Date.now();
  for (const [id, live] of state.live) {
    if (live.at && t - live.at > 80_000) {
      live.el.remove();
      state.live.delete(id);
    }
  }
}, 15_000);

function pushMessage(ev) {
  const m = ev.message;
  if (!m || state.seen.has(m.id)) return;
  state.seen.add(m.id);

  // 流式气泡收尾
  if (ev.replaceTemp) {
    const live = state.live.get(ev.replaceTemp);
    if (live) live.el.remove();
    state.live.delete(ev.replaceTemp);
  }

  const list = state.messages.get(m.convId) || [];
  list.push(m);
  state.messages.set(m.convId, list);

  const conv = state.convs.find((c) => c.id === m.convId);
  if (conv) {
    conv.lastMessage = {
      id: m.id, seq: m.seq, nickname: m.sender.nickname, senderId: m.sender.id,
      createdAt: m.createdAt, recalledAt: 0, kind: m.blocks[0]?.t || 'text',
      text: previewOf(m.blocks),
    };
    if (m.convId === state.activeId) {
      conv.unread = 0;
    } else if (m.sender.id !== state.me.id) {
      conv.unread = (conv.unread || 0) + 1;
    }
  }

  if (m.convId === state.activeId) {
    const box = $('#messages');
    const prev = list[list.length - 2] || null;
    const kind = dividerKind(prev, m.createdAt);
    if (kind === 'day') box.appendChild(pill(dayLabel(m.createdAt)));
    else if (kind === 'time') box.appendChild(pill(hm(m.createdAt)));
    box.appendChild(messageEl(m, prev));
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    if (nearBottom || m.sender.id === state.me.id) box.scrollTop = box.scrollHeight;

    if (m.sender.id !== state.me.id) {
      api('/api/read', { method: 'POST', body: { conv: m.convId, seq: m.seq } }).catch(() => {});
    }
  }

  sortConvs();
  renderConvList();
  renderRail();
}

function previewOf(blocks) {
  if (!blocks?.length) return '';
  const text = blocks.filter((b) => b.t === 'text').map((b) => b.v).join('').trim();
  if (text) return text.length > 48 ? text.slice(0, 48) + '…' : text;
  return { image: '[图片]', voice: '[语音]', file: '[文件]' }[blocks[0].t] || '';
}

function sortConvs() {
  state.convs.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0);
  });
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'message':
      pushMessage(ev);
      break;

    case 'message.start': {
      if (ev.conv !== state.activeId) break;
      const box = $('#messages');
      const row = document.createElement('div');
      row.className = 'msg is-live';
      row.innerHTML = `
        ${avatarHtml(ev.sender)}
        <div class="msg-body">
          <div class="msg-meta"><b>${esc(ev.sender.nickname)}</b><span>正在输入</span></div>
          <div class="bubble"><span class="live-text"></span></div>
        </div>`;
      box.appendChild(row);
      state.live.set(ev.tempId, {
        el: row, textEl: row.querySelector('.live-text'), conv: ev.conv, at: Date.now(),
      });
      box.scrollTop = box.scrollHeight;
      break;
    }

    case 'message.delta': {
      const live = state.live.get(ev.tempId);
      if (!live) break;
      live.textEl.append(document.createTextNode(ev.text));
      const box = $('#messages');
      box.scrollTop = box.scrollHeight;
      break;
    }

    case 'message.cancel': {
      // AI 这一轮潜水了，把空气泡收掉
      const live = state.live.get(ev.tempId);
      if (live) live.el.remove();
      state.live.delete(ev.tempId);
      break;
    }

    case 'recall': {
      const list = state.messages.get(ev.conv);
      const m = list?.find((x) => x.id === ev.id);
      if (m) {
        m.recalledAt = Date.now();
        if (ev.conv === state.activeId) renderMessages(ev.conv, { scroll: false });
      }
      break;
    }

    case 'typing': {
      if (ev.conv !== state.activeId) break;
      const hint = $('#typing');
      hint.textContent = `${ev.user.nickname} 正在输入…`;
      clearTimeout(state.typing.get(ev.conv)?.timer);
      const timer = setTimeout(() => { hint.textContent = ''; }, 3200);
      state.typing.set(ev.conv, { timer });
      break;
    }

    case 'presence': {
      for (const c of state.convs) {
        for (const m of c.members) if (m.id === ev.userId) m.status = ev.status;
      }
      if (meConv()) renderHead();
      break;
    }

    case 'read': {
      const c = state.convs.find((x) => x.id === ev.conv);
      if (c) c.peerReadSeq = ev.seq;
      break;
    }

    case 'reload': {
      // 别人新建了和我的私聊，重拉会话列表
      refreshConversations();
      break;
    }
  }
}

/* --------------------------------- 发送 --------------------------------- */

function applyEmojiShortcuts(text) {
  let out = text;
  for (const [name, char] of EMOJI) out = out.split(`/${name}`).join(char);
  return out;
}

function updateSend() {
  const hasContent = !!$('#input').value.trim() || state.pending.length > 0;
  $('#send').disabled = !hasContent || !state.activeId;
}

/* ---------------------------- 待发送图片（预览） ---------------------------- */

function readImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ file, url, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ file, url, w: 0, h: 0 });
    img.src = url;
  });
}

function renderPending() {
  const box = $('#pending');
  box.hidden = state.pending.length === 0;
  box.innerHTML = state.pending
    .map((p, i) => `<div class="pm"><img src="${p.url}" alt="">
      <button type="button" data-rm="${i}" title="移除">×</button></div>`)
    .join('');
  updateSend();
}

let typingSentAt = 0;
function pingTyping() {
  if (!state.activeId) return;
  const t = Date.now();
  if (t - typingSentAt < 2200) return;
  typingSentAt = t;
  api('/api/typing', { method: 'POST', body: { conv: state.activeId } }).catch(() => {});
}

async function send() {
  // 发送锁：带图时上传要几秒，期间再按回车会重复发一条（服务端也会用 clientId 兜底）
  if (!state.activeId || state.sending) return;
  const raw = $('#input').value.trim();
  const imgs = state.pending.slice();
  if (!raw && !imgs.length) return;

  const convId = state.activeId;
  const clientId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  state.sending = true;
  updateSend();

  try {
    const blocks = [];

    // 图片先待在输入框上方，按发送时才真正上传 —— 和 QQ 一个行为
    for (const p of imgs) {
      const meta = await api('/api/upload', {
        method: 'POST',
        raw: p.file,
        type: p.file.type || 'image/png',
      });
      blocks.push({ t: 'image', sha: meta.sha, ext: meta.ext, w: p.w, h: p.h });
    }

    const text = applyEmojiShortcuts(raw);
    if (text) blocks.push({ t: 'text', v: text });

    for (const p of imgs) URL.revokeObjectURL(p.url);
    state.pending = [];
    renderPending();
    $('#input').value = '';
    autoGrow();
    state.drafts.set(convId, '');

    const { message } = await api('/api/message', {
      method: 'POST',
      body: {
        conv: convId,
        blocks,
        replyTo: state.replyTo ? state.replyTo.id : 0,
        clientId,
      },
    });
    clearReply();
    // 服务端会通过 SSE 把同一条消息广播回来，seen 会挡住重复插入
    if (message && !state.seen.has(message.id)) {
      pushMessage({ type: 'message', message });
    }
  } catch (err) {
    if (!$('#input').value) {
      $('#input').value = raw;
      autoGrow();
    }
    toast(err.message || '发送失败');
  } finally {
    state.sending = false;
    updateSend();
  }
}

/* -------------------------------- 右键菜单 -------------------------------- */

let ctxEl = null;

function closeMenu() {
  if (ctxEl) {
    ctxEl.remove();
    ctxEl = null;
  }
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

function insertAt(text) {
  const el = $('#input');
  const pos = el.selectionStart ?? el.value.length;
  el.value = el.value.slice(0, pos) + text + el.value.slice(pos);
  el.focus();
  el.selectionStart = el.selectionEnd = pos + text.length;
  autoGrow();
  updateSend();
}

function setReply(msg) {
  state.replyTo = msg;
  const bar = $('#reply-bar');
  bar.hidden = false;
  bar.querySelector('.rb-text').innerHTML =
    `回复 <b>${esc(msg.sender.nickname)}</b>：${esc(previewOf(msg.blocks) || '（非文字消息）')}`;
  $('#input').focus();
}

function clearReply() {
  state.replyTo = null;
  const bar = $('#reply-bar');
  if (bar) bar.hidden = true;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制');
}

/* ---- 菜单构建：QQ 里「消息菜单」和「头像菜单」是两套 ---- */

function buildMessageMenu(msg) {
  const mine = msg.sender.id === state.me.id;
  const within2m = Date.now() - msg.createdAt < 2 * 60 * 1000;
  const hasText = (msg.blocks || []).some((b) => b.t === 'text' && (b.v || '').trim());

  // 别人的消息：复制 / 回复 / 转发 / 删除
  // 自己的消息：再加一条 2 分钟内的撤回
  const firstImg = (msg.blocks || []).find((b) => b.t === 'image');
  const items = [];
  if (hasText) items.push({ k: 'copy', label: '复制' });
  if (firstImg) items.push({ k: 'saveSticker', label: '存为表情' });
  const voiceBlock = (msg.blocks || []).find((b) => b.t === 'voice');
  if (voiceBlock?.sha) items.push({ k: 'toText', label: msg._voiceText ? '重新转文字' : '转文字' });
  items.push({ k: 'reply', label: '回复' });
  if (hasText) items.push({ k: 'forward', label: '转发' });
  if (mine && within2m) items.push({ k: 'recall', label: '撤回', danger: true, sep: true });
  items.push({ k: 'delete', label: '删除', danger: true, sep: !(mine && within2m) });
  return items;
}

// 头像菜单：＠他 / 发消息 / 复制昵称 —— 对齐 QQ 的 at_、message_、remark_ 那几个独立图标
function buildAvatarMenu(user) {
  const isGroup = meConv()?.kind === 'group';
  const self = user.id === state.me.id;
  const items = [];
  items.push({ k: 'select', label: '多选' });
  if (isGroup && !self) items.push({ k: 'at', label: '＠' + user.nickname });
  if (!self) items.push({ k: 'say', label: '发消息' });
  items.push({ k: 'copyName', label: '复制昵称', sep: isGroup && !self });
  return items;
}

function openMenu(x, y, items, ctx) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.innerHTML = items
    .map((it) =>
      `${it.sep ? '<div class="ctx-sep"></div>' : ''}` +
      `<button type="button" class="ctx-item${it.danger ? ' is-danger' : ''}" data-k="${it.k}">${esc(it.label)}</button>`)
    .join('');
  document.body.appendChild(el);

  // 贴边翻转：别让菜单跑出视口
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  ctxEl = el;

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-k]');
    if (!btn) return;
    const kind = btn.dataset.k;
    closeMenu();
    doAction(kind, ctx);
  });
}

async function doAction(kind, ctx) {
  const { msg, user, member } = ctx;

  // 群主对成员的操作
  if (kind.startsWith('gm:')) return groupAction(kind.slice(3), member);

  if (kind === 'copy' && msg) {
    const text = (msg.blocks || []).filter((b) => b.t === 'text').map((b) => b.v).join('\n');
    return copyText(text);
  }
  if (kind === 'copyName' && user) return copyText(user.nickname);
  if (kind === 'reply' && msg) return setReply(msg);
  if (kind === 'at' && user) return insertAt('＠' + user.nickname + ' ');
  if (kind === 'say' && user) return openDm(user.id);
  if (kind === 'forward' && msg) return openForwardPicker(msg);
  if (kind === 'select' && msg) return enterSelect(msg.id);
  if (kind === 'toText' && msg) {
    toast('转写中…');
    try {
      const r = await api('/api/voice/transcribe', { method: 'POST', body: { id: msg.id } });
      msg._voiceText = r.text || '（没听出内容）';
      const row = document.querySelector(`#messages [data-id="${msg.id}"]`);
      const body = row?.querySelector('.msg-body');
      if (body) {
        let el = body.querySelector('.voice-text');
        if (!el) {
          el = document.createElement('div');
          el.className = 'voice-text';
          el.title = '本机离线转写，可能有错字';
          body.appendChild(el);
        }
        el.textContent = msg._voiceText;
      }
      toast(r.cached ? '转好了（缓存）' : '转好了');
    } catch (err) {
      toast(err.message || '转写失败');
    }
    return;
  }
  if (kind === 'saveSticker' && msg) {
    const img = (msg.blocks || []).find((b) => b.t === 'image');
    if (!img) return toast('这条没有图片');
    try {
      await api('/api/stickers', { method: 'POST', body: { sha: img.sha, ext: img.ext } });
      toast('已存进表情');
      buildEmojiPanel();
    } catch (err) {
      toast(err.message || '存不了');
    }
    return;
  }

  try {
    if (kind === 'recall' && msg) {
      await api('/api/recall', { method: 'POST', body: { id: msg.id } });
      return; // 靠 SSE 的 recall 事件刷新，多端一致
    }
    if (kind === 'delete' && msg) {
      await api('/api/hide', { method: 'POST', body: { id: msg.id } });
      const list = state.messages.get(msg.convId) || [];
      state.messages.set(msg.convId, list.filter((m) => m.id !== msg.id));
      state.seen.delete(msg.id);
      if (msg.convId === state.activeId) renderMessages(msg.convId, { scroll: false });
      refreshConversations();
      return;
    }
  } catch (err) {
    toast(err.message || '操作失败');
  }
}

/* ---- 自己的资料 ---- */

function openMyProfile() {
  const me = state.me;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal prompt-modal" style="width:420px">
      <div class="modal-head">个人资料</div>
      <div class="modal-body">
        <div class="profile-head">
          <div class="avatar" id="my-avatar" style="background:${me.avatar ? `url(${me.avatar}) center/cover` : AV_COLORS[me.id % AV_COLORS.length]};cursor:pointer"
               title="点头换头像">${me.avatar ? '' : esc(me.nickname.slice(0, 1))}</div>
          <div class="profile-meta">
            <div class="profile-name">${esc(me.nickname)}</div>
            <div class="profile-handle">@${esc(me.handle)} · 点头像可以换</div>
          </div>
        </div>
        <div class="ga-field">
          <label>昵称</label>
          <input id="my-name" maxlength="16" value="${esc(me.nickname)}">
        </div>
        <div class="ga-field">
          <label>签名</label>
          <input id="my-sig" maxlength="60" value="${esc(me.signature || '')}" placeholder="一句话介绍自己">
        </div>
      </div>
      <div class="prompt-actions">
        <button type="button" class="prompt-cancel">取消</button>
        <button type="button" class="prompt-ok" id="my-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  mask.querySelector('.prompt-cancel').addEventListener('click', close);

  mask.querySelector('#my-avatar').addEventListener('click', () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/png,image/jpeg,image/gif,image/webp';
    picker.style.position = 'fixed';
    picker.style.left = '-9999px';
    picker.onchange = async () => {
      const f = picker.files[0];
      picker.remove();
      if (!f) return;
      try {
        // 先裁剪成 1:1 再上传（QQ/微信设置头像都这样）
        await new Promise((resolve) => {
          openCropper({
            file: f,
            aspect: 1,
            maxOut: 256,
            title: '裁剪头像（1:1）',
            onDone: async (blob) => {
              try {
                const up = await api('/api/upload', { method: 'POST', raw: blob, type: blob.type || 'image/png' });
                const r = await api('/api/profile', { method: 'POST', body: { avatar: up.url } });
                refreshMe(r.me);
                const av = mask.querySelector('#my-avatar') || mask.querySelector('[id$="-avatar"]');
                if (av) { av.textContent = ''; av.style.background = `url(${up.url}) center/cover`; }
                toast('头像换了');
                await refreshAfterProfileChange();
              } catch (err) {
                toast(err.message || '换头像失败');
              } finally { resolve(); }
            },
          });
        });
        return;
        // 下面是旧的直接上传逻辑（保留但走不到）
        const up = await api('/api/upload', { method: 'POST', raw: f, type: f.type });
        const r = await api('/api/profile', { method: 'POST', body: { avatar: up.url } });
        refreshMe(r.me);
        const av = mask.querySelector('#my-avatar');
        av.textContent = '';
        av.style.background = `url(${up.url}) center/cover`;
        toast('头像换了');
        await refreshAfterProfileChange();
      } catch (err) {
        toast(err.message || '换头像失败');
      }
    };
    document.body.appendChild(picker);
    picker.click();
  });

  mask.querySelector('#my-save').addEventListener('click', async () => {
    const nickname = mask.querySelector('#my-name').value.trim();
    if (!nickname) return toast('名字不能空着');
    try {
      const r = await api('/api/profile', {
        method: 'POST',
        body: { nickname, signature: mask.querySelector('#my-sig').value.trim() },
      });
      refreshMe(r.me);
      close();
      toast('已保存');
      await refreshAfterProfileChange();
    } catch (err) {
      toast(err.message || '保存失败');
    }
  });
}

/* ---- AI 资料页：资料 + 能力开关 + 记忆星图入口 ---- */

/** 资料改完：重新拉自己 + 当前会话的消息，头像昵称立刻到处都对 */
async function refreshAfterProfileChange() {
  try {
    const data = await api('/api/bootstrap');
    state.me = data.me;
    state.convs = data.conversations;
    renderRail();
    renderConvList();
    if (state.activeId) {
      const convId = state.activeId;
      const rows = await api(`/api/messages?conv=${convId}&limit=40`);
      if (state.activeId === convId) {
        state.messages.set(convId, rows.messages);
        renderMessages(convId, { scroll: false });
        renderHead();
      }
    }
  } catch { /* 刷新失败就算了，下次进会话会好 */ }
}

/** 把自己的资料同步到内存和界面（改完头像/昵称用） */
function refreshMe(me) {
  if (!me) return;
  state.me = { ...state.me, ...me };
  const nameEl = $('#me-avatar');
  if (nameEl) {
    nameEl.textContent = me.avatar ? '' : me.nickname.slice(0, 1);
    nameEl.classList.toggle('has-img', !!me.avatar);
    nameEl.style.background = me.avatar
      ? `url('${me.avatar}') center/cover`
      : AV_COLORS[me.id % AV_COLORS.length];
  }
  const setAvatar = $('#set-avatar');
  if (setAvatar) {
    setAvatar.textContent = me.avatar ? '' : me.nickname.slice(0, 1);
    setAvatar.style.background = me.avatar ? `url(${me.avatar}) center/cover` : AV_COLORS[me.id % AV_COLORS.length];
  }
  const setName = $('#set-name');
  if (setName) setName.textContent = me.nickname;
}

async function openAiProfile(member) {
  let info = null;
  try {
    info = await api(`/api/profile/${member.id}`);
  } catch (err) {
    return toast(err.message || '打不开');
  }
  const u = info.user;

  let mem = null;
  try {
    mem = await api(`/api/ai/${member.id}/memory`);
  } catch {}

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ai-modal">
      <div class="modal-head"><span>${esc(u.nickname)}</span></div>
      <div class="modal-body">
        <div class="profile-head">
          <div class="avatar" id="pf-avatar" style="background:${AV_COLORS[u.id % AV_COLORS.length]};cursor:pointer"
               title="点头换头像">${esc(u.nickname.slice(0, 1))}</div>
          <div class="profile-meta">
            <div class="profile-name">${esc(u.nickname)} <i class="tag-ai">AI</i></div>
            <div class="profile-handle">@${esc(u.handle)}</div>
            <div class="profile-sig">${esc(u.signature || '还没签名')}</div>
          </div>
        </div>

        <div class="ga-field">
          <label>签名</label>
          <input id="pf-sig" maxlength="60" value="${esc(u.signature || '')}" placeholder="它是个什么样的 AI">
        </div>

        <label class="pick-row" style="margin-bottom:6px">
          <input type="checkbox" id="pf-rename" ${u.self_rename ? 'checked' : ''}>
          <span>允许它自己改名字</span>
        </label>
        <div class="ai-tip">关着的时候，它只能改签名和头像，名字由你定。</div>

        <div class="ga-field" style="margin-top:16px">
          <label>能力（关掉它就没有）</label>
          <label class="pick-row">
            <input type="checkbox" id="cap-memory" ${u.capabilities?.memory ? 'checked' : ''}>
            <span>记忆</span>
            <i class="cap-hint">记得群里发生过什么</i>
          </label>
          <label class="pick-row">
            <input type="checkbox" id="cap-emotion" ${u.capabilities?.emotion ? 'checked' : ''}>
            <span>情绪</span>
            <i class="cap-hint">说话有情绪，不装中立</i>
          </label>
          <label class="pick-row">
            <input type="checkbox" id="cap-proactive" ${u.capabilities?.proactive ? 'checked' : ''}>
            <span>主动说话</span>
            <i class="cap-hint">没人 @ 也接话；关掉=只回 @</i>
          </label>
        </div>

        ${mem && !mem.missing ? `
        <div class="ga-field" style="margin-top:16px">
          <label>记忆</label>
          ${mem ? `
            <div class="mem-stats">
              <div><b>${mem.neurons}</b><span>神经元</span></div>
              <div><b>${mem.synapses}</b><span>突触</span></div>
              <div><b>${mem.fibers}</b><span>记忆段</span></div>
            </div>
            ${mem.emotions?.length ? `<div class="ai-tip">情绪：${mem.emotions.map(([k, v]) => `${esc(k)}×${v}`).join('、')}</div>` : ''}
            ${mem.recent?.length ? `<div class="mem-recent">${mem.recent.slice(0, 5).map((r) => `<div>· ${esc(r.text)}</div>`).join('')}</div>` : ''}
            <button type="button" class="btn-plain" id="pf-starmap">查看记忆星图</button>
            <div class="ai-tip" style="margin-top:6px">这台电脑上的多个 AI 共用同一份记忆，星图显示的是全部。</div>
          ` : ''}
        </div>` : ''}
      </div>
      <div class="prompt-actions">
        <button type="button" class="prompt-cancel">关闭</button>
        <button type="button" class="prompt-ok" id="pf-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  mask.querySelector('.prompt-cancel').addEventListener('click', close);

  // 点头像换头像
  mask.querySelector('#pf-avatar').addEventListener('click', () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/png,image/jpeg,image/gif,image/webp';
    picker.style.position = 'fixed';
    picker.style.left = '-9999px';
    picker.onchange = async () => {
      const f = picker.files[0];
      picker.remove();
      if (!f) return;
      try {
        // 先裁剪成 1:1 再上传（QQ/微信设置头像都这样）
        await new Promise((resolve) => {
          openCropper({
            file: f,
            aspect: 1,
            maxOut: 256,
            title: '裁剪头像（1:1）',
            onDone: async (blob) => {
              try {
                const up = await api('/api/upload', { method: 'POST', raw: blob, type: blob.type || 'image/png' });
                const r = await api('/api/profile', { method: 'POST', body: { avatar: up.url } });
                refreshMe(r.me);
                const av = mask.querySelector('#my-avatar') || mask.querySelector('[id$="-avatar"]');
                if (av) { av.textContent = ''; av.style.background = `url(${up.url}) center/cover`; }
                toast('头像换了');
                await refreshAfterProfileChange();
              } catch (err) {
                toast(err.message || '换头像失败');
              } finally { resolve(); }
            },
          });
        });
        return;
        // 下面是旧的直接上传逻辑（保留但走不到）
        const up = await api('/api/upload', { method: 'POST', raw: f, type: f.type });
        const r = await api('/api/profile', { method: 'POST', body: { avatar: up.url } });
        const av = mask.querySelector('#pf-avatar');
        av.style.background = `url(${up.url}) center/cover`;
        av.textContent = '';
        toast('头像换了');
        refreshMe(r.me);
        await refreshAfterProfileChange();
      } catch (err) {
        toast(err.message || '换头像失败');
      }
    };
    if (!picker.isConnected) document.body.appendChild(picker);
    picker.click();
  });

  mask.querySelector('#pf-save').addEventListener('click', async () => {
    try {
      await api('/api/profile', {
        method: 'POST',
        body: { signature: mask.querySelector('#pf-sig').value.trim() },
      });
      await api(`/api/ai/members/${member.id}/flags`, {
        method: 'POST',
        body: {
          self_rename: mask.querySelector('#pf-rename').checked ? 1 : 0,
          capabilities: {
            memory: mask.querySelector('#cap-memory').checked,
            emotion: mask.querySelector('#cap-emotion').checked,
            proactive: mask.querySelector('#cap-proactive').checked,
          },
        },
      });
      toast('已保存');
      close();
      const data = await api('/api/bootstrap');
      state.convs = data.conversations;
      renderConvList();
    } catch (err) {
      toast(err.message || '保存失败');
    }
  });

  const sm = mask.querySelector('#pf-starmap');
  if (sm) sm.addEventListener('click', () => openStarmap(member));
}

/* ---- 记忆星图：直接嵌现有的 starmap.html ---- */

function openStarmap(member) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask starmap-mask';
  mask.innerHTML = `
    <div class="starmap-box">
      <div class="starmap-bar">
        <span>${esc(member.nickname)} 的记忆星图</span>
        <button type="button" id="sm-refresh">刷新</button>
        <button type="button" id="sm-close">关闭</button>
      </div>
      <iframe id="sm-frame" src="/starmap.html?ai=${member.id}" title="记忆星图"></iframe>
    </div>`;
  document.body.appendChild(mask);
  const bar = mask.querySelector('.starmap-bar');
  mask.querySelector('#sm-close').addEventListener('click', () => mask.remove());
  mask.querySelector('#sm-refresh').addEventListener('click', async () => {
    const btn = mask.querySelector('#sm-refresh');
    btn.disabled = true;
    btn.textContent = '刷新中…（要跑几十秒）';
    try {
      await api(`/api/ai/${member.id}/starmap/refresh`, { method: 'POST' });
      mask.querySelector('#sm-frame').src = `/api/ai/${member.id}/starmap?t=${Date.now()}`;
      toast('星图已刷新');
    } catch (err) {
      toast(err.message || '刷新失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '刷新';
    }
  });
}



async function openPersonaEditor(member) {
  let cur = member.persona_text || '';
  if (!cur) {
    try {
      const { members } = await api('/api/ai/members');
      cur = members.find((x) => x.id === member.id)?.persona_text || '';
    } catch {}
  }

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal prompt-modal" style="width:520px">
      <div class="modal-head">${esc(member.nickname)} 的人设</div>
      <div class="modal-body">
        <div class="ai-tip">用几句话告诉它：它叫什么、是什么性格、怎么说话、懂什么。<br>填完保存，它下次开口前会自动知道。</div>
        <textarea id="ps-text" rows="8" maxlength="4000"
          placeholder="比如：你叫大肥鱼，说话很冲但心是热的。你跟人说话从来不打官腔，喜欢用短句，偶尔说句损话。你懂前端和部署，遇到具体问题就直接说怎么做。"
          style="width:100%;margin-top:8px;padding:10px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--text);font:13px/1.7 inherit;resize:vertical"></textarea>
      </div>
      <div class="prompt-actions">
        <button type="button" class="prompt-cancel">取消</button>
        <button type="button" class="prompt-ok">保存</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const ta = mask.querySelector('#ps-text');
  ta.value = cur;
  ta.focus();

  mask.addEventListener('mousedown', (e) => { if (e.target === mask) mask.remove(); });
  mask.querySelector('.prompt-cancel').addEventListener('click', () => mask.remove());
  mask.querySelector('.prompt-ok').addEventListener('click', async () => {
    const text = ta.value.trim();
    mask.remove();
    try {
      await api(`/api/ai/members/${member.id}/persona`, { method: 'POST', body: { persona: text } });
      toast(text ? '人设已保存，它下次开口时生效' : '人设已清空');
    } catch (err) {
      toast(err.message || '保存失败');
    }
  });
}

﻿/* ---- 服务器世界：把别的 Nest 服务器挂进来，会话列表合并显示 ---- */
async function openWorldsManager() {
  let worlds = [];
  try {
    worlds = (await api('/api/worlds')).worlds || [];
  } catch (err) {
    return toast(err.message || '拿不到世界列表');
  }

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const statusText = (w) => (w.status === 'online' ? '在线' : w.status === 'need-login' ? '登录失效' : '离线');
  const errText = (w) => (/fetch failed|ECONN|ENOTFOUND|timed? ?out/i.test(w.error || '') ? '' : (w.error || ''));
  mask.innerHTML = `
    <div class="modal" style="width:520px;max-height:82vh">
      <div class="modal-head"><span>服务器世界</span></div>
      <div class="modal-body" style="overflow:auto">
        <div class="ai-tip">把朋友的（或你自己电脑上的）Nest 服务器挂到这儿，它们的会话会合并显示在左边列表里；离线时灰掉，点一下就跳过去。</div>
        <div id="world-list" style="margin:12px 0">
          ${worlds.length ? worlds.map((w) => `
            <div class="world-row" data-wid="${w.id}" style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">
              <div style="flex:1;min-width:0">
                <div style="font-size:13.5px">${esc(w.title)}</div>
                <div style="font-size:11.5px;color:var(--text-3)">${esc(w.baseUrl)} · ${statusText(w)}${errText(w) ? ' · ' + esc(errText(w)) : ''}</div>
              </div>
              <button type="button" class="btn-plain" data-del="${w.id}">移除</button>
            </div>`).join('')
            : '<div class="ai-tip" style="color:var(--text-3)">还没有挂载任何服务器</div>'}
        </div>

        <div class="ga-field"><label>服务器地址</label>
          <input id="w-base" placeholder="http://192.168.1.172:8787 或 https://xxx.ts.net" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)">
        </div>
        <div class="ga-field"><label>那台服务器上的手机号</label>
          <input id="w-account" placeholder="手机号" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)">
        </div>
        <div class="ga-field"><label>密码</label>
          <input id="w-password" type="password" placeholder="密码" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)">
        </div>
      </div>
      <div class="prompt-actions">
        <button type="button" class="prompt-cancel">关闭</button>
        <button type="button" class="prompt-ok">添加</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const close = () => mask.remove();
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  mask.querySelector('.prompt-cancel').addEventListener('click', close);

  mask.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/worlds/${btn.dataset.del}`, { method: 'DELETE' });
        await loadWorlds();
        renderConvList();
        updateWorldsHint();
        btn.closest('.world-row').remove();
        toast('已移除');
      } catch (err) {
        toast(err.message || '移除失败');
      }
    });
  });

  mask.querySelector('.prompt-ok').addEventListener('click', async () => {
    const baseUrl = mask.querySelector('#w-base').value.trim();
    const account = mask.querySelector('#w-account').value.trim();
    const password = mask.querySelector('#w-password').value;
    if (!baseUrl || !account || !password) return toast('地址、手机号、密码都要填');
    const btn = mask.querySelector('.prompt-ok');
    btn.disabled = true;
    btn.textContent = '连接中…';
    try {
      await api('/api/worlds', { method: 'POST', body: { baseUrl, account, password } });
      await loadWorlds();
      renderConvList();
      updateWorldsHint();
      updateWorldsHint();
      startWorldsRefresh();
      toast('已添加，会话会出现在列表里');
      close();
    } catch (err) {
      toast(err.message || '加不进去');
      btn.disabled = false;
      btn.textContent = '添加';
    }
  });
}

function updateWorldsHint() {
  const el = $('#set-worlds-hint');
  if (!el) return;
  const list = state.worlds || [];
  const online = list.filter((w) => w.status === 'online').length;
  el.textContent = list.length ? `${online}/${list.length} 在线` : '未添加';
}

/* ---- 建群：起名 + 勾选好友一起拉进来 ---- */

async function openCreateGroup() {
  const [fr, ai] = await Promise.all([
    api('/api/friends/requests').catch(() => ({ friends: [] })),
    api('/api/ai/members').catch(() => ({ members: [] })),
  ]);
  const candidates = [
    ...(fr.friends || []).map((u) => ({ id: u.id, nickname: u.nickname, kind: 'human' })),
    ...(ai.members || []).map((u) => ({ id: u.id, nickname: u.nickname, kind: 'agent' })),
  ];

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal prompt-modal">
      <div class="modal-head">新建群聊</div>
      <div class="modal-body">
        <input type="text" id="cg-title" maxlength="40" placeholder="群名称，比如：深夜写码互助会">
        <div style="margin-top:14px">
          <div class="cmd-label">一起拉进来（可选）</div>
          ${candidates.length ? candidates.map((u) => `
            <label class="pick-row" data-uid="${u.id}">
              <input type="checkbox" value="${u.id}">
              <span>${esc(u.nickname)}</span>
              ${u.kind === 'agent' ? '<i class="tag-ai">AI</i>' : ''}
            </label>`).join('')
            : '<div class="ai-tip">还没有好友。先用「设置 → 加好友」加几个，或者建完群发邀请码。</div>'}
        </div>
      </div>
      <div class="prompt-actions">
        <button type="button" class="prompt-cancel">取消</button>
        <button type="button" class="prompt-ok">创建</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const titleEl = mask.querySelector('#cg-title');
  titleEl.focus();

  const finish = (v) => { mask.remove(); return v; };
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(null); });
  mask.querySelector('.prompt-cancel').addEventListener('click', () => finish(null));
  mask.querySelector('.prompt-ok').addEventListener('click', async () => {
    const title = titleEl.value.trim();
    if (!title) { toast('先起个群名'); titleEl.focus(); return; }
    const memberIds = [...mask.querySelectorAll('input[type=checkbox]:checked')].map((x) => Number(x.value));
    mask.remove();
    try {
      const { conv } = await api('/api/conversation', { method: 'POST', body: { title, memberIds } });
      const data = await api('/api/bootstrap');
      state.convs = data.conversations;
      renderConvList();
      if (conv?.id) await openConv(conv.id);
      if (memberIds.length) toast(`建好了，拉了 ${memberIds.length} 个人进来`);
    } catch (err) {
      toast(err.message || '创建失败');
    }
  });
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); mask.querySelector('.prompt-ok').click(); }
  });
}

/* ---- 群里的「拉好友进来」---- */

async function inviteFriendsToGroup() {
  const c = meConv();
  if (!c || c.kind !== 'group') return;
  const inGroup = new Set((c.members || []).map((m) => m.id));
  const [fr, ai] = await Promise.all([
    api('/api/friends/requests').catch(() => ({ friends: [] })),
    api('/api/ai/members').catch(() => ({ members: [] })),
  ]);
  const candidates = [
    ...(fr.friends || []).map((u) => ({ id: u.id, nickname: u.nickname, kind: 'human' })),
    ...(ai.members || []).map((u) => ({ id: u.id, nickname: u.nickname, kind: 'agent' })),
  ].filter((u) => !inGroup.has(u.id));

  if (!candidates.length) return toast('好友都在群里了（或者还没加好友）');

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal prompt-modal">
      <div class="modal-head">拉进「${esc(c.title)}」</div>
      <div class="modal-body">
        ${candidates.map((u) => `
          <label class="pick-row" data-uid="${u.id}">
            <input type="checkbox" value="${u.id}">
            <span>${esc(u.nickname)}</span>
            ${u.kind === 'agent' ? '<i class="tag-ai">AI</i>' : ''}
          </label>`).join('')}
      </div>
      <div class="prompt-actions">
        <button type="button" class="prompt-cancel">取消</button>
        <button type="button" class="prompt-ok">拉进来</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) mask.remove(); });
  mask.querySelector('.prompt-cancel').addEventListener('click', () => mask.remove());
  mask.querySelector('.prompt-ok').addEventListener('click', async () => {
    const ids = [...mask.querySelectorAll('input[type=checkbox]:checked')].map((x) => Number(x.value));
    if (!ids.length) return toast('先勾几个人');
    mask.remove();
    let ok = 0;
    for (const id of ids) {
      try {
        await api(`/api/conversation/${c.id}/members`, { method: 'POST', body: { userId: id } });
        ok++;
      } catch (err) {
        toast(err.message || '有人没拉进来');
      }
    }
    const data = await api('/api/bootstrap');
    state.convs = data.conversations;
    renderConvList();

    if (ok) toast(`拉了 ${ok} 个人进来`);
  });
}

/* ---- 加好友：手机号搜索 → 发申请 ---- */

async function openAddFriend() {
  closeMenu();
  $('#settings-popover').hidden = true;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal prompt-modal">
      <div class="modal-head">加好友</div>
      <div class="modal-body">
        <div class="ai-tip">填手机号找人，或者填对方的 <b>@ID</b> 找 AI。<br>AI 的 ID 在它的名字下面能看到，比如 <code>@ai_408c4c7b</code>。</div>
        <div class="ai-create">
          <input type="text" id="f-phone" maxlength="32" placeholder="手机号 或 @ai_xxxx">
          <button type="button" id="f-search">搜索</button>
        </div>
        <div id="f-result"></div>
      </div>
      <button type="button" class="modal-cancel">关闭</button>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('.modal-cancel')) mask.remove();
  });

  const result = mask.querySelector('#f-result');
  const doSearch = async () => {
    const query = mask.querySelector('#f-phone').value.trim();
    if (!query) {
      result.innerHTML = '<div class="ai-tip is-err">填个手机号或 @ID</div>';
      return;
    }
    try {
      const { user } = await api('/api/friends/search', { method: 'POST', body: { query } });
      const rel = {
        friend: '已经是好友',
        pending_out: '你已经发过申请，等对方同意',
        pending_in: '对方也在等你同意（去通讯录「新的朋友」）',
        none: '',
      }[user.relation] || '';

      result.innerHTML = `
        <div class="friend-row">
          <div class="avatar" style="background:${AV_COLORS[user.id % AV_COLORS.length]}">${esc(user.nickname.slice(0, 1))}</div>
          <div class="ai-row-main">
            <div class="ai-row-name">${esc(user.nickname)}${user.kind === 'agent' ? ' <i class="tag-ai">AI</i>' : ''}</div>
            <div class="ai-row-sub">${esc(rel || '@' + user.handle)}${user.kind === 'agent' && !rel ? ' · 申请会发给它的主人' : ''}</div>
          </div>
          ${user.relation === 'none' ? '<button type="button" id="f-send">加好友</button>' : ''}
        </div>`;

      const send = result.querySelector('#f-send');
      if (send) {
        send.addEventListener('click', async () => {
          try {
            const r = await api('/api/friends/request', { method: 'POST', body: { userId: user.id } });
            toast(r.friend ? '对方也申请过你，已经是好友了' : '申请已发出，等对方同意');
            result.innerHTML = '<div class="ai-tip">已发出，等对方在通讯录里同意。</div>';
            refreshFriendHint();
          } catch (err) {
            toast(err.message || '发送失败');
          }
        });
      }
    } catch (err) {
      result.innerHTML = `<div class="ai-tip is-err">${esc(err.message || '没找到')}</div>`;
    }
  };

  mask.querySelector('#f-search').addEventListener('click', doSearch);
  mask.querySelector('#f-phone').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });
  mask.querySelector('#f-phone').focus();
}

/* ---- 好友申请：收到的列表，同意 / 拒绝 ---- */

async function openFriendRequests() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ai-modal">
      <div class="modal-head"><span>新的朋友</span></div>
      <div class="modal-body"><div id="fr-list">加载中…</div></div>
      <button type="button" class="modal-cancel">关闭</button>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('.modal-cancel')) mask.remove();
  });

  const box = mask.querySelector('#fr-list');
  const render = async () => {
    const { incoming, outgoing } = await api('/api/friends/requests');
    if (!incoming.length && !outgoing.length) {
      box.innerHTML = '<div class="ai-empty">没有待处理的申请</div>';
      return;
    }
    box.innerHTML = [
      ...incoming.map((r) => `
        <div class="friend-row" data-id="${r.id}">
          <div class="avatar" style="background:${AV_COLORS[r.uid % AV_COLORS.length]}">${esc(r.nickname.slice(0, 1))}</div>
          <div class="ai-row-main">
            <div class="ai-row-name">${esc(r.nickname)}</div>
            <div class="ai-row-sub">${esc(r.message || '想加你为好友')}${r.for_ai ? ` · 要加「${esc(r.to_nickname)}」` : ''}</div>
          </div>
          <button type="button" data-act="accept" data-id="${r.id}">同意</button>
          <button type="button" data-act="reject" data-id="${r.id}" class="is-danger">拒绝</button>
        </div>`).join(''),
      ...outgoing.map((r) => `
        <div class="friend-row is-dim">
          <div class="avatar" style="background:${AV_COLORS[r.uid % AV_COLORS.length]}">${esc(r.nickname.slice(0, 1))}</div>
          <div class="ai-row-main">
            <div class="ai-row-name">${esc(r.nickname)}</div>
            <div class="ai-row-sub">等待对方同意</div>
          </div>
        </div>`).join(''),
    ].join('');
  };

  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    try {
      await api(`/api/friends/${btn.dataset.act}`, { method: 'POST', body: { id: Number(btn.dataset.id) } });
      toast(btn.dataset.act === 'accept' ? '已加为好友' : '已拒绝');
      await render();
      await refreshFriendHint();
      await loadContacts();
    } catch (err) {
      toast(err.message || '操作失败');
    }
  });

  await render();
}

async function refreshFriendHint() {
  try {
    const { incoming } = await api('/api/friends/requests');
    $('#set-friend-hint').textContent = incoming.length ? `${incoming.length} 条申请` : '手机号';
  } catch {
    $('#set-friend-hint').textContent = '手机号';
  }
}



async function openGroupPanel() {
  const c = meConv();
  if (!c) return toast('先选一个会话');

  // 私聊没有群公告、没有邀请码 —— 单独给一个简单的面板
  if (c.kind !== 'group') {
    const peer = convPeer(c);
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <div class="modal-head">${esc(peer?.nickname || c.title || '私聊')}</div>
        <div class="modal-body" style="padding:14px">
          <div class="ai-tip">这是你和 ${esc(peer?.nickname || '对方')} 的私聊。${
            peer?.kind === 'agent' ? '对方是一个 AI 成员，它跑在其主人的电脑上。' : ''
          }</div>
        </div>
        <button type="button" class="modal-cancel">关闭</button>
      </div>`;
    document.body.appendChild(mask);
    mask.addEventListener('click', (e) => {
      if (e.target === mask || e.target.closest('.modal-cancel')) mask.remove();
    });
    return;
  }

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ai-modal">
      <div class="modal-head"><span>${esc(c.title)}</span></div>
      <div class="modal-body">
        <div class="guide-step">
          <b>群公告</b>
          <p>${c.announcement ? esc(c.announcement) : '暂无'}</p>
        </div>
        <div class="guide-step">
          <b>邀请别人进群</b>
          <p>已经加了好友的，直接点下面按钮勾选；陌生人的话，把码发给对方填。</p>
          <button type="button" class="btn-plain" id="gi-pick-friends">拉好友进来</button>
          <div id="gi-box" style="margin-top:8px"></div>
        </div>
      </div>
      <button type="button" class="modal-cancel">关闭</button>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('.modal-cancel')) mask.remove();
  });

  try {
    const { code } = await api(`/api/conversation/${c.id}/invite`, { method: 'POST' });
    const box = mask.querySelector('#gi-box');
    box.appendChild(copyable(code));
  } catch (err) {
    mask.querySelector('#gi-box').textContent = err.message || '取不到邀请码';
  }

  mask.querySelector('#gi-pick-friends').addEventListener('click', () => {
    mask.remove();
    inviteFriendsToGroup().catch((err) => toast(err.message || '打不开'));
  });
}



function openTextPrompt({ title, placeholder = '', value = '', confirm = '确定', hint = '' }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal prompt-modal">
        <div class="modal-head">${esc(title)}</div>
        <div class="modal-body">
          <input type="text" id="prompt-input" maxlength="40"
                 value="${esc(value)}" placeholder="${esc(placeholder)}">
          ${hint ? `<div class="ai-tip" style="margin:8px 0 0">${esc(hint)}</div>` : ''}
        </div>
        <div class="prompt-actions">
          <button type="button" class="prompt-cancel">取消</button>
          <button type="button" class="prompt-ok">${esc(confirm)}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const input = mask.querySelector('#prompt-input');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      mask.remove();
      resolve(v);
    };

    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(null); });
    mask.querySelector('.prompt-cancel').addEventListener('click', () => finish(null));
    mask.querySelector('.prompt-ok').addEventListener('click', () => finish(input.value.trim() || null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); }
      if (e.key === 'Escape') finish(null);
    });
    input.focus();
    input.select();
  });
}

/* ---- 邀请码：给另一个真人开一个位置 ---- */

async function openInviteManager() {
  closeMenu();
  $('#settings-popover').hidden = true;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ai-modal">
      <div class="modal-head">邀请码</div>
      <div class="modal-body">
        <div class="ai-list" id="inv-list">加载中…</div>
        <div class="ai-tip">
          发给要进来的朋友，他在登录页点「用邀请码注册」，填账号、昵称、密码和这个码就能进来。<br>
          用完即失效；AI 成员<b>不需要</b>邀请码，走钥匙。
        </div>
      </div>
      <button type="button" class="modal-cancel">关闭</button>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('.modal-cancel')) close();
  });

  const render = async () => {
    const { invites } = await api('/api/invites');
    const box = mask.querySelector('#inv-list');
    const free = invites.filter((i) => !i.used);
    const used = invites.filter((i) => i.used);

    box.innerHTML = `
      <button type="button" class="inv-new" id="inv-new">＋ 生成一个新邀请码</button>
      ${free.length ? free.map((i) => `
        <div class="inv-row">
          <code>${esc(i.code)}</code>
          <button type="button" class="inv-copy" data-code="${esc(i.code)}">复制</button>
        </div>`).join('') : '<div class="ai-empty">还没有可用的邀请码</div>'}
      ${used.length ? `<div class="ai-tip" style="margin-top:10px">已用掉 ${used.length} 个</div>` : ''}`;

    box.querySelector('#inv-new').addEventListener('click', async () => {
      try {
        await api('/api/invites', { method: 'POST' });
        await render();
      } catch (err) {
        toast(err.message || '生成失败');
      }
    });
    box.querySelectorAll('.inv-copy').forEach((btn) => {
      btn.addEventListener('click', () => copyText(btn.dataset.code));
    });
  };

  await render();
  refreshInviteCount().catch(() => {});
}

async function refreshInviteCount() {
  try {
    const { available } = await api('/api/invites');
    $('#set-invite-hint').textContent = available ? `${available} 个可用` : '无';
  } catch {
    $('#set-invite-hint').textContent = '—';
  }
}



/* ---- 二次确认弹框 ---- */

function confirmModal({ title, text, confirm = '确定', danger = false }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal prompt-modal">
        <div class="modal-head">${esc(title)}</div>
        <div class="modal-body"><p class="confirm-text">${text}</p></div>
        <div class="prompt-actions">
          <button type="button" class="prompt-cancel">取消</button>
          <button type="button" class="prompt-ok${danger ? ' is-danger' : ''}">${esc(confirm)}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      mask.remove();
      resolve(v);
    };
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(false); });
    mask.querySelector('.prompt-cancel').addEventListener('click', () => finish(false));
    mask.querySelector('.prompt-ok').addEventListener('click', () => finish(true));
    document.addEventListener('keydown', function escClose(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', escClose);
        finish(false);
      }
    });
  });
}

/* ---- 接入说明：把「创建 → 进群 → 钥匙 → 跑起来」讲清楚 ---- */

function openAiGuide() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal guide-modal">
      <div class="modal-head">怎么把 AI 接进来</div>
      <div class="modal-body guide-body">
        <div class="guide-step">
          <b>1. 把 AI 拉进群</b>
          <p>在你那一行点「拉进群」，选一个群。<b>没进群的 AI 收不到任何消息。</b></p>
        </div>
        <div class="guide-step">
          <b>2. 给它一把钥匙</b>
          <p>点「重发钥匙」，界面上会出现钥匙和一条完整命令。复制那条命令，发给对方。</p>
        </div>
        <div class="guide-step">
          <b>3. 对方把桥接文件放到自己电脑上</b>
          <p>点<a href="/nest-bridge.mjs" class="guide-dl">下载 nest-bridge.mjs</a>（一个小文件，放哪个目录都行）。
             他电脑上还要有 <b>Node 22+</b>，终端里 <code>node -v</code> 能看到版本号就行。</p>
        </div>
        <div class="guide-step">
          <b>4. 对方在终端里跑那条命令</b>
          <p>跑之前他电脑上的 <b>DSH 要是开着的</b>。看到 <code>已连上消息流</code> 就成功了。</p>
        </div>
        <div class="guide-note">
          之后群里有人说话，他的 DSH 就会接。他的 AI 用他自己电脑上的文件和工具，我们这边看不到。
        </div>
      </div>
      <button type="button" class="modal-cancel">知道了</button>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('.modal-cancel')) mask.remove();
  });
}

/* ---- 把某个 AI 拉进一个群 ---- */

function pickGroupAndAdd(member) {
  const groups = state.convs.filter((c) => c.kind === 'group');
  if (!groups.length) return toast('你还没有群，先用左上角 ＋ 建一个');

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-head">把「${esc(member.nickname)}」拉进…</div>
      <div class="modal-list">
        ${groups.map((c) => `
          <button type="button" class="modal-row" data-conv="${c.id}">
            <div class="avatar" style="background:${AV_COLORS[c.id % AV_COLORS.length]}">${esc(c.title.slice(0, 1))}</div>
            <div class="modal-row-main">
              <div class="modal-row-name">${esc(c.title)}</div>
              <div class="modal-row-sub">${(c.members || []).length} 人</div>
            </div>
          </button>`).join('')}
      </div>
      <button type="button" class="modal-cancel">取消</button>
    </div>`;
  document.body.appendChild(mask);

  mask.addEventListener('click', async (e) => {
    if (e.target === mask || e.target.closest('.modal-cancel')) return mask.remove();
    const row = e.target.closest('[data-conv]');
    if (!row) return;
    const convId = Number(row.dataset.conv);
    try {
      await api(`/api/conversation/${convId}/members`, {
        method: 'POST',
        body: { userId: member.id },
      });
      mask.remove();
      toast(`已把「${member.nickname}」拉进群`);
      const data = await api('/api/bootstrap');
      state.convs = data.conversations;
      renderConvList();
    } catch (err) {
      toast(err.message || '拉进群失败');
    }
  });
}

/* ---- 我的 AI：创建成员、拿钥匙、拉进群 ---- */

function copyable(text) {
  const box = document.createElement('div');
  box.className = 'key-box';
  box.innerHTML = `<code>${esc(text)}</code><button type="button" class="key-copy">复制</button>`;
  box.querySelector('.key-copy').addEventListener('click', () => copyText(text));
  return box;
}

/** 钥匙 + 一段「接入口令」：粘进 DSH 的对话框，让它自己下载、自己跑 */
function keyReveal(title, key, aiName = '') {
  const host = location.hostname;
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const lan = state.serverInfo?.lan?.[0];
  const base = loopback && lan
    ? `http://${lan}:${state.serverInfo.port}`
    : location.origin;
  const name = aiName || '这个 AI';

  const prompt = `照下面做，别的都不要研究，也不要改任何代码。只做这四步：

1. 下载 ${base}/nest-bridge.mjs ，保存成 nest-bridge.mjs（放哪都行，建个 nest 目录）
2. 在后台常驻运行它：
   node nest-bridge.mjs --server ${base} --key ${key}
   （如果 node 不在 PATH 里，用 DSH 自带的那个 node）
3. 等它的输出里出现「已连上消息流」，就算成功
4. 告诉我一声。然后记住：在这个聊天室里你叫「${name}」，别人说话你就接。

如果哪一步报错，把完整错误发给我，不要自己想办法绕过。`;

  const box = document.createElement('div');
  box.className = 'key-reveal';
  box.innerHTML = `<div class="key-reveal-title">${esc(title)}</div>`;
  box.appendChild(copyable(key));

  // 主入口：口令
  const promptBox = document.createElement('div');
  promptBox.className = 'cmd-box';
  promptBox.innerHTML = `
    <div class="cmd-label">把这整段粘到<b>你自己电脑上 DSH 的对话框</b>里，它会自己搞定</div>`;
  const pre = document.createElement('pre');
  pre.className = 'prompt-block';
  pre.textContent = prompt;
  promptBox.appendChild(pre);

  const copyPrompt = document.createElement('button');
  copyPrompt.type = 'button';
  copyPrompt.className = 'btn-plain';
  copyPrompt.textContent = '复制接入口令';
  copyPrompt.addEventListener('click', () => copyText(prompt));
  promptBox.appendChild(copyPrompt);

  // 兜底：没有 DSH 的人可以手动跑
  const manual = document.createElement('details');
  manual.className = 'manual-box';
  manual.innerHTML = `
    <summary>没有 DSH？手动跑（需要装 Node 22+）</summary>
    <div class="key-box" style="margin-top:8px">
      <code>node nest-bridge.mjs --server ${base} --key ${key}</code>
    </div>
    <div class="cmd-legend">
      <div><b>--server</b> = 群主那台电脑的地址</div>
      <div><b>--key</b> = 它的身份，别给别人</div>
      <div class="dim">本机 DSH 会自动找到，不用填端口</div>
    </div>`;
  promptBox.appendChild(manual);

  box.appendChild(promptBox);

  if (loopback && lan) {
    const note = document.createElement('div');
    note.className = 'cmd-note';
    note.textContent = `地址已换成本机局域网地址 ${lan}：同学不在同一台电脑上，用 127.0.0.1 是连不上的。`;
    box.appendChild(note);
  } else if (loopback) {
    const note = document.createElement('div');
    note.className = 'cmd-note is-warn';
    note.textContent = '没探测到局域网地址。同学要连的话，把地址换成你这台机器的 IP（如 192.168.x.x），或者用内网穿透。';
    box.appendChild(note);
  }

  return box;
}

/* ---------------------------- 创建 AI 向导 ---------------------------- */

const AI_DEFAULTS = { memory: true, emotion: true, proactive: true };
// 需要 DSH 插件的能力：这里只声明"要什么"，不扫描任何机器。
// AI 跑在它主人的电脑上，插件得他自己装——服务器扫不到，也不该扫。
const DSH_CAP_OPTIONS = [
  { id: 'voice', name: '听懂语音', desc: '别人发语音，它也能看懂内容', plugin: 'speech-to-text（含 SenseVoice 模型）' },
  { id: 'longterm', name: '长期记忆', desc: '跨会话记得住人和事', plugin: 'graphmemory 或 nmem' },
];

const AI_TEMPLATES = [
  { id: 'plain', name: '普通聊天', persona: '', caps: { ...AI_DEFAULTS } },
  { id: 'writer', name: '写作助手', persona: '你擅长把杂乱的想法写成通顺的文字，帮人改稿、润色。', caps: { ...AI_DEFAULTS } },
  { id: 'coder', name: '代码搭子', persona: '你是个靠谱的程序员搭子，讲人话、给能跑的方案，不废话。', caps: { ...AI_DEFAULTS } },
  { id: 'quiet', name: '安静旁听', persona: '', caps: { ...AI_DEFAULTS, proactive: false } },
];

/** 服务器地址：手机上是 localhost，桥接要能连的得是局域网 IP */
/**
 * 接入口令里该写哪个服务器地址。
 * 桥接可能跑在同一台机器（127.0.0.1 最快）、同一局域网（lan），
 * 也可能跑在朋友的机器上（必须用公网地址）。所以都列出来，让接手的人自己选对的那条。
 */
function bridgeServerUrls() {
  const info = state.serverInfo || {};
  const port = info.port || 8787;
  const out = [{ url: `http://127.0.0.1:${port}`, when: '桥接就在这台电脑上' }];
  if (info.lan?.length) {
    out.push({ url: `http://${info.lan[0]}:${port}`, when: '同一局域网里的另一台电脑' });
  }
  if (info.publicUrl) {
    out.push({ url: info.publicUrl, when: '不在同一个网络（外网/朋友家）' });
  }
  return out;
}

/** 只取一个默认地址（老逻辑保留） */
function bridgeServerUrl() {
  return bridgeServerUrls()[0].url;
}

/**
 * 生成一段"复制粘贴给 DSH 用"的口令。
 * 用户的原话：最后要返回一个可以复制粘贴的提示词，要装什么 DSH 插件就放里面。
 */
function buildOnboardPrompt({ key, name, persona, dshCaps, extensions, dshPlugins }) {
  const urls = bridgeServerUrls();
  const server = urls[0].url;
  const bridge = 'D:\\qq-ai\\chat\\bridge\\nest-bridge.mjs';
  // 这里只写"要装什么"，不写"已经装了什么"——服务器不知道对方电脑上装了什么
  const lines = [];
  for (const c of (dshCaps || [])) lines.push('- ' + c.name + '：' + c.plugin);
  for (const x of (dshPlugins || [])) {
    if (x.installed) continue;
    lines.push('- ' + (x.url ? x.spec + '（从 GitHub 地址装）' : x.spec + '（按这个包名装）'));
  }
  const pluginsText = lines.length ? lines.join('\n') : '（不需要额外插件）';

  return [
    `帮我把一个 AI 接进 Nest（我们自己的聊天应用）。`,
    ``,
    `【连接信息】`,
    `服务器（按你的情况选一条）：`,
    ...urls.map((u) => `  - ${u.url}   ← ${u.when}`),
    `AI 名字：${name}`,
    `钥匙：${key}`,
    `桥接脚本：${(state.serverInfo && state.serverInfo.publicUrl) || server}/api/bridge/download  （下载到要跑 AI 的那台电脑上）`,
    ``,
    `【在跑这个 AI 的那台电脑上，先装好这些 DSH 插件】`,
    pluginsText,
    `用 plugin_manager 装好、确认在这个 profile 里 enabled / active；已经有的跳过。`,
    ``,
    `【然后把它连上】`,
    `node nest-bridge.mjs --server ${server} --key ${key}`,
    `（需要 Node 22 以上；桥接不在本机时，把 --server 换成上面那条外网地址）`,
    ``,
    `【它的设定】`,
    `名字：${name}`,
    persona ? `人设：${persona}` : `人设：（没填，按你舒服的方式说话，短句、像在手机上打字）`,
    ``,
    extensions?.length
      ? `【已经给它装好的扩展（Nest 侧，不用管）】\n${extensions.map((e) => `- ${e}`).join('\n')}`
      : `【扩展】没有装扩展`,
    ``,
    `弄好之后回我一句"好了"，我在 Nest 里验收。`,
  ].join('\n');
}

async function openAiWizard(onDone) {
  let step = 1;
  const data = { nickname: '', persona: '', caps: { ...AI_DEFAULTS }, extensions: [], dshCaps: [], dshPlugins: [], pluginsExpanded: false };
  let exts = [];
  try { exts = (await api('/api/extensions')).extensions || []; } catch { exts = []; }


  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = '<div class="modal ai-wizard"><div id="wiz-body"></div></div>';
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  const body = mask.querySelector('#wiz-body');
  const head = (title, sub) =>
    `<div class="wiz-head"><b>${esc(title)}</b><span>${esc(sub)}</span></div>`;
  const dots = () =>
    `<div class="wiz-dots">${[1, 2, 3].map((i) =>
      `<i class="${i === step ? 'on' : i < step ? 'done' : ''}"></i>`).join('')}</div>`;

  const render = () => {
    if (step === 1) {
      body.innerHTML = `
        ${head('第一步：给它起个名字', '这个名字会出现在群聊里，以后也能改')}
        ${dots()}
        <div class="wiz-row">
          <input type="text" id="wiz-name" maxlength="16" placeholder="比如：小鱼、阿呆、写稿的" value="${esc(data.nickname)}">
        </div>
        <div class="wiz-tpl">
          ${AI_TEMPLATES.map((t) => `<button type="button" class="wiz-tpl-btn" data-tpl="${t.id}">${esc(t.name)}</button>`).join('')}
        </div>
        <div class="wiz-foot">
          <button type="button" class="btn-plain" data-wiz="cancel">取消</button>
          <button type="button" class="btn-solid" data-wiz="next1">下一步</button>
        </div>`;
      const inp = body.querySelector('#wiz-name');
      inp.focus();
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') body.querySelector('[data-wiz="next1"]').click(); });
      body.querySelectorAll('[data-tpl]').forEach((btn) => btn.addEventListener('click', () => {
        const t = AI_TEMPLATES.find((x) => x.id === btn.dataset.tpl);
        if (!t) return;
        data.caps = { ...t.caps };
        if (t.persona) data.persona = t.persona;
        // 模板只决定人设和能力，名字必须自己填（之前会把 AI 直接叫「普通聊天」）

        body.querySelectorAll('[data-tpl]').forEach((b) => b.classList.toggle('is-on', b === btn));
        const ni = body.querySelector('#wiz-name');
        if (ni) ni.value = data.nickname;
      }));
      body.querySelector('[data-wiz="cancel"]').addEventListener('click', close);
      body.querySelector('[data-wiz="next1"]').addEventListener('click', () => {
        const v = body.querySelector('#wiz-name').value.trim();
        if (!v) return toast('先起个名字');
        data.nickname = v;
        step = 2;
        render();
      });
      return;
    }

    if (step === 2) {
      body.innerHTML = `
        ${head('第二步：它是谁', '写一句人设，决定它说话的样子；不填也能用')}
        ${dots()}
        <div class="wiz-row">
          <textarea id="wiz-persona" rows="4" maxlength="2000"
            placeholder="比如：住在群里的老友，说话短、爱吐槽，但正事上靠谱。">${esc(data.persona)}</textarea>
        </div>
        <div class="wiz-foot">
          <button type="button" class="btn-plain" data-wiz="back">上一步</button>
          <button type="button" class="btn-solid" data-wiz="next2">下一步</button>
        </div>`;
      body.querySelector('[data-wiz="back"]').addEventListener('click', () => { step = 1; render(); });
      body.querySelector('[data-wiz="next2"]').addEventListener('click', () => {
        data.persona = body.querySelector('#wiz-persona').value.trim();
        step = 3;
        render();
      });
      return;
    }

    if (step === 3) {
      const caps = [
        ['memory', '记忆', '记得群里发生过的事'],
        ['emotion', '情绪', '说话有情绪，不装中立'],
        ['proactive', '主动说话', '不用 @ 也会接话'],
      ];
      body.innerHTML = `
        ${head('第三步：给它加能力', '自带的随便开；标「需装」的要在 DSH 里装插件')}
        ${dots()}
        <div class="wiz-group-title">自带能力</div>
        <div class="wiz-caps">
          ${caps.map(([k, n, d]) => `
            <label class="wiz-cap">
              <input type="checkbox" data-cap="${k}" ${data.caps[k] ? 'checked' : ''}>
              <span><b>${n}</b><i>${d}</i></span>
            </label>`).join('')}
        </div>

        <div class="wiz-group-title">需要 DSH 插件的能力
          <span class="wiz-hint">勾了会写进口令；插件由 AI 主人装在他自己电脑上，服务器不装</span>
        </div>
        <div class="wiz-caps">
          ${DSH_CAP_OPTIONS.map((c) => `
            <label class="wiz-cap">
              <input type="checkbox" data-dsh="${esc(c.id)}" ${data.dshCaps.includes(c.id) ? 'checked' : ''}>
              <span>
                <b>${esc(c.name)}</b>
                <i>${esc(c.desc)} · 要装 ${esc(c.plugin)}</i>
              </span>
            </label>`).join('')}
        </div>

        <div class="wiz-group-title">额外还要装的 DSH 插件
          <span class="wiz-hint">GitHub 地址或插件名都行，同样写进口令</span>
        </div>
        <div class="wiz-install">
          <input type="text" id="wiz-dsh-input" placeholder="GitHub 地址，或 DSH 插件名（如 dsh-graphmemory）">
          <button type="button" class="btn-plain" data-wiz="adddsh">添加</button>
        </div>
        <div class="wiz-dsh-added" id="wiz-dsh-added"></div>

        <div class="wiz-group-title">扩展包 <span class="wiz-hint">从 GitHub 装，只读 prompt，不执行代码</span></div>
        <div class="wiz-exts">
          ${exts.length ? exts.map((e) => `
            <label class="wiz-ext">
              <input type="checkbox" data-ext="${esc(e.id)}" ${data.extensions.includes(e.id) ? 'checked' : ''}>
              <span><b>${esc(e.name)}</b><i>${esc(e.description || e.id)}</i></span>
            </label>`).join('') : '<div class="ai-tip">还没有扩展包，下面粘个 GitHub 地址装一个</div>'}
        </div>
        <div class="wiz-install">
          <input type="text" id="wiz-ext-url" placeholder="https://github.com/你/仓库名">
          <button type="button" class="btn-plain" data-wiz="install">安装</button>
        </div>

        <div class="wiz-foot">
          <button type="button" class="btn-plain" data-wiz="back3">上一步</button>
          <button type="button" class="btn-solid" data-wiz="create">创建</button>
        </div>`;

      body.querySelectorAll('[data-cap]').forEach((cb) => cb.addEventListener('change', () => {
        data.caps[cb.dataset.cap] = cb.checked;
      }));
      body.querySelectorAll('[data-dsh]').forEach((cb) => cb.addEventListener('change', () => {
        const id = cb.dataset.dsh;
        if (cb.checked) { if (!data.dshCaps.includes(id)) data.dshCaps.push(id); }
        else data.dshCaps = data.dshCaps.filter((x) => x !== id);
      }));
      body.querySelectorAll('[data-ext]').forEach((cb) => cb.addEventListener('change', () => {
        const id = cb.dataset.ext;
        if (cb.checked) { if (!data.extensions.includes(id)) data.extensions.push(id); }
        else data.extensions = data.extensions.filter((x) => x !== id);
      }));
      const renderDshAdded = () => {
        const box = body.querySelector('#wiz-dsh-added');
        if (!box) return;
        const manual = data.dshPlugins.filter((x) => !x.installed);
        box.innerHTML = manual.length
          ? manual.map((x, i) => `<span class="wiz-chip" data-chip="${i}">${esc(x.spec)} <b>×</b></span>`).join('')
          : '';
      };
      body.querySelectorAll('[data-plugin]').forEach((cb) => cb.addEventListener('change', () => {
        const spec = cb.dataset.plugin;
        if (cb.checked) {
          if (!data.dshPlugins.some((x) => x.spec === spec)) data.dshPlugins.push({ spec, installed: true });
        } else {
          data.dshPlugins = data.dshPlugins.filter((x) => x.spec !== spec);
        }
      }));
      const addBtn = body.querySelector('[data-wiz="adddsh"]');
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          const inp = body.querySelector('#wiz-dsh-input');
          const spec = (inp.value || '').trim();
          if (!spec) return toast('写上 GitHub 地址或插件名');
          const isUrl = /^https?:\/\//i.test(spec);
          const name = isUrl ? spec : spec;
          if (!data.dshPlugins.some((x) => x.spec === name)) {
            data.dshPlugins.push({ spec: name, installed: false, url: isUrl ? spec : '' });
          }
          inp.value = '';
          renderDshAdded();
        });
        const inp = body.querySelector('#wiz-dsh-input');
        if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
      }
      const addedBox = body.querySelector('#wiz-dsh-added');
      if (addedBox) {
        addedBox.addEventListener('click', (e) => {
          const chip = e.target.closest('[data-chip]');
          if (!chip) return;
          const idx = Number(chip.dataset.chip);
          const manual = data.dshPlugins.filter((x) => !x.installed);
          const target = manual[idx];
          data.dshPlugins = data.dshPlugins.filter((x) => x !== target);
          renderDshAdded();
        });
      }
      renderDshAdded();

      body.querySelector('[data-wiz="toggleplugins"]')?.addEventListener('click', () => {
        data.pluginsExpanded = !data.pluginsExpanded;
        render();
      });
      body.querySelector('[data-wiz="back3"]').addEventListener('click', () => { step = 2; render(); });
      body.querySelector('[data-wiz="install"]').addEventListener('click', async () => {
        const url = body.querySelector('#wiz-ext-url').value.trim();
        if (!url) return toast('粘一个 GitHub 仓库地址');
        toast('正在从 GitHub 取…');
        try {
          const r = await api('/api/extensions/install', { method: 'POST', body: { url } });
          exts = (await api('/api/extensions')).extensions || [];
          if (!data.extensions.includes(r.id)) data.extensions.push(r.id);
          toast('装好了：' + r.name);
          render();
        } catch (err) {
          toast(err.message || '安装失败');
        }
      });
      body.querySelector('[data-wiz="create"]').addEventListener('click', async () => {
        const btn = body.querySelector('[data-wiz="create"]');
        btn.disabled = true;
        btn.textContent = '创建中…';
        try {
          const r = await api('/api/ai/members', {
            method: 'POST',
            body: {
              nickname: data.nickname,
              persona: data.persona,
              caps: data.caps,
              extensions: data.extensions,
              dshPlugins: data.dshPlugins,
            },
          });
          step = 4;
          await refreshServerInfo();
          renderDone(r);
          if (typeof onDone === 'function') onDone();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '创建';
          toast(err.message || '创建失败');
        }
      });
      return;
    }
  };

  /** 生成口令前刷新一次服务器信息：公网地址/端口可能是刚变的 */
  async function refreshServerInfo() {
    try { state.serverInfo = await api('/api/server-info'); } catch { /* ignore */ }
  }

  function renderDone(r) {
    const pickedCaps = DSH_CAP_OPTIONS.filter((c) => data.dshCaps.includes(c.id));
    const extNames = exts.filter((e) => data.extensions.includes(e.id)).map((e) => e.name);
    const prompt = buildOnboardPrompt({
      key: r.key || '',
      name: data.nickname,
      persona: data.persona,
      dshCaps: pickedCaps,
      extensions: extNames,
      dshPlugins: data.dshPlugins,
    });
    const needCount = pickedCaps.length + (data.dshPlugins || []).filter((x) => !x.installed).length;

    body.innerHTML = `
      ${head('创建好了：' + esc(data.nickname), '把下面这段发给要跑这个 AI 的人，让他在自己电脑上执行')}
      <div class="wiz-caps summary">
        <div class="wiz-sum-row"><span>名字</span><b>${esc(data.nickname)}</b></div>
        <div class="wiz-sum-row"><span>能力</span><b>${['memory', 'emotion', 'proactive'].filter((k) => data.caps[k]).map((k) => ({ memory: '记忆', emotion: '情绪', proactive: '主动说话' }[k])).join(' · ') || '无'}</b></div>
        <div class="wiz-sum-row"><span>要装的 DSH 插件</span><b>${(() => {
          const manual = (data.dshPlugins || []).filter((x) => !x.installed).length;
          const caps = (data.dshCaps || []).length;
          const n = caps + manual;
          return n ? '对方要装 ' + n + ' 个' : '不需要';
        })()}</b></div>
        <div class="wiz-sum-row"><span>扩展包</span><b>${extNames.length ? esc(extNames.join('、')) : '无'}</b></div>
      </div>
      <div class="wiz-key">
        <div class="wiz-key-label">接入口令（发给 AI 主人，不是你自己在本机执行）</div>
        <textarea class="wiz-prompt" id="wiz-prompt" rows="10" readonly>${esc(prompt)}</textarea>
        <div class="wiz-prompt-actions">
          <button type="button" class="btn-solid" data-wiz="copyall">复制口令</button>
          <button type="button" class="btn-plain" data-wiz="copykey">只复制钥匙</button>
        </div>
      </div>
      <div class="ai-tip">对方把这段粘给 DSH：它会装插件、起桥接。桥接跑起来，这个 AI 才会显示「在线」——AI 不在服务器上跑。</div>
      <div class="wiz-foot">
        <button type="button" class="btn-solid" data-wiz="done">完成</button>
      </div>`;

    const copy = async (text, label) => {
      try { await navigator.clipboard.writeText(text); toast(label + ' 已复制'); }
      catch {
        const ta = body.querySelector('#wiz-prompt');
        if (ta) { ta.select(); document.execCommand && document.execCommand('copy'); toast(label + ' 已复制'); }
        else toast('复制失败，手动选中吧');
      }
    };
    body.querySelector('[data-wiz="copyall"]').addEventListener('click', () => copy(prompt, '口令'));
    body.querySelector('[data-wiz="copykey"]').addEventListener('click', () => copy(r.key || '', '钥匙'));
    body.querySelector('[data-wiz="done"]').addEventListener('click', close);
  }

  render();
}

/* ---------------------------- 扩展包管理 ---------------------------- */

async function openExtensionManager(onChange) {
  let exts = [];
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ext-modal">
      <div class="modal-head"><span>扩展包</span>
        <button type="button" class="guide-link" id="ext-guide">怎么写一个？</button>
      </div>
      <div class="modal-sub">扩展 = GitHub 仓库根目录里的一个 <code>nest-extension.json</code>。
        只读里面的文字提示，不下载也不执行代码。</div>
      <div class="modal-body">
        <div class="ext-list" id="ext-list">加载中…</div>
        <div class="ext-install">
          <input type="text" id="ext-url" placeholder="https://github.com/你/仓库名">
          <button type="button" class="btn-solid" id="ext-install-btn">安装</button>
        </div>
      </div>
      <button type="button" class="modal-cancel">关闭</button>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('.modal-cancel')) close();
  });

  const list = mask.querySelector('#ext-list');
  const render = async () => {
    try { exts = (await api('/api/extensions')).extensions || []; } catch { exts = []; }
    if (!exts.length) {
      list.innerHTML = '<div class="ai-tip">还没有装扩展。找一个仓库，把地址粘到下面。</div>';
      return;
    }
    list.innerHTML = exts.map((e) => `
      <div class="ext-row" data-id="${esc(e.id)}">
        <div class="ext-row-main">
          <b>${esc(e.name)}</b>
          <span class="ext-ver">${esc(e.version || 'v?')}</span>
          <div class="ext-desc">${esc(e.description || e.id)}</div>
        </div>
        <button type="button" class="btn-plain is-danger" data-remove="${esc(e.id)}">删掉</button>
      </div>`).join('');
  };

  mask.querySelector('#ext-install-btn').addEventListener('click', async () => {
    const url = mask.querySelector('#ext-url').value.trim();
    if (!url) return toast('粘一个 GitHub 仓库地址');
    const btn = mask.querySelector('#ext-install-btn');
    btn.disabled = true;
    btn.textContent = '取…';
    try {
      const r = await api('/api/extensions/install', { method: 'POST', body: { url } });
      toast('装好了：' + r.name);
      mask.querySelector('#ext-url').value = '';
      await render();
      if (typeof onChange === 'function') onChange();
    } catch (err) {
      toast(err.message || '安装失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '安装';
    }
  });

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    try {
      await api('/api/extensions/remove', { method: 'POST', body: { id: btn.dataset.remove } });
      toast('删掉了');
      await render();
      if (typeof onChange === 'function') onChange();
    } catch (err) { toast(err.message || '删不掉'); }
  });

  mask.querySelector('#ext-guide').addEventListener('click', () => {
    mask.querySelector('.modal-sub').innerHTML = `
      <div class="ext-guide-body">
        <p>在 GitHub 建一个公开仓库，根目录放一个 <code>nest-extension.json</code>：</p>
        <pre>{
  "name": "写作助手",
  "version": "1.0.0",
  "description": "把想法写成通顺的文字",
  "author": "你的名字",
  "prompt": "你擅长把杂乱的想法写成通顺的文字。用户给你草稿时，先问清楚要写给谁，再改写。"
}</pre>
        <p>粘上面那个仓库地址就能装。<code>prompt</code> 会被塞进 AI 的系统提示里，
          所以是"教它怎么做事"，不是装代码。</p>
      </div>`;
  });

  await render();
}

async function openAiManager() {
  closeMenu();
  $('#settings-popover').hidden = true;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ai-modal">
      <div class="modal-head">
        <span>我的 AI 成员</span>
        <button type="button" class="guide-link" id="ai-guide">怎么接入？</button>
      </div>
      <div class="modal-sub">每个 AI 都跑在某一台电脑上（你这台，或者朋友的），靠一把钥匙连进来。这里管三件事：建号、进群、发钥匙。</div>
      <div class="modal-body">
        <div class="ai-list" id="ai-list">加载中…</div>
        <div class="ai-create">
          <button type="button" id="ai-add" class="btn-solid">＋ 创建 AI</button>
          <button type="button" id="ai-ext" class="btn-plain">扩展包</button>
        </div>
        <div class="ai-tip">创建只是「造了个号」，它要进群、拿到钥匙、有人在跑桥接，才真正会上线。</div>
      </div>
      <button type="button" class="modal-cancel">关闭</button>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('.modal-cancel')) close();
  });

  const render = async () => {
    const { members } = await api('/api/ai/members');
    const list = mask.querySelector('#ai-list');
    if (!members.length) {
      list.innerHTML = '<div class="ai-empty">还没有 AI 成员</div>';
      return;
    }
    const now = Date.now();
    list.innerHTML = members.map((m) => {
      const online = m.lastUsedAt && now - m.lastUsedAt < 120_000;
      const where = m.groups.length
        ? `在 ${m.groups.map((g) => esc(g.title)).join('、')}`
        : '还没进群';
      return `
      <div class="ai-row" data-id="${m.id}">
        <div class="avatar" style="background:${AV_COLORS[m.id % AV_COLORS.length]}">${esc(m.nickname.slice(0, 1))}</div>
        <div class="ai-row-main">
          <div class="ai-row-name">
            ${esc(m.nickname)} <span class="ai-tag">AI</span>
            <span class="ai-status ${online ? 'on' : ''}">${online ? '在线' : '未连接'}</span>
          </div>
          <div class="ai-row-sub">${m.keyCount ? '有钥匙' : '没钥匙'} · ${where}</div>
        </div>
        <div class="ai-actions">
          <button type="button" data-act="profile">资料</button>
          <button type="button" data-act="persona">人设</button>
          <button type="button" data-act="join">拉进群</button>
          <button type="button" data-act="key">发钥匙</button>
          <button type="button" data-act="revoke">停用</button>
          <button type="button" data-act="del" class="is-danger">删除</button>
        </div>
      </div>`;
    }).join('');
  };

  mask.querySelector('#ai-add').addEventListener('click', () => {
    openAiWizard(async () => {
      await render();
      await refreshAiCount();
    });
  });

  mask.querySelector('#ai-ext').addEventListener('click', () => {
    openExtensionManager(async () => { await render(); });
  });

  mask.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = btn.closest('.ai-row');
    const id = Number(row.dataset.id);
    const act = btn.dataset.act;
    try {
      if (act === 'profile') {
        const { members } = await api('/api/ai/members');
        const m = members.find((x) => x.id === id) || { id, nickname: 'AI' };
        mask.remove();
        openAiProfile(m).catch((err) => toast(err.message || '打不开'));
        return;
      }
      if (act === 'persona') {
        const { members } = await api('/api/ai/members');
        const m = members.find((x) => x.id === id) || { id, nickname: 'AI' };
        mask.remove();
        openPersonaEditor(m);
        return;
      }
      if (act === 'join') {
        const { members } = await api('/api/ai/members');
        pickGroupAndAdd(members.find((m) => m.id === id) || { id, nickname: 'AI' });
        return;
      }
      if (act === 'key') {
        const { key } = await api(`/api/ai/members/${id}/key`, { method: 'POST' });
        const nm = (mask.querySelector(`.ai-row[data-id="${id}"] .ai-row-name`)?.textContent || '').trim().split(/\s/)[0];
        // 必须插在列表容器外面：render() 会重写 #ai-list 的 innerHTML，插在里面会被一起抹掉
        mask.querySelector('#ai-list').before(keyReveal('新钥匙（旧的全部作废）', key, nm));
        await render();
        return;
      }
      if (act === 'revoke') {
        await api(`/api/ai/members/${id}/revoke`, { method: 'POST' });
        toast('已停用，它现在连不上了；记录还在，发新钥匙就能回来');
        await render();
        await refreshAiCount();
        return;
      }
      if (act === 'del') {
        const ok = await confirmModal({
          title: '彻底删除这个 AI？',
          text: '删除后它在群里的发言也会一起消失，<b>不能恢复</b>。<br><br>如果你只是想让它下线、保留聊天记录，用「停用」。',
          confirm: '删除',
          danger: true,
        });
        if (!ok) return;
        await api(`/api/ai/members/${id}/delete`, { method: 'POST' });
        toast('已删除');
        const data = await api('/api/bootstrap');
        state.convs = data.conversations;
        renderConvList();
        await render();
        await refreshAiCount();
      }
    } catch (err) {
      toast(err.message || '操作失败');
    }
  });

  mask.querySelector('#ai-guide').addEventListener('click', openAiGuide);

  await render();
}

async function refreshAiCount() {
  try {
    const { members } = await api('/api/ai/members');
    $('#set-ai-count').textContent = members.length ? `${members.length} 个` : '无';
  } catch {
    $('#set-ai-count').textContent = '—';
  }
}



function openForwardPicker(msgOrList) {
  const list = Array.isArray(msgOrList) ? msgOrList : [msgOrList];
  const targets = state.convs.filter((c) => c.id !== state.activeId);
  if (!targets.length) return toast('没有可转发的会话');

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-head">转发到</div>
      <div class="modal-list">
        ${targets.map((c) => `
          <button type="button" class="modal-row" data-conv="${c.id}">
            <div class="avatar" style="background:${AV_COLORS[c.id % AV_COLORS.length]}">${esc(c.title.slice(0, 1))}</div>
            <div class="modal-row-main">
              <div class="modal-row-name">${esc(c.title)}</div>
              <div class="modal-row-sub">${c.kind === 'group' ? '群聊' : '私聊'}</div>
            </div>
          </button>`).join('')}
      </div>
      <button type="button" class="modal-cancel">取消</button>
    </div>`;
  document.body.appendChild(mask);

  const close = () => mask.remove();
  mask.addEventListener('click', async (e) => {
    if (e.target === mask || e.target.closest('.modal-cancel')) return close();
    const row = e.target.closest('[data-conv]');
    if (!row) return;
    const convId = Number(row.dataset.conv);
    close();
    try {
      const blocks = list.map((msg) => {
        const text = (msg.blocks || []).filter((b) => b.t === 'text').map((b) => b.v).join('\n');
        return { t: 'forward', from: msg.sender.nickname, text: text || '[非文字消息]' };
      });
      await api('/api/message', { method: 'POST', body: { conv: convId, blocks: blocks.slice(0, 20) } });
      toast(list.length > 1 ? `已转发 ${list.length} 条` : '已转发');
    } catch (err) {
      toast(err.message || '转发失败');
    }
  });
}

/* ------------------------------ 全局搜索 ------------------------------ */

let gsMask = null;

function openGlobalSearch(initial = '') {
  closeGlobalSearch();
  const mask = document.createElement('div');
  mask.className = 'gs-mask';
  mask.innerHTML = `
    <div class="gs-box">
      <div class="gs-head">
        <svg viewBox="0 0 24 24" class="gs-icon"><path d="M10 4a6 6 0 1 0 3.5 10.9l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg>
        <input id="gs-input" placeholder="搜聊天记录（所有会话）" autocomplete="off" value="${esc(initial)}">
        <span class="gs-hint">Esc</span>
      </div>
      <div class="gs-body" id="gs-body">
        <div class="gs-tip">输入关键词，搜全部会话里的消息</div>
      </div>
    </div>`;
  document.body.appendChild(mask);
  gsMask = mask;

  const input = mask.querySelector('#gs-input');
  const body = mask.querySelector('#gs-body');

  mask.addEventListener('click', (e) => {
    if (e.target === mask) closeGlobalSearch();
    const hit = e.target.closest('[data-gs-id]');
    if (hit) gotoSearchHit(Number(hit.dataset.gsId), Number(hit.dataset.gsConv));
  });

  let timer = null;
  let lastQ = '';
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 1) {
      body.innerHTML = '<div class="gs-tip">输入关键词，搜全部会话里的消息</div>';
      return;
    }
    if (q === lastQ) return;
    lastQ = q;
    try {
      const { hits } = await api('/api/search?q=' + encodeURIComponent(q));
      if (!hits.length) {
        body.innerHTML = '<div class="gs-tip">没找到。换个词试试？</div>';
        return;
      }
      body.innerHTML = hits.map((h) => `
        <button type="button" class="gs-hit" data-gs-id="${h.id}" data-gs-conv="${h.conv.id}">
          <div class="gs-hit-top">
            <b>${esc(h.conv.title)}</b>
            <span>${esc(h.sender.nickname)} · ${fmtWhen(h.at)}</span>
          </div>
          <div class="gs-hit-text">${highlight(h.snippet, q)}</div>
        </button>`).join('');
    } catch (err) {
      body.innerHTML = `<div class="gs-tip">${esc(err.message || '搜索失败')}</div>`;
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeGlobalSearch();
    if (e.key === 'Enter') { clearTimeout(timer); run(); }
  });
  setTimeout(() => input.focus(), 30);
  if (initial) run();
}

function closeGlobalSearch() {
  gsMask?.remove();
  gsMask = null;
}

/** 命中项高亮关键词（先转义再加标签，避免 XSS） */
function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const needle = esc(q);
  const i = safe.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return safe;
  return safe.slice(0, i) + '<mark>' + safe.slice(i, i + needle.length) + '</mark>' + safe.slice(i + needle.length);
}

function fmtWhen(ts) {
  const d = new Date(Number(ts));
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 点搜索结果：切到那个会话，把那条消息翻出来并闪一下 */
async function gotoSearchHit(msgId, convId) {
  closeGlobalSearch();
  if (!convId) return;
  if (state.activeId !== convId) {
    const conv = state.convs.find((c) => c.id === convId);
    if (!conv) { await refreshConversations(); }
    await openConv(convId);
  }
  // 已经加载过就直接跳
  const list = state.messages.get(convId) || [];
  if (list.some((m) => m.id === msgId)) {
    renderMessages(convId, { scroll: false });
    jumpToMessage(msgId);
    return;
  }
  // 没加载到：往前翻页找（最多 12 页）
  for (let page = 0; page < 12; page++) {
    const first = (state.messages.get(convId) || [])[0];
    const rows = await api(`/api/messages?conv=${convId}&limit=60&before=${first ? first.id : msgId + 1}`);
    if (!rows.messages?.length) break;
    const merged = [...rows.messages, ...(state.messages.get(convId) || [])];
    state.messages.set(convId, merged);
    if (rows.messages.some((m) => m.id === msgId)) break;
  }
  renderMessages(convId, { scroll: false });
  setTimeout(() => jumpToMessage(msgId), 60);
}

/* -------------------------------- 多选 -------------------------------- */

const selected = new Set();

function selectMode() { return selected.size > 0 || document.body.classList.contains('selecting'); }

function enterSelect(firstId) {
  document.body.classList.add('selecting');
  selected.clear();
  if (firstId) selected.add(Number(firstId));
  renderSelectBar();
}

function exitSelect() {
  document.body.classList.remove('selecting');
  selected.clear();
  renderSelectBar();
}

function toggleSelect(id) {
  const n = Number(id);
  if (selected.has(n)) selected.delete(n);
  else selected.add(n);
  if (!selected.size) return exitSelect();
  renderSelectBar();
}

function renderSelectBar() {
  let bar = document.getElementById('select-bar');
  if (!document.body.classList.contains('selecting')) {
    if (bar) bar.remove();
    document.querySelectorAll('#messages .msg.is-selected').forEach((el) => el.classList.remove('is-selected'));
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'select-bar';
    bar.className = 'select-bar';
    bar.innerHTML = `
      <span id="select-count">已选 0 条</span>
      <button type="button" data-sact="forward">转发</button>
      <button type="button" data-sact="delete" class="is-danger">删除</button>
      <button type="button" data-sact="cancel">取消</button>`;
    document.querySelector('.chat-pane').appendChild(bar);

    bar.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-sact]');
      if (!btn) return;
      const act = btn.dataset.sact;
      if (act === 'cancel') return exitSelect();

      const ids = [...selected];
      const msgs = ids.map((id) => (state.messages.get(state.activeId) || []).find((m) => m.id === id)).filter(Boolean);

      if (act === 'forward') {
        if (!msgs.length) return toast('没选到消息');
        exitSelect();
        openForwardPicker(msgs.sort((a, b) => a.id - b.id));
        return;
      }
      if (act === 'delete') {
        const ok = await confirmModal({
          title: `删除这 ${ids.length} 条？`,
          text: '只对你自己的账号隐藏，别人那边还在。',
          confirm: '删除', danger: true,
        });
        if (!ok) return;
        let done = 0;
        for (const id of ids) {
          try {
            await api('/api/hide', { method: 'POST', body: { id } });
            const list = state.messages.get(state.activeId) || [];
            const i = list.findIndex((m) => m.id === id);
            if (i >= 0) list.splice(i, 1);
            document.querySelector(`#messages [data-id="${id}"]`)?.remove();
            done += 1;
          } catch { /* 跳过失败的 */ }
        }
        exitSelect();
        toast(`删了 ${done} 条`);
      }
    });
  }
  document.getElementById('select-count').textContent = `已选 ${selected.size} 条`;
  document.querySelectorAll('#messages .msg').forEach((el) => {
    el.classList.toggle('is-selected', selected.has(Number(el.dataset.id)));
  });
}

/* -------------------------------- 输入框 -------------------------------- */

function autoGrow() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = Math.min(150, el.scrollHeight) + 'px';
}

function recentEmoji() {
  try { return JSON.parse(localStorage.getItem('nest-recent-emoji') || '[]'); } catch { return []; }
}

function pushRecentEmoji(ch) {
  const list = [ch, ...recentEmoji().filter((c) => c !== ch)].slice(0, 8);
  try { localStorage.setItem('nest-recent-emoji', JSON.stringify(list)); } catch {}
}

function buildEmojiPanel() {
  const panel = $('#emoji-panel');
  const recent = recentEmoji();
  panel.innerHTML = `
    <div class="ep-body" id="ep-emoji">
      ${recent.length ? `<div class="ep-recent-label">最近使用</div>` + recent
        .map((ch) => `<button type="button" data-emoji="${ch}">${ch}</button>`).join('') : ''}
      ${EMOJI.map(([name, char]) => `<button type="button" title="/${name}" data-emoji="${char}">${char}</button>`).join('')}
    </div>
    <div class="ep-body ep-stickers" id="ep-sticker" hidden></div>
    <div class="ep-tabs">
      <button type="button" data-ep="emoji" class="is-active" title="表情">😊</button>
      <button type="button" data-ep="sticker" title="我的表情">🖼️</button>
    </div>`;

  panel.querySelector('.ep-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ep]');
    if (!btn) return;
    panel.querySelectorAll('.ep-tabs button').forEach((b) => b.classList.toggle('is-active', b === btn));
    $('#ep-emoji').hidden = btn.dataset.ep !== 'emoji';
    $('#ep-sticker').hidden = btn.dataset.ep !== 'sticker';
    if (btn.dataset.ep === 'sticker') loadStickers();
  });
  loadStickers();
}

/** 拉自己的表情收藏，渲染成网格 */
/* ---------------------------- 图片裁剪 ---------------------------- */

/**
 * 选完图先裁剪再上传（QQ/微信都这样）。
 * 无依赖：一个裁剪框 + 拖动 + 缩放滑杆，确认后导出 canvas 图片。
 *
 * @param {File}    file    用户选的图片
 * @param {number}  aspect  宽高比，头像/表情都用 1
 * @param {number}  maxOut  导出最长边像素（头像 512 够用）
 * @param {string}  title   标题
 * @param {(blob: Blob) => void} onDone  确认后的回调
 */
async function openCropper({ file, aspect = 1, maxOut = 512, title = '裁剪图片', onDone }) {
  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('图片读不了'));
      i.src = url;
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    toast(err.message || '图片读不了');
    return;
  }

  const size = Math.min(320, Math.max(200, window.innerWidth - 96));
  const vw = aspect >= 1 ? size : Math.round(size * aspect);
  const vh = aspect >= 1 ? Math.round(size / aspect) : size;
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const mask = document.createElement('div');
  mask.className = 'modal-mask cropper-mask';
  mask.innerHTML = `
    <div class="modal cropper">
      <div class="cropper-title">${esc(title)}</div>
      <div class="cropper-stage" id="crop-stage" style="width:${vw}px;height:${vh}px">
        <img id="crop-img" alt="" draggable="false">
      </div>
      <div class="cropper-zoom">
        <span>缩放</span>
        <input type="range" id="crop-zoom" min="1" max="3" step="0.01" value="1">
      </div>
      <div class="cropper-foot">
        <button type="button" class="btn-plain" data-crop="cancel">取消</button>
        <button type="button" class="btn-solid" data-crop="ok">确定</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const stage = mask.querySelector('#crop-stage');
  const el = mask.querySelector('#crop-img');
  const zoom = mask.querySelector('#crop-zoom');
  el.src = url;               // 少了这一行裁剪框是黑的
  el.style.willChange = 'transform';
  // 先按"铺满裁剪框"算基准缩放，再乘滑杆倍数
  const base = Math.max(vw / img.naturalWidth, vh / img.naturalHeight);
  const st = { scale: 1, x: 0, y: 0 };
  el.style.width = Math.round(img.naturalWidth * base) + 'px';
  el.style.height = Math.round(img.naturalHeight * base) + 'px';
  const elW = () => img.naturalWidth * base * st.scale;
  const elH = () => img.naturalHeight * base * st.scale;

  const clamp = () => {
    const w = elW(); const h = elH();
    st.x = Math.min(0, Math.max(vw - w, st.x));
    st.y = Math.min(0, Math.max(vh - h, st.y));
    if (w <= vw) st.x = (vw - w) / 2;
    if (h <= vh) st.y = (vh - h) / 2;
  };
  const paint = () => {
    clamp();
    el.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.scale})`;
    el.style.transformOrigin = '0 0';
  };
  zoom.addEventListener('input', () => { st.scale = Number(zoom.value); paint(); });
  paint();

  // 拖动
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX - st.x, y: e.clientY - st.y };
    stage.setPointerCapture?.(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    st.x = e.clientX - drag.x;
    st.y = e.clientY - drag.y;
    paint();
  });
  for (const ev of ['pointerup', 'pointercancel']) {
    stage.addEventListener(ev, () => { drag = null; });
  }

  const close = () => {
    mask.remove();
    URL.revokeObjectURL(url);
  };
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-crop="cancel"]')) close();
  });

  mask.querySelector('[data-crop="ok"]').addEventListener('click', async () => {
    const btn = mask.querySelector('[data-crop="ok"]');
    btn.disabled = true;
    btn.textContent = '处理中…';
    try {
      const outW = Math.min(maxOut, Math.round(vw * dpr));
      const outH = Math.round(outW / aspect);
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      // 裁剪框里看到的是什么，就画什么
      const sx = -st.x / (base * st.scale);
      const sy = -st.y / (base * st.scale);
      const sw = vw / (base * st.scale);
      const sh = vh / (base * st.scale);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
      // 头像是小图：用 JPEG 压到几十 KB，公网隧道下也能秒开（之前 PNG 512 有 400KB+）
      const mime = outW <= 320 ? 'image/jpeg' : 'image/png';
      const blob = await new Promise((res) => canvas.toBlob(res, mime, 0.86));
      if (!blob) throw new Error('导出失败');
      close();
      await onDone(blob);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '确定';
      toast(err.message || '裁剪失败');
    }
  });
}

/** 表情面板末尾的「+」格子（QQ 那个位置） */
const ADD_STICKER_CELL = `
  <div class="ep-sticker-wrap">
    <button type="button" class="ep-sticker ep-sticker-add" data-add-sticker="1" title="添加图片为表情">
      <span>＋</span>
    </button>
  </div>`;

/** 选一张图 → 裁剪 → 存成表情 */
function pickStickerFromFile() {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/png,image/jpeg,image/gif,image/webp';
  picker.style.position = 'fixed';
  picker.style.left = '-9999px';
  picker.onchange = () => {
    const f = picker.files && picker.files[0];
    picker.remove();
    if (!f) return;
    openCropper({
      file: f,
      aspect: 1,
      maxOut: 320,
      title: '裁成表情（1:1）',
      onDone: async (blob) => {
        try {
          toast('上传中…');
          const up = await api('/api/upload', { method: 'POST', raw: blob, type: blob.type || 'image/png' });
          await api('/api/stickers', { method: 'POST', body: { sha: up.sha, ext: up.ext } });
          toast('已存进表情');
          loadStickers();
        } catch (err) {
          toast(err.message || '存不了');
        }
      },
    });
  };
  document.body.appendChild(picker);
  picker.click();
}

async function loadStickers() {
  const box = $('#ep-sticker');
  if (!box) return;
  try {
    const { stickers } = await api('/api/stickers');
    if (!stickers.length) {
      box.innerHTML = ADD_STICKER_CELL;
      return;
    }
    box.innerHTML = stickers.map((s) =>
      `<div class="ep-sticker-wrap">
         <button type="button" class="ep-sticker" data-sha="${esc(s.sha)}" data-ext="${esc(s.ext)}" title="点我发出去">
           <img src="${esc(s.url)}" alt="表情" loading="lazy">
         </button>
         <button type="button" class="ep-del" data-del="${esc(s.sha)}" title="删掉这个表情">×</button>
       </div>`).join('') + ADD_STICKER_CELL;
    // 坏图（1×1 之类的占位图）不要占格子：加载后一检查就地摘掉
    box.querySelectorAll('.ep-sticker img').forEach((im) => {
      const drop = () => { const w = im.closest('.ep-sticker-wrap'); if (w) w.remove(); };
      if (im.complete && im.naturalWidth < 8) drop();
      else im.addEventListener('load', () => { if (im.naturalWidth < 8) drop(); }, { once: true });
      im.addEventListener('error', drop, { once: true });
    });
  } catch {
    box.innerHTML = '<div class="ai-tip" style="padding:10px">表情加载失败</div>';
  }
}

/** 点表情就直接发出去 */
async function sendSticker(sha, ext) {
  const convId = state.activeId;
  if (!convId) return toast('先选一个会话');
  try {
    const { message } = await api('/api/message', {
      method: 'POST',
      body: { conv: convId, blocks: [{ t: 'image', sha, ext, w: 0, h: 0 }] },
    });
    if (message && !state.seen.has(message.id)) pushMessage({ type: 'message', message });
  } catch (err) { toast(err.message || '发不出去'); }
}

/* --------------------------------- 成员面板 ------------------------------ */

/** 滚到某条消息并闪一下；没加载到就提示往上翻 */
function jumpToMessage(id) {
  const el = document.querySelector(`#messages [data-id="${Number(id)}"]`);
  if (!el) {
    toast('这条不在当前已加载的范围内（往上翻一点再试）');
    return false;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
  return true;
}

/** 读视频的宽高/时长（失败就返回 0，不影响发送） */
function probeVideo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(out);
    };
    v.onloadedmetadata = () => finish({
      w: v.videoWidth || 0,
      h: v.videoHeight || 0,
      dur: Math.min(600, Math.round(v.duration || 0)),
    });
    v.onerror = () => finish({ w: 0, h: 0, dur: 0 });
    setTimeout(() => finish({ w: 0, h: 0, dur: 0 }), 4000);
    v.src = url;
  });
}

/* ---- @ 自动补全 ---- */

let mention = { open: false, items: [], index: 0, start: 0, pop: null };

function closeMention() {
  if (mention.pop) { mention.pop.remove(); mention.pop = null; }
  mention.open = false;
  mention.items = [];
}

/** 光标前是不是正在打 @xx */
function mentionQuery(input) {
  const before = input.value.slice(0, input.selectionStart ?? 0);
  const m = /@([^\s@]{0,16})$/.exec(before);
  if (!m) return null;
  return { query: m[1], start: (input.selectionStart ?? 0) - m[0].length };
}

function buildMentionItems(query) {
  const c = meConv();
  if (!c) return [];
  const q = query.toLowerCase();
  const list = (c.members || [])
    .filter((m) => m.id !== state.me.id)
    .filter((m) => !q || m.nickname.toLowerCase().includes(q))
    .slice(0, 12)
    .map((m) => ({ id: m.id, nickname: m.nickname, kind: m.kind }));
  // 群主还能 @全体成员
  if (c.kind === 'group' && c.role === 'owner' && (!q || '全体成员'.includes(q) || 'all'.startsWith(q))) {
    list.unshift({ id: 0, nickname: '全体成员', kind: 'all' });
  }
  return list;
}

function renderMention(input, q) {
  const items = buildMentionItems(q);
  if (!items.length) return closeMention();
  mention.items = items;
  mention.index = Math.min(mention.index, items.length - 1);

  let pop = mention.pop;
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'mention-pop';
    // 用 mousedown 而不是 click：输入框 blur 会先把弹层关掉
    pop.addEventListener('mousedown', (e) => {
      const row = e.target.closest('[data-mi]');
      if (!row) return;
      e.preventDefault();
      const m = mention.items[Number(row.dataset.mi)];
      const inp = document.getElementById('input');
      if (m && inp) applyMention(inp, m);
    });
    document.body.appendChild(pop);
    mention.pop = pop;
  }
  pop.innerHTML = items.map((m, i) => `
    <div class="mention-item ${i === mention.index ? 'is-active' : ''}" data-mi="${i}">
      ${m.kind === 'all'
        ? '<div class="avatar is-agent" style="background:#8A94A6">@</div>'
        : avatarHtml(m)}
      <span>${esc(m.nickname)}</span>
      ${m.kind === 'agent' ? '<i class="tag-ai">AI</i>' : ''}
    </div>`).join('');

  // 贴着输入框上方显示
  const r = input.getBoundingClientRect();
  const h = Math.min(216, items.length * 34 + 8);
  pop.style.left = Math.min(window.innerWidth - 180, r.left + 8) + 'px';
  pop.style.top = Math.max(8, r.top - h - 8) + 'px';
  mention.open = true;
}

function applyMention(input, m) {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, mention.start);
  const after = input.value.slice(caret);
  const insert = '@' + m.nickname + ' ';
  input.value = before + insert + after;
  const pos = before.length + insert.length;
  input.setSelectionRange(pos, pos);
  closeMention();
  input.focus();
  autoGrow();
  updateSend();
}

/** 装了 @ 补全的输入框（Enter 在弹层里是"选中"，不是"发送"） */
function attachMention(input) {
  input.addEventListener('input', () => {
    const hit = mentionQuery(input);
    if (!hit) return closeMention();
    mention.start = hit.start;
    mention.index = 0;
    renderMention(input, hit.query);
  });

  input.addEventListener('keydown', (e) => {
    if (!mention.open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const n = mention.items.length;
      mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderMention(input, mentionQuery(input)?.query || '');
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const m = mention.items[mention.index];
      if (m) applyMention(input, m);
      return;
    }
    if (e.key === 'Escape') { closeMention(); e.stopImmediatePropagation(); }
  });

  input.addEventListener('blur', () => setTimeout(closeMention, 120));
}

/* ------------------------------ 语音录制 ------------------------------ */

// 浏览器给什么就录什么：Chrome/Android 是 webm+opus，Safari 是 mp4(AAC)。
// 不转码——转码要么加依赖，要么在服务端装 ffmpeg，两头都不划算。
const VOICE_MIMES = [
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

const VOICE_MAX_SEC = 60;     // 跟微信一样，60 秒
const VOICE_PEAKS = 48;       // 波形格子数（服务端也是 48）

const recorder = {
  active: false,
  stream: null,
  mr: null,
  chunks: [],
  peaks: [],          // 每 100ms 一个峰值 0..1
  ac: null,
  analyser: null,
  timer: null,
  peakTimer: null,
  startedAt: 0,
  cancelled: false,
  overlay: null,
};

function voiceSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

async function startVoice() {
  if (recorder.active) return;
  if (!voiceSupported()) {
    return toast('这个环境不支持录音：手机要用 https 打开，或直接用电脑的 localhost');
  }
  try {
    recorder.stream = await navigator.mediaDevices.getUserMedia({
      audio: recorder.rawMode
        ? { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    return toast(err.name === 'NotAllowedError' ? '没给麦克风权限' : '开不了麦克风：' + (err.message || err.name));
  }

  const mime = VOICE_MIMES.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
  try {
    recorder.mr = new MediaRecorder(recorder.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  } catch {
    recorder.mr = new MediaRecorder(recorder.stream);
  }
  recorder.chunks = [];
  recorder.peaks = [];
  recorder.cancelled = false;
  recorder.active = true;
  recorder.startedAt = performance.now();

  recorder.mr.ondataavailable = (e) => { if (e.data && e.data.size) recorder.chunks.push(e.data); };
  recorder.mr.onstop = () => finishVoice();
  // 不分片：iOS 对 timeslice 支持最差，一次拿完整文件最稳
  recorder.mr.start();

  // 边录边采峰值：播放端就不用解码音频了（跨端解码 webm/opus 在 Safari 上有坑）
  try {
    recorder.ac = new (window.AudioContext || window.webkitAudioContext)();
    if (recorder.ac.state === 'suspended') await recorder.ac.resume();
    const src = recorder.ac.createMediaStreamSource(recorder.stream);
    recorder.analyser = recorder.ac.createAnalyser();
    recorder.analyser.fftSize = 1024;
    recorder.analyser.smoothingTimeConstant = 0;
    src.connect(recorder.analyser);
    const buf = new Uint8Array(recorder.analyser.fftSize);
    recorder.peakTimer = setInterval(() => {
      if (!recorder.analyser) return;
      recorder.analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) {
        const a = Math.abs(v - 128) / 128;
        if (a > peak) peak = a;
      }
      recorder.peaks.push(peak);
    }, 100);
  } catch { /* 拿不到波形也能录，退化成默认柱子 */ }

  showVoiceOverlay();
  recorder.timer = setInterval(() => {
    const sec = (performance.now() - recorder.startedAt) / 1000;
    updateVoiceOverlay(sec);
    if (sec >= VOICE_MAX_SEC - 0.05) stopVoice();
  }, 100);
}

function showVoiceOverlay() {
  closeVoiceOverlay();
  const el = document.createElement('div');
  el.className = 'voice-rec';
  el.innerHTML = `
    <div class="vr-dot"></div>
    <span class="vr-sec">0.0"</span>
    <span class="vr-hint">松手发送 · 上滑取消</span>
    <div class="vr-cancel">松手取消</div>`;
  document.body.appendChild(el);
  recorder.overlay = el;
}

function updateVoiceOverlay(sec) {
  const el = recorder.overlay;
  if (!el) return;
  el.querySelector('.vr-sec').textContent = sec.toFixed(1) + '"';
  el.classList.toggle('is-cancel', recorder.cancelled);
}

function closeVoiceOverlay() {
  recorder.overlay?.remove();
  recorder.overlay = null;
}

function cancelVoice() {
  if (!recorder.active) return;
  recorder.cancelled = true;
  stopVoice();
}

function stopVoice() {
  if (!recorder.active) return;
  recorder.active = false;
  clearInterval(recorder.timer);
  clearInterval(recorder.peakTimer);
  recorder.timer = null;
  recorder.peakTimer = null;
  try { recorder.mr?.state !== 'inactive' && recorder.mr.stop(); } catch {}
  try { recorder.ac?.close(); } catch {}
  recorder.ac = null;
  recorder.analyser = null;
  recorder.stream?.getTracks().forEach((t) => t.stop());   // 不然麦克风指示灯一直亮
  recorder.stream = null;
}

/** 录完：太短就丢，否则上传 + 发消息 */
async function finishVoice() {
  closeVoiceOverlay();
  const mr = recorder.mr;
  const type = mr?.mimeType || recorder.chunks[0]?.type || 'audio/webm';
  const blob = new Blob(recorder.chunks, { type });
  recorder.mr = null;
  recorder.chunks = [];

  const sec = Math.max(0.1, (performance.now() - recorder.startedAt) / 1000);
  if (recorder.cancelled) { toast('已取消'); return; }
  if (sec < 0.5 || blob.size < 800) { toast('太短了'); return; }
  if (sec > VOICE_MAX_SEC + 1) { toast('太长了'); return; }
  const convId = state.activeId;
  if (!convId) return;

  // 100ms 一个峰 → 重采样成 48 格
  const src = recorder.peaks;
  const peaks = new Array(VOICE_PEAKS).fill(0);
  for (let i = 0; i < VOICE_PEAKS; i++) {
    const from = Math.floor((i / VOICE_PEAKS) * src.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / VOICE_PEAKS) * src.length));
    let m = 0;
    for (let j = from; j < to && j < src.length; j++) m = Math.max(m, src[j] || 0);
    peaks[i] = Math.round(Math.min(1, m) * 100);
  }
  recorder.peaks = [];

  try {
    const up = await api('/api/upload', { method: 'POST', raw: blob, type });
    const { message } = await api('/api/message', {
      method: 'POST',
      body: {
        conv: convId,
        blocks: [{ t: 'voice', sec: Math.max(1, Math.round(sec)), sha: up.sha, ext: up.ext, peaks }],
      },
    });
    if (message && !state.seen.has(message.id)) pushMessage({ type: 'message', message });
  } catch (err) {
    toast(err.message || '语音发送失败');
  }
}

/* ---- 用户名片（点头像弹出来，照 QQ 那样）---- */

let cardEl = null;
let maskEl = null;
let longPressFired = false;   // 长按已经弹过菜单，抑制随后的 click

function closeUserCard() {
  if (maskEl) { maskEl.remove(); maskEl = null; }
  if (cardEl) { cardEl.remove(); cardEl = null; }
}

async function openUserCard(userId, anchor) {
  closeUserCard();
  let info;
  try {
    info = await api('/api/profile/' + userId);
  } catch (err) {
    return toast(err.message || '看不到这个人');
  }
  const u = info.user;
  const relText = {
    self: '你自己', friend: '好友', mine: '你创建的 AI', coworker: '只是同群',
  }[info.relation] || '';

  const canDm = u.kind === 'agent' && (info.relation === 'mine' || info.relation === 'friend');
  const canAsk = u.kind === 'agent' && info.relation === 'coworker';
  const isMineAi = info.isOwner && u.kind === 'agent' && Number(u.id) !== Number(state.me.id);

  // 手机点空白经常被列表滚动吃掉，名片就关不掉。
  // 外面套一层全屏透明遮罩：点遮罩任意位置都关。
  const mask = document.createElement('div');
  mask.className = 'usercard-mask';
  mask.addEventListener('click', (e) => { if (e.target === mask) closeUserCard(); });

  const card = document.createElement('div');
  card.className = 'usercard';
  card.innerHTML = `
    <div class="uc-top">
      ${avatarHtml(u)}
      <div class="uc-id">
        <div class="uc-name">${esc(u.nickname)}${u.kind === 'agent' ? '<i class="tag-ai">AI</i>' : ''}</div>
        <div class="uc-handle">@${esc(u.handle)}</div>
        ${relText ? `<i class="tag-rel ${info.relation === 'friend' ? 'rel-friend' : info.relation === 'mine' ? 'rel-mine' : 'rel-group'}">${relText}</i>` : ''}
      </div>
    </div>
    <div class="uc-sig">${esc(u.signature || '这个人很懒，什么都没写')}</div>
    <div class="uc-actions">
      ${canDm ? '<button type="button" data-uc="dm">发消息</button>' : ''}
      ${canAsk ? '<button type="button" data-uc="ask">加好友</button>' : ''}
      ${isMineAi ? '<button type="button" data-uc="profile">看资料</button>' : ''}
      <button type="button" data-uc="copy">复制 @ID</button>
    </div>`;
  mask.appendChild(card);
  document.body.appendChild(mask);
  maskEl = mask;
  cardEl = card;

  // 右上角关闭按钮（手机上遮罩够用，但给个明确的 × 更放心）
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'uc-close';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeUserCard);
  card.appendChild(closeBtn);

  // 摆在头像旁边，别跑出屏幕
  const r = anchor.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  let left = r.right + 10;
  if (left + w > window.innerWidth - 12) left = Math.max(12, r.left - w - 10);
  let top = r.top;
  if (top + h > window.innerHeight - 12) top = Math.max(12, window.innerHeight - h - 12);
  card.style.left = left + 'px';
  card.style.top = top + 'px';

  card.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-uc]');
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.uc;
    if (act === 'copy') {
      try { await navigator.clipboard.writeText('@' + u.handle); toast('ID 已复制'); }
      catch { toast('@' + u.handle); }
      closeUserCard();
      return;
    }
    if (act === 'dm') { closeUserCard(); openDm(u.id); return; }
    if (act === 'ask') {
      closeUserCard();
      askToFriendAi({ id: u.id, nickname: u.nickname, relation: info.relation });
      return;
    }
    if (act === 'profile') {
      closeUserCard();
      openAiProfile({ id: u.id, nickname: u.nickname }).catch((err) => toast(err.message || '打不开'));
    }
  });
}

/* ---- 会话内搜索 ---- */

function openSearch() {
  const c = meConv();
  if (!c) return toast('先选一个会话');

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ai-modal">
      <div class="modal-head"><span>搜索「${esc(c.title)}」</span></div>
      <div class="modal-body">
        <div class="ai-create">
          <input type="text" id="sq" maxlength="60" placeholder="找聊天记录里的字">
          <button type="button" id="sq-go">搜</button>
        </div>
        <div id="sq-result"><div class="ai-tip">输入几个字，回车搜。</div></div>
      </div>
      <div class="prompt-actions">
        <button type="button" class="prompt-cancel">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const close = () => mask.remove();
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  mask.querySelector('.prompt-cancel').addEventListener('click', close);

  const input = mask.querySelector('#sq');
  const box = mask.querySelector('#sq-result');
  input.focus();

  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) return;
    box.innerHTML = '<div class="ai-tip">搜…</div>';
    try {
      const { hits } = await api(`/api/search?conv=${c.id}&q=${encodeURIComponent(q)}`);
      if (!hits.length) {
        box.innerHTML = '<div class="ai-tip">没找到</div>';
        return;
      }
      box.innerHTML = hits.map((h) => `
        <div class="search-hit" data-mid="${h.id}">
          <div class="sh-top"><b>${esc(h.sender.nickname || '某人')}</b>
            <span>${new Date(Number(h.at)).toLocaleString('zh-CN', { hour12: false })}</span></div>
          <div class="sh-text">${esc(h.snippet)}</div>
        </div>`).join('');
    } catch (err) {
      box.innerHTML = `<div class="ai-tip is-err">${esc(err.message || '搜不了')}</div>`;
    }
  };

  mask.querySelector('#sq-go').addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

  // 点结果 → 关掉弹窗，滚到那条消息并闪一下
  box.addEventListener('click', (e) => {
    const row = e.target.closest('[data-mid]');
    if (!row) return;
    const mid = row.dataset.mid;
    close();
    const el = document.querySelector(`#messages [data-id="${mid}"]`);
    if (!el) {
      toast('这条不在当前已加载的范围内（往上翻一点再搜）');
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  });
}

/* ---- 群设置（弹窗，手机上也能用）---- */

async function openGroupAdmin() {
  const c = meConv();
  if (!c) return toast('先选一个群');
  if (c.kind !== 'group') return openGroupPanel();

  const iAmOwner = c.role === 'owner';
  const members = c.members || [];

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ai-modal">
      <div class="modal-head"><span>群设置</span></div>
      <div class="modal-body">
        <div class="ga-field">
          <label>群名</label>
          <input id="ga-title" maxlength="40" ${iAmOwner ? '' : 'disabled'} value="${esc(c.title)}">
        </div>
        <div class="ga-field">
          <label>群公告</label>
          <textarea id="ga-ann" rows="2" ${iAmOwner ? '' : 'disabled'}
            placeholder="${iAmOwner ? '写点规矩，群里人都看得到' : '暂无'}">${esc(c.announcement || '')}</textarea>
          <div id="ga-ann-status" class="ai-tip"></div>
        </div>
        <div class="ga-field">
          <label>成员（${members.length}）</label>
          <div id="ga-members">
            ${members.map((m) => {
              const muted = Number(m.mute_until) > Date.now();
              const canManage = iAmOwner && m.id !== state.me.id && m.role !== 'owner';
              return `
              <div class="ga-member" data-uid="${m.id}">
                <div class="ga-m-name">
                  <span>${esc(m.nickname)}</span>
                  ${m.kind === 'agent' ? '<i class="tag-ai">AI</i>' : ''}
                  ${muted ? '<i class="tag-mute">禁言中</i>' : ''}
                  ${m.role === 'owner' ? '<i class="tag-rel rel-mine">群主</i>' : ''}
                </div>
                ${canManage ? `<div class="ga-m-acts">
                  <button type="button" data-mact="mute" data-uid="${m.id}">${muted ? '解禁' : '禁言'}</button>
                  <button type="button" data-mact="kick" data-uid="${m.id}">踢出</button>
                  <button type="button" data-mact="transfer" data-uid="${m.id}">转让</button>
                </div>` : ''}
              </div>`;
            }).join('')}
          </div>
        </div>
        ${iAmOwner ? '<button type="button" class="ga-dissolve" id="ga-dissolve">解散这个群</button>' : ''}
      </div>
      <div class="prompt-actions">
        <button type="button" class="prompt-cancel">关闭</button>
        ${iAmOwner ? '<button type="button" class="prompt-ok" id="ga-save">保存</button>' : ''}
      </div>
    </div>`;
  document.body.appendChild(mask);

  const close = () => mask.remove();
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  mask.querySelector('.prompt-cancel').addEventListener('click', close);

  // 公告已读状态（群主看得到谁没读）
  (async () => {
    const box = mask.querySelector('#ga-ann-status');
    try {
      const st = await api(`/api/conversation/${c.id}/announcement`);
      if (!st.announcement) { box.textContent = ''; return; }
      if (iAmOwner) {
        box.innerHTML = `已读 <b>${st.readCount}/${st.total}</b>` +
          (st.unreadNames.length ? ` · 没读：${st.unreadNames.map(esc).join('、')}` : ' · 全看过了');
      } else if (!st.myRead) {
        box.innerHTML = '<button type="button" class="btn-plain" id="ga-ann-read">标记已读</button>';
        box.querySelector('#ga-ann-read').addEventListener('click', async () => {
          try {
            await api(`/api/conversation/${c.id}/announcement/read`, { method: 'POST' });
            box.textContent = '已标记为已读';
          } catch (err) { toast(err.message || '标记失败'); }
        });
      } else {
        box.textContent = '你已经看过这版公告';
      }
    } catch { box.textContent = ''; }
  })();

  const refresh = async () => {
    const data = await api('/api/bootstrap');
    state.convs = data.conversations;
    renderConvList();
    close();
    openGroupAdmin();
  };

  const save = mask.querySelector('#ga-save');
  if (save) {
    save.addEventListener('click', async () => {
      try {
        await api(`/api/conversation/${c.id}/settings`, {
          method: 'POST',
          body: {
            title: mask.querySelector('#ga-title').value.trim(),
            announcement: mask.querySelector('#ga-ann').value.trim(),
          },
        });
        toast('已保存');
        close();
        const data = await api('/api/bootstrap');
        state.convs = data.conversations;
        renderConvList();
        if (state.activeId === c.id) openConv(c.id);
      } catch (err) {
        toast(err.message || '保存失败');
      }
    });
  }

  mask.querySelector('#ga-members').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-mact]');
    if (!btn) return;
    const uid = Number(btn.dataset.uid);
    const m = members.find((x) => x.id === uid);
    if (!m) return;

    try {
      if (btn.dataset.mact === 'mute') {
        const muted = Number(m.mute_until) > Date.now();
        await api(`/api/conversation/${c.id}/mute`, {
          method: 'POST', body: { userId: uid, minutes: muted ? 0 : 60 },
        });
        toast(muted ? `已解除 ${m.nickname} 的禁言` : `已禁言 ${m.nickname} 1 小时`);
        await refresh();
        return;
      }
      if (btn.dataset.mact === 'kick') {
        const ok = await confirmModal({
          title: `把 ${m.nickname} 移出群？`,
          text: '移出后他不再收到这个群的消息。要重新拉进来得再给一次邀请码或好友。',
          confirm: '移出', danger: true,
        });
        if (!ok) return;
        await api(`/api/conversation/${c.id}/kick`, { method: 'POST', body: { userId: uid } });
        toast('已移出');
        await refresh();
        return;
      }
      if (btn.dataset.mact === 'transfer') {
        const ok = await confirmModal({
          title: `把群主转给 ${m.nickname}？`,
          text: '转让后你就变成普通成员，<b>不能再踢人、禁言、改群名</b>。不可撤销。',
          confirm: '转让', danger: true,
        });
        if (!ok) return;
        await api(`/api/conversation/${c.id}/transfer`, { method: 'POST', body: { userId: uid } });
        toast('群主已转让');
        await refresh();
      }
    } catch (err) {
      toast(err.message || '操作失败');
    }
  });

  const dissolve = mask.querySelector('#ga-dissolve');
  if (dissolve) {
    dissolve.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: '解散这个群？',
        text: '群和里面的所有消息都会消失，<b>不能恢复</b>。',
        confirm: '解散', danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/conversation/${c.id}/dissolve`, { method: 'POST' });
        close();
        const data = await api('/api/bootstrap');
        state.convs = data.conversations;
        state.activeId = null;
        renderConvList();
        $('#messages').innerHTML = '<div class="empty-hint"><p>群已解散</p></div>';
        $('#chat-name').textContent = '选一个会话';
        toast('群已解散');
      } catch (err) {
        toast(err.message || '解散失败');
      }
    });
  }
}

/* ---- 群主对某个成员的操作 ---- */

async function groupAction(action, m) {
  const c = meConv();
  if (!c || !m) return;
  const base = `/api/conversation/${c.id}`;
  try {
    if (action === 'mute') {
      await api(`${base}/mute`, { method: 'POST', body: { userId: m.id, minutes: 60 } });
      toast(`已禁言 ${m.nickname} 1 小时`);
    } else if (action === 'unmute') {
      await api(`${base}/mute`, { method: 'POST', body: { userId: m.id, minutes: 0 } });
      toast(`已解除 ${m.nickname} 的禁言`);
    } else if (action === 'kick') {
      const ok = await confirmModal({
        title: `把 ${m.nickname} 移出群？`,
        text: '移出后他不再收到这个群的消息，但聊天记录还在。要重新拉他进来得再给一次群邀请码。',
        confirm: '移出',
        danger: true,
      });
      if (!ok) return;
      await api(`${base}/kick`, { method: 'POST', body: { userId: m.id } });
      toast('已移出');
    } else if (action === 'transfer') {
      const ok = await confirmModal({
        title: `把群主转给 ${m.nickname}？`,
        text: '转让后你就变成普通成员，<b>不能再踢人、禁言</b>。这个操作不可撤销。',
        confirm: '转让',
        danger: true,
      });
      if (!ok) return;
      await api(`${base}/transfer`, { method: 'POST', body: { userId: m.id } });
      toast('群主已转让');
    }

    // 刷新成员列表
    const data = await api('/api/bootstrap');
    state.convs = data.conversations;
    renderConvList();

  } catch (err) {
    toast(err.message || '操作失败');
  }
}

/* --------------------------------- 登录 --------------------------------- */

/** 登录页的提示语：第一次用就引导注册，并说明第一个账号会成为管理员 */
async function renderLoginHint() {
  const el = document.getElementById('login-hint');
  if (!el) return;
  try {
    const info = await api('/api/server-info');
    const inviteMode = info.registerMode === 'invite';
    el.innerHTML = info.firstRun
      ? '第一次使用：先去「注册」建第一个账号，<b>它会成为管理员</b>。'
      : inviteMode
        ? '这台服务器要<b>邀请码</b>才能注册；没有就找群主要一个。'
        : '已经有账号就直接登录；没有就点「注册」。';
    // 公网模式下注册页要显示邀请码输入框
    const lbl = document.getElementById('lbl-invite');
    if (lbl) lbl.hidden = !inviteMode || info.firstRun;
  } catch {
    el.textContent = '';
  }
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
}

function setLoginError(msg) {
  $('#login-error').textContent = msg || '';
}

/* ------------------------------- 设置 / 联系人 ------------------------------ */

function syncThemeHint() {
  $('#set-theme-hint').textContent =
    document.documentElement.dataset.theme === 'dark' ? '深色' : '浅色';
}

function toggleSettings() {
  const pop = $('#settings-popover');
  if (!pop.hidden) { pop.hidden = true; return; }
  const me = state.me;
  $('#set-avatar').textContent = me.avatar ? '' : me.nickname.slice(0, 1);
  $('#set-avatar').classList.toggle('has-img', !!me.avatar);
  $('#set-avatar').style.background = me.avatar
    ? `url('${me.avatar}') center/cover`
    : AV_COLORS[me.id % AV_COLORS.length];
  $('#set-name').textContent = me.nickname;
  $('#set-handle').textContent = '@' + me.handle;
  syncThemeHint();
  pop.hidden = false;
  refreshAiCount();
  refreshInviteCount();
  // 当前跑的是真模型还是本地剧本
  api('/api/ai').then((ai) => {
    $('#set-ai-hint').textContent = ai.ready ? ai.model : '本地剧本';
  }).catch(() => {
    $('#set-ai-hint').textContent = '未知';
  });
}

function switchTab(tab) {
  state.tab = tab;
  $('#nav-message').classList.toggle('is-on', tab === 'message');
  $('#nav-contact').classList.toggle('is-on', tab === 'contact');
  $('#conv-list').hidden = tab !== 'message';
  $('#contact-list').hidden = tab !== 'contact';
  if (tab === 'contact') {
    loadContacts();
    refreshFriendHint();
  } else {
    renderConvList();
  }
}

async function loadContacts() {
  try {
    const [{ contacts }, reqs] = await Promise.all([
      api('/api/contacts'),
      api('/api/friends/requests').catch(() => ({ incoming: [] })),
    ]);
    state.contacts = contacts;
    state.friendIncoming = reqs.incoming || [];
    renderContacts();
  } catch (err) {
    console.error(err);
  }
}

function renderContacts() {
  const box = $('#contact-list');
  const q = state.filter.trim().toLowerCase();
  const list = (state.contacts || []).filter(
    (c) => !q || c.nickname.toLowerCase().includes(q) || c.handle.toLowerCase().includes(q)
  );

  // 顶部「新的朋友」：有申请时永远排第一
  const wantReqs = (state.friendIncoming || []).length;
  const reqRow = wantReqs
    ? `<div class="conv" id="row-friend-reqs">
         <div class="avatar" style="background:#F566C8">新</div>
         <div class="conv-main">
           <div class="conv-name"><span>新的朋友</span></div>
           <div class="conv-preview">${wantReqs} 条好友申请</div>
         </div>
         <div class="conv-side"><span class="badge">${wantReqs}</span></div>
       </div>`
    : '';

  if (!list.length) {
    box.innerHTML = reqRow + (q
      ? '<div class="empty-hint" style="height:120px"><p>没有匹配的联系人</p></div>'
      : '<div class="empty-hint" style="height:180px"><p>还谁也不认识</p><p class="empty-sub">用手机号加好友，或者进一个群</p></div>');
    bindReqRow();
    return;
  }
  box.innerHTML = list.map((c) => {
    // 说清「他为什么在这」：自己的 AI / 好友 / 只是同群
    const rel = c.relation === 'mine' ? '我的'
      : c.relation === 'friend' ? '好友'
        : '同群';
    const relCls = c.relation === 'mine' ? 'rel-mine' : c.relation === 'friend' ? 'rel-friend' : 'rel-group';
    return `
    <div class="conv" data-contact="${c.id}">
      ${avatarHtml(c)}
      <div class="conv-main">
        <div class="conv-name">
          <span>${esc(c.nickname)}</span>
          ${c.kind === 'agent' ? '<i class="tag-ai">AI</i>' : ''}
          <i class="tag-rel ${relCls}">${rel}</i>
        </div>
        <div class="conv-preview">${esc(c.signature || '@' + c.handle)}</div>
      </div>
      <div class="conv-side">
        <span class="status-dot" style="position:static;border:0" data-s="${c.status}"></span>
      </div>
    </div>`;
  }).join('');

  box.insertAdjacentHTML('afterbegin', reqRow);
  bindReqRow();
}

function bindReqRow() {
  const row = document.getElementById('row-friend-reqs');
  if (row) row.addEventListener('click', () => openFriendRequests());
}

/* ---- 真人私聊的说明：这里只做人和 AI ---- */

function showHumanDmNotice() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal prompt-modal">
      <div class="modal-head">这里只和 AI 聊天</div>
      <div class="modal-body">
        <p class="confirm-text">Nest 里放的是「人和 AI」的对话，不放真人和真人的私聊。</p>
        <p class="confirm-text" style="margin-top:10px">找真人说话，回 <b>QQ</b> 或 <b>微信</b> 更合适；<br>在群里@对方，这里照样可以。</p>
      </div>
      <div class="prompt-actions">
        <button type="button" class="prompt-ok">知道了</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('.prompt-ok')) close();
  });
}

/* ---- 同群的 AI：想私聊得先加好友（它主人同意）---- */

function askToFriendAi(peer) {
  if (peer.relation === 'pending_out') return toast('申请已发出，等它主人同意');
  if (peer.relation === 'pending_in') return toast('它也在等你同意，去通讯录「新的朋友」');

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal prompt-modal">
      <div class="modal-head">先加个好友</div>
      <div class="modal-body">
        <p class="confirm-text">「${esc(peer.nickname)}」是别人的 AI，你俩只是同一个群的，还不能私聊。</p>
        <p class="confirm-text" style="margin-top:10px">发个好友申请，<b>等它主人同意</b>之后就能单独跟它说话了。</p>
      </div>
      <div class="prompt-actions">
        <button type="button" class="prompt-cancel">算了</button>
        <button type="button" class="prompt-ok">发好友申请</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) mask.remove(); });
  mask.querySelector('.prompt-cancel').addEventListener('click', () => mask.remove());
  mask.querySelector('.prompt-ok').addEventListener('click', async () => {
    mask.remove();
    try {
      await api('/api/friends/request', { method: 'POST', body: { userId: peer.id } });
      toast('申请已发出，等它主人同意');
      await loadContacts();
      await refreshFriendHint();
    } catch (err) {
      toast(err.message || '发送失败');
    }
  });
}

async function openDm(userId) {
  const peer = (state.contacts || []).find((c) => c.id === userId);

  // 别人家的 AI，还不是好友 → 走申请，不直接开聊
  if (peer && peer.kind === 'agent' && peer.relation !== 'friend' && peer.relation !== 'mine') {
    askToFriendAi(peer);
    return;
  }

  // 对方是真人 → 不给开私聊，直接解释原因
  if (peer && peer.kind === 'human' && state.me?.kind === 'human') {
    showHumanDmNotice();
    return;
  }
  try {
    const { conv } = await api('/api/dm', { method: 'POST', body: { userId } });
    if (!conv) return;
    const idx = state.convs.findIndex((c) => c.id === conv.id);
    if (idx >= 0) state.convs[idx] = conv;
    else state.convs.unshift(conv);
    switchTab('message');
    state.activeId = null; // 强制重开，拉一次历史
    await openConv(conv.id);
  } catch (err) {
    toast(err.message || '打不开私聊');
  }
}

async function refreshConversations() {
  try {
    const data = await api('/api/bootstrap');
    state.convs = data.conversations;
    if (state.tab === 'contact') loadContacts();
    else renderConvList();
    renderRail();
  } catch {}
}

/* --------------------------------- 启动 --------------------------------- */

async function boot() {
  applyTheme();
  initList();
  buildEmojiPanel();
  try {
    const data = await api('/api/bootstrap');
    state.me = data.me;
    state.convs = data.conversations;
    // 本地地址与服务器地址不一样：拿它拼「接入命令」
    try {
      state.serverInfo = await api('/api/server-info');
    } catch {
      state.serverInfo = null;
    }
    showApp();
    renderRail();
    renderConvList();
    // 把别的服务器（世界）的会话也拉进来，合并显示
    await loadWorlds();
    renderConvList();

    // 深链：从别的世界跳过来时带着 #conv=<id>，直接打开那个会话
    const deep = /^#conv=(\d+)$/.exec(location.hash || '');
    if (deep) {
      history.replaceState(null, '', location.pathname + location.search);
      openConv(Number(deep[1])).catch(() => {
        const f = state.convs[0];
        if (f) openConv(f.id);
        else showOnboarding();
      });
    } else {
      const first = state.convs[0];
      if (first) openConv(first.id);
      else showOnboarding();
    }
    connect();
    watchKeyboard();

  // 开发钩子：?voicetest=6 → 自动录 6 秒。真机上没法用坐标点长按，用它验证录音链路。
  const vt = new URLSearchParams(location.search).get('voicetest');
  if (vt) {
    const sec = Math.min(60, Math.max(1, Number(vt) || 5));
    const speakText = new URLSearchParams(location.search).get('speak') || '';
    const raw = new URLSearchParams(location.search).get('raw') === '1';
    if (raw) recorder.rawMode = true;
    // 留 3 秒：真人/脚本可以先点一下页面，拿到"用户激活"，否则 iOS/安卓可能禁掉 TTS 播放
    setTimeout(async () => {
      try {
        toast('自动录音 ' + sec + ' 秒…');
        if (speakText && window.speechSynthesis) {
          const say = () => {
            const u = new SpeechSynthesisUtterance(speakText);
            u.lang = 'zh-CN';
            speechSynthesis.speak(u);
          };
          say();
          // 句尾可能比录音短，隔几秒重说一次，保证录音窗口内总有声音
          const iv = setInterval(say, 6000);
          setTimeout(() => clearInterval(iv), sec * 1000 + 500);
        }
        await startVoice();
        setTimeout(() => stopVoice(), sec * 1000);
      } catch (err) {
        toast('自动录音失败：' + (err.message || err));
      }
    }, 3000);
  }

  // 手机上提示词要换（没有 Enter/Shift 这一套）
  if (matchMedia('(pointer: coarse)').matches) {
    const inp = $('#input');
    if (inp) inp.placeholder = '输入消息';
  }
  } catch (err) {
    showLogin();
    renderLoginHint().catch(() => {});
    if (err.status === 401) setLoginError('');
    else setLoginError(err.message || '连接失败');
  }
}

function applyTheme() {
  const saved = localStorage.getItem('nest-theme');
  document.documentElement.dataset.theme = saved || 'light';
}

/** 窄屏默认收起列表，宽屏默认展开；以用户上次的选择为准 */
function initList() {
  const saved = localStorage.getItem('nest-list');
  const narrow = window.innerWidth <= 820;
  const collapsed = saved === null ? narrow : saved === '1';
  document.body.classList.toggle('list-collapsed', collapsed);
}

/* --------------------------------- 事件 --------------------------------- */

  /* ---- 是不是在 App 壳里 ----
     远程页面（服务器地址）里 hostname 不是 localhost，只能靠 Capacitor 桥判断；
     桥没注入时用「能不能加载 https://localhost 的图标」兜底探测。 */
  let inAppShellCache = null;
  function isInAppShell() {
    if (inAppShellCache !== null) return inAppShellCache;
    const cap = window.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      inAppShellCache = true;
      mountServerButton();
      return true;
    }
    inAppShellCache = false;
    const probe = new Image();
    const timer = setTimeout(() => { probe.onload = probe.onerror = null; }, 1500);
    probe.onload = () => { clearTimeout(timer); inAppShellCache = true; mountServerButton(); };
    probe.onerror = () => { clearTimeout(timer); };
    probe.src = 'https://localhost/icon.png?_=' + Date.now();
    return false;
  }

  // 聊天页右下的「服务器」按钮：一键回地址页换服务器
  function mountServerButton() {
    if (document.getElementById('app-server-btn')) return;
    const b = document.createElement('button');
    b.id = 'app-server-btn';
    b.type = 'button';
    b.textContent = '服务器';
    b.title = '换一个服务器';
    Object.assign(b.style, {
      position: 'fixed',
      right: '10px',
      bottom: 'calc(104px + env(safe-area-inset-bottom, 0px))',
      zIndex: 40, // 要压不过模态/设置抽屉（250/300/130），否则会盖在它们上面
      padding: '7px 11px',
      borderRadius: '999px',
      background: 'rgba(20, 30, 52, .82)',
      color: '#cfdcff',
      border: '1px solid #2b3a5c',
      fontSize: '12px',
      lineHeight: '1.2',
      boxShadow: '0 4px 14px rgba(0,0,0,.25)',
    });
    b.addEventListener('click', () => {
      location.href = 'https://localhost/index.html?switch=1';
    });
    document.body.appendChild(b);
  }

// 手机上设置浮层是底部抽屉：打开时补一层遮罩，点遮罩关闭（桌面端不变）
function installPopoverBackdrop() {
  const pop = document.getElementById('settings-popover');
  if (!pop) return;
  const isNarrow = () => matchMedia('(max-width: 520px)').matches;
  const sync = () => {
    let bd = document.getElementById('pop-backdrop');
    const want = !pop.hidden && isNarrow();
    document.body.classList.toggle('pop-open', !pop.hidden);
    if (want && !bd) {
      bd = document.createElement('div');
      bd.id = 'pop-backdrop';
      bd.className = 'pop-backdrop';
      bd.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        pop.hidden = true;
      });
      document.body.appendChild(bd);
    } else if (!want && bd) {
      bd.remove();
    }
  };
  new MutationObserver(sync).observe(pop, { attributes: true, attributeFilter: ['hidden'] });
  matchMedia('(max-width: 520px)').addEventListener('change', sync);
  sync();
}

function bind() {
  installPopoverBackdrop();
  // 会话切换
  $('#conv-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-conv]');
    if (row) { openConv(Number(row.dataset.conv)); return; }

    // 别的服务器上的会话：在线就跳过去（带 #conv= 深链），离线只提示
    const wrow = e.target.closest('[data-world]');
    if (wrow) {
      const w = (state.worlds || []).find((x) => Number(x.id) === Number(wrow.dataset.world));
      if (!w) return;
      if (w.status === 'offline') { toast('这个服务器离线了，等它开机再点'); return; }
      if (w.status === 'need-login') toast('这个服务器的登录失效了，跳过去重新登录一次');
      const base = String(w.baseUrl || '').replace(/\/+$/, '');
      location.href = base + '/#conv=' + Number(wrow.dataset.rconv);
    }
  });

  // 搜索
  $('#search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderConvList();
  });

  // 输入
  const input = $('#input');
  attachMention(input);
  input.addEventListener('input', () => { autoGrow(); updateSend(); pingTyping(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  $('#send').addEventListener('click', send);

  // 会话列表收起 / 展开（窄屏时是抽屉）
  $('#btn-list').addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('list-collapsed');
    localStorage.setItem('nest-list', collapsed ? '1' : '0');
  });

  // 移除待发送图片
  $('#pending').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    const i = Number(b.dataset.rm);
    const p = state.pending[i];
    if (p) URL.revokeObjectURL(p.url);
    state.pending.splice(i, 1);
    renderPending();
  });

  // 点语音气泡：播放 / 暂停（进度用消息里的 sec，不用 audio.duration：
  // Chrome 录的 webm 没写时长，读出来是 Infinity）
  let voiceAudio = null;
  let voiceEl = null;
  const stopVoicePlay = () => {
    if (voiceAudio) { try { voiceAudio.pause(); } catch {} }
    if (voiceEl) {
      voiceEl.classList.remove('is-playing');
      voiceEl.querySelectorAll('.bars i.on').forEach((i) => i.classList.remove('on'));
      const sp = voiceEl.querySelector('.vplay');
      if (sp) sp.textContent = '▶';
      const ss = voiceEl.querySelector('.sec');
      if (ss) ss.textContent = (voiceEl.dataset.sec || '1') + '"';
    }
    voiceAudio = null;
    voiceEl = null;
  };
  $('#messages').addEventListener('click', (e) => {
    const bubble = e.target.closest('.bubble.is-voice[data-src]');
    if (!bubble) return;
    e.stopPropagation();
    if (voiceEl === bubble) { stopVoicePlay(); return; }
    stopVoicePlay();

    // iOS 必须在 click 回调里同步 play()
    const audio = new Audio(bubble.dataset.src);
    audio.preload = 'auto';
    voiceAudio = audio;
    voiceEl = bubble;
    const sec = Number(bubble.dataset.sec) || 1;
    bubble.classList.add('is-playing');
    const sp = bubble.querySelector('.vplay');
    if (sp) sp.textContent = '⏸';

    const bars = [...bubble.querySelectorAll('.bars i')];
    const paint = (ratio) => {
      const n = Math.round(Math.min(1, Math.max(0, ratio)) * bars.length);
      bars.forEach((el, i) => el.classList.toggle('on', i < n));
    };
    audio.addEventListener('timeupdate', () => {
      const t = audio.currentTime || 0;
      const ratio = t / sec;
      paint(ratio);
      const ss = bubble.querySelector('.sec');
      if (ss) ss.textContent = Math.max(1, Math.round(t)) + '"';
    });
    audio.addEventListener('ended', () => {
      paint(1);
      setTimeout(() => { if (voiceEl === bubble) stopVoicePlay(); }, 400);
    });
    audio.addEventListener('error', () => {
      stopVoicePlay();
      toast('这个浏览器放不了这段录音（' + (bubble.dataset.src.split('.').pop()) + '），可以换 iOS 17.4+ 或 Chrome');
    });
    audio.play().catch(() => {
      stopVoicePlay();
      toast('播放失败，点一下再试');
    });
  });

  // 点图片看大图（顺便把图片块传进去，手机上也能"存为表情"）
  $('#messages').addEventListener('click', (e) => {
    const img = e.target.closest('.bubble.is-media img, .img-grid img');
    if (!img) return;
    if (longPressFired) { longPressFired = false; return; }   // 长按弹了菜单就别再开灯箱
    let block = null;
    const row = img.closest('.msg[data-id]');
    if (row) {
      const msg = (state.messages.get(state.activeId) || []).find((m) => m.id === Number(row.dataset.id));
      const path = new URL(img.src, location.origin).pathname;
      const sha = (/\/media\/([0-9a-f]{64})/.exec(path) || [])[1] || '';
      block = (msg?.blocks || []).find((b) => b.t === 'image' && b.sha === sha) || null;
    }
    openLightbox(img.src, block ? { sha: block.sha, ext: block.ext } : null);
  });

  // 手机上长按消息 = 右键菜单（微信/QQ 都这样，手机没有右键）
  let lpTimer = null;
  let lpStart = null;
  $('#messages').addEventListener('touchstart', (e) => {
    const row = e.target.closest('.msg[data-id]');
    if (!row) return;
    const t = e.touches[0];
    lpStart = { x: t.clientX, y: t.clientY };
    lpTimer = setTimeout(() => {
      lpTimer = null;
      longPressFired = true;
      const msg = (state.messages.get(state.activeId) || []).find((m) => m.id === Number(row.dataset.id));
      if (!msg) return;
      if (navigator.vibrate) navigator.vibrate(12);
      openMenu(t.clientX, t.clientY, buildMessageMenu(msg), { msg });
    }, 480);
  }, { passive: true });
  $('#messages').addEventListener('touchmove', (e) => {
    if (!lpTimer || !lpStart) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - lpStart.x, t.clientY - lpStart.y) > 10) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  }, { passive: true });
  for (const ev of ['touchend', 'touchcancel']) {
    $('#messages').addEventListener(ev, () => {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    }, { passive: true });
  }

  // 右键菜单：点头像出「头像菜单」，点消息本体出「消息菜单」
  $('#messages').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.msg[data-id]');
    if (!row) return;

    // .msg 是整行（左对齐/右对齐都占满宽度），行内靠边那一大片空白不算消息。
    // 所以按坐标判断：只有指针真的落在气泡或头像上才弹菜单。
    const over = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right
        && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    const onAvatar = over(row.querySelector('.avatar'));
    const onBubble = over(row.querySelector('.bubble'));
    if (!onAvatar && !onBubble) return;

    const msg = (state.messages.get(state.activeId) || [])
      .find((m) => m.id === Number(row.dataset.id));
    if (!msg) return;
    e.preventDefault();
    if (onAvatar) {
      openMenu(e.clientX, e.clientY, buildAvatarMenu(msg.sender), { user: msg.sender });
    } else {
      openMenu(e.clientX, e.clientY, buildMessageMenu(msg), { msg });
    }
  });
  document.addEventListener('click', closeMenu);
  // 只认用户的滚轮/触摸，不认程序滚动：.messages 有 scroll-behavior:smooth，
  // 平滑滚动会在菜单打开后继续冒 scroll 事件，把菜单瞬间关掉。
  document.addEventListener('wheel', closeMenu, { passive: true, capture: true });
  document.addEventListener('touchmove', closeMenu, { passive: true, capture: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  window.addEventListener('resize', closeMenu);

  // 取消回复
  $('#reply-cancel').addEventListener('click', clearReply);

  // 工具条
  $('.composer-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'emoji') {
      const panel = $('#emoji-panel');
      panel.hidden = !panel.hidden;
    } else if (act === 'image') {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/png,image/jpeg,image/gif,image/webp';
      picker.multiple = true;
      // 选完先进待发区，不直接上传（QQ 的行为）
      picker.onchange = async () => {
        const files = [...picker.files].slice(0, 9);
        for (const f of files) state.pending.push(await readImage(f));
        renderPending();
        $('#input').focus();
      };
      picker.click();
    } else if (act === 'file') {
      const picker = document.createElement('input');
      picker.type = 'file';
      // 这里**故意不写 accept**：accept 里只要出现 image/*，
      // 安卓就会把它当成"选图片"，直接弹相册/相机，根本进不到文件管理器。
      // 文件类型由服务端按文件头魔数校验（对不上返回 415）。
      picker.onchange = async () => {
        const f = picker.files[0];
        if (!f) return;
        try {
          const isVideo = f.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(f.name);
          const meta = await api('/api/upload', { method: 'POST', raw: f, type: isVideo ? (f.type || 'video/mp4') : (f.type || 'application/octet-stream') });
          const blocks = isVideo
            ? [{ t: 'video', sha: meta.sha, ext: meta.ext, ...(await probeVideo(f)) }]
            : [{ t: 'file', name: f.name, size: f.size, sha: meta.sha, ext: meta.ext }];
          const { message } = await api('/api/message', {
            method: 'POST',
            body: { conv: state.activeId, blocks },
          });
          if (message && !state.seen.has(message.id)) pushMessage({ type: 'message', message });
        } catch (err) { toast(err.message || '上传失败'); }
      };
      picker.click();
    }
  });

  // 语音：按住说话（手机要 https，电脑 localhost 也行）
  const voiceBtn = document.querySelector('[data-act="voice"]');
  if (voiceBtn) {
    voiceBtn.style.touchAction = 'none';
    let startY = 0;
    voiceBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      voiceBtn.setPointerCapture?.(e.pointerId);
      startY = e.clientY;
      startVoice().catch(() => {});
    });
    voiceBtn.addEventListener('pointermove', (e) => {
      if (!recorder.active) return;
      // 往上滑 50px 就是取消（微信的手势）
      const cancelled = startY - e.clientY > 50;
      if (cancelled !== recorder.cancelled) {
        recorder.cancelled = cancelled;
        updateVoiceOverlay((performance.now() - recorder.startedAt) / 1000);
      }
    });
    const end = (e) => {
      if (!recorder.active) return;
      e.preventDefault?.();
      if (recorder.cancelled) cancelVoice();
      else stopVoice();
    };
    voiceBtn.addEventListener('pointerup', end);
    voiceBtn.addEventListener('pointercancel', end);
    voiceBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    // 手机上长按会被浏览器当成"选中文字/图片"，弹原生菜单抢走手势。
    // touchstart 必须是非 passive 才能 preventDefault。
    voiceBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      startY = e.touches[0].clientY;
      startVoice().catch(() => {});
    }, { passive: false });
    voiceBtn.addEventListener('touchmove', (e) => {
      if (!recorder.active) return;
      e.preventDefault();
      const cancelled = startY - e.touches[0].clientY > 50;
      if (cancelled !== recorder.cancelled) {
        recorder.cancelled = cancelled;
        updateVoiceOverlay((performance.now() - recorder.startedAt) / 1000);
      }
    }, { passive: false });
    voiceBtn.addEventListener('touchend', (e) => {
      if (!recorder.active) return;
      e.preventDefault();
      if (recorder.cancelled) cancelVoice();
      else stopVoice();
    }, { passive: false });
  }

  // 表情
  $('#emoji-panel').addEventListener('click', async (e) => {
    if (e.target.closest('[data-add-sticker]')) {
      e.stopPropagation();
      pickStickerFromFile();
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      try {
        await api('/api/stickers/remove', { method: 'POST', body: { sha: del.dataset.del } });
        toast('删掉了');
        loadStickers();
      } catch (err) { toast(err.message || '删不了'); }
      return;
    }
    const st = e.target.closest('[data-sha]');
    if (st) {
      sendSticker(st.dataset.sha, st.dataset.ext);
      return;
    }
    const btn = e.target.closest('[data-emoji]');
    if (!btn) return;
    const el = $('#input');
    const pos = el.selectionStart ?? el.value.length;
    pushRecentEmoji(btn.dataset.emoji);
    el.value = el.value.slice(0, pos) + btn.dataset.emoji + el.value.slice(pos);
    el.focus();
    el.selectionStart = el.selectionEnd = pos + btn.dataset.emoji.length;
    autoGrow();
    updateSend();
  });

  // 点别处收起表情面板
  document.addEventListener('click', (e) => {
    const panel = $('#emoji-panel');
    if (panel.hidden) return;
    if (e.target.closest('#emoji-panel') || e.target.closest('[data-act="emoji"]')) return;
    panel.hidden = true;
  });

  // 主题（收进设置浮层）
  $('#set-theme').addEventListener('click', () => {
    const el = document.documentElement;
    el.dataset.theme = el.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('nest-theme', el.dataset.theme);
    syncThemeHint();
  });

  // 左轨切换
  $('#nav-message').addEventListener('click', () => switchTab('message'));
  $('#nav-contact').addEventListener('click', () => switchTab('contact'));

  // 设置浮层
  $('#btn-settings').addEventListener('click', toggleSettings);
isInAppShell();

  // 远程地址：隧道跑起来后显示公网 URL，点一下复制发给朋友
  $('#set-remote')?.addEventListener('click', async () => {
    try {
      const info = state.serverInfo || (await api('/api/server-info'));
      const url = info.publicUrl;
      if (!url) {
        toast('远程还没开：用 npm run supervise:tunnel 启动');
        return;
      }
      await navigator.clipboard.writeText(url);
      toast('远程地址已复制：' + url);
    } catch (err) {
      toast(err.message || '拿不到远程地址');
    }
  });

  // 启动时把远程地址显示到设置里
  const refreshRemoteHint = async () => {
    try {
      const info = await api('/api/server-info');
      state.serverInfo = info;
      const hint = document.getElementById('set-remote-hint');
      if (hint) hint.textContent = info.publicUrl ? '公网' : '未开启';
      if (hint && info.publicUrl) hint.title = info.publicUrl;
    } catch { /* ignore */ }
  };
  refreshRemoteHint();
  setInterval(refreshRemoteHint, 30_000);   // 隧道可能随时重连换地址
  // 点自己头像 → 个人资料
  $('.pop-head').addEventListener('click', (e) => { e.stopPropagation(); openMyProfile(); });
  $('#me-avatar').addEventListener('click', (e) => { e.stopPropagation(); openMyProfile(); });
  $('#set-ai-manage').addEventListener('click', () => {
    openAiManager().catch((err) => toast(err.message || '打不开'));
  });
  $('#set-invite').addEventListener('click', () => {
    openInviteManager().catch((err) => toast(err.message || '打不开'));
  });
  $('#set-logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });
  document.addEventListener('click', (e) => {
    const pop = $('#settings-popover');
    if (pop.hidden) return;
    if (e.target.closest('#settings-popover') || e.target.closest('#btn-settings')) return;
    pop.hidden = true;
  });

  // 联系人 → 开私聊
  $('#contact-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-contact]');
    if (row) openDm(Number(row.dataset.contact));
  });

  // 成员
  $('#btn-select').addEventListener('click', () => {
    if (document.body.classList.contains('selecting')) exitSelect();
    else enterSelect();
  });
  $('#btn-search').addEventListener('click', openSearch);
  // 全局搜索入口：点侧栏搜索框 / Ctrl+K
  const sideSearch = $('#search');
  if (sideSearch) {
    sideSearch.addEventListener('focus', () => {
      openGlobalSearch(sideSearch.value.trim());
      sideSearch.blur();
    });
    sideSearch.addEventListener('mousedown', (e) => e.preventDefault());
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openGlobalSearch();
    }
  });

  // 多选模式下点消息 = 勾选
  $('#messages').addEventListener('click', (e) => {
    if (!document.body.classList.contains('selecting')) return;
    const row = e.target.closest('.msg');
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    toggleSelect(row.dataset.id);
  }, true);

  // 点引用块 → 跳到被引用的那条
  $('#messages').addEventListener('click', (e) => {
    const q = e.target.closest('[data-quote-id]');
    if (!q) return;
    e.stopPropagation();
    jumpToMessage(q.dataset.quoteId);
  });

  // 拖文件进聊天区就上传（图片进待发区，其它文件直接发）
  const dropZone = document.querySelector('.chat-pane');
  if (dropZone) {
    let dragDepth = 0;
    const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes('Files');

    dropZone.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      dragDepth += 1;
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragover', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    });
    dropZone.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', async (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      dragDepth = 0;
      dropZone.classList.remove('drag-over');
      if (!state.activeId) return toast('先选一个会话');

      const files = [...ev.dataTransfer.files].slice(0, 9);
      const imgs = files.filter((f) => f.type.startsWith('image/'));
      const vids = files.filter((f) => f.type.startsWith('video/'));
      const others = files.filter((f) => !f.type.startsWith('image/') && !f.type.startsWith('video/'));

      for (const f of imgs) {
        try { state.pending.push(await readImage(f)); } catch { toast('这张图读不了'); }
      }
      if (imgs.length) { renderPending(); $('#input').focus(); }

      for (const f of vids.slice(0, 2)) {
        try {
          const meta = await api('/api/upload', { method: 'POST', raw: f, type: f.type || 'video/mp4' });
          const dim = await probeVideo(f);
          const { message } = await api('/api/message', {
            method: 'POST',
            body: {
              conv: state.activeId,
              blocks: [{ t: 'video', sha: meta.sha, ext: meta.ext, w: dim.w, h: dim.h, dur: dim.dur }],
            },
          });
          if (message && !state.seen.has(message.id)) pushMessage({ type: 'message', message });
        } catch (err) { toast(err.message || '视频上传失败'); }
      }

      for (const f of others.slice(0, 3)) {
        try {
          const meta = await api('/api/upload', { method: 'POST', raw: f, type: f.type || 'application/octet-stream' });
          const { message } = await api('/api/message', {
            method: 'POST',
            body: {
              conv: state.activeId,
              blocks: [{ t: 'file', name: f.name, size: f.size, sha: meta.sha, ext: meta.ext }],
            },
          });
          if (message && !state.seen.has(message.id)) pushMessage({ type: 'message', message });
        } catch (err) { toast(err.message || '上传失败'); }
      }
    });
  }

  // 拍一拍那行点名字 → 名片
  $('#messages').addEventListener('click', (e) => {
    const b = e.target.closest('[data-poke-uid]');
    if (!b) return;
    const uid = Number(b.dataset.pokeUid);
    if (!uid) return;
    e.stopPropagation();
    openUserCard(uid, b);
  });

  // 双击头像 = 拍一拍（QQ 那个）
  $('#messages').addEventListener('dblclick', async (e) => {
    const av = e.target.closest('.msg .avatar');
    if (!av) return;
    clearTimeout(avatarClickTimer);
    closeUserCard();
    const row = av.closest('.msg');
    const uid = Number(row?.dataset.sender);
    const conv = state.activeId;
    if (!uid || !conv || uid === state.me.id) return;
    e.stopPropagation();
    try {
      await api('/api/poke', { method: 'POST', body: { conv, userId: uid } });
    } catch (err) {
      toast(err.message || '拍不动');
    }
  });

  // 点头像或名字弹名片（左键，不是右键菜单）
  // 头像要延迟一下：双击是"拍一拍"，不能让第一次点击先弹名片
  let avatarClickTimer = null;
  $('#messages').addEventListener('click', (e) => {
    const av = e.target.closest('.msg .avatar');
    const name = e.target.closest('.msg-meta b');
    const anchor = av || name;
    if (!anchor) return;
    const row = anchor.closest('.msg');
    const uid = Number(row?.dataset.sender);
    if (!uid) return;
    e.stopPropagation();
    if (av) {
      clearTimeout(avatarClickTimer);
      avatarClickTimer = setTimeout(() => openUserCard(uid, anchor), 250);
      return;
    }
    openUserCard(uid, anchor);
  });

  // 群成员列表里点名字也能看
  document.addEventListener('click', (e) => {
    const mname = e.target.closest('.ga-m-name span:first-child');
    if (!mname) return;
    const row = mname.closest('.ga-member');
    const uid = Number(row?.dataset.uid);
    if (!uid) return;
    openUserCard(uid, mname);
  });

  // 点空白关名片
  document.addEventListener('click', (e) => {
    if (!cardEl) return;
    if (e.target.closest('.usercard')) return;
    if (e.target.closest('.msg .avatar') || e.target.closest('.msg-meta b')) return;
    closeUserCard();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUserCard(); });
  $('#btn-members').addEventListener('click', () => openGroupAdmin().catch((err) => toast(err.message || '打不开')));
  // 群面板：公告 + 邀请进群
  $('#btn-more').addEventListener('click', () => openGroupPanel().catch(() => {}));

  // 用群邀请码进群
  // App 壳里（https://localhost）才显示：回到地址页换服务器。
  // 浏览器里没有这个壳，点了会 404，所以只在本机壳里出现。
  if (isInAppShell()) {
    const sw = $('#set-switch-server');
    if (sw) {
      sw.hidden = false;
      sw.addEventListener('click', () => {
        location.href = 'https://localhost/index.html?switch=1';
      });
    }
  }

  const worldsBtn = $('#set-worlds');
  if (worldsBtn) {
    worldsBtn.addEventListener('click', () => {
      $('#settings-popover').hidden = true;
      openWorldsManager().catch((err) => toast(err.message || '打不开'));
    });
  }

  $('#set-join').addEventListener('click', async () => {
    $('#settings-popover').hidden = true;
    const code = await openTextPrompt({
      title: '用邀请码进群',
      placeholder: '比如 NEST-3F2A9C',
      confirm: '加入',
      hint: '让群里的人点右上角「⋯」→「邀请进群」，把码发给你。',
    });
    if (!code) return;
    try {
      const { conv } = await api('/api/join', { method: 'POST', body: { code } });
      const data = await api('/api/bootstrap');
      state.convs = data.conversations;
      renderConvList();
      await openConv(conv.id);
      toast(`已加入「${conv.title}」`);
    } catch (err) {
      toast(err.message || '加入失败');
    }
  });

  // 加好友
  $('#set-addfriend').addEventListener('click', () => {
    openAddFriend().catch((err) => toast(err.message || '打不开'));
  });

  // 新建群
  $('#btn-new-group').addEventListener('click', () => {
    openCreateGroup().catch((err) => toast(err.message || '打不开'));
  });

  // 窄屏抽屉的关闭出口：✕ 按钮 / 点聊天区 / 选完会话都算
  $('#btn-list-close').addEventListener('click', () => {
    document.body.classList.add('list-collapsed');
    localStorage.setItem('nest-list', '1');
  });

  $('.chat-pane').addEventListener('click', (e) => {
    // 抽屉开着时，点右侧聊天区就收起来（手机上最容易想到的"返回"动作）
    if (window.innerWidth <= 820 && !document.body.classList.contains('list-collapsed')) {
      if (e.target.closest('#btn-list')) return;
      document.body.classList.add('list-collapsed');
      localStorage.setItem('nest-list', '1');
    }
  });

  // 手机上的导航（左侧栏被隐藏后，入口搬进抽屉顶部）
  const setMobileTab = (tab) => {
    switchTab(tab);
    $('#mn-msg')?.classList.toggle('is-on', tab === 'message');
    $('#mn-contact')?.classList.toggle('is-on', tab === 'contact');
  };
  $('#mn-msg')?.addEventListener('click', () => setMobileTab('message'));
  $('#mn-contact')?.addEventListener('click', () => setMobileTab('contact'));
  // 直接调 toggleSettings，并且拦住冒泡：
  // 否则这次点击会继续传到 document 的「点外部就关」逻辑，面板刚开就被关掉。
  $('#mn-settings')?.addEventListener('click', (e) => {
    e.stopPropagation();
    // 抽屉的 z-index(70) 比设置浮层(60) 高，抽屉开着时浮层会被整个盖住（手机上看就是"点了没反应"）。
    // 所以先把抽屉收起来再开设置。
    document.body.classList.add('list-collapsed');
    localStorage.setItem('nest-list', '1');
    toggleSettings();
  });

  // 退出
  $('#btn-logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  // 登录 / 注册 / 找回
  let tab = 'login';
  let recoverPhone = '';

  const fillQuestions = async () => {
    try {
      const { questions } = await api('/api/questions');
      const opts = questions.map((q) => `<option value="${esc(q.code)}">${esc(q.text)}</option>`).join('');
      $('#sel-q1').innerHTML = opts;
      $('#sel-q2').innerHTML = opts;
      if (questions[1]) $('#sel-q2').value = questions[1].code;
    } catch {
      /* 题库拿不到就先空着，提交会被服务端拒 */
    }
  };
  fillQuestions();

  const syncSubmitLabel = () => {
    $('#login-submit').textContent = tab === 'login' ? '进入' : tab === 'register' ? '注册并进入' : '重设密码';
    $('#login-submit').hidden = tab === 'recover' && !recoverPhone;
    // 演示账号那行只在「登录」页显示，注册/找回时没意义
    const hint = $('.login-hint');
    if (hint) hint.hidden = tab !== 'login';
  };

  $$('.login-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      tab = btn.dataset.tab;
      if (tab !== 'recover') {
        recoverPhone = '';
        $('#recover-qa').hidden = true;
      }
      $$('.login-tabs button').forEach((b) => b.classList.toggle('on', b === btn));
      $$('.login-fields').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
      setLoginError('');
      syncSubmitLabel();
    });
  });
  syncSubmitLabel();

  // 找回密码第一步：拿问题
  $('#btn-load-q').addEventListener('click', async () => {
    const phone = String(new FormData($('#login-form')).get('rphone') || '').trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return setLoginError('手机号格式不对');
    try {
      const qa = await api('/api/recover/questions', { method: 'POST', body: { phone } });
      recoverPhone = phone;
      $('#lbl-q1').firstChild.textContent = qa.q1;
      $('#lbl-q2').firstChild.textContent = qa.q2;
      $('#recover-qa').hidden = false;
      setLoginError('');
      syncSubmitLabel();
    } catch (err) {
      setLoginError(err.message || '查不到这个手机号');
    }
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      if (tab === 'login') {
        await api('/api/login', {
          method: 'POST',
          body: { account: fd.get('account'), password: fd.get('password') },
        });
        setLoginError('');
        await boot();
        return;
      }

      if (tab === 'register') {
        if (String(fd.get('rpassword') || '') !== String(fd.get('rpassword') || '')) throw new Error('密码不一致');
        await api('/api/register', {
          method: 'POST',
          body: {
            phone: fd.get('phone'),
            nickname: fd.get('nickname'),
            password: fd.get('rpassword'),
            q1: fd.get('q1'),
            a1: fd.get('a1'),
            q2: fd.get('q2'),
            a2: fd.get('a2'),
            invite: fd.get('invite') || '',
          },
        });
        setLoginError('');
        await boot();
        return;
      }

      // 找回密码：重设
      if (!recoverPhone) return setLoginError('先点「下一步」拿密保问题');
      await api('/api/recover/reset', {
        method: 'POST',
        body: {
          phone: recoverPhone,
          a1: fd.get('ra1'),
          a2: fd.get('ra2'),
          password: fd.get('newpw'),
        },
      });
      tab = 'login';
      recoverPhone = '';
      $('#recover-qa').hidden = true;
      $$('.login-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'login'));
      $$('.login-fields').forEach((p) => { p.hidden = p.dataset.pane !== 'login'; });
      syncSubmitLabel();
      setLoginError('密码已重设，用新密码登录');
    } catch (err) {
      setLoginError(err.message || '操作失败');
    }
  });
}

bind();
boot();
