// Fase 10: selección avanzada (selección rápida, de objeto, gama de colores, seleccionar y aplicar máscara) y transformaciones.
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PORT = 4177;
const URL = `http://localhost:${PORT}/app/`;
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

  // =========================================================== TRANSFORMAR: PERSPECTIVA, DISTORSIONAR, SESGAR, DEFORMAR
  const red = (c) => c[3] > 200 && c[0] > 180 && c[1] < 60;
  const clear = (c) => c[3] < 20;
  const square = async () => {
    await newDoc(600, 450, 'transparent');
    await call('selectShape', { x: 100, y: 100, w: 200, h: 200 }, 'rect', 'replace', 0);
    await call('fill', [220, 30, 30, 255]); await call('deselect');
  };
  const handleDrag = async (h, dx, dy, mods = []) => {
    const hb = await page.locator(`[data-handle=${h}]`).first().boundingBox();
    const { view } = await S();
    const x = hb.x + hb.width / 2, y = hb.y + hb.height / 2;
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx * view.zoom, y + dy * view.zoom, { steps: 8 }); await page.mouse.up();
    for (const m of mods) await page.keyboard.up(m);
    await wait(200);
  };
  const commitT = async () => { await key('Enter', 200); await page.waitForFunction(() => !window.__lienzoStore.getState().busy, null, { timeout: 20000 }).catch(() => {}); await wait(400); };

  await square();
  await menu('Edición', 'Transformar', 'Perspectiva');
  ok('Edición > Transformar > Perspectiva entra en modo perspectiva', (await S()).transform?.mode === 'perspective');
  await handleDrag('ne', 60, 0);
  await commitT();
  ok('Perspectiva: el lado superior se ensancha simétricamente y el inferior no cambia',
    red(await lpx(55, 103)) && red(await lpx(345, 103)) && clear(await lpx(55, 296)) && red(await lpx(105, 296)),
    JSON.stringify([await lpx(55, 103), await lpx(345, 103), await lpx(55, 296)]));
  { const d = (await S()).doc; ok('El historial muestra «Perspectiva»', d.history[d.historyIndex]?.label === 'Perspectiva', JSON.stringify(d.history[d.historyIndex])); }
  await key('Control+z', 400);
  ok('Deshacer la perspectiva', clear(await lpx(55, 103)) && red(await lpx(105, 103)));

  await key('Control+t', 400);
  await handleDrag('se', 80, 40, ['Control']);
  ok('Ctrl+arrastrar una esquina distorsiona (vista previa con malla)', !!(await S()).transform?.quad);
  await commitT();
  ok('Distorsionar: la esquina se desplaza libremente', red(await lpx(330, 300)) && red(await lpx(370, 330)) && clear(await lpx(330, 345)),
    JSON.stringify([await lpx(330, 300), await lpx(370, 330)]));
  await key('Control+z', 400);

  await key('Control+t', 400);
  await handleDrag('n', 80, 30, ['Control', 'Shift']);
  await commitT();
  ok('Ctrl+Mayús+arrastrar un lado sesga (el lado se desliza sobre sí mismo)', red(await lpx(360, 103)) && clear(await lpx(110, 103)) && red(await lpx(110, 296)),
    JSON.stringify([await lpx(360, 103), await lpx(110, 103), await lpx(110, 296)]));
  await key('Control+z', 400);

  await menu('Edición', 'Transformar', 'Deformar');
  ok('Edición > Transformar > Deformar muestra la malla', (await S()).transform?.mode === 'warp' && (await page.locator('.warp-grid').count()) >= 4);
  await page.getByLabel('Estilo de deformación').selectOption('arch');
  await wait(300);
  await page.screenshot({ path: 'tests/out-warp.png' });
  await commitT();
  ok('Deformar con el estilo «Arco (edificio)» levanta el centro', red(await lpx(200, 62)) && clear(await lpx(104, 62)) && red(await lpx(200, 240)) && red(await lpx(104, 285)),
    JSON.stringify([await lpx(200, 62), await lpx(104, 62), await lpx(200, 240), await lpx(104, 296), await lpx(104, 290), await lpx(110, 296)]));
  await key('Control+z', 400);

  await menu('Edición', 'Transformar', 'Deformar');
  await handleDrag('w15', 60, 60);
  await commitT();
  ok('Deformar: arrastrar una esquina de la malla la lleva consigo', red(await lpx(352, 352)) && red(await lpx(200, 200)), JSON.stringify(await lpx(352, 352)));
  await key('Control+z', 400);

  // Interior: arrastrar dentro de la malla dobla el contenido.
  await menu('Edición', 'Transformar', 'Deformar');
  {
    const [x, y] = await scr(200, 200), z = (await S()).view.zoom;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + 80 * z, { steps: 8 }); await page.mouse.up(); await wait(200);
  }
  await commitT();
  ok('Deformar: arrastrar el interior dobla la imagen', clear(await lpx(200, 104)) && red(await lpx(200, 320)) && red(await lpx(104, 104)),
    JSON.stringify([await lpx(200, 104), await lpx(200, 320), await lpx(104, 104)]));
  await key('Control+z', 400);

  // =========================================================== DEFORMACIÓN DE POSICIÓN LIBRE
  await menu('Edición', 'Deformación de posición libre');
  ok('Deformación de posición libre: barra de opciones y malla', !!(await S()).puppet || (await page.getByTestId('puppet-options').count()) === 1);
  await click([130, 130]);
  await click([270, 270]);
  ok('Clic añade chinchetas', (await page.locator('.puppet-pin').count()) === 2);
  {
    const [x, y] = await scr(270, 270), z = (await S()).view.zoom;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 70 * z, y + 70 * z, { steps: 10 }); await page.mouse.up(); await wait(300);
  }
  await page.screenshot({ path: 'tests/out-puppet.png' });
  await commitT();
  ok('Mover una chincheta deforma y la otra queda fija', red(await lpx(335, 335)) && red(await lpx(130, 130)) && red(await lpx(104, 104)) && clear(await lpx(380, 120)),
    JSON.stringify([await lpx(335, 335), await lpx(130, 130)]));
  await key('Control+z', 400);
  ok('Deshacer la deformación de posición libre', clear(await lpx(335, 335)) && red(await lpx(295, 295)));

  // Objeto inteligente: la perspectiva se guarda sin pérdida y el texto se convierte solo.
  await call('convertToSmart'); await wait(400);
  await menu('Edición', 'Transformar', 'Perspectiva');
  await handleDrag('ne', 60, 0);
  await commitT();
  {
    const L = await active();
    ok('Perspectiva en objeto inteligente (sigue siendo inteligente)', L.kind === 'smart' && red(await lpx(55, 103)), JSON.stringify({ kind: L.kind }));
  }
  await call('createText', { text: 'Hola', x: 120, y: 360, size: 60, color: [0, 0, 0, 255] }); await wait(400);
  await menu('Edición', 'Transformar', 'Distorsionar');
  await handleDrag('se', 40, 30);
  await commitT();
  ok('Distorsionar un texto lo convierte en objeto inteligente', (await active()).kind === 'smart', (await active()).kind);

  // =========================================================== RECORTAR: ENDEREZAR, GIRAR, PERSPECTIVA
  await newDoc(600, 400, 'white');
  // Banda negra inclinada 10° que pasa por el centro (un horizonte torcido).
  {
    const a = 10 * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), cx = 300, cy = 200, hl = 400, hw = 10;
    const P = (u, v) => [cx + u * c - v * sn, cy + u * sn + v * c];
    await call('selectPolygon', [P(-hl, -hw), P(hl, -hw), P(hl, hw), P(-hl, hw)], 'replace', 'Lazo');
    await call('fill', [0, 0, 0, 255]); await call('deselect');
  }
  await call('rotateArbitrary', 10); await wait(500);
  ok('Imagen > Rotación de imagen > Arbitraria agranda el lienzo', (await S()).doc.width > 600 && (await S()).doc.height > 400, `${(await S()).doc.width}×${(await S()).doc.height}`);
  await key('Control+z', 400);
  {
    const st = await S();
    const W = st.doc.width, H = st.doc.height, a = 10 * Math.PI / 180;
    await useTool('crop');
    await page.getByRole('button', { name: 'Enderezar' }).click();
    // La banda pasa por el centro con 10°: se traza sobre ella.
    const cx = W / 2, cy = H / 2, L = 200;
    await drag([cx - L * Math.cos(a), cy - L * Math.sin(a)], [cx + L * Math.cos(a), cy + L * Math.sin(a)], 10);
    const c = (await S()).crop;
    ok('Enderezar: el cuadro de recorte gira con la línea', c && Math.abs(c.angle - a) < 0.01, JSON.stringify(c));
    await page.screenshot({ path: 'tests/out-straighten.png' });
    await key('Enter', 300);
    await page.waitForFunction(() => window.__lienzoStore.getState().doc.width < 640, null, { timeout: 15000 }).catch(() => {});
    const d2 = (await S()).doc;
    // Tras enderezar, la banda queda horizontal: negro a la izquierda y a la derecha a la misma altura.
    let yl = -1, yr = -1;
    for (let y = 0; y < d2.height; y += 2) { const l = await px(30, y), r = await px(d2.width - 30, y); if (yl < 0 && l[3] > 200 && l[0] < 60) yl = y; if (yr < 0 && r[3] > 200 && r[0] < 60) yr = y; }
    ok('Enderezar deja el horizonte recto y sin esquinas vacías', yl > 0 && Math.abs(yl - yr) <= 3 && (await px(2, 2))[3] === 255 && (await px(d2.width - 3, d2.height - 3))[3] === 255, `${d2.width}×${d2.height} izq=${yl} der=${yr}`);
  }

  // Recortar con perspectiva: un cuadrilátero rojo se vuelve un rectángulo lleno.
  await newDoc(600, 400, 'white');
  await useTool('marquee');
  await call('selectPolygon', [[150, 80], [450, 120], [480, 330], [120, 300]], 'replace', 'Lazo');
  await call('fill', [200, 20, 20, 255]); await call('deselect');
  await page.keyboard.press('c'); await page.keyboard.press('Shift+c'); await wait(100);
  ok('C / Mayús+C → Recortar con perspectiva', (await S()).tool === 'perspectiveCrop');
  await drag([200, 150], [400, 250], 6);
  for (const [i, p] of [[0, [150, 80]], [1, [450, 120]], [2, [480, 330]], [3, [120, 300]]]) {
    const hb = await page.locator(`[data-handle=pc${i}]`).boundingBox();
    const [tx, ty] = await scr(...p);
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down(); await page.mouse.move(tx, ty, { steps: 6 }); await page.mouse.up();
  }
  await wait(200);
  await page.screenshot({ path: 'tests/out-pcrop.png' });
  await key('Enter', 300);
  await page.waitForFunction(() => window.__lienzoStore.getState().doc.width !== 600, null, { timeout: 15000 }).catch(() => {});
  {
    const d3 = (await S()).doc;
    const corners = [await px(3, 3), await px(d3.width - 4, 3), await px(d3.width - 4, d3.height - 4), await px(3, d3.height - 4), await px(d3.width >> 1, d3.height >> 1)];
    ok('Recortar con perspectiva endereza el plano (todo rojo, sin blanco)', d3.width > 250 && d3.height > 150 && corners.every((c) => c[0] > 150 && c[1] < 80), `${d3.width}×${d3.height} ${JSON.stringify(corners)}`);
  }
  await key('Control+z', 400);
  ok('Deshacer el recorte con perspectiva', (await S()).doc.width === 600);

  // =========================================================== MÁSCARAS VECTORIALES
  await newDoc(500, 400, 'transparent');
  await call('selectShape', { x: 0, y: 0, w: 500, h: 400 }, 'rect', 'replace', 0);
  await call('fill', [30, 90, 200, 255]); await call('deselect');
  await useTool('pen');
  for (const p of [[100, 100], [300, 100], [300, 300], [100, 300]]) await click(p);
  await click([100, 100]);
  await menu('Capa', 'Máscara vectorial', 'Trazado actual');
  await wait(300);
  {
    const L = await active();
    ok('Capa > Máscara vectorial > Trazado actual', !!L.vmask && !L.vmask.empty && (await page.getByTestId('vmask-thumb').count()) === 1, JSON.stringify(L.vmask && { ...L.vmask, svg: undefined }));
    ok('La máscara vectorial recorta la capa con borde nítido', (await px(200, 200))[3] === 255 && (await px(350, 200))[3] === 0 && (await px(101, 200))[3] > 200 && (await px(98, 200))[3] < 30,
      JSON.stringify([await px(200, 200), await px(350, 200), await px(101, 200), await px(98, 200)]));
  }
  await page.getByLabel('Calado de la máscara vectorial').fill('10'); await wait(400);
  ok('Calar la máscara vectorial suaviza el borde', (await px(100, 200))[3] > 40 && (await px(100, 200))[3] < 220, JSON.stringify(await px(100, 200)));
  await page.getByLabel('Calado de la máscara vectorial').fill('0'); await wait(300);
  await page.evaluate(() => document.activeElement?.blur());
  const h0 = (await S()).doc.historyIndex;
  await call('addMask', 'reveal'); await wait(200);
  await call('selectShape', { x: 150, y: 150, w: 60, h: 60 }, 'rect', 'replace', 0);
  await call('fill', [0, 0, 0, 255]); await call('deselect'); await wait(300);
  ok('Máscara de píxeles y vectorial se combinan', (await px(180, 180))[3] === 0 && (await px(250, 250))[3] === 255 && (await px(350, 200))[3] === 0,
    JSON.stringify([await px(180, 180), await px(250, 250)]));
  await page.evaluate(() => document.activeElement?.blur());
  for (let i = 0; i < 8 && (await S()).doc.historyIndex > h0; i++) await key('Control+z', 200);
  ok('Deshacer quita la máscara de píxeles', !(await active()).hasMask);
  // Mover la capa mueve la máscara vectorial con ella.
  await useTool('move');
  await drag([200, 200], [250, 200], 8);
  ok('La máscara vectorial se mueve con la capa', (await px(320, 200))[3] === 255 && (await px(130, 200))[3] === 0, JSON.stringify([await px(320, 200), await px(130, 200)]));
  await key('Control+z', 300);
  // Transformar (escalar con Ctrl+T) transforma también la máscara vectorial.
  await call('beginTransform'); await call('updateTransform', [0.5, 0, 0, 0.5, 0, 0]); await call('commitTransform'); await wait(400);
  ok('Transformar escala también la máscara vectorial', (await px(100, 100))[3] === 255 && (await px(160, 100))[3] === 0 && (await px(45, 100))[3] === 0 && (await px(60, 60))[3] === 255, JSON.stringify([await px(100, 100), await px(160, 100), await px(45, 100)]));
  await key('Control+z', 400);
  // Guardar y abrir PSD conserva la máscara vectorial.
  {
    const buf = await page.evaluate(async () => { const b = await window.__lienzo.call('savePsd'); return Array.from(new Uint8Array(b)); });
    await page.evaluate(async (arr) => { await window.__lienzo.call('open', 'vm.psd', new Uint8Array(arr).buffer, 'image/vnd.adobe.photoshop'); }, buf);
    await wait(600);
    const L = (await S()).doc.layers[0];
    ok('PSD: la máscara vectorial se guarda y se vuelve a abrir', !!L.vmask && (await px(200, 200))[3] === 255 && (await px(350, 200))[3] === 0, JSON.stringify({ vm: !!L.vmask, a: (await px(200, 200))[3], b: (await px(350, 200))[3] }));
  }
  await menu('Capa', 'Máscara vectorial', 'Rasterizar máscara vectorial'); await wait(300);
  ok('Rasterizar la máscara vectorial la pasa a máscara de píxeles', !(await active()).vmask && (await active()).hasMask && (await px(350, 200))[3] === 0);

  // Rotar el lienzo conserva grupos y objetos inteligentes (antes se perdían).
  await newDoc(400, 300, 'white');
  await call('newLayer'); await call('selectShape', { x: 20, y: 20, w: 50, h: 50 }, 'rect', 'replace', 0); await call('fill', [255, 0, 0, 255]); await call('deselect');
  await key('Control+g', 300);
  await call('rotateCanvas', 90); await wait(400);
  {
    const st = await S();
    const g = st.doc.layers.find((l) => l.kind === 'group');
    const inside = st.doc.layers.find((l) => l.parent === g?.id);
    ok('Rotar el lienzo 90° conserva los grupos', st.doc.width === 300 && !!g && !!inside, JSON.stringify(st.doc.layers.map((l) => [l.name, l.kind, l.parent])));
  }
  await call('resizeImage', 150, 200); await wait(400);
  {
    const st = await S();
    const g = st.doc.layers.find((l) => l.kind === 'group');
    ok('Tamaño de imagen conserva los grupos', st.doc.width === 150 && !!g && st.doc.layers.some((l) => l.parent === g.id), JSON.stringify(st.doc.layers.map((l) => [l.name, l.kind, l.parent])));
  }

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
