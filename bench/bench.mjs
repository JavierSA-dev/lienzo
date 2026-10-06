// Benchmark comparativo Lienzo vs Photopea en TU navegador y TU GPU.
// Uso: npm run build && npm run bench        (necesita Google Chrome instalado)
// Mide cada operación y la tarea más larga del hilo principal (= tiempo que la interfaz queda congelada).
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const PORT = 4174;
const channel = process.env.BENCH_CHANNEL ?? 'chrome'; // o 'msedge'
const skipPhotopea = process.argv.includes('--solo-lienzo');

if (!existsSync('dist/index.html')) execSync('npx vite build', { stdio: 'inherit' });
if (!existsSync('tests/fixtures/50-capas.psd')) execSync('node tests/make-psd.mjs', { stdio: 'inherit' });
mkdirSync('dist/__fixtures', { recursive: true });
copyFileSync('tests/fixtures/50-capas.psd', 'dist/__fixtures/50-capas.psd');

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', shell: process.platform === 'win32', detached: process.platform !== 'win32' });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('localhost') && r()));
const stopServer = () => {
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-server.pid, 'SIGTERM');
  } catch { /* ya cerrado */ }
};

const headless = process.env.BENCH_HEADLESS === '1';
const browser = await chromium.launch({
  channel: channel === 'bundled' ? undefined : channel,
  headless,
  args: ['--window-size=1500,950', ...(headless ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])],
});
const psd = readFileSync('tests/fixtures/50-capas.psd');

// Script común: se ejecuta dentro de cada página. `run(op)` debe resolver cuando termina la operación.
const OPS = [
  ['Abrir PSD de 50 capas (41 MB)', 'openPsd'],
  ['Documento nuevo 6000×4000 (24 MP)', 'create'],
  ['Rellenar 24 MP', 'fill'],
  ['Duplicar capa ×10', 'dup10'],
  ['Redimensionar 11 capas al 50 %', 'resizeDown'],
  ['Redimensionar 11 capas a 24 MP', 'resizeUp'],
];

async function measure(page, runner) {
  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({ type: 'longtask' });
  });
  const out = {};
  for (const [, op] of OPS) {
    await page.evaluate(() => { window.__lt = []; });
    const ms = await page.evaluate(runner, op);
    await page.waitForTimeout(400);
    const freeze = await page.evaluate(() => Math.round(Math.max(0, ...window.__lt)));
    out[op] = { ms: Math.round(ms), freeze };
    console.log(`  ${op.padEnd(12)} ${String(Math.round(ms)).padStart(7)} ms   interfaz congelada: ${freeze} ms`);
  }
  return out;
}

const results = {};
try {
  // ---------------- Lienzo
  console.log('\nLienzo');
  const p1 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p1.goto(`http://localhost:${PORT}/app/`);
  await p1.waitForFunction(() => window.__lienzoStore?.getState().ready);
  console.log('  GPU:', await p1.evaluate(() => window.__lienzoStore.getState().renderer));
  results.lienzo = await measure(p1, async (op) => {
    const e = window.__lienzo;
    const t0 = performance.now();
    const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    switch (op) {
      case 'openPsd': {
        const buf = await (await fetch('/__fixtures/50-capas.psd')).arrayBuffer();
        const t = performance.now();
        await e.call('open', '50-capas.psd', buf, '');
        await e.call('debugComposeAll');
        return performance.now() - t;
      }
      case 'create': await e.call('newDoc', 6000, 4000, 'white', 'bench.psd'); break;
      case 'fill': await e.call('selectAll'); await e.call('fill', 'fg'); await e.call('deselect'); break;
      case 'dup10': for (let i = 0; i < 10; i++) await e.call('duplicateLayer'); break;
      case 'resizeDown': await e.call('resizeImage', 3000, 2000); break;
      case 'resizeUp': await e.call('resizeImage', 6000, 4000); break;
    }
    await e.call('debugComposeAll');
    await settle();
    return performance.now() - t0;
  });

  // ---------------- Photopea (misma prueba vía su API de scripts)
  if (!skipPhotopea) {
    console.log('\nPhotopea');
    const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await p2.goto('https://www.photopea.com/');
    await p2.evaluate(async () => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999;border:0';
      f.src = 'https://www.photopea.com#' + encodeURIComponent(JSON.stringify({ environment: {} }));
      window.__pp = f;
      window.__msgs = [];
      window.addEventListener('message', (e) => { if (e.source === f.contentWindow) window.__msgs.push(e.data); });
      document.body.appendChild(f);
      await new Promise((r) => { const iv = setInterval(() => { if (window.__msgs.includes('done')) { clearInterval(iv); r(); } }, 100); });
    });
    await p2.evaluate((b64) => { window.__psd = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer; }, psd.toString('base64'));
    results.photopea = await measure(p2, async (op) => {
      const send = (msg) => new Promise((res) => {
        const n0 = window.__msgs.length;
        window.__pp.contentWindow.postMessage(msg, '*');
        const iv = setInterval(() => { if (window.__msgs.slice(n0).includes('done')) { clearInterval(iv); res(); } }, 5);
      });
      const t0 = performance.now();
      switch (op) {
        case 'openPsd': await send(window.__psd.slice(0)); break;
        case 'create': await send('app.documents.add(6000,4000,72,"bench","RGB");'); break;
        case 'fill': await send('var c=new SolidColor();c.rgb.red=0;c.rgb.green=0;c.rgb.blue=0;app.activeDocument.selection.selectAll();app.activeDocument.selection.fill(c);app.activeDocument.selection.deselect();'); break;
        case 'dup10': await send('for(var i=0;i<10;i++){app.activeDocument.activeLayer.duplicate();}'); break;
        case 'resizeDown': await send('app.activeDocument.resizeImage(3000,2000);'); break;
        case 'resizeUp': await send('app.activeDocument.resizeImage(6000,4000);'); break;
      }
      return performance.now() - t0;
    });
  }
} finally {
  await browser.close();
  stopServer();
}

// ---------------- Informe
const rows = OPS.map(([label, op]) => {
  const a = results.lienzo?.[op], b = results.photopea?.[op];
  const f = (r) => (r ? `${r.ms.toLocaleString('es')} ms (congela ${r.freeze.toLocaleString('es')} ms)` : '—');
  const speed = a && b ? `${(b.ms / Math.max(1, a.ms)).toFixed(1)}×` : '—';
  return `| ${label} | ${f(a)} | ${f(b)} | ${speed} |`;
});
const md = `# Benchmark Lienzo vs Photopea\n\nFecha: ${new Date().toLocaleString('es')} · Navegador: ${channel}\n\n| Operación | Lienzo | Photopea | Lienzo es… |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n"Congela" = tarea más larga del hilo principal: el tiempo en que la interfaz no responde.\n`;
mkdirSync('bench', { recursive: true });
writeFileSync('bench/resultados.md', md);
console.log('\n' + md);
