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
const url = `${base}?shot&lat=25.03&lon=121.56&${query}`;
await page.goto(url, { waitUntil: 'load' });
try {
  await page.waitForFunction('window.__ready === true', { timeout: 60000 });
} catch {
  logs.push('[timeout] app never became ready');
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
