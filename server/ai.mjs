// AI 驱动层：OpenAI 兼容协议（DeepSeek / OpenAI / Ollama / vLLM / LM Studio 通吃）。
// 没有 key 或请求失败时抛错，由 agent.mjs 回落到本地剧本，保证群里永远有人接话。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
export const CONFIG_PATH = process.env.NEST_AI_CONFIG || join(ROOT, 'data', 'ai.json');

/* --------------------------------- 配置 --------------------------------- */

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/** 依次尝试：进程环境变量 → 项目根 .env */
export function resolveSecret(name) {
  if (!name) return '';
  if (process.env[name]) return process.env[name];
  const envPath = process.env.NEST_AI_ENV_FILE || join(ROOT, '.env');
  if (existsSync(envPath)) {
    const vars = parseEnvFile(readFileSync(envPath, 'utf8'));
    if (vars[name]) return vars[name];
  }
  return '';
}

const DEFAULTS = {
  driver: 'openai',              // openai | dsh
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  temperature: 1.15,
  maxTokens: 240,
  persona: 'adai',
  contextMessages: 20,
  timeoutMs: 30000,
  dsh: { baseUrl: '', preset: 'standard' },
};

export function loadAiConfig() {
  let cfg = { ...DEFAULTS };
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      cfg = { ...cfg, ...raw, dsh: { ...DEFAULTS.dsh, ...(raw.dsh || {}) } };
    } catch (err) {
      console.warn('[ai] ai.json 解析失败，用默认配置：', err.message);
    }
  }
  cfg.apiKey = resolveSecret(cfg.apiKeyEnv);
  // dsh 模式不需要 apiKey（鉴权走 DSH 自己的凭证），能不能用由 agent.mjs 探活决定
  cfg.ready = cfg.driver === 'dsh' ? true : (cfg.driver === 'openai' && !!cfg.apiKey);
  return cfg;
}

export function describeAi(cfg) {
  return {
    driver: cfg.driver,
    model: cfg.driver === 'dsh' ? `dsh:${cfg.dsh?.preset || 'standard'}` : cfg.model,
    baseUrl: cfg.driver === 'dsh' ? (cfg.dsh?.baseUrl || 'auto') : cfg.baseUrl,
    hasKey: !!cfg.apiKey,
    persona: cfg.persona,
    ready: cfg.ready,
  };
}

/* -------------------------------- 人设 ---------------------------------- */

const PERSONA_DIR = join(ROOT, 'data', 'persona');

export function loadPersona(name) {
  const p = join(PERSONA_DIR, `${name || 'adai'}.md`);
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  return '你叫「阿呆」，是群里常驻的一个 AI 群友。说话短、口语、像真人。';
}

/* ------------------------------- 流式请求 -------------------------------- */

function endpointOf(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (/\/(v\d+)$/.test(base)) return base + '/chat/completions';
  return base + '/v1/chat/completions';
}

/**
 * 流式补全。onDelta 收到增量文本；返回完整文本。
 * 协议：OpenAI /v1/chat/completions + stream:true（SSE，data: {...}）。
 */
export async function complete({ cfg, messages, onDelta }) {
  if (!cfg.ready) throw Object.assign(new Error('AI 未配置（缺 apiKey）'), { code: 'NO_KEY' });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);

  let res;
  try {
    res = await fetch(endpointOf(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: true,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw Object.assign(new Error(`AI 请求失败：${err.message}`), { code: 'NETWORK' });
  }

  if (!res.ok) {
    clearTimeout(timer);
    const body = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`AI 返回 ${res.status}：${body.slice(0, 200)}`),
      { code: 'HTTP' }
    );
  }

  let full = '';
  const decoder = new TextDecoder();
  let buf = '';

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const piece = json.choices?.[0]?.delta?.content || '';
          if (piece) {
            full += piece;
            onDelta?.(piece);
          }
        } catch {
          // 半包/心跳，忽略
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return full.trim();
}
