// Renders each fixture with bpmn-js, as a host would show it (the package's
// viewer script and stylesheet), light and dark, to review/<name>-<theme>.png.
// Run `npm run build` first; `npm run review` does both.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initParser, storyAnalysisInRust } from '@listen-fire/movement-lang';
import { chromium } from 'playwright';

import { renderProgram } from '../dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'test', 'fixtures');
const out = join(root, 'review');
const PIN = '0.16.1';
const CATALOG = { payment_failed: 'project' };
const ORIGIN = 'http://review.invalid';

const files = {
  '/bpmn-viewer.js': join(root, 'node_modules/bpmn-js/dist/bpmn-navigated-viewer.production.min.js'),
  '/diagram-js.css': join(root, 'node_modules/bpmn-js/dist/assets/diagram-js.css'),
  '/bpmn-js.css': join(root, 'node_modules/bpmn-js/dist/assets/bpmn-js.css'),
  '/lf-bpmn.css': join(root, 'viewer/lf-bpmn.css'),
  '/viewer.js': join(root, 'dist/viewer.js'),
  '/kinds.js': join(root, 'dist/kinds.js'),
};

const page = (theme) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/diagram-js.css"><link rel="stylesheet" href="/bpmn-js.css"><link rel="stylesheet" href="/lf-bpmn.css">
<style>body{margin:0;background:${theme === 'dark' ? '#12151d' : '#ffffff'}}#canvas{width:800px;height:600px}</style>
<script src="/bpmn-viewer.js"></script></head>
<body><div id="canvas" class="${theme === 'dark' ? 'lf-dark' : ''}"></div>
<script type="module">
import { styleDiagram } from '/viewer.js';
window.show = async (xml) => {
  const container = document.getElementById('canvas');
  const viewer = new BpmnJS({ container });
  await viewer.importXML(xml);
  const canvas = viewer.get('canvas');
  const inner = canvas.viewbox().inner;
  const pad = 24;
  container.style.width = Math.ceil(inner.width + 2 * pad) + 'px';
  container.style.height = Math.ceil(inner.height + 2 * pad) + 'px';
  canvas.resized();
  canvas.viewbox({ x: inner.x - pad, y: inner.y - pad, width: inner.width + 2 * pad, height: inner.height + 2 * pad });
  styleDiagram(viewer);
  return { width: container.offsetWidth, height: container.offsetHeight };
};
window.ready = true;
</script></body></html>`;

await initParser();
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1600, height: 1000 } });
await context.route(`${ORIGIN}/**`, async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/light.html' || path === '/dark.html') {
    return route.fulfill({ contentType: 'text/html', body: page(path.slice(1, -5)) });
  }
  const file = files[path];
  if (file === undefined) return route.fulfill({ status: 404, body: '' });
  const contentType = path.endsWith('.css') ? 'text/css' : 'text/javascript';
  return route.fulfill({ contentType, body: await readFile(file, 'utf8') });
});

const names = (await readdir(fixtures)).filter((file) => file.endsWith('.mvt')).map((file) => file.slice(0, -4)).sort();
for (const name of names) {
  const source = await readFile(join(fixtures, `${name}.mvt`), 'utf8');
  const snapshot = JSON.parse(await readFile(join(fixtures, 'catalogs', `${CATALOG[name] ?? 'handbook'}.json`), 'utf8'));
  const analysis = storyAnalysisInRust(source, snapshot, { languageVersion: PIN });
  const rendering = await renderProgram(source, { analysis, languageVersion: PIN, fileName: `${name}.mvt` });
  if (!rendering.ok) throw new Error(`${name} does not check`);
  await writeFile(join(out, `${name}.bpmn`), rendering.xml);
  for (const theme of ['light', 'dark']) {
    const tab = await context.newPage();
    const errors = [];
    tab.on('pageerror', (error) => errors.push(error.message));
    await tab.goto(`${ORIGIN}/${theme}.html`);
    await tab.waitForFunction(() => window.ready === true);
    const size = await tab.evaluate((xml) => window.show(xml), rendering.xml);
    await tab.setViewportSize({ width: Math.max(400, size.width), height: Math.max(300, size.height) });
    await tab.locator('#canvas').screenshot({ path: join(out, `${name}-${theme}.png`) });
    if (errors.length > 0) throw new Error(`${name} ${theme}: ${errors.join('; ')}`);
    await tab.close();
    process.stdout.write(`review/${name}-${theme}.png ${size.width}x${size.height}\n`);
  }
}
await browser.close();
