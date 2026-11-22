// AI 成员运行时：一个坐在群里的「人」，而不是一个按钮。
// 有 key 就走真模型（OpenAI 兼容，流式）；没有或失败就回落到本地剧本，永远有人接话。
import { all, publicUser } from './db.mjs';
import { createHash } from 'node:crypto';
import { loadAiConfig, loadPersona, complete, describeAi } from './ai.mjs';
import {
  dshBaseUrl, createSession, getBoundSession, bindSession, markSeen,
  pendingContext, runTurn, setPersonaHash,
} from './dsh.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* ------------------------------ 本地兜底剧本 ------------------------------ */

const OPENERS = ['我觉得吧，', '这个我有话说 —— ', '嗯……', '不是，', '说真的，'];

const LINES = {
  ask: [
    '大概率是缓存没清。你先按 Ctrl+F5 再来一遍，我猜能好。',
    '先别改代码，把日志最后 20 行贴出来，八成答案就在那儿。',
    '这个看情况：本地跑得通、线上跑不通，基本就是环境变量没同步。',
    '你把它拆成最小复现，我陪你一起看。',
    '先问问自己：这条路径上一次跑通是什么时候？',
  ],
  code: [
    '这 bug 我熟，九成是异步顺序错了。加个 await 试试。',
    '先写个失败的测试把现象钉住，再改实现。',
    '命名比注释重要。这函数叫 handle 谁也看不懂，叫 syncInbox 一下就懂了。',
    '别重构了，今晚先让它跑起来。明天再动刀。',
    '先把日志补上。你现在的报错只说「失败」，没说失败在哪。',
  ],
  tired: ['睡吧睡吧，代码明天不会跑。', '这时候写的代码，明天你得花两倍时间读。', '来杯热的，然后收工。'],
  food: ['这个点还没吃饭？点个粥吧，别硬扛。', '我投螺蛳粉一票。', '奶茶可以，但记得半糖。'],
  morning: ['早啊。今天有什么要收拾的？', '早，昨晚那个问题解决了吗？'],
  night: ['晚安，明天见。', '睡了睡了，别卷了。'],
  fallback: [
    '有道理。', '我记一下，这个坑值得写进文档。', '笑死，这也行。', '嗯，那就这么定。',
    '你说的这个我认，但我觉得还能再省一步。', '行，那我来。', '先这样，有问题随时喊我。',
    '这个我没想到，学到了。', '要不反过来想：如果这条路走不通，最省事的退路是什么？',
  ],
};

const usedLines = new Map();

function pickLine(convId, key) {
  const pool = LINES[key] || LINES.fallback;
  let used = usedLines.get(convId);
  if (!used) {
    used = new Set();
    usedLines.set(convId, used);
  }
  let avail = pool.filter((l) => !used.has(l));
  if (!avail.length) {
    used.clear();
    avail = pool;
  }
  const line = pickRandom(avail);
  used.add(line);
  return line;
}

function bucket(text) {
  const t = text.toLowerCase();
  if (/[?？]|为什么|怎么|如何|是不是|能不能|要不要/.test(text)) return 'ask';
  if (/bug|报错|错误|异常|部署|上线|测试|重构|代码|接口|数据库/.test(t)) return 'code';
  if (/累|困|睡了|晚安|熬夜/.test(text)) return 'tired';
  if (/吃|饭|奶茶|夜宵|外卖|饿/.test(text)) return 'food';
  if (/早|早上好|早安/.test(text)) return 'morning';
  if (/晚安|睡了/.test(text)) return 'night';
  return 'fallback';
}

/* ------------------------------ 上下文构造 ------------------------------ */

function textOf(message) {
  return (message.blocks || [])
    .filter((b) => b.t === 'text')
    .map((b) => b.v)
    .join(' ')
    .trim();
}

