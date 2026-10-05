// Fase 12: ilustración (pinceles con dinámicas, puntas, ABR, simetría, mezclador, degradados y motivos).
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PORT = 4179;
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

  const stats = (rect) => page.evaluate(async (r) => {
    const out = { mean: [0, 0, 0], sd: 0, n: 0 };
    let s2 = 0;
    for (let y = r.y; y < r.y + r.h; y += 3) for (let x = r.x; x < r.x + r.w; x += 3) {
      const c = await window.__lienzo.call('debugLayerPixel', x, y);
      out.mean[0] += c[0]; out.mean[1] += c[1]; out.mean[2] += c[2]; s2 += ((c[0] + c[1] + c[2]) / 3) ** 2; out.n++;
    }
    out.mean = out.mean.map((v) => v / out.n);
    const m = (out.mean[0] + out.mean[1] + out.mean[2]) / 3;
    out.sd = Math.sqrt(Math.max(0, s2 / out.n - m * m));
    return out;
  }, rect);
  const develop = async (fn) => {
    await key('Control+Alt+Shift+a', 400);
    await page.waitForFunction(() => { const c = document.querySelector('[data-testid=develop-preview]'); return c && c.width > 10; }, null, { timeout: 15000 });
    if (fn) await fn();
    await wait(400);
    const h0 = (await S()).doc.historyIndex;
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForFunction((h) => { const s = window.__lienzoStore.getState(); return !s.dialog && !s.busy && s.doc.historyIndex !== h && /Revelado|inteligente/.test(s.doc.history[s.doc.historyIndex]?.label ?? ''); }, h0, { timeout: 30000 }).catch(() => {});
    await wait(300);
  };
  const setSlider = async (label, v, nth = 0) => { const el = page.getByLabel(`${label} (valor)`, { exact: true }).nth(nth); await el.fill(String(v)); await wait(150); };

  const painted = (rect, test = (c) => c[3] > 40) => page.evaluate(async ([r, t]) => {
    const f = new Function('c', `return (${t})(c)`);
    let n = 0;
    for (let y = r.y; y < r.y + r.h; y += 2) for (let x = r.x; x < r.x + r.w; x += 2) if (f(await window.__lienzo.call('debugLayerPixel', x, y))) n++;
    return n;
  }, [rect, test.toString()]);
  const extent = (rect) => page.evaluate(async (r) => {
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = r.y; y < r.y + r.h; y += 1) for (let x = r.x; x < r.x + r.w; x += 1) { const c = await window.__lienzo.call('debugLayerPixel', x, y); if (c[3] > 60) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }
    return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }, rect);
  const dot = async (p) => { const [x, y] = await scr(...p); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up(); await wait(150); };
  const brushSet = (b) => page.evaluate((b) => window.__lienzoStore.getState().setBrush(b), b);

  // =========================================================== PINCELES
  await newDoc(600, 400, 'transparent');
  await useTool('brush');
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#2e7d32', '#a5d6a7'));
  await page.getByLabel('Valores preestablecidos de pincel').click();
  await page.waitForSelector('.brush-item'); await wait(300);
  await page.screenshot({ path: 'tests/out-brushes.png' });
  ok('Selector de pinceles con valores preestablecidos', await page.getByTestId('brush-presets').isVisible() && (await page.locator('.brush-item').count()) >= 12);
  await page.locator('.brush-item', { hasText: 'Hierba' }).click(); await wait(300);
  ok('Elegir «Hierba» carga su punta y dinámicas', (await S()).brush.tip === 'gen:grass' && (await S()).brush.dyn?.fgBgJitter === 1);
  await brushSet({ size: 50 });
  await drag([60, 300], [540, 300], 30);
  {
    const n = await painted({ x: 40, y: 230, w: 520, h: 120 });
    const colors = await page.evaluate(async () => { const s = new Set(); for (let x = 60; x < 540; x += 7) for (let y = 270; y < 320; y += 5) { const c = await window.__lienzo.call('debugLayerPixel', x, y); if (c[3] > 200) s.add(c.slice(0, 3).join()); } return s.size; });
    ok('Hierba: briznas con dispersión y variación de color', n > 200 && colors > 5, `px=${n} colores=${colors}`);
  }
  await call('deselect'); await key('Control+a'); await key('Delete'); await key('Control+d');

  // Forma de la punta: redondez y ángulo.
  await page.getByLabel('Valores preestablecidos de pincel').click();
  await page.locator('.brush-item', { hasText: 'Redondo duro' }).first().click(); await wait(200);
  await brushSet({ size: 60, roundness: 0.3, angle: 0 });
  await dot([150, 150]);
  { const e = await extent({ x: 100, y: 110, w: 100, h: 80 }); ok('Redondez 30 %: punta elíptica', Math.abs(e.w - 60) <= 3 && Math.abs(e.h - 18) <= 3, JSON.stringify(e)); }
  await brushSet({ angle: 90 });
  await dot([350, 150]);
  { const e = await extent({ x: 300, y: 100, w: 100, h: 100 }); ok('Ángulo 90°: la elipse gira', Math.abs(e.h - 60) <= 3 && Math.abs(e.w - 18) <= 3, JSON.stringify(e)); }
  await brushSet({ roundness: 1, angle: 0 });

  // F5: Ajustes de pincel.
  await key('F5', 300);
  await page.getByRole('button', { name: 'Dinámica de forma', exact: true }).click(); await wait(200);
  await page.screenshot({ path: 'tests/out-brushsettings.png' });
  ok('F5 abre Ajustes de pincel', (await S()).dialog?.kind === 'brushSettings' && await page.getByTestId('brush-preview').isVisible());
  await page.getByRole('button', { name: 'Dispersión', exact: true }).click();
  await page.getByLabel('Dispersión (valor)', { exact: true }).fill('300'); await page.getByLabel('Recuento (valor)', { exact: true }).fill('3'); await wait(200);
  await page.getByRole('button', { name: 'OK' }).click(); await wait(200);
  ok('Dispersión y recuento guardados en el pincel', (await S()).brush.dyn?.scatter === 3 && (await S()).brush.dyn?.count === 3);
  await brushSet({ size: 12 });
  await key('Control+a'); await key('Delete'); await key('Control+d');
  await drag([60, 300], [540, 300], 20);
  { const far = await painted({ x: 60, y: 315, w: 480, h: 30 }); ok('La dispersión lleva puntas lejos del trazo', far > 3, `fuera de la línea: ${far}`); }
  await brushSet({ dyn: undefined });
  await key('Control+a'); await key('Delete'); await key('Control+d');

  // Punta muestreada (estrella).
  await page.getByLabel('Valores preestablecidos de pincel').click();
  await page.locator('.brush-item', { hasText: 'Cuadrado' }).click(); await wait(300);
  await brushSet({ size: 80, dyn: undefined });
  await dot([300, 200]);
  { const e = await extent({ x: 240, y: 140, w: 120, h: 120 }); ok('Punta muestreada (cuadrado)', Math.abs(e.w - 64) <= 4 && Math.abs(e.h - 64) <= 4 && (await lpx(300, 200))[3] > 200, JSON.stringify(e)); }
  await key('Control+a'); await key('Delete'); await key('Control+d');

  // =========================================================== SIMETRÍA
  await page.getByLabel('Valores preestablecidos de pincel').click();
  await page.locator('.brush-item', { hasText: 'Redondo duro' }).first().click(); await wait(200);
  await brushSet({ size: 16 });
  await page.getByLabel('Simetría').selectOption('vertical'); await wait(200);
  ok('Simetría vertical: se ven los ejes', (await page.getByTestId('symmetry-axes').count()) === 1);
  await dot([100, 100]);
  ok('Simetría vertical: el trazo se refleja', (await lpx(100, 100))[3] > 200 && (await lpx(500, 100))[3] > 200, JSON.stringify([await lpx(100, 100), await lpx(500, 100)]));
  await page.getByLabel('Simetría').selectOption('radial'); await page.getByLabel('Segmentos').selectOption('6'); await wait(200);
  await key('Control+a'); await key('Delete'); await key('Control+d');
  await dot([300, 80]);
  {
    let n = 0;
    for (let k = 0; k < 6; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 3; if ((await lpx(Math.round(300 + Math.cos(a) * 120), Math.round(200 + Math.sin(a) * 120)))[3] > 200) n++; }
    ok('Simetría radial de 6: seis copias', n === 6, `${n}/6 ${JSON.stringify(await page.evaluate(() => window.__lienzoStore.getState().symmetry))}`);
  }
  await page.getByLabel('Simetría').selectOption('off'); await wait(100);
  await key('Control+a'); await key('Delete'); await key('Control+d');

  // =========================================================== PINCEL MEZCLADOR
  await call('selectShape', { x: 0, y: 0, w: 300, h: 400 }, 'rect', 'replace', 0); await call('fill', [220, 20, 20, 255]);
  await call('selectShape', { x: 300, y: 0, w: 300, h: 400 }, 'rect', 'replace', 0); await call('fill', [20, 40, 220, 255]); await call('deselect');
  await page.keyboard.press('b'); for (let i = 0; i < 3 && (await S()).tool !== 'mixer'; i++) await page.keyboard.press('Shift+b');
  ok('Mayús+B llega al pincel mezclador', (await S()).tool === 'mixer');
  await brushSet({ size: 40, mixer: { wet: 0.9, load: 0.2, mix: 0.9, loadEach: false, cleanEach: true, sampleAll: false } });
  await drag([150, 200], [450, 200], 40);
  { const c = await lpx(330, 200), f = await lpx(560, 200); ok('Mezclador: arrastra el rojo sobre el azul y se diluye', c[0] > 70 && c[0] > (await lpx(330, 120))[0] + 40 && f[2] > f[0], JSON.stringify([c, f])); }
  ok('Mezclador en el historial', (await S()).doc.history[(await S()).doc.historyIndex]?.label === 'Pincel mezclador');
  await useTool('brush');

  // =========================================================== ABR Y DEFINIR PINCEL
  await page.getByLabel('Valores preestablecidos de pincel').click();
  await page.getByTestId('abr-input').setInputFiles(['tests/fixtures/sample.abr', 'tests/fixtures/simple.abr'].slice(0, 1));
  await page.waitForFunction(() => window.__lienzoStore.getState().userBrushes.length > 0, null, { timeout: 15000 }).catch(() => {});
  ok('Importar pinceles .abr (punta muestreada)', (await S()).userBrushes?.length > 0 || (await page.evaluate(() => window.__lienzoStore.getState().userBrushes.length)) > 0);
  await page.locator('.brush-item', { hasText: 'Bobbys Brush 743' }).click(); await wait(300);
  {
    const b = (await S()).brush;
    await key('Control+a'); await key('Delete'); await key('Control+d');
    await brushSet({ size: 100 });
    await dot([300, 200]);
    const n = await painted({ x: 240, y: 140, w: 120, h: 120 });
    ok('El pincel ABR pinta con su punta', !!b.tip?.startsWith('abr:') && n > 30, `${b.tip} px=${n}`);
  }
  await key('Control+a'); await key('Delete'); await key('Control+d');
  await call('selectShape', { x: 100, y: 100, w: 40, h: 40 }, 'ellipse', 'replace', 0); await call('fill', [0, 0, 0, 255]);
  await call('selectShape', { x: 90, y: 90, w: 60, h: 60 }, 'rect', 'replace', 0);
  await menu('Edición', 'Definir valor de pincel…');
  await page.waitForFunction(() => (window.__lienzoStore.getState().brush.tip ?? '').startsWith('user:'), null, { timeout: 10000 }).catch(() => {});
  ok('Definir valor de pincel desde la selección', ((await S()).brush.tip ?? '').startsWith('user:') && (await page.evaluate(() => window.__lienzoStore.getState().userBrushes.some((b) => b.group === 'Mis pinceles'))));
  await call('deselect');

  // =========================================================== DEGRADADOS
  await newDoc(600, 200, 'white');
  await useTool('gradient');
  await page.getByLabel('Editar degradado').click();
  ok('Editor de degradado', await page.getByTestId('gradient-editor').isVisible());
  await page.screenshot({ path: 'tests/out-gradient.png' });
  await page.getByRole('button', { name: 'Espectro', exact: true }).click(); await wait(150);
  {
    const bar = await page.getByTestId('gradient-bar').boundingBox();
    const before = await page.locator('.gstop.c').count();
    await page.mouse.click(bar.x + bar.width * 0.3, bar.y + bar.height + 8); await wait(150);
    ok('Clic bajo la barra añade una parada de color', (await page.locator('.gstop.c').count()) === before + 1);
    await page.getByRole('button', { name: 'Eliminar parada' }).click(); await wait(100);
  }
  await page.getByRole('button', { name: 'OK' }).click(); await wait(200);
  ok('El degradado elegido queda en la herramienta', (await page.evaluate(() => window.__lienzoStore.getState().opts.gradient?.stops.length)) === 7);
  await drag([0, 100], [600, 100], 10);
  {
    const a = await lpx(5, 100), m = await lpx(200, 100), z = await lpx(300, 100);
    ok('Degradado de varias paradas (espectro)', a[0] > 230 && a[2] < 40 && m[1] > 200 && z[1] > 200 && z[2] > 200, JSON.stringify([a, m, z]));
  }

  // =========================================================== MOTIVOS
  await newDoc(200, 200, 'white');
  await call('selectShape', { x: 0, y: 0, w: 10, h: 10 }, 'rect', 'replace', 0); await call('fill', [255, 0, 0, 255]);
  await call('selectShape', { x: 10, y: 10, w: 10, h: 10 }, 'rect', 'replace', 0); await call('fill', [0, 0, 255, 255]);
  await call('selectShape', { x: 0, y: 0, w: 20, h: 20 }, 'rect', 'replace', 0);
  await menu('Edición', 'Definir motivo…');
  await page.waitForFunction(() => window.__lienzoStore.getState().userPatterns.length > 0, null, { timeout: 10000 }).catch(() => {});
  ok('Definir motivo', (await page.evaluate(() => window.__lienzoStore.getState().userPatterns.length)) > 0);
  await call('deselect');
  await newDoc(200, 200, 'white');
  await key('Shift+F5', 300);
  await page.locator('.modal select').first().selectOption('pattern');
  await page.getByRole('button', { name: 'OK' }).click(); await wait(400);
  ok('Rellenar con el motivo (en mosaico)', near(await lpx(45, 45), [255, 0, 0, 255], 2) && near(await lpx(55, 55), [0, 0, 255, 255], 2) && near(await lpx(55, 45), [255, 255, 255, 255], 2),
    JSON.stringify([await lpx(45, 45), await lpx(55, 55), await lpx(55, 45)]));
  await page.screenshot({ path: 'tests/out-art-pattern.png' });

  await page.screenshot({ path: 'tests/out-art.png' });
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
