// Renders the app in headless Edge/Chrome and saves screenshots for review.
// Usage: node tools/shot.mjs <name> "<query>" [width] [height] [dpr] [waitMs]
//   node tools/shot.mjs lake-noon "scene=lake&time=12:00" 390 844 2
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const [name = 'shot', query = '', w = '390', h = '844', dpr = '2', wait = '1500'] = process.argv.slice(2);
const exe = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const base = process.env.BASE ?? 'http://localhost:5173/';
mkdirSync('tools/shots', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: Number(w), height: Number(h), deviceScaleFactor: Number(dpr) });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const url = `${base}?${process.env.UI ? '' : 'shot&'}lat=25.03&lon=121.56&${query}`;
await page.goto(url, { waitUntil: 'load' });
try {
  await page.waitForFunction('window.__ready === true', { timeout: 60000 });
} catch {
  logs.push('[timeout] app never became ready');
}
if (process.env.CLICK) {
  for (const sel of process.env.CLICK.split('|')) {
    await page.click(sel).catch((e) => logs.push(`[click] ${sel}: ${e.message}`));
    await new Promise((r) => setTimeout(r, 700));
  }
}
// SEQ="150,450,1500": extra screenshots this many ms after the tap/flick
const seq = (process.env.SEQ ?? '').split(',').filter(Boolean).map(Number);
const sequence = async () => {
  let t = 0;
  for (const at of seq) {
    await new Promise((r) => setTimeout(r, Math.max(0, at - t)));
    t = at;
    await page.screenshot({ path: `tools/shots/${name}-${at}.png` });
  }
};
if (process.env.TAP) {
  // tap on the water: fractions of the viewport
  const [fx, fy] = process.env.TAP.split(',').map(Number);
  await page.mouse.click(Number(w) * fx, Number(h) * fy);
  await sequence();
}
if (process.env.FLICK) {
  const [fx, fy, len, ms] = process.env.FLICK.split(',').map(Number);
  const x = Number(w) * fx, y = Number(h) * fy;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x, y - (len * i) / steps);
    await new Promise((r) => setTimeout(r, ms / steps));
  }
  await page.mouse.up();
  await sequence();
}
await new Promise((r) => setTimeout(r, Number(wait)));
const info = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
await page.screenshot({ path: `tools/shots/${name}.png` });
console.log(`GPU: ${info}`);
console.log(logs.filter((l) => !l.includes('[vite]')).slice(0, 40).join('\n'));
await browser.close();
