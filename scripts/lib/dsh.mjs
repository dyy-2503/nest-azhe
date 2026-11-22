/**
 * 找本机正在跑的 DSH，不依赖任何环境变量。
 *
 * 为什么要这个：DSH 每次启动的 HTTP 端口都是随机分配的（今天先后是 62212、
 * 58249、49734……）。Nest 服务端的「内置 AI」和桥接都要连着它，端口一变就全断。
 * 与其让用户每次改环境变量，不如自己找。
 *
 * 指纹：DSH 对未认证的 GET / 会回 401，body 里是
 * "dsh web authentication required; reopen the URL printed by dsh web."——
 * 这句是它独有的，拿来做识别比"谁在监听"可靠得多。
 */
import { execFileSync } from 'node:child_process';

/** 本机正在监听的 TCP 端口（跨平台，拿不到就返回空数组） */
export function listeningPorts() {
  const found = new Set();
  try {
    if (process.platform === 'win32') {
      const txt = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 5000 });
      for (const line of txt.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const m = /^\s*TCP\s+\S*[:.](\d+)\s/mi.exec(line);
        if (m) found.add(Number(m[1]));
      }
    } else {
      const cmd = process.platform === 'darwin' ? 'lsof' : 'ss';
      const args = process.platform === 'darwin' ? ['-iTCP', '-sTCP:LISTEN', '-nP'] : ['-ltn'];
      const txt = execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
      for (const line of txt.split(/\r?\n/)) {
        const m = /[:.](\d+)\s+(?:\(LISTEN\)|LISTEN|\S*\*)/.exec(line) || /:(\d+)\s/.exec(line);
        if (m) found.add(Number(m[1]));
      }
    }
  } catch {
    // 系统命令不可用就退回小范围扫描
  }
  return [...found].filter((p) => p > 0 && p < 65536);
}

/** 这个端口是不是 DSH（靠那句 401 文案认） */
export async function isDshPort(port, timeoutMs = 900) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    if (res.status !== 401) return false;
    const text = await res.text().catch(() => '');
    return /dsh web authentication required/i.test(text) || /dsh/i.test(text) && text.length < 400;
  } catch {
    return false;
  }
}

/**
 * 找出本机 DSH 的地址。
 * 顺序：显式指定（DSH_WEB_URL / NEST_DSH_BASE）→ 已知能用的端口缓存 → 扫监听端口。
 * 找不到返回 ''。
 */
export async function findDshBase({ known = [], log = () => {} } = {}) {
  const explicit = process.env.NEST_DSH_BASE || process.env.DSH_WEB_URL;
  if (explicit) {
    const base = String(explicit).replace(/\/+$/, '');
    const port = Number(new URL(base).port || 80);
    if (await isDshPort(port)) return base;
    log(`指定的 DSH ${base} 不通，开始自己找…`);
  }

  for (const port of known) {
    if (await isDshPort(port)) return `http://127.0.0.1:${port}`;
  }

  const ports = listeningPorts().filter((p) => p !== 8787);   // 8787 是 Nest 自己
  if (ports.length) {
    log(`本机有 ${ports.length} 个端口在监听，挨个试哪个是 DSH…`);
    for (let i = 0; i < ports.length; i += 8) {
      const batch = ports.slice(i, i + 8);
      const hits = await Promise.all(batch.map(async (p) => ((await isDshPort(p)) ? p : 0)));
      const hit = hits.find(Boolean);
      if (hit) return `http://127.0.0.1:${hit}`;
    }
  }
  return '';
}
