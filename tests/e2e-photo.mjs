// Fase 11: fotografía (revelado, ruido, corrección de lente, desenfoques, Quitar, escalado, HDR y panorámica).
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PORT = 4178;
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', locale: 'es-ES' });
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

  // Escena: gris medio con parches de color.
  await newDoc(600, 400, 'white');
  await call('selectShape', { x: 0, y: 0, w: 600, h: 400 }, 'rect', 'replace', 0); await call('fill', [128, 128, 128, 255]);
  await call('selectShape', { x: 40, y: 40, w: 120, h: 120 }, 'rect', 'replace', 0); await call('fill', [200, 60, 50, 255]);
  await call('selectShape', { x: 440, y: 240, w: 120, h: 120 }, 'rect', 'replace', 0); await call('fill', [40, 90, 200, 255]);
  await call('deselect');

  // =========================================================== REVELADO
  await key('Control+Alt+Shift+a', 400);
  ok('Ctrl+Alt+Mayús+A abre Revelado', (await S()).dialog?.kind === 'develop');
  await page.waitForFunction(() => { const c = document.querySelector('[data-testid=develop-preview]'); return c && c.width > 10; }, null, { timeout: 15000 });
  ok('Revelado: vista previa e histograma', (await page.locator('.dv-hist').count()) === 1);
  await setSlider('Exposición', 1);
  await wait(500);
  await page.screenshot({ path: 'tests/out-develop.png' });
  const pvBright = await page.evaluate(() => { const c = document.querySelector('[data-testid=develop-preview]'); const x = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data; return [...x]; });
  ok('La vista previa refleja la exposición', pvBright[0] > 160, JSON.stringify(pvBright));
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('y'); await wait(200);
  ok('Y cambia a la vista Antes | Después', await page.getByRole('button', { name: 'Antes | Después' }).evaluate((b) => b.classList.contains('on')));
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForFunction(() => !window.__lienzoStore.getState().dialog && !window.__lienzoStore.getState().busy, null, { timeout: 30000 });
  await wait(400);
  {
    const c = await lpx(300, 200);
    ok('Exposición +1 aclara la capa', c[0] > 165 && Math.abs(c[0] - c[1]) < 3, JSON.stringify(c));
  }
  await key('Control+z', 300);
  ok('Deshacer el revelado', (await lpx(300, 200))[0] === 128);

  await develop(async () => { await setSlider('Temperatura', 60); });
  { const c = await lpx(300, 200); ok('Temperatura cálida: más rojo que azul', c[0] > c[2] + 20, JSON.stringify(c)); }
  await key('Control+z', 300);

  await develop(async () => { await page.getByRole('button', { name: 'Blanco y negro' }).click(); });
  { const c = await lpx(100, 100); ok('Blanco y negro', Math.abs(c[0] - c[1]) <= 2 && Math.abs(c[1] - c[2]) <= 2 && c[0] > 60, JSON.stringify(c)); }
  await key('Control+z', 300);

  await develop(async () => { await page.getByText('Efectos', { exact: true }).click(); await setSlider('Cantidad', -100, 0); });
  { const cc = await lpx(300, 200), co = await lpx(585, 15); ok('Viñeta oscurece las esquinas', co[0] < cc[0] - 40, JSON.stringify([cc, co])); }
  await key('Control+z', 300);

  await develop(async () => { await page.getByText('Mezclador de color', { exact: true }).click(); await page.getByRole('button', { name: 'Saturación', exact: true }).first().click(); await setSlider('Rojos', -100); });
  { const r = await lpx(100, 100), b = await lpx(500, 300); ok('Mezclador: desaturar sólo los rojos', Math.abs(r[0] - r[2]) < 25 && b[2] - b[0] > 100, JSON.stringify([r, b])); }
  await key('Control+z', 300);

  await develop(async () => { await setSlider('Contraste', 80); await setSlider('Sombras', 60); await setSlider('Claridad', 50); await setSlider('Neblina', 40); await setSlider('Intensidad', 40); });
  ok('Revelado con tono y presencia sin errores', (await S()).doc.history[(await S()).doc.historyIndex]?.label === 'Revelado');
  await key('Control+z', 300);

  // Auto.
  await key('Control+Alt+Shift+a', 400);
  await page.waitForFunction(() => { const c = document.querySelector('[data-testid=develop-preview]'); return c && c.width > 10; }, null, { timeout: 15000 });
  await wait(500);
  await page.getByRole('button', { name: 'Auto' }).click(); await wait(300);
  ok('Auto ajusta los valores', Number(await page.getByLabel('Intensidad (valor)').inputValue()) !== 0);
  await page.getByRole('button', { name: 'Cancelar' }).click(); await wait(300);

  // Reducción de ruido.
  await call('applyFilter', 'addNoise', { amount: 25, gaussian: true, monochrome: true }); await wait(400);
  ok('Ruido añadido para la prueba', (await S()).doc.history[(await S()).doc.historyIndex]?.label === 'Añadir ruido');
  const noisy = await stats({ x: 220, y: 150, w: 150, h: 100 });
  await develop(async () => { await page.getByText('Detalle', { exact: true }).click(); await setSlider('Luminancia', 100); });
  const clean = await stats({ x: 220, y: 150, w: 150, h: 100 });
  ok('Reducción de ruido de luminancia', clean.sd < noisy.sd * 0.6, `${noisy.sd.toFixed(1)} → ${clean.sd.toFixed(1)}`);
  await key('Control+z', 300); await key('Control+z', 300);

  // Objeto inteligente: queda como filtro inteligente editable.
  await call('convertToSmart'); await wait(400);
  await develop(async () => { await setSlider('Exposición', -1); });
  {
    const L = await active();
    ok('En un objeto inteligente se añade como filtro inteligente', L.kind === 'smart' && L.smart.filters.some((f) => f.name === 'cameraRaw') && (await lpx(300, 200))[0] < 100, JSON.stringify((await lpx(300, 200))));
  }
  await page.locator('.sf-name', { hasText: 'Revelado' }).first().click(); await wait(200);
  await page.getByRole('button', { name: 'Editar revelado…' }).click();
  await page.waitForFunction(() => { const c = document.querySelector('[data-testid=develop-preview]'); return c && c.width > 10; }, null, { timeout: 15000 });
  ok('Editar revelado recupera los valores', Number(await page.getByLabel('Exposición (valor)').inputValue()) === -1);
  await setSlider('Exposición', 1); await wait(500);
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForFunction(() => !window.__lienzoStore.getState().dialog && !window.__lienzoStore.getState().busy, null, { timeout: 30000 });
  await wait(800);
  ok('Editar el filtro inteligente de revelado', (await lpx(300, 200))[0] > 160, JSON.stringify(await lpx(300, 200)));

  // =========================================================== CORRECCIÓN DE LENTE, RUIDO, POLVO
  await newDoc(600, 400, 'white');
  await call('selectShape', { x: 0, y: 0, w: 600, h: 400 }, 'rect', 'replace', 0); await call('fill', [150, 150, 150, 255]); await call('deselect');
  await call('applyFilter', 'lensCorrection', { vignette: -100, vigMid: 30 }); await wait(400);
  { const c = await lpx(300, 200), k = await lpx(5, 5); ok('Corrección de lente: viñeta', k[0] < c[0] - 30 && Math.abs(c[0] - 150) < 6, JSON.stringify([c, k])); }
  await key('Control+z', 300);
  await call('selectShape', { x: 280, y: 0, w: 40, h: 400 }, 'rect', 'replace', 0); await call('fill', [0, 0, 0, 255]); await call('deselect');
  await call('applyFilter', 'lensCorrection', { distortion: -60 }); await wait(400);
  { const top = await lpx(300, 3), mid = await lpx(300, 200); ok('Corrección de lente: distorsión (las rectas se curvan)', mid[0] < 30 && top[3] === 255, JSON.stringify([top, mid])); }
  await key('Control+z', 300);
  await call('applyFilter', 'addNoise', { amount: 20, gaussian: true, monochrome: true }); await wait(300);
  const n0 = await stats({ x: 40, y: 60, w: 150, h: 100 });
  await call('applyFilter', 'reduceNoise', { strength: 10, preserve: 10, colorNoise: 50, sharpenDetails: 0 }); await wait(400);
  const n1 = await stats({ x: 40, y: 60, w: 150, h: 100 });
  ok('Filtro > Ruido > Reducir ruido', n1.sd < n0.sd * 0.6, `${n0.sd.toFixed(1)} → ${n1.sd.toFixed(1)}`);
  await key('Control+z', 300); await key('Control+z', 300);
  await call('selectShape', { x: 100, y: 100, w: 2, h: 2 }, 'rect', 'replace', 0); await call('fill', [0, 0, 0, 255]); await call('deselect');
  await call('applyFilter', 'dustScratches', { radius: 2, threshold: 20 }); await wait(400);
  ok('Polvo y rascaduras quita la mota y respeta la barra ancha', (await lpx(101, 101))[0] > 120 && (await lpx(300, 200))[0] < 30, JSON.stringify(await lpx(101, 101)));

  // =========================================================== GALERÍA DE DESENFOQUES
  await newDoc(600, 400, 'white');
  for (let x = 0; x < 600; x += 20) { await call('selectShape', { x, y: 0, w: 10, h: 400 }, 'rect', x === 0 ? 'replace' : 'add', 0); }
  await call('fill', [0, 0, 0, 255]); await call('deselect');
  await menu('Filtro', 'Galería de desenfoques', 'Cambio de inclinación…');
  await page.waitForSelector('.bg-line', { timeout: 15000 }).catch(() => {});
  ok('Galería de desenfoques: vista previa y controles', (await page.locator('.bg-line').count()) >= 2);
  await page.getByLabel('Desenfoque (valor)').fill('12'); await wait(300);
  await page.screenshot({ path: 'tests/out-blurgal.png' });
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForFunction(() => { const s = window.__lienzoStore.getState(); return !s.dialog && s.doc.history[s.doc.historyIndex]?.label === 'Galería de desenfoques'; }, null, { timeout: 30000 }).catch(() => {});
  await wait(300);
  {
    const sharp = await lpx(5, 200), blurred = await lpx(5, 10);
    ok('Cambio de inclinación: banda central nítida y bordes desenfocados', sharp[0] < 20 && blurred[0] > 70 && blurred[0] < 200 && blurred[3] === 255, JSON.stringify([sharp, blurred]));
  }
  await key('Control+z', 300);
  await menu('Filtro', 'Galería de desenfoques', 'Desenfoque de iris…');
  await page.waitForFunction(() => { const c = document.querySelector('[data-testid=blur-preview]'); return c && c.width > 10; }, null, { timeout: 15000 });
  await page.getByLabel('Desenfoque (valor)').fill('12'); await wait(300);
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForFunction(() => { const s = window.__lienzoStore.getState(); return !s.dialog && s.doc.history[s.doc.historyIndex]?.label === 'Galería de desenfoques'; }, null, { timeout: 30000 }).catch(() => {});
  ok('Desenfoque de iris: centro nítido, esquinas desenfocadas', (await lpx(305, 200))[0] < 20 && (await lpx(5, 5))[0] > 70 && (await lpx(5, 5))[3] === 255, JSON.stringify([await lpx(305, 200), await lpx(5, 5)]));

  // =========================================================== QUITAR
  await newDoc(400, 300, 'white');
  await call('selectShape', { x: 0, y: 0, w: 400, h: 300 }, 'rect', 'replace', 0); await call('fill', [70, 140, 90, 255]);
  await call('selectShape', { x: 190, y: 140, w: 20, h: 20 }, 'ellipse', 'replace', 0); await call('fill', [230, 20, 20, 255]); await call('deselect');
  await page.keyboard.press('j'); await page.keyboard.press('Shift+j'); await wait(100);
  ok('J / Mayús+J → Quitar', (await S()).tool === 'remove');
  // Un contorno alrededor del objeto basta (se rellena lo encerrado).
  {
    const pts = []; for (let a = 0; a <= Math.PI * 2 + 0.3; a += 0.3) pts.push([200 + Math.cos(a) * 26, 150 + Math.sin(a) * 26]);
    const [sx, sy] = await scr(...pts[0]);
    await page.evaluate(() => window.__lienzoStore.getState().setBrush({ size: 8 }));
    await page.mouse.move(sx, sy); await page.mouse.down();
    for (const p of pts.slice(1)) { const [x, y] = await scr(...p); await page.mouse.move(x, y, { steps: 3 }); }
    await page.mouse.up();
  }
  await page.waitForFunction(() => window.__lienzoStore.getState().doc.history.at(-1)?.label === 'Quitar' || window.__lienzoStore.getState().doc.history[window.__lienzoStore.getState().doc.historyIndex]?.label === 'Quitar', null, { timeout: 30000 }).catch(() => {});
  await wait(400);
  { const c = await lpx(200, 150); ok('Quitar: el objeto rodeado desaparece', c[0] < 140 && c[1] > 100, JSON.stringify(c)); }

  // =========================================================== TAMAÑO DE IMAGEN
  await newDoc(100, 80, 'white');
  await call('selectShape', { x: 0, y: 0, w: 50, h: 80 }, 'rect', 'replace', 0); await call('fill', [0, 0, 0, 255]); await call('deselect');
  await call('resizeImage', 400, 320, 'nearest'); await wait(400);
  ok('Tamaño de imagen por aproximación: bordes duros', (await S()).doc.width === 400 && (await lpx(199, 100))[0] === 0 && (await lpx(200, 100))[0] === 255, JSON.stringify([await lpx(199, 100), await lpx(200, 100)]));
  await key('Control+z', 300);
  await menu('Imagen', 'Tamaño de imagen…');
  await page.getByLabel('Remuestrear').selectOption('details');
  await page.locator('.modal input[type=number]').first().fill('300'); await wait(100);
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForFunction(() => window.__lienzoStore.getState().doc.width === 300, null, { timeout: 20000 }).catch(() => {});
  ok('Conservar detalles: amplía y enfoca el borde', (await S()).doc.width === 300 && (await lpx(140, 100))[0] < 20 && (await lpx(160, 100))[0] > 235, JSON.stringify([await lpx(140, 100), await lpx(160, 100)]));

  // =========================================================== PANORÁMICA, HDR, ALINEAR Y APILAR
  const fx = (n) => `tests/fixtures/${n}`;
  await menu('Archivo', 'Automatizar', 'Panorámica…');
  await page.getByTestId('auto-input').setInputFiles([fx('pano1.jpg'), fx('pano2.jpg'), fx('pano3.jpg')]);
  await page.waitForFunction(() => document.querySelectorAll('.auto-files figure').length === 3);
  await page.getByRole('button', { name: 'Crear panorámica' }).click();
  await page.waitForFunction(() => window.__lienzoStore.getState().doc.name === 'Panorámica.psd' && !window.__lienzoStore.getState().busy, null, { timeout: 120000 }).catch(() => {});
  await wait(500);
  {
    const st = await S();
    ok('Panorámica: 3 capas alineadas con máscaras', st.doc.name === 'Panorámica.psd' && st.doc.layers.length === 3 && st.doc.layers.filter((l) => l.hasMask).length === 2 && Math.abs(st.doc.width - 1500) < 60 && Math.abs(st.doc.height - 600) < 60,
      `${st.doc.width}×${st.doc.height} capas=${st.doc.layers.length}`);
    await page.screenshot({ path: 'tests/out-pano.png' });
  }
  await menu('Archivo', 'Automatizar', 'Combinar para HDR…');
  await page.getByTestId('auto-input').setInputFiles([fx('hdr1.jpg'), fx('hdr2.jpg'), fx('hdr3.jpg')]);
  await page.waitForFunction(() => document.querySelectorAll('.auto-files figure').length === 3);
  await page.getByRole('button', { name: 'Combinar' }).click();
  await page.waitForFunction(() => window.__lienzoStore.getState().doc.name === 'HDR.psd' && !window.__lienzoStore.getState().busy, null, { timeout: 120000 }).catch(() => {});
  await wait(500);
  {
    const st = await S();
    const hs = await stats({ x: 100, y: 100, w: 600, h: 300 });
    ok('Combinar para HDR: un documento fundido sin luces quemadas', st.doc.name === 'HDR.psd' && st.doc.width === 800 && hs.mean[0] > 50 && hs.mean[0] < 210, JSON.stringify(hs.mean));
  }
  // Alinear capas: una copia desplazada vuelve a su sitio.
  await page.evaluate(async (b) => { await window.__lienzo.call('open', 'pano2.jpg', new Uint8Array(b).buffer, 'image/jpeg'); }, [...(await import('node:fs')).readFileSync(fx('pano2.jpg'))]);
  await wait(400);
  await call('duplicateLayer'); await wait(200);
  await call('moveLayerBy', 24, -14); await wait(200);
  const moved = await active();
  await call('selectLayer', (await S()).doc.layers[0].id, false); await call('selectLayer', moved.id, false, 'toggle');
  await menu('Edición', 'Alinear capas automáticamente');
  await page.waitForFunction(() => window.__lienzoStore.getState().doc.history[window.__lienzoStore.getState().doc.historyIndex]?.label === 'Alinear capas automáticamente', null, { timeout: 60000 }).catch(() => {});
  {
    let diff = 0;
    for (const [x, y] of [[150, 150], [300, 300], [420, 200], [200, 450]]) {
      const a = await call('debugLayerPixel', x, y);
      await call('selectLayer', (await S()).doc.layers[0].id);
      const b = await call('debugLayerPixel', x, y);
      await call('selectLayer', moved.id);
      diff += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    }
    ok('Alinear capas automáticamente', diff / 12 < 18, `dif. media ${(diff / 12).toFixed(1)}`);
  }

  // =========================================================== RAW
  if (existsSync('tests/fixtures/sample.arw')) {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), key('Control+o', 100)]);
    await fc.setFiles('tests/fixtures/sample.arw');
    await page.waitForFunction(() => window.__lienzoStore.getState().dialog?.kind === 'develop', null, { timeout: 120000 }).catch(() => {});
    const st = await S();
    ok('Abrir un RAW (ARW) lo revela y abre Revelado', st.dialog?.kind === 'develop' && st.doc.width > 3000 && st.doc.name.endsWith('.psd'), `${st.doc.width}×${st.doc.height} ${st.doc.name}`);
    const c = await lpx(st.doc.width >> 1, st.doc.height >> 1);
    ok('El RAW revelado tiene imagen', c[3] === 255 && c[0] + c[1] + c[2] > 30, JSON.stringify(c));
    await page.getByRole('button', { name: 'Cancelar' }).click(); await wait(300);
  } else console.log('(sin tests/fixtures/sample.arw: se omite la prueba RAW)');

  await page.screenshot({ path: 'tests/out-photo.png' });
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
