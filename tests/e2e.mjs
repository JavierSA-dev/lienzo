// Prueba de extremo a extremo en Chromium: interfaz, pincel, historial, capas, PSD y rendimiento.
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { makeLayers } from './make-psd.mjs';
import { compositePixel } from './reference.mjs';

const PORT = 4173;
const URL = `http://localhost:${PORT}/`;
const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? '✔' : '✘'} ${name} ${extra}`); };

if (!existsSync('dist/index.html')) execSync('npx vite build', { stdio: 'inherit' });
if (!existsSync('tests/fixtures/50-capas.psd')) execSync('node tests/make-psd.mjs', { stdio: 'inherit' });
mkdirSync('dist/__fixtures', { recursive: true });
copyFileSync('tests/fixtures/50-capas.psd', 'dist/__fixtures/50-capas.psd');

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', detached: true });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch {} };
server.stderr.on('data', (d) => process.stderr.write(d));
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('localhost') && r()));

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(URL);
  await page.waitForFunction(() => window.__lienzoStore?.getState().ready, null, { timeout: 15000 });
  ok('El motor arranca en el worker', true, await page.evaluate(() => window.__lienzoStore.getState().renderer));
  ok('Página aislada (SharedArrayBuffer disponible)', await page.evaluate(() => crossOriginIsolated));

  // Longtasks del hilo principal: la prueba clave frente a Photopea.
  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({ type: 'longtask' });
  });
  const maxLongTask = () => page.evaluate(() => { const m = Math.max(0, ...window.__lt); window.__lt = []; return Math.round(m); });

  // 1. Documento nuevo desde la pantalla de inicio.
  await page.getByRole('button', { name: /Por defecto/ }).click();
  await page.waitForFunction(() => window.__lienzoStore.getState().doc.open);
  const doc = await page.evaluate(() => window.__lienzoStore.getState().doc);
  ok('Documento nuevo 1920×1080', doc.width === 1920 && doc.height === 1080 && doc.layers.length === 1);

  const S = () => page.evaluate(() => window.__lienzoStore.getState());
  const toScreen = async (dx, dy) => {
    const { view } = await S();
    const box = await page.getByTestId('canvas-area').boundingBox();
    return [box.x + view.panX + dx * view.zoom, box.y + view.panY + dy * view.zoom];
  };
  const px = (x, y) => page.evaluate(([x, y]) => window.__lienzo.call('debugPixel', x, y), [x, y]);
  const settle = () => page.waitForTimeout(250);

  // 2. Pincel: trazo negro horizontal por el centro.
  await page.keyboard.press('b');
  const [ax, ay] = await toScreen(600, 540);
  const [bx, by] = await toScreen(1300, 540);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 30 });
  await page.mouse.up();
  await settle();
  let p = await px(950, 540);
  ok('El pincel pinta', p[0] < 20 && p[3] === 255, JSON.stringify(p));
  const st = await S();
  ok('El trazo queda en el historial', st.doc.history.at(-1).label === 'Pincel');

  // 3. Deshacer / rehacer.
  await page.keyboard.press('Control+z');
  await settle();
  p = await px(950, 540);
  ok('Deshacer restaura el blanco', p[0] === 255, JSON.stringify(p));
  await page.keyboard.press('Control+Shift+z');
  await settle();
  p = await px(950, 540);
  ok('Rehacer vuelve a pintar', p[0] < 20, JSON.stringify(p));

  // 4. Capa nueva en Multiplicar + relleno rojo sobre gris.
  await page.evaluate(async () => {
    const e = window.__lienzo, s = window.__lienzoStore.getState();
    s.setColors('#808080', '#ffffff');
    await e.call('fill', 'fg');
    await e.call('newLayer');
    s.setColors('#ff0000', '#ffffff');
    await e.call('fill', 'fg');
    const id = window.__lienzoStore.getState().doc.activeLayerId;
    await e.call('setLayer', id, { blend: 'multiply' });
  });
  await settle();
  p = await px(100, 100);
  ok('Modo Multiplicar correcto (gris×rojo = 128,0,0)', Math.abs(p[0] - 128) <= 2 && p[1] <= 2 && p[2] <= 2, JSON.stringify(p));
  await page.evaluate(async () => { const id = window.__lienzoStore.getState().doc.activeLayerId; await window.__lienzo.call('setLayer', id, { blend: 'screen' }); });
  await settle();
  p = await px(100, 100);
  ok('Modo Trama correcto (255,128,128)', p[0] >= 253 && Math.abs(p[1] - 128) <= 2, JSON.stringify(p));
  await page.evaluate(async () => { const id = window.__lienzoStore.getState().doc.activeLayerId; await window.__lienzo.call('setLayer', id, { blend: 'difference' }); });
  await settle();
  p = await px(100, 100);
  ok('Modo Diferencia correcto (127,128,128)', Math.abs(p[0] - 127) <= 2 && Math.abs(p[1] - 128) <= 2, JSON.stringify(p));

  // 5. Combinar hacia abajo conserva el resultado.
  await page.keyboard.press('Control+e');
  await settle();
  p = await px(100, 100);
  const afterMerge = await S();
  ok('Combinar hacia abajo', afterMerge.doc.layers.length === 1 && Math.abs(p[0] - 127) <= 3, JSON.stringify(p));

  // 6. Selección + borrar.
  await page.evaluate(() => window.__lienzo.call('selectAll'));
  await page.keyboard.press('Delete');
  await settle();
  p = await px(100, 100);
  ok('Seleccionar todo + Suprimir deja transparente', p[3] === 0, JSON.stringify(p));

  await page.screenshot({ path: 'tests/out-editor.png' });

  // 7. Abrir un PSD de 50 capas (40 MB) y medir.
  await maxLongTask();
  const open = await page.evaluate(async () => {
    const buf = await (await fetch('/__fixtures/50-capas.psd')).arrayBuffer();
    const t0 = performance.now();
    const r = await window.__lienzo.call('open', '50-capas.psd', buf, '');
    const t1 = performance.now();
    const compose = await window.__lienzo.call('debugComposeAll');
    const stats = await window.__lienzo.call('stats');
    return { layers: r.layers, openMs: Math.round(t1 - t0), composeMs: Math.round(compose), stats };
  });
  const ltOpen = await maxLongTask();
  ok('PSD de 50 capas abierto', open.layers === 50, `${open.openMs} ms · composición completa ${open.composeMs} ms · ${open.stats.layerMB} MB en tiles`);
  ok('La interfaz no se bloquea al abrir el PSD', ltOpen < 200, `tarea larga máx. en hilo principal: ${ltOpen} ms`);
  // Compara la composición GPU (50 capas, 8 modos, capas desplazadas) con la referencia en CPU.
  const children = makeLayers();
  let worst = 0, checked = 0;
  for (let i = 0; i < 40; i++) {
    const x = (i * 739 + 101) % 3000, y = (i * 419 + 57) % 2000;
    const ref = compositePixel(children, x, y);
    const got = await px(x, y);
    worst = Math.max(worst, ...ref.map((v, k) => Math.abs(v - got[k])));
    checked++;
  }
  ok('Composición GPU = referencia CPU (40 píxeles, 50 capas)', worst <= 8, `diferencia máx. ${worst}/255 en ${checked} píxeles`);
  await settle();
  const t0s = Date.now();
  await page.screenshot({ path: 'tests/out-psd.png', timeout: 180000 });
  ok('Primer fotograma del PSD en pantalla', true, `${Date.now() - t0s} ms (GPU emulada por CPU en este entorno)`);

  // 8. Pincel: 1000 puntos con pincel de 100 px sobre un 24 MP.
  const brush = await page.evaluate(async () => {
    const e = window.__lienzo;
    await e.call('newDoc', 6000, 4000, 'white', 'bench.psd');
    window.__lienzoStore.getState().setBrush({ size: 100, hardness: 0.5 });
    const pts = [];
    for (let i = 0; i < 1000; i++) pts.push([500 + i * 5, 2000 + Math.sin(i / 30) * 800, 1]);
    const ms = await e.call('debugStroke', pts);
    return Math.round(ms);
  });
  ok('Trazo de 1000 puntos (pincel 100 px, 24 MP)', brush < 2000, `${brush} ms → ${(brush / 1000).toFixed(2)} ms por punto`);

  // 9. Misma prueba que hicimos a Photopea: 11 capas de 24 MP y redimensionar.
  const resize = await page.evaluate(async () => {
    const e = window.__lienzo;
    const t = async (fn) => { const t0 = performance.now(); await fn(); return Math.round(performance.now() - t0); };
    const fill = await t(() => e.call('fill', 'fg'));
    const dup = await t(async () => { for (let i = 0; i < 10; i++) await e.call('duplicateLayer'); });
    const statsDup = await e.call('stats');
    const down = await t(() => e.call('resizeImage', 3000, 2000));
    const stats = await e.call('stats');
    const up = await t(() => e.call('resizeImage', 6000, 4000));
    const undo = await t(() => e.call('undo'));
    return { fill, dup, down, up, undo, stats: statsDup };
  });
  const ltResize = await maxLongTask();
  ok('Rellenar 24 MP', true, `${resize.fill} ms`);
  ok('Duplicar capa ×10 (24 MP) sin copiar píxeles', resize.stats.gpuTextures < 400 * 11, `${resize.dup} ms · texturas en GPU: ${resize.stats.gpuTextures}`);
  ok('Redimensionar 11 capas de 24 MP al 50 %', true, `${resize.down} ms (Photopea: 29 400 ms)`);
  ok('Redimensionar 11 capas a 24 MP', true, `${resize.up} ms (Photopea: 25 400 ms)`);
  ok('Deshacer redimensionado', true, `${resize.undo} ms`);
  ok('Interfaz fluida durante todo lo anterior', ltResize < 200, `tarea larga máx.: ${ltResize} ms (Photopea: 25 000 ms)`);

  ok('Sin errores en consola', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  ok('Excepción en la prueba', false, String(e));
  await page.screenshot({ path: 'tests/out-error.png' }).catch(() => {});
} finally {
  await browser.close();
  stopServer();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`);
process.exit(failed.length ? 1 : 0);