/** 把最近若干条消息压成 OpenAI 的 messages，同角色相邻的合并 */
function buildMessages({ conv, convId, agent, limit }) {
  const persona = loadPersona(loadAiConfig().persona);

  const rows = all(
    `SELECT m.body, m.recalled_at, m.sender_id, u.nickname, u.kind
       FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.conv_id = ? AND m.recalled_at = 0
      ORDER BY m.id DESC LIMIT ?`,
    convId, limit
  ).reverse();

  const members = all(
    `SELECT u.nickname, u.kind FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.conv_id = ? ORDER BY m.joined_at`,
    convId
  );

  const memberLine = members
    .map((m) => (m.kind === 'agent' ? `${m.nickname}（你自己）` : m.nickname))
    .join('、');

  const system = [
    persona,
    '',
    `【此刻】你在「${conv.kind === 'dm' ? '私聊' : conv.title}」里，成员：${memberLine}。`,
    '【硬约束】',
    '- 每次 1~2 句，不超过 60 字，口语，像在手机上打字。',
    '- 不用 Markdown：不要列表、标题、加粗、星号、代码块。',
    '- 不要说"作为一个AI""希望对你有帮助""还有什么可以帮您"。',
    '- 不要自我介绍，不要复述对方的话，不要把上一条说过的句子再说一遍。',
    '- 不知道就说不知道，别编。',
    `- 现在是 ${new Date().toLocaleString('zh-CN', { hour12: false })}。`,
  ].join('\n');

  const messages = [{ role: 'system', content: system }];

  for (const r of rows) {
    const text = textOf({ blocks: JSON.parse(r.body) });
    if (!text) continue;
    const isSelf = Number(r.sender_id) === agent.id;
    if (isSelf) {
      if (messages.at(-1)?.role === 'assistant') {
        messages.at(-1).content += '\n' + text;
      } else {
        messages.push({ role: 'assistant', content: text });
      }
    } else {
      const line = `${r.nickname}：${text}`;
      if (messages.at(-1)?.role === 'user') {
        messages.at(-1).content += '\n' + line;
      } else {
        messages.push({ role: 'user', content: line });
      }
    }
  }

  return messages;
}

/* --------------------------------- 回复 --------------------------------- */

// 模型只输出这个标记 = 这一轮它选择潜水。桥接不往群里发任何东西。
// 照搬 qq-bridge 的 SILENT_MARKER 语义：给 AI 一个合法的沉默出口，
// 而不是逼它写"（内心戏）"然后被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
const isSilentMarker = (text) => /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());

/** 该不该说话 */
// 连续 AI 轮次计数：AI 之间最多来回 3 轮，真人一说话就归零
const aiChain = new Map();

function shouldSpeak(conv, text, agent, cfg, message) {
  const convId = conv.id;

  // 别的 AI 说话：不自动接，但会进上下文（pendingContext 负责带进去）。
  // 除非它点名 @ 了这个 AI —— 那是明确想让它接。
  if (message.sender.kind === 'agent') {
    if (!text.includes('@' + agent.nickname)) return false;
    if ((aiChain.get(convId) || 0) >= 3) {
      console.warn(`[agent] 群 ${convId} AI 之间已经来回 3 轮，先停，等真人说话`);
      return false;
    }
    return true;
  }

  // 真人说话：链归零，然后按模式判断
  aiChain.set(convId, 0);
  if ((cfg.replyMode || 'always') === 'always') return true;
  if (conv.kind === 'dm') return true;
  return text.includes('@' + agent.nickname);
}

/**
 * 走 DSH：会话按「群 × AI 成员」绑定 —— 一个群就是一个对话，跨消息、跨重启都连着。
 * 每次发言前把「上次开口之后群里还说了什么」补进去，
 * 否则 DSH 会话只知道自己被 @ 的那几句，对这个群一无所知。
 */
