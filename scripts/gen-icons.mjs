// Renders the SVG logo into the PWA / iOS icons with the pre-installed Playwright Chromium.
// Usage: npm run icons   (writes public/icons/*.png)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('playwright is not installed: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
const logo = fs.readFileSync(path.join(root, 'public', 'logo.svg'), 'utf8');

// full-bleed dark square (iOS applies its own rounded mask); logo scale = share of the canvas
const variants = [
  { file: 'apple-touch-icon.png', size: 180, scale: 0.66 },
  { file: 'icon-192.png', size: 192, scale: 0.66 },
  { file: 'icon-512.png', size: 512, scale: 0.66 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.5 }, // logo inside the 80% safe zone
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const v of variants) {
  const inner = Math.round(v.size * v.scale);
  await page.setViewportSize({ width: v.size, height: v.size });
  await page.setContent(`<html><body style="margin:0;width:${v.size}px;height:${v.size}px;display:grid;place-items:center;background:radial-gradient(circle at 50% 30%,#16201e,#0b0f0e 70%)">
    <div style="width:${inner}px;height:${inner}px">${logo.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`);
  await page.screenshot({ path: path.join(out, v.file), omitBackground: false });
  console.log('wrote', v.file);
}
await browser.close();
