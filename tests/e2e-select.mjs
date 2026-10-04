// Fase 10: selección avanzada (selección rápida, de objeto, gama de colores, seleccionar y aplicar máscara) y transformaciones.
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PORT = 4177;
const URL = `http://localhost:${PORT}/`;
const results = [];
let page;
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra }); console.log(`${cond ? '✔' : '✘'} ${name} ${extra}`);
  if (!cond && process.env.DEBUG && page) page.evaluate(() => { const s = window.__lienzoStore.getState(); return { tool: s.tool, temp: s.tempTool, dialog: s.dialog, layers: s.doc.layers.length, textEdit: !!s.textEdit, transform: !!s.transform, focus: document.activeElement?.tagName + '.' + document.activeElement?.className }; }).then((x) => console.log('   estado:', JSON.stringify(x))).catch(() => {});
};

if (!existsSync('dist/index.html')) execSync('npx vite build', { stdio: 'inherit' });
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', detached: true });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch {} };
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('localhost') && r()));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL });
page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const S = () => page.evaluate(() => { const s = window.__lienzoStore.getState(); return { tool: s.tool, doc: s.doc, view: s.view, brush: s.brush, fg: s.fg, bg: s.bg, transform: s.transform, textEdit: s.textEdit, selectionPath: s.selectionPath, dialog: s.dialog, actions: s.actions, recording: s.recording, crop: s.crop }; });
const call = (m, ...a) => page.evaluate(([m, a]) => window.__lienzo.call(m, ...a), [m, a]);
const px = (x, y) => call('debugPixel', x, y);
const lpx = (x, y) => call('debugLayerPixel', x, y);
const sel = (x, y) => call('debugSelection', x, y);
const wait = (ms = 250) => page.waitForTimeout(ms);
const box = async () => page.getByTestId('canvas-area').boundingBox();
const scr = async (dx, dy) => { const { view } = await S(); const b = await box(); return [b.x + view.panX + dx * view.zoom, b.y + view.panY + dy * view.zoom]; };
const drag = async (a, b, steps = 12, mods = []) => {
  const [ax, ay] = await scr(...a), [bx, by] = await scr(...b);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(bx, by, { steps }); await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await wait();
};
const click = async (p, mods = []) => { const [x, y] = await scr(...p); for (const m of mods) await page.keyboard.down(m); await page.mouse.click(x, y); for (const m of mods) await page.keyboard.up(m); await wait(); };
const near = (a, b, t = 3) => a.every((v, i) => Math.abs(v - b[i]) <= t);
const active = async () => { const { doc } = await S(); return doc.layers.find((l) => l.id === doc.activeLayerId); };
const useTool = async (t) => { await page.evaluate((t) => window.__lienzoStore.getState().setTool(t), t); await wait(100); };
const key = async (k, ms = 150) => { await page.keyboard.press(k); await wait(ms); };
const closeAllButFirst = async () => { await page.evaluate(async () => { const s = window.__lienzoStore.getState(); for (const d of s.doc.docs.slice(1)) await window.__lienzo.call('closeDoc', d.id); }); await wait(200); };
const newDoc = async (w = 800, h = 600, bg = 'white') => {
  // Cada bloque de pruebas empieza sin pestañas abiertas (para no acumular memoria).
  await page.evaluate(async () => { for (let i = 0; i < 20 && window.__lienzoStore.getState().doc.docs.length; i++) await window.__lienzo.call('closeDoc'); });
  await call('newDoc', w, h, bg, 'prueba.psd'); await wait(300);
};

