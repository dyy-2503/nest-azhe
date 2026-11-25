// 给 dsh 入口加自启动钩子：dsh web 启动时顺带拉起 Nest 本地世界
import fs from 'node:fs';
const link = '/usr/local/bin/dsh';
const real = fs.realpathSync(link);
const file = fs.existsSync(real) ? real : link;
let s = fs.readFileSync(file, 'utf8');
if (s.includes('NEST_AUTOSTART')) { console.log('already patched:', file); process.exit(0); }
const inject = `// NEST_AUTOSTART: dsh 一启动就把 Nest 本地世界带起来
import { spawn as __nestSpawn } from "node:child_process";
try {
  if (process.argv.includes("web")) {
    const __c = __nestSpawn("sh", ["/root/nest-local/start.sh"], { detached: true, stdio: "ignore" });
    __c.unref();
  }
} catch (e) {}
`;
fs.writeFileSync(file, inject + s, 'utf8');
console.log('patched ok:', file);