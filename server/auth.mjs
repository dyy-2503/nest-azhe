// 鉴权：scrypt 口令 + HttpOnly 会话 cookie（无 JWT、无刷新令牌，够小圈子用）
// 另有 AI 成员的接入钥匙：明文只返回一次，库里只存 sha256。
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, KEYLEN).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, KEYLEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const newToken = () => randomBytes(24).toString('base64url');
export const newInvite = () => 'NEST-' + randomBytes(3).toString('hex').toUpperCase();

/**
 * AI 成员的接入钥匙。明文形如 `NEST-AI-ab12cd34…`，只在创建时返回一次。
 * 字母表去掉了 0/O/1/l/I —— 同学要手抄到另一台机器上。
 */
const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function newAiKey() {
  let body = '';
  for (const b of randomBytes(32)) body += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return `NEST-AI-${body}`;
}

export const aiKeyHash = (key) => createHash('sha256').update(String(key || '')).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 这个请求是不是走的 HTTPS（直连 TLS，或经过隧道/反代的 X-Forwarded-Proto） */
export function isSecureReq(req) {
  try {
    if (req.socket && req.socket.encrypted) return true;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    return proto === 'https';
  } catch { return false; }
}

/**
 * sid 会话 cookie。
 * secure=true 时加 Secure：走 https（公网隧道/证书）必须加，
 * 但局域网 http 访问时加了会存不上，所以按请求动态判断。
 */
export function sessionCookie(token, { clear = false, secure = false } = {}) {
  const base = `sid=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=${60 * 60 * 24 * 30}`;
}