async function dshTurn({ cfg, convId, agent, message, onDelta }) {
  const base = dshBaseUrl(cfg.dsh || {});
  const persona = loadPersona(cfg.persona);

  let bound = getBoundSession(convId, agent.id);
  let sid = bound?.dsh_session_id || '';

  if (!sid) {
    sid = await createSession(base, cfg.dsh || {});
    bindSession(convId, agent.id, sid);
    bound = getBoundSession(convId, agent.id);
  }

  // 人设文件改了就重新注入一次（新建的会话 persona_hash 为空，也必然走这里）。
  // 不做这件事的话，改 persona 对已经存在的会话完全无效——踩过一次。
  const hash = createHash('sha256').update(persona).digest('hex').slice(0, 16);
  if (bound?.persona_hash !== hash) {
    await runTurn(base, sid,
      `【身份设定，长期有效】\n${persona}\n\n以上是你在这个群里的固定设定，之后都按这个来。现在只回一个字：好`,
      { timeoutMs: 60000 });
    setPersonaHash(convId, agent.id, hash);
  }

  const text = message.blocks?.some((b) => b.t === 'text')
    ? textOf(message)
    : '';
  const line = text
    ? `${message.sender.nickname}：${text}`
    : `${message.sender.nickname}：发了一条${message.blocks?.[0]?.t === 'image' ? '图片' : '非文字消息'}`;

  // 补上它没看见的群聊内容，让这个会话真正等于「这个群」
  const context = pendingContext(convId, agent.id, message.id);

  try {
    const out = await runTurn(base, sid, context + line, { onDelta, timeoutMs: 90000 });
    markSeen(convId, agent.id, message.id);
    return out;
  } catch (err) {
    // 只有「会话确实没了」才解绑重建；其它错误（超时、网络）不能丢绑定，
    // 否则每失败一次这个群就换一个新会话，记忆全断。
    if (/not.?found|不存在|unknown session|no such session/i.test(err.message)) {
      bindSession(convId, agent.id, '');
    }
    throw err;
  }
}

export async function maybeReply({ conv, convId, agent, message, hooks }) {
  if (!agent || message.sender.id === agent.id) return false;

  const cfg = loadAiConfig();
  const text = textOf(message);
  if (!shouldSpeak(conv, text, agent, cfg, message)) return false;

  // 先「想一下」再动手：真人不会秒回
  await sleep(conv.kind === 'dm' ? 420 + Math.random() * 520 : 800 + Math.random() * 1000);

  const tempId = 'tmp_' + Math.random().toString(36).slice(2, 10);
  hooks.onStart(tempId, publicUser(agent));

  // 模型说 [SILENT] → 撤回这个空气泡，群里什么都不发
  const settle = (full) => {
    if (isSilentMarker(full)) {
      hooks.onCancel?.(tempId);
      return true;
    }
    hooks.onDone(tempId, [{ t: 'text', v: full }]);
    aiChain.set(convId, (aiChain.get(convId) || 0) + 1);
    return true;
  };

  let streamed = '';
  const delta = (piece) => {
    if (!piece) return;
    streamed += piece;
    hooks.onDelta(tempId, piece);
  };

  // ---- 1) DSH agent 会话（角色卡 / preset / 工具都在这一侧）----
  if (cfg.driver === 'dsh') {
    try {
      const full = await dshTurn({ cfg, convId, agent, message, onDelta: delta });
      if (full) return settle(full);
      console.warn('[agent] DSH 返回空文本');
    } catch (err) {
      console.warn(`[agent] DSH 失败：${err.message}`);
      if (streamed) return settle(streamed);
    }
  }

  // ---- 2) OpenAI 兼容接口（DSH 不通时的第二选择）----
  if (cfg.apiKey && !streamed) {
    try {
      const messages = buildMessages({
        conv, convId, agent, limit: cfg.contextMessages || 20,
      });
      const full = await complete({ cfg, messages, onDelta: delta });
      if (full) return settle(full);
      console.warn('[agent] 模型返回空，回落到剧本');
    } catch (err) {
      console.warn(`[agent] ${err.message}，回落到剧本`);
    }
  }

  // ---- 本地兜底 ----
  const key = bucket(text);
  const parts = key === 'ask' && Math.random() < 0.4
    ? [pickRandom(OPENERS), pickLine(convId, key)]
    : [pickLine(convId, key)];

  // 第一段已经在流式气泡里了，直接续写；没有再开新气泡
  let first = true;
  for (const part of parts) {
    if (first) {
      for (const ch of part) {
        hooks.onDelta(tempId, ch);
        await sleep(18 + Math.random() * 26);
      }
      hooks.onDone(tempId, [{ t: 'text', v: part }]);
      first = false;
    } else {
      const id2 = 'tmp_' + Math.random().toString(36).slice(2, 10);
      hooks.onStart(id2, publicUser(agent));
      for (const ch of part) {
        hooks.onDelta(id2, ch);
        await sleep(18 + Math.random() * 26);
      }
      hooks.onDone(id2, [{ t: 'text', v: part }]);
    }
    await sleep(200 + Math.random() * 160);
  }
  return true;
}

export { describeAi };
