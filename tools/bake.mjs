// Bakes tree impostor atlases from Poly Haven glTFs using headless Edge.
// Usage: node tools/bake.mjs <assets_dir> <out_dir>   (Vite dev server must be running)
import puppeteer from 'puppeteer-core';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

const [assets, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TREES = [
  { name: 'fir_a', url: 'fir_tree_01/fir_tree_01_1k.gltf', node: 'fir_tree_01_a_LOD0', frames: 3, width: 320, height: 640 },
  { name: 'fir_b', url: 'fir_tree_01/fir_tree_01_1k.gltf', node: 'fir_tree_01_b_LOD0', frames: 3, width: 320, height: 640 },
  { name: 'fir_c', url: 'fir_tree_01/fir_tree_01_1k.gltf', node: 'fir_tree_01_c_LOD0', frames: 3, width: 320, height: 640 },
  { name: 'island', url: 'island_tree_01/island_tree_01_1k.gltf', frames: 3, width: 448, height: 512 },
  { name: 'small', url: 'tree_small_02/tree_small_02_1k.gltf', frames: 3, width: 448, height: 512 },
];
const types = { '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png' };
// Large glTFs (hundreds of MB) are streamed from a local static server.
const server = createServer((req, res) => {
  const file = join(assets, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(8765);
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--no-sandbox', '--js-flags=--max-old-space-size=8192'],
  protocolTimeout: 900000,
});
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/tools/bake.html');
await page.waitForFunction('window.bakeReady === true', { timeout: 120000 });
const meta = {};
for (const t of TREES) {
  if (!existsSync(join(assets, t.url))) {
    console.log('skip (not downloaded)', t.name);
    continue;
  }
  console.log('baking', t.name);
  const r = await page.evaluate((t) => window.bake(`http://localhost:8765/${t.url}`, t), t);
  writeFileSync(join(out, `${t.name}_color.png`), Buffer.from(r.color.split(',')[1], 'base64'));
  writeFileSync(join(out, `${t.name}_normal.png`), Buffer.from(r.normal.split(',')[1], 'base64'));
  meta[t.name] = { worldWidth: r.worldWidth, worldHeight: r.worldHeight, base: r.base, frames: r.frames };
}
writeFileSync(join(out, 'trees.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta));
await browser.close();
server.close();