try {
  await page.goto(URL);
  await page.waitForFunction(() => window.__lienzoStore?.getState().ready, null, { timeout: 20000 });
  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({ type: 'longtask' });
  });
  const maxLongTask = () => page.evaluate(() => { const m = Math.max(0, ...window.__lt); window.__lt = []; return Math.round(m); });
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const menu = async (...path) => {
    await page.locator('.menu-btn', { hasText: new RegExp(`^${esc(path[0])}$`) }).click();
    for (const p of path.slice(1, -1)) await page.locator('.menu-pop .menu-sub > .menu-item', { hasText: new RegExp(`^${esc(p)}▸`) }).last().hover();
    await page.locator('.menu-pop button.menu-item', { hasText: new RegExp(`^✓?${esc(path.at(-1))}`) }).last().click();
    await wait();
  };

  // Escena: fondo blanco, círculo rojo, cuadrado azul, banda verde.
  await newDoc(800, 600, 'white');
  await call('selectShape', { x: 250, y: 150, w: 300, h: 300 }, 'ellipse', 'replace', 0);
  await call('fill', [208, 48, 48, 255]);
  await call('selectShape', { x: 40, y: 40, w: 150, h: 150 }, 'rect', 'replace', 0);
  await call('fill', [40, 80, 200, 255]);
  await call('selectShape', { x: 600, y: 420, w: 160, h: 120 }, 'rect', 'replace', 0);
  await call('fill', [40, 170, 70, 255]);
  await call('deselect');

  // =========================================================== ATAJOS (grupo W)
  await page.keyboard.press('w'); ok('W → Selección de objeto', (await S()).tool === 'objectSelect');
  await page.keyboard.press('Shift+w'); ok('Mayús+W → Selección rápida', (await S()).tool === 'quickSelect');
  await page.keyboard.press('Shift+w'); ok('Mayús+W → Varita mágica', (await S()).tool === 'wand');
  await page.keyboard.press('Shift+w');

  // =========================================================== SELECCIÓN RÁPIDA
  await useTool('quickSelect');
  await drag([360, 280], [440, 320], 10);
  await page.waitForFunction(() => !!window.__lienzoStore.getState().doc.selection, null, { timeout: 15000 });
  ok('Selección rápida: un trazo dentro del círculo selecciona el círculo entero',
    (await sel(400, 300)) === 255 && (await sel(400, 165)) > 200 && (await sel(265, 300)) > 200 && (await sel(400, 140)) < 30 && (await sel(100, 100)) === 0,
    JSON.stringify([await sel(400, 300), await sel(400, 165), await sel(265, 300), await sel(400, 140), await sel(100, 100)]));
  // Añadir otra zona (el modo añadir es el predeterminado con selección activa).
  await drag([80, 80], [150, 150], 8);
  await page.waitForFunction(() => window.__lienzo && true);
  await wait(600);
  ok('Selección rápida: un segundo trazo añade el cuadrado', (await sel(100, 100)) === 255 && (await sel(400, 300)) === 255 && (await sel(220, 220)) === 0);
  // Alt resta.
  await drag([70, 70], [160, 160], 8, ['Alt']);
  await wait(600);
  ok('Selección rápida + Alt resta', (await sel(100, 100)) === 0 && (await sel(400, 300)) === 255);
  await call('deselect');

  // =========================================================== SELECCIÓN DE OBJETO
  await useTool('objectSelect');
  await drag([20, 20], [215, 215], 6);
  await page.waitForFunction(() => !!window.__lienzoStore.getState().doc.selection, null, { timeout: 60000 });
  ok('Selección de objeto: el rectángulo encuentra el cuadrado azul',
    (await sel(115, 115)) === 255 && (await sel(45, 45)) > 200 && (await sel(30, 30)) < 30 && (await sel(205, 115)) < 30,
    JSON.stringify([await sel(115, 115), await sel(45, 45), await sel(30, 30), await sel(205, 115)]));
  await call('deselect');

  // =========================================================== GAMA DE COLORES
  await menu('Selección', 'Gama de colores…');
  ok('Gama de colores abre el diálogo', (await S()).dialog?.kind === 'colorRange');
  const cr = page.getByTestId('cr-preview');
  await page.waitForFunction(() => { const c = document.querySelector('[data-testid=cr-preview]'); return c && c.width > 10; });
  const cb = await cr.boundingBox();
  await page.mouse.click(cb.x + cb.width * 0.5, cb.y + cb.height * 0.5); // rojo del círculo
  await wait(600);
  await page.screenshot({ path: 'tests/out-colorrange.png' });
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForFunction(() => !!window.__lienzoStore.getState().doc.selection, null, { timeout: 10000 });
  ok('Gama de colores con el cuentagotas selecciona el rojo', (await sel(400, 300)) === 255 && (await sel(100, 100)) === 0 && (await sel(20, 580)) === 0 && (await sel(680, 480)) === 0,
    JSON.stringify([await sel(400, 300), await sel(100, 100), await sel(20, 580), await sel(680, 480)]));
  await call('deselect');
  await menu('Selección', 'Gama de colores…');
  await page.getByLabel('Seleccionar').selectOption('blues');
  await wait(300);
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForFunction(() => !!window.__lienzoStore.getState().doc.selection, null, { timeout: 10000 });
  ok('Gama de colores «Azules» selecciona el cuadrado azul', (await sel(100, 100)) > 200 && (await sel(400, 300)) < 30 && (await sel(680, 480)) < 30,
    JSON.stringify([await sel(100, 100), await sel(400, 300), await sel(680, 480)]));
  await call('deselect');

  // =========================================================== SELECCIONAR Y APLICAR MÁSCARA
  await call('selectShape', { x: 250, y: 150, w: 300, h: 300 }, 'ellipse', 'replace', 0);
  await key('Control+Alt+r', 400);
  ok('Ctrl+Alt+R abre Seleccionar y aplicar máscara', (await S()).dialog?.kind === 'refine');
  await page.waitForFunction(() => { const c = document.querySelector('[data-testid=refine-preview]'); return c && c.width > 10; }, null, { timeout: 10000 });
  ok('Seleccionar y aplicar máscara: vista previa', true);
  await page.keyboard.press('k'); await wait(150);
  ok('Atajo K cambia la vista a Blanco y negro', (await page.getByLabel('Vista').inputValue()) === 'bw');
  await page.getByLabel('Calar').fill('6');
  await page.getByLabel('Enviar a').selectOption('mask');
  await page.keyboard.press('v'); await wait(500);
  await page.screenshot({ path: 'tests/out-refine.png' });
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForFunction(() => { const s = window.__lienzoStore.getState(); const L = s.doc.layers.find((l) => l.id === s.doc.activeLayerId); return L?.hasMask; }, null, { timeout: 10000 }).catch(() => {});
  {
    const L = await active();
    const inner = await px(400, 300), edge = await px(400, 151), out = await px(100, 300);
    ok('Salida a máscara de capa con calado suave', !!L.hasMask && inner[3] === 255 && edge[3] > 10 && edge[3] < 250 && out[3] === 0 && !(await S()).doc.selection,
      JSON.stringify({ mask: L.hasMask, inner, edge, out }));
  }
  await key('Control+z', 400);
  ok('Deshacer quita la máscara refinada', !(await active()).hasMask);

  // Nueva capa con máscara + descontaminar.
  await call('selectShape', { x: 250, y: 150, w: 300, h: 300 }, 'ellipse', 'replace', 0);
  const before = (await S()).doc.layers.length;
  await menu('Selección', 'Seleccionar y aplicar máscara…');
  await page.waitForFunction(() => { const c = document.querySelector('[data-testid=refine-preview]'); return c && c.width > 10; }, null, { timeout: 10000 });
  await page.getByText('Descontaminar colores').click();
  ok('Descontaminar fuerza la salida a capa nueva', (await page.getByLabel('Enviar a').inputValue()) === 'newLayerMask');
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForFunction((n) => window.__lienzoStore.getState().doc.layers.length === n + 1, before, { timeout: 10000 }).catch(() => {});
  {
    const st = await S();
    const L = st.doc.layers.find((l) => l.id === st.doc.activeLayerId);
    const orig = st.doc.layers.find((l) => l.id !== L.id && l.name !== L.name);
    ok('Nueva capa con máscara (refinada) y la original oculta', st.doc.layers.length === before + 1 && L.name.endsWith('(refinada)') && L.hasMask && st.doc.layers.some((l) => !l.visible),
      JSON.stringify(st.doc.layers.map((l) => [l.name, l.visible, l.hasMask])));
  }
  await key('Control+z', 400);
  ok('Deshacer elimina la capa refinada y vuelve a mostrar la original', (await S()).doc.layers.length === before && (await S()).doc.layers.every((l) => l.visible));

  await page.screenshot({ path: 'tests/out-select.png' });
  ok('Sin errores en consola', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  ok('Excepción en la prueba', false, String(e.stack ?? e));
  await page.screenshot({ path: 'tests/out-error.png' }).catch(() => {});
} finally {
  await browser.close();
  stopServer();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`);
if (failed.length) console.log('Fallos:\n' + failed.map((f) => ` - ${f.name}: ${f.extra}`).join('\n'));
process.exit(failed.length ? 1 : 0);
