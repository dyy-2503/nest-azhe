// 用 Electron 渲染 SVG → 生成 PNG / ICO / 网页 favicon
//
// 为什么用 Electron 渲染：这台机器没有 sharp / rsvg / ImageMagick，
// 但 Electron 本身就是 Chromium，渲染 SVG 最准，而且它已经是桌面端的开发依赖。
//
// 用法（在仓库根目录）：
//   desktop\node_modules\electron\dist\electron.exe scripts\make-icon.cjs

const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const SVG = readFileSync(join(ROOT, 'build', 'icon.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 180, 192, 256, 512, 1024];

/** 生成 ICO（PNG 内嵌格式，Windows Vista+ 支持） */
function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const datas = [];
  pngs.forEach(({ size, buf }, i) => {
    const e = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, e + 0);
    entries.writeUInt8(size >= 256 ? 0 : size, e + 1);
    entries.writeUInt8(0, e + 2);
    entries.writeUInt8(0, e + 3);
    entries.writeUInt16LE(1, e + 4);
    entries.writeUInt16LE(32, e + 6);
    entries.writeUInt32LE(buf.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += buf.length;
    datas.push(buf);
  });
  return Buffer.concat([header, entries, ...datas]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const outDir = join(ROOT, 'build', 'icons');
  mkdirSync(outDir, { recursive: true });

  // 渲染页面：SVG 铺满窗口，透明背景
  const htmlPath = join(outDir, '_render.html');
  writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  svg{display:block;width:100vw;height:100vh}
</style>
${SVG}`, 'utf8');

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  await win.loadFile(htmlPath);
  await sleep(250);

  const pngs = [];
  for (const size of SIZES) {
    win.setContentSize(size, size);
    await sleep(180);
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    const buf = img.toPNG();
    pngs.push({ size, buf });
    writeFileSync(join(outDir, `icon-${size}.png`), buf);
    console.log(`  png ${size}  ${buf.length}B`);
  }
  win.destroy();
  try { unlinkSync(htmlPath); } catch { /* ignore */ }

  const icoSizes = pngs.filter((p) => p.size <= 256);
  const ico = buildIco(icoSizes);
  mkdirSync(join(ROOT, 'desktop', 'build'), { recursive: true });
  writeFileSync(join(ROOT, 'desktop', 'build', 'icon.ico'), ico);
  console.log(`  desktop/build/icon.ico  ${(ico.length / 1024).toFixed(1)}KB  ${icoSizes.length} 尺寸`);

  writeFileSync(join(ROOT, 'public', 'favicon.ico'), buildIco(pngs.filter((p) => p.size <= 64)));
  writeFileSync(join(ROOT, 'public', 'icon-192.png'), pngs.find((p) => p.size === 192).buf);
  writeFileSync(join(ROOT, 'public', 'icon-512.png'), pngs.find((p) => p.size === 512).buf);
  writeFileSync(join(ROOT, 'public', 'apple-touch-icon.png'), pngs.find((p) => p.size === 180).buf);
  console.log('  public/favicon.ico + icon-192/512 + apple-touch-icon');

  if (existsSync(join(ROOT, 'mobile'))) {
    // 安卓各密度图标（不用 sharp，直接写对应尺寸的 PNG）
    const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
    for (const [d, size] of Object.entries(DENSITIES)) {
      const dir = join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'res', `mipmap-${d}`);
      const src = pngs.find((p2) => p2.size === size);
      if (src && existsSync(dir)) writeFileSync(join(dir, 'ic_launcher.png'), src.buf);
    }
    console.log('  android mipmap-* 图标');
    // 启动页里显示的 logo
    writeFileSync(join(ROOT, 'mobile', 'www', 'icon.png'), pngs.find((p2) => p2.size === 192).buf);
    console.log('  mobile/www/icon.png');
    const res = join(ROOT, 'mobile', 'resources');
    mkdirSync(res, { recursive: true });
    writeFileSync(join(res, 'icon.png'), pngs.find((p) => p.size === 1024).buf);
    writeFileSync(join(res, 'splash.png'), pngs.find((p) => p.size === 512).buf);
    console.log('  mobile/resources/icon.png + splash.png');
  }

  console.log('图标生成完成');
  app.exit(0);
});
