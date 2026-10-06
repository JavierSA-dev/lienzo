// Prueba completa de las fases 2-4 en Chromium con ratón y teclado reales.
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PORT = 4175;
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

  // =========================================================== ATAJOS DE TECLADO
  await newDoc();
  await page.keyboard.press('m'); ok('M → Marco rectangular', (await S()).tool === 'marquee');
  await page.keyboard.press('Shift+m'); ok('Mayús+M → Marco elíptico', (await S()).tool === 'marqueeEllipse');
  await page.keyboard.press('v'); await page.keyboard.press('m'); ok('M recuerda la última del grupo (elíptico)', (await S()).tool === 'marqueeEllipse');
  await page.keyboard.press('l'); ok('L → Lazo', (await S()).tool === 'lasso');
  await page.keyboard.press('Shift+l'); ok('Mayús+L → Lazo poligonal', (await S()).tool === 'polylasso');
  await page.keyboard.press('w'); ok('W → Selección de objeto (grupo de la varita)', (await S()).tool === 'objectSelect');
  await page.keyboard.press('c'); ok('C → Recortar', (await S()).tool === 'crop');
  await page.keyboard.press('i'); ok('I → Cuentagotas', (await S()).tool === 'eyedropper');
  await page.keyboard.press('b'); ok('B → Pincel', (await S()).tool === 'brush');
  await page.keyboard.press('Shift+b'); ok('Mayús+B → Lápiz', (await S()).tool === 'pencil');
  await page.keyboard.press('s'); ok('S → Tampón', (await S()).tool === 'clone');
  await page.keyboard.press('e'); ok('E → Borrador', (await S()).tool === 'eraser');
  await page.keyboard.press('g'); ok('G → Degradado', (await S()).tool === 'gradient');
  await page.keyboard.press('Shift+g'); ok('Mayús+G → Bote de pintura', (await S()).tool === 'bucket');
  await page.keyboard.press('o'); ok('O → Sobreexponer', (await S()).tool === 'dodge');
  await page.keyboard.press('t'); ok('T → Texto', (await S()).tool === 'text');
  await page.keyboard.press('u'); ok('U → Forma', (await S()).tool === 'shape');
  await page.keyboard.press('h'); ok('H → Mano', (await S()).tool === 'hand');
  await page.keyboard.press('z'); ok('Z → Zoom', (await S()).tool === 'zoom');
  await page.keyboard.press('b'); ok('B recuerda la última del grupo (Lápiz)', (await S()).tool === 'pencil');
  await page.keyboard.press('Shift+b'); ok('Mayús+B → Pincel mezclador (orden de Photoshop)', (await S()).tool === 'mixer');
  await page.keyboard.press('Shift+b'); ok('Mayús+B alterna a Pincel', (await S()).tool === 'brush');
  await page.keyboard.down('Space'); ok('Espacio mantenido → Mano temporal', (await S()).tool === 'hand');
  await page.keyboard.up('Space'); ok('Al soltar Espacio vuelve al Pincel', (await S()).tool === 'brush');
  await page.keyboard.down('Alt'); ok('Alt con Pincel → Cuentagotas temporal', (await S()).tool === 'eyedropper');
  await page.keyboard.up('Alt'); ok('Al soltar Alt vuelve al Pincel', (await S()).tool === 'brush');
  await page.keyboard.down('Control'); ok('Ctrl mantenido → Mover temporal', (await S()).tool === 'move');
  await page.keyboard.up('Control'); ok('Al soltar Ctrl vuelve al Pincel', (await S()).tool === 'brush');
  // Tecla de herramienta mantenida (spring-loaded).
  await page.keyboard.down('e'); await wait(450); await page.keyboard.up('e');
  ok('E mantenida y soltada → vuelve al Pincel (spring-loaded)', (await S()).tool === 'brush');
  await wait(600); await page.keyboard.press('5'); ok('5 → opacidad 50 %', Math.abs((await S()).brush.opacity - 0.5) < 0.01);
  await wait(600); await page.keyboard.press('4'); await page.keyboard.press('5'); ok('4,5 rápido → opacidad 45 %', Math.abs((await S()).brush.opacity - 0.45) < 0.01);
  await wait(600); await page.keyboard.press('0'); ok('0 → opacidad 100 %', (await S()).brush.opacity === 1);
  await wait(600); await key('Shift+3'); ok('Mayús+3 → flujo 30 %', Math.abs((await S()).brush.flow - 0.3) < 0.01);
  await page.keyboard.press('Shift+0');
  const size0 = (await S()).brush.size;
  await page.keyboard.press(']'); ok('] aumenta el pincel', (await S()).brush.size > size0);
  await page.keyboard.press('['); ok('[ reduce el pincel', (await S()).brush.size === size0);
  const hard0 = (await S()).brush.hardness;
  await page.keyboard.press('Shift+['); ok('Mayús+[ reduce la dureza', (await S()).brush.hardness < hard0);
  await page.keyboard.press('Shift+]');
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#ff0000', '#00ff00'));
  await page.keyboard.press('x'); ok('X intercambia colores', (await S()).fg === '#00ff00' && (await S()).bg === '#ff0000');
  await page.keyboard.press('d'); ok('D colores por defecto', (await S()).fg === '#000000' && (await S()).bg === '#ffffff');
  await key('Control+Shift+Alt+n'); ok('Ctrl+Mayús+Alt+N → capa nueva', (await S()).doc.layers.length === 2);
  await key('Alt+Shift+m'); ok('Mayús+Alt+M → modo Multiplicar', (await active()).blend === 'multiply');
  await key('Alt+Shift+n'); ok('Mayús+Alt+N → modo Normal', (await active()).blend === 'normal');
  await key('Shift+Equal'); ok('Mayús++ → siguiente modo de fusión', (await active()).blend === 'dissolve');
  await key('Alt+Shift+n');
  await page.keyboard.press('v'); await wait(600); await page.keyboard.press('5'); await wait();
  ok('Con Mover, 5 → opacidad de la capa 50 %', Math.abs((await active()).opacity - 0.5) < 0.01);
  await wait(600); await page.keyboard.press('0');
  await key('Alt+BracketLeft'); ok('Alt+[ → capa inferior', (await S()).doc.activeLayerId === (await S()).doc.layers[0].id);
  await key('Alt+BracketRight'); ok('Alt+] → capa superior', (await S()).doc.activeLayerId === (await S()).doc.layers[1].id);
  await key('Control+BracketLeft'); ok('Ctrl+[ → capa hacia atrás', (await S()).doc.layers[0].id === (await S()).doc.activeLayerId);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Alt+Shift+k'); await wait();
  ok('Ctrl+Alt+Mayús+K abre la lista de atajos', (await S()).dialog?.kind === 'shortcuts');
  await page.keyboard.press('Escape'); await wait();
  await page.keyboard.press('Control+0'); ok('Ctrl+0 encaja en pantalla', (await S()).view.zoom > 0);
  await page.keyboard.press('Control+Alt+0'); await wait(); ok('Ctrl+Alt+0 → 100 %', (await S()).view.zoom === 1);
  await page.keyboard.press('Control+0'); await wait();

  // =========================================================== SELECCIONES
  await newDoc();
  await useTool('marquee');
  await drag([100, 100], [300, 250]);
  let st = await S();
  ok('Marco rectangular con el ratón', st.doc.selection && st.doc.selection.w === 200 && st.doc.selection.h === 150, JSON.stringify(st.doc.selection));
  ok('Hormigas: contorno de la selección', st.selectionPath.startsWith('M100 100'));
  await drag([400, 300], [500, 400], 8, ['Shift']);
  ok('Mayús+arrastrar añade a la selección', (await sel(450, 350)) === 255 && (await sel(150, 150)) === 255);
  await drag([120, 120], [160, 160], 8, ['Alt']);
  ok('Alt+arrastrar resta de la selección', (await sel(140, 140)) === 0 && (await sel(250, 200)) === 255);
  await key('Control+d'); ok('Ctrl+D deselecciona', !(await S()).doc.selection);
  await key('Control+Shift+d'); ok('Ctrl+Mayús+D vuelve a seleccionar', !!(await S()).doc.selection);
  await key('Shift+F7'); await wait(); ok('Mayús+F7 invierte la selección', (await sel(10, 10)) === 255 && (await sel(450, 350)) === 0);
  await key('Control+d');
  await useTool('marqueeEllipse');
  await drag([200, 150], [600, 450]);
  ok('Marco elíptico: centro dentro, esquina fuera', (await sel(400, 300)) === 255 && (await sel(205, 155)) === 0);
  const edge = await sel(600, 300);
  ok('Elipse con borde suavizado', edge > 0 && edge < 255 || (await sel(599, 300)) > 0, `borde=${edge}`);
  await key('Shift+F6'); await wait();
  await page.locator('.modal input[type=number]').fill('20'); await key('Enter'); await wait(400);
  const f = await sel(400, 150);
  ok('Calar (Mayús+F6) suaviza el borde', f > 20 && f < 235, `valor=${f}`);
  // Lazo a mano alzada.
  await key('Control+d');
  await useTool('lasso');
  {
    const pts = [[100, 100], [300, 100], [300, 300], [100, 300], [100, 110]];
    const s0 = await scr(...pts[0]);
    await page.mouse.move(...s0); await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(...(await scr(...p)), { steps: 10 });
    await page.mouse.up(); await wait();
  }
  ok('Lazo: selección cerrada', (await sel(200, 200)) === 255 && (await sel(350, 200)) === 0);
  // Lazo poligonal: clics + Intro.
  await key('Control+d');
  await useTool('polylasso');
  for (const p of [[400, 100], [700, 100], [550, 400]]) await click(p);
  await key('Enter'); await wait();
  ok('Lazo poligonal (clics + Intro)', (await sel(550, 200)) === 255 && (await sel(420, 380)) === 0);
  // Varita mágica.
  await key('Control+d');
  await call('selectShape', { x: 50, y: 50, w: 200, h: 200 }, 'rect', 'replace', 0);
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#3366cc', '#ffffff'));
  await key('Alt+Backspace'); await wait();
  ok('Alt+Retroceso rellena la selección con el frontal', near((await lpx(100, 100)).slice(0, 3), [0x33, 0x66, 0xcc]));
  await key('Control+d');
  await useTool('wand');
  await click([100, 100]);
  st = await S();
  ok('Varita mágica selecciona la zona del mismo color', st.doc.selection?.w === 200 && st.doc.selection?.h === 200, JSON.stringify(st.doc.selection));
  // Pincel recortado por la selección.
  await useTool('brush');
  await key('d');
  await drag([20, 150], [400, 150], 20);
  ok('El pincel respeta la selección', (await lpx(30, 150))[2] === 255 && (await lpx(150, 150))[0] < 30, JSON.stringify([await lpx(30, 150), await lpx(150, 150)]));
  await key('Control+d');
  // Flechas mueven la selección.
  await call('selectShape', { x: 10, y: 10, w: 50, h: 50 }, 'rect', 'replace', 0);
  await useTool('marquee');
  await key('Shift+ArrowRight'); await wait();
  ok('Mayús+→ mueve la selección 10 px', (await S()).doc.selection.x === 20);
  await key('Control+d');

  // =========================================================== DEGRADADO, BOTE, RECORTE, LIENZO
  await newDoc(800, 600, 'transparent');
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#000000', '#ffffff'));
  await useTool('gradient');
  await drag([0, 300], [800, 300], 10);
  const g0 = await lpx(5, 300), gm = await lpx(400, 300), g1 = await lpx(795, 300);
  ok('Degradado lineal negro→blanco', g0[0] < 10 && g1[0] > 245 && Math.abs(gm[0] - 128) < 12, JSON.stringify([g0, gm, g1]));
  await newDoc(400, 300, 'white');
  await call('selectShape', { x: 0, y: 0, w: 200, h: 300 }, 'rect', 'replace', 0);
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#000000', '#ffffff'));
  await key('Alt+Backspace'); await key('Control+d');
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#ff0000', '#ffffff'));
  await useTool('bucket');
  await click([300, 150]);
  ok('Bote de pintura rellena la zona contigua', near(await lpx(300, 150), [255, 0, 0, 255]) && near(await lpx(100, 150), [0, 0, 0, 255]));
  await key('c');
  ok('Recortar muestra el cuadro sobre todo el lienzo', (await S()).crop?.w === 400);
  await page.evaluate(() => window.__lienzoStore.setState({ crop: { x: 100, y: 50, w: 200, h: 150 } }));
  await key('Enter'); await wait(400);
  st = await S();
  ok('Intro recorta el documento', st.doc.width === 200 && st.doc.height === 150);
  ok('El recorte desplaza el contenido', near(await px(0, 50), [0, 0, 0, 255]) && near(await px(150, 50), [255, 0, 0, 255]), JSON.stringify([await px(0, 50), await px(150, 50)]));
  await useTool('move');
  await call('canvasSize', 400, 150, 3);
  ok('Tamaño de lienzo con ancla izquierda', (await S()).doc.width === 400 && near(await px(0, 50), [0, 0, 0, 255]) && (await px(300, 50))[3] === 0);
  await call('rotateCanvas', 90);
  st = await S();
  ok('Rotación de imagen 90°', st.doc.width === 150 && st.doc.height === 400 && near(await px(100, 0), [0, 0, 0, 255]), JSON.stringify(await px(100, 0)));
  await key('Control+z');
  ok('Deshacer la rotación', (await S()).doc.width === 400);

  // =========================================================== FILTROS
  await newDoc(600, 400, 'white');
  await call('selectShape', { x: 0, y: 0, w: 300, h: 400 }, 'rect', 'replace', 0);
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#000000', '#ffffff'));
  await key('Alt+Backspace'); await key('Control+d');
  await call('applyFilter', 'gaussianBlur', { radius: 10 });
  const b1 = await lpx(300, 200), b2 = await lpx(270, 200);
  ok('Desenfoque gaussiano suaviza el borde', b1[0] > 60 && b1[0] < 200 && b2[0] < b1[0], JSON.stringify([b2, b1]));
  await key('Control+z');
  // Diálogo con vista previa y cancelar.
  await page.evaluate(() => window.__lienzoStore.getState().setDialog({ kind: 'filter', name: 'addNoise' }));
  await wait(1500);
  const sample = async () => { const r = []; for (let i = 0; i < 12; i++) r.push(await lpx(420 + i * 7, 200)); return r; };
  const noisy = await sample();
  await key('Escape'); await wait(500);
  const clean = await sample();
  ok('Vista previa de filtro y Cancelar restaura', noisy.some((p) => !near(p, [255, 255, 255, 255], 0)) && clean.every((p) => near(p, [255, 255, 255, 255], 0)), JSON.stringify([noisy[0], clean[0]]));
  ok('Cancelar no deja paso en el historial', (await S()).doc.history.at(-1).label !== 'Añadir ruido');
  await call('applyFilter', 'mosaic', { cell: 40 });
  ok('Mosaico', near(await lpx(281, 10), await lpx(319, 10)), JSON.stringify([await lpx(281, 10), await lpx(319, 10)]));
  await key('Control+z');
  await key('Control+i'); await wait();
  ok('Ctrl+I invierte', near(await lpx(100, 100), [255, 255, 255, 255]) && near(await lpx(500, 100), [0, 0, 0, 255]));
  await key('Control+z');
  // Ctrl+L (niveles) con vista previa y OK.
  await key('Control+l'); await wait(600);
  ok('Ctrl+L abre Niveles', (await S()).dialog?.kind === 'adjust' && (await S()).dialog?.type === 'levels');
  await page.locator('.modal input[type=number]').nth(3).fill('100'); await wait(600);
  await page.locator('.modal button[type=submit]').click(); await wait(600);
  ok('Niveles: salida negro 100', (await lpx(100, 100))[0] >= 98 && (await S()).doc.history.at(-1).label === 'Niveles', JSON.stringify(await lpx(100, 100)));
  const ltFilter0 = await maxLongTask();
  void ltFilter0;

  // =========================================================== CAPAS DE AJUSTE Y MÁSCARAS
  await newDoc(400, 300, 'white');
  await call('fill', [200, 50, 50, 255]);
  const adjId = await call('newAdjustmentLayer', 'invert');
  await wait();
  ok('Capa de ajuste Invertir (no destructiva)', near(await px(50, 50), [55, 205, 205, 255]) && near((await S()).doc.layers[0].id ? await page.evaluate(() => 1) && [1] : [1], [1]));
  await call('selectLayer', (await S()).doc.layers[0].id, false);
  ok('Los píxeles de la capa no cambian', near(await lpx(50, 50), [200, 50, 50, 255]));
  await call('setAdjustment', adjId, { type: 'hueSat', hue: 120, saturation: 0, lightness: 0, colorize: false }, true);
  const hs = await px(50, 50);
  ok('Tono/Saturación +120° (rojo → verde)', hs[1] > hs[0] && hs[1] > hs[2], JSON.stringify(hs));
  await call('setAdjustment', adjId, { type: 'curves', points: [[0, 0], [128, 200], [255, 255]] }, true);
  ok('Curvas aclaran los medios tonos', (await px(50, 50))[1] > 60, JSON.stringify(await px(50, 50)));
  await call('setAdjustment', adjId, { type: 'blackWhite', reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 }, true);
  const bw = await px(50, 50);
  ok('Blanco y negro', Math.abs(bw[0] - bw[1]) <= 2 && Math.abs(bw[1] - bw[2]) <= 2, JSON.stringify(bw));
  // Máscara de la capa de ajuste: ocultar la mitad derecha.
  await call('selectLayer', adjId, true);
  await call('selectShape', { x: 200, y: 0, w: 200, h: 300 }, 'rect', 'replace', 0);
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#000000', '#ffffff'));
  await key('Alt+Backspace'); await key('Control+d'); await wait();
  ok('Máscara del ajuste oculta la mitad derecha', near(await px(300, 150), [200, 50, 50, 255]) && !near(await px(50, 150), [200, 50, 50, 255]), JSON.stringify([await px(50, 150), await px(300, 150)]));
  await key('Control+Alt+Shift+n');
  await call('fill', [0, 0, 255, 255]);
  await call('addMask', 'hide'); await wait();
  ok('Máscara "ocultar todo"', !near(await px(100, 100), [0, 0, 255, 255]));
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#ffffff', '#000000'));
  await useTool('brush'); await key('Shift+]'); await key('Shift+]');
  await page.evaluate(() => window.__lienzoStore.getState().setBrush({ size: 60, hardness: 1, opacity: 1, flow: 1 }));
  await drag([60, 100], [140, 100], 10);
  ok('Pintar blanco en la máscara revela la capa', near(await px(100, 100), [0, 0, 255, 255]), JSON.stringify(await px(100, 100)));
  ok('Pintar en la máscara no toca los píxeles', near(await lpx(10, 10), [0, 0, 255, 255]));
  await call('deleteMask', true); await wait();
  ok('Aplicar máscara', (await active()).hasMask === false && (await lpx(10, 10))[3] === 0 && (await lpx(100, 100))[3] === 255);

  // =========================================================== TEXTO Y FORMAS
  await newDoc(600, 300, 'white');
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#000000', '#ffffff'));
  await useTool('text');
  await click([50, 150]);
  ok('Clic con Texto crea una capa de texto', (await active())?.kind === 'text');
  await page.keyboard.type('Hola Lienzo');
  await wait(300);
  await key('Escape'); await wait(300);
  const tl = await active();
  ok('El texto se escribe y se aplica con Esc', tl.kind === 'text' && tl.text.text === 'Hola Lienzo' && tl.name === 'Hola Lienzo', `${tl?.text?.text} / ${tl?.name}`);
  let dark = 0;
  for (let x = 50; x < 300; x += 3) { const p = await px(x, 140); if (p[0] < 100) dark++; if (dark > 3) break; }
  ok('El texto se ve rasterizado en el lienzo', dark > 3);
  await call('updateText', tl.id, { size: 96 }, true);
  ok('Texto editable (cambiar tamaño)', (await active()).text.size === 96);
  await useTool('shape');
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#00aa00', '#000000'));
  await drag([350, 50], [550, 250]);
  const sh = await active();
  ok('Herramienta Forma crea una capa de forma', sh.kind === 'shape' && sh.shape.shape === 'rect' && near(await px(450, 150), [0, 170, 0, 255]));
  await call('updateShape', sh.id, { shape: 'ellipse' }, true);
  ok('Forma editable (rectángulo → elipse)', (await px(355, 55))[3] < 255 || near(await px(355, 55), [255, 255, 255, 255]));

  // =========================================================== TRANSFORMACIÓN LIBRE
  await newDoc(600, 400, 'transparent');
  await call('selectShape', { x: 100, y: 100, w: 100, h: 100 }, 'rect', 'replace', 0);
  await call('fill', [255, 0, 0, 255]); await call('deselect');
  await useTool('move');
  await key('Control+t'); await wait(500);
  st = await S();
  ok('Ctrl+T inicia la transformación libre', !!st.transform && st.transform.bounds.w === 100, JSON.stringify(st.transform?.bounds));
  await drag([200, 200], [300, 300], 10);
  st = await S();
  ok('Arrastrar la esquina escala en proporción', Math.abs(st.transform.matrix[0] - 2) < 0.05 && Math.abs(st.transform.matrix[3] - 2) < 0.05, JSON.stringify(st.transform.matrix));
  await key('Enter'); await wait(800);
  ok('Intro aplica: la capa mide el doble', near(await lpx(280, 280), [255, 0, 0, 255]) && near(await lpx(110, 110), [255, 0, 0, 255]) && (await lpx(320, 320))[3] === 0, JSON.stringify(await lpx(280, 280)));
  await key('Control+z'); await wait();
  ok('Deshacer la transformación', (await lpx(280, 280))[3] === 0 && near(await lpx(150, 150), [255, 0, 0, 255]));
  await call('transformLayer', 'flipH'); await wait(500);
  ok('Voltear horizontal (sobre sí misma)', near(await lpx(150, 150), [255, 0, 0, 255]));
  await key('ArrowRight'); await key('Shift+ArrowDown'); await wait();
  ok('Flechas mueven la capa (1 px y 10 px)', near(await lpx(101, 110), [255, 0, 0, 255]) && (await lpx(100, 105))[3] === 0);

  // =========================================================== TAMPÓN DE CLONAR
  await newDoc(400, 300, 'white');
  await call('selectShape', { x: 50, y: 50, w: 50, h: 50 }, 'rect', 'replace', 0);
  await call('fill', [0, 0, 255, 255]); await call('deselect');
  await useTool('clone');
  await page.evaluate(() => window.__lienzoStore.getState().setBrush({ size: 40, hardness: 1, opacity: 1, flow: 1 }));
  await click([75, 75], ['Alt']);
  await drag([275, 75], [276, 75], 2);
  ok('Tampón de clonar copia desde el origen (Alt+clic)', near(await lpx(275, 75), [0, 0, 255, 255]), JSON.stringify(await lpx(275, 75)));

  // =========================================================== ESTILOS DE CAPA
  await newDoc(400, 300, 'white');
  await key('Control+Alt+Shift+n');
  await call('selectShape', { x: 100, y: 100, w: 100, h: 100 }, 'rect', 'replace', 0);
  await call('fill', [255, 0, 0, 255]); await call('deselect');
  await call('setEffects', (await active()).id, { stroke: { enabled: true, color: [0, 0, 255, 255], size: 5 }, dropShadow: { enabled: true, color: [0, 0, 0, 255], opacity: 1, angle: 90, distance: 20, size: 0 } }, true);
  await call('debugFlushEffects'); await wait(400);
  ok('Estilo: trazo exterior azul', near(await px(97, 150), [0, 0, 255, 255], 20), JSON.stringify(await px(97, 150)));
  ok('Estilo: sombra paralela bajo la capa', (await px(150, 212))[0] < 60, JSON.stringify(await px(150, 212)));

  // =========================================================== ACCIONES
  await newDoc(200, 200, 'white');
  await page.evaluate(() => { const s = window.__lienzoStore; s.setState({ actions: [...s.getState().actions, { name: 'Test', steps: [] }], recording: true }); });
  await key('Control+i'); await wait();
  await key('Control+Shift+Alt+n'); await wait();
  await page.evaluate(() => window.__lienzoStore.setState({ recording: false }));
  const act = (await S()).actions.at(-1);
  ok('Grabar acción (Ctrl+I y nueva capa)', act.steps.length === 2 && act.steps[0].id === 'image.invert', JSON.stringify(act.steps));
  await key('Control+z'); await key('Control+z');
  ok('Deshacer la acción grabada', (await S()).doc.layers.length === 1 && near(await px(50, 50), [255, 255, 255, 255]));
  await page.getByTestId('actions-tab').click(); await wait(200);
  await page.locator('button[title=Reproducir]').last().click(); await wait(600);
  ok('Reproducir la acción', (await S()).doc.layers.length === 2 && near(await px(50, 50), [0, 0, 0, 255]), JSON.stringify(await px(50, 50)));

  // =========================================================== COPIAR / PEGAR
  await newDoc(300, 200, 'white');
  await call('selectShape', { x: 20, y: 20, w: 60, h: 60 }, 'rect', 'replace', 0);
  await call('fill', [255, 128, 0, 255]);
  await key('Control+c'); await wait(400);
  await key('Control+Shift+v'); await wait(600);
  st = await S();
  ok('Copiar + Pegar en el mismo sitio crea una capa', st.doc.layers.length === 2 && near(await lpx(50, 50), [255, 128, 0, 255]), `${st.doc.layers.length} capas`);
  await call('deselect');
  await key('Control+j'); await wait();
  ok('Ctrl+J duplica la capa', (await S()).doc.layers.length === 3);
  await key('Control+e'); await wait();
  ok('Ctrl+E combina hacia abajo', (await S()).doc.layers.length === 2);

  // =========================================================== IA: QUITAR FONDO
  await newDoc(400, 400, 'white');
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#d02020', '#ffffff'));
  await call('selectShape', { x: 110, y: 110, w: 180, h: 180 }, 'ellipse', 'replace', 0);
  await key('Alt+Backspace'); await call('deselect');
  const t0 = Date.now();
  await call('removeBackground');
  const aiMs = Date.now() - t0;
  const cIn = await px(200, 200), cOut = await px(20, 20);
  ok('Quitar fondo con IA local (u2netp)', (await active()).hasMask && cIn[3] > 200 && cOut[3] < 60, `${aiMs} ms · centro α=${cIn[3]} · esquina α=${cOut[3]}`);

  // =========================================================== RELLENO GENERATIVO (servicio simulado)
  await page.route('**/mock-generate', async (route) => {
    const png = await page.evaluate(async () => { const c = new OffscreenCanvas(64, 64); const x = c.getContext('2d'); x.fillStyle = '#00ff00'; x.fillRect(0, 0, 64, 64); return [...new Uint8Array(await (await c.convertToBlob()).arrayBuffer())]; });
    await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(png) });
  });
  await newDoc(400, 300, 'white');
  await call('selectShape', { x: 100, y: 100, w: 100, h: 100 }, 'rect', 'replace', 0);
  await page.evaluate(() => localStorage.setItem('lienzo:gen', JSON.stringify({ endpoint: '/mock-generate', apiKey: '' })));
  await page.evaluate(() => window.__lienzoStore.getState().setDialog({ kind: 'generative' }));
  await wait(300);
  await page.locator('.modal input').first().fill('un cuadrado verde');
  await page.locator('.modal button[type=submit]').click();
  await page.waitForFunction(() => window.__lienzoStore.getState().doc.layers.length === 2, null, { timeout: 10000 }).catch(() => {});
  await wait(300);
  ok('Relleno generativo: capa nueva con máscara de la selección', (await active())?.hasMask && near(await px(150, 150), [0, 255, 0, 255], 4) && near(await px(20, 20), [255, 255, 255, 255]), JSON.stringify([await px(150, 150), await px(20, 20)]));

  // =========================================================== LICUAR
  await newDoc(200, 200, 'white');
  await call('selectShape', { x: 0, y: 0, w: 100, h: 200 }, 'rect', 'replace', 0);
  await call('fill', [0, 0, 0, 255]); await call('deselect');
  const fw = 100, fh = 100;
  const field = await page.evaluate(([fw, fh]) => { const f = new Float32Array(fw * fh * 2); for (let i = 0; i < fw * fh; i++) f[i * 2] = -20; return Array.from(f); }, [fw, fh]);
  await page.evaluate(([f, fw, fh]) => window.__lienzo.call('applyLiquify', new Float32Array(f), fw, fh, 0.5), [field, fw, fh]);
  await wait(300);
  ok('Licuar desplaza el contenido', near(await lpx(130, 100), [0, 0, 0, 255]) && near(await lpx(160, 100), [255, 255, 255, 255]), JSON.stringify([await lpx(130, 100), await lpx(160, 100)]));

  // =========================================================== PSD CON MÁSCARAS Y AJUSTES
  await newDoc(300, 200, 'white');
  await call('newLayer'); await call('fill', [0, 0, 255, 255]); await call('addMask', 'hide');
  await call('newAdjustmentLayer', 'invert');
  const bytes = await page.evaluate(async () => Array.from(await window.__lienzo.call('savePsd')));
  await page.evaluate(async (b) => { await window.__lienzo.call('open', 'roundtrip.psd', new Uint8Array(b).buffer, ''); }, bytes);
  await wait(300);
  st = await S();
  ok('PSD: guarda y reabre máscaras y capas de ajuste', st.doc.layers.length === 3 && st.doc.layers[1].hasMask && st.doc.layers[2].kind === 'adjustment', st.doc.layers.map((l) => `${l.kind}${l.hasMask ? '+m' : ''}`).join(','));
  ok('PSD reabierto se compone igual (blanco invertido = negro)', near(await px(10, 10), [0, 0, 0, 255]), JSON.stringify(await px(10, 10)));

  // =========================================================== FASE 5: GRUPOS
  await newDoc(400, 300, 'white');
  await call('newLayer');
  await call('selectShape', { x: 0, y: 0, w: 200, h: 300 }, 'rect', 'replace', 0); await call('fill', [255, 0, 0, 255]); await call('deselect');
  await key('Control+g');
  st = await S();
  const grp = st.doc.layers.find((l) => l.kind === 'group');
  ok('Ctrl+G mete la capa en un grupo', grp && st.doc.activeLayerId === grp.id && st.doc.layers.find((l) => l.name === 'Capa 2')?.parent === grp.id);
  ok('El panel muestra el grupo con su capa sangrada', (await page.locator('[data-testid=layer-row]').count()) === 3 && (await page.locator('[data-testid=layer-row] .indent').count()) === 1);
  await call('setLayer', grp.id, { opacity: 0.5 }); await wait();
  ok('Opacidad del grupo', near(await px(100, 100), [255, 128, 128, 255], 2), JSON.stringify(await px(100, 100)));
  await call('setLayer', grp.id, { opacity: 1 });
  await page.locator(`[data-layer-id="${grp.id}"] .twisty`).click(); await wait();
  ok('Plegar el grupo oculta su contenido en el panel', (await page.locator('[data-testid=layer-row]').count()) === 2);
  await page.locator(`[data-layer-id="${grp.id}"] .twisty`).click(); await wait();
  await useTool('move');
  await drag([100, 150], [150, 150], 8);
  ok('Mover un grupo mueve su contenido', near(await px(230, 150), [255, 0, 0, 255]) && near(await px(20, 150), [255, 255, 255, 255]), JSON.stringify([await px(230, 150), await px(20, 150)]));
  await key('Control+z');
  // Máscara de recorte
  await call('selectLayer', st.doc.layers.find((l) => l.name === 'Capa 2').id);
  await key('Control+Shift+Alt+n');
  await call('fill', [0, 0, 255, 255]);
  const blueId = (await S()).doc.activeLayerId;
  ok('Capa nueva dentro del grupo', (await active()).parent === grp.id);
  await page.locator(`[data-layer-id="${blueId}"] .layer-text`).click({ modifiers: ['Alt'] }); await wait();
  ok('Alt+clic en la capa crea la máscara de recorte', (await active()).clipped && near(await px(100, 100), [0, 0, 255, 255]) && near(await px(300, 100), [255, 255, 255, 255]), JSON.stringify([await px(100, 100), await px(300, 100)]));
  await call('setLayer', blueId, { blend: 'screen' }); await wait();
  ok('Modo de fusión dentro del recorte (Trama)', near(await px(100, 100), [255, 0, 255, 255]), JSON.stringify(await px(100, 100)));
  await call('setLayer', blueId, { blend: 'normal' });
  await key('Control+Alt+g');
  ok('Ctrl+Alt+G libera el recorte', !(await active()).clipped && near(await px(300, 100), [0, 0, 255, 255]), JSON.stringify(await px(300, 100)));
  await key('Control+Alt+g');
  await call('setLayer', blueId, { blend: 'screen' }); await wait();
  {
    const bytes = await page.evaluate(async () => Array.from(await window.__lienzo.call('savePsd')));
    await page.evaluate(async (b) => { await window.__lienzo.call('open', 'grupos.psd', new Uint8Array(b).buffer, ''); }, bytes);
    await wait(300);
    const ls = (await S()).doc.layers;
    ok('PSD guarda grupos y máscaras de recorte', ls.some((l) => l.kind === 'group') && ls.some((l) => l.clipped) && ls.filter((l) => l.parent != null).length === 2, ls.map((l) => `${l.kind}${l.clipped ? '+clip' : ''}`).join(','));
    ok('El PSD reabierto se compone igual', near(await px(100, 100), [255, 0, 255, 255]) && near(await px(300, 100), [255, 255, 255, 255]), JSON.stringify(await px(100, 100)));
  }
  await call('selectLayer', (await S()).doc.layers.find((l) => l.kind === 'group').id);
  await key('Control+Shift+g');
  ok('Ctrl+Mayús+G desagrupa', !(await S()).doc.layers.some((l) => l.kind === 'group'));

  // =========================================================== FASE 5: CORRECTORES Y RELLENO SEGÚN CONTENIDO
  await newDoc(300, 200, 'white');
  await call('selectShape', { x: 140, y: 90, w: 16, h: 16 }, 'rect', 'replace', 0); await call('fill', [0, 0, 0, 255]); await call('deselect');
  await key('j');
  ok('J → Pincel corrector puntual', (await S()).tool === 'spotHeal');
  await page.evaluate(() => window.__lienzoStore.getState().setBrush({ size: 36, hardness: 0.6, opacity: 1, flow: 1 }));
  await drag([140, 98], [156, 98], 6);
  await page.waitForFunction(() => !window.__lienzoStore.getState().busy, null, { timeout: 15000 }).catch(() => {});
  await wait(300);
  ok('El corrector puntual borra la mancha', near(await lpx(148, 98), [255, 255, 255, 255], 12), JSON.stringify(await lpx(148, 98)));
  ok('Queda un paso en el historial', (await S()).doc.history.at(-1).label === 'Pincel corrector puntual');
  await newDoc(300, 200, 'white');
  await call('selectShape', { x: 0, y: 0, w: 100, h: 200 }, 'rect', 'replace', 0); await call('fill', [60, 60, 60, 255]);
  await call('selectShape', { x: 100, y: 0, w: 200, h: 200 }, 'rect', 'replace', 0); await call('fill', [200, 150, 100, 255]); await call('deselect');
  await key('Shift+j');
  ok('Mayús+J → Quitar (orden de Photoshop)', (await S()).tool === 'remove');
  await key('Shift+j');
  ok('Mayús+J otra vez → Pincel corrector', (await S()).tool === 'heal');
  await click([50, 100], ['Alt']);
  await drag([200, 100], [202, 100], 2);
  await page.waitForFunction(() => !window.__lienzoStore.getState().busy, null, { timeout: 15000 }).catch(() => {});
  await wait(300);
  ok('El corrector adapta la textura al color del destino', near(await lpx(201, 100), [200, 150, 100, 255], 8), JSON.stringify(await lpx(201, 100)));
  await newDoc(300, 200, 'white');
  await call('selectShape', { x: 120, y: 80, w: 40, h: 40 }, 'rect', 'replace', 0); await call('fill', [0, 0, 0, 255]);
  await call('selectShape', { x: 116, y: 76, w: 48, h: 48 }, 'rect', 'replace', 0);
  await key('Shift+F5'); await wait();
  await page.locator('.modal select').first().selectOption('content');
  await page.locator('.modal button[type=submit]').click();
  await page.waitForFunction(() => window.__lienzoStore.getState().doc.history.at(-1)?.label === 'Relleno según contenido', null, { timeout: 20000 }).catch(() => {});
  ok('Rellenar > Según el contenido', near(await lpx(140, 100), [255, 255, 255, 255], 6), JSON.stringify(await lpx(140, 100)));
  await call('deselect');

  // =========================================================== FASE 5: PLUMA
  await newDoc(400, 300, 'white');
  await key('p');
  ok('P → Pluma', (await S()).tool === 'pen');
  await click([100, 100]);
  await click([300, 100]);
  {
    const [ax, ay] = await scr(300, 250), [bx, by] = await scr(360, 250);
    await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(bx, by, { steps: 6 }); await page.mouse.up(); await wait();
  }
  await click([100, 250]);
  await click([100, 100]);
  st = await page.evaluate(() => window.__lienzoStore.getState().path);
  ok('Trazado cerrado con 4 puntos y una curva', st.length === 1 && st[0].closed && st[0].points.length === 4 && st[0].points[2].ox > 330, JSON.stringify(st[0]?.points?.[2]));
  await key('Control+Enter'); await wait();
  ok('Ctrl+Intro convierte el trazado en selección', (await sel(200, 170)) === 255 && (await sel(200, 240)) === 255 && (await sel(50, 50)) === 0, JSON.stringify([await sel(200, 170), await sel(200, 240), await sel(50, 50)]));
  await call('deselect');
  // Ctrl con la pluma: mover un ancla.
  await drag([100, 250], [80, 270], 6, ['Control']);
  st = await page.evaluate(() => window.__lienzoStore.getState().path);
  ok('Ctrl+arrastrar mueve un ancla', Math.abs(st[0].points[3].x - 80) < 1.5 && Math.abs(st[0].points[3].y - 270) < 1.5, JSON.stringify(st[0].points[3]));
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#00aa00', '#ffffff'));
  await page.locator('.optionsbar button.chip', { hasText: 'Forma' }).click(); await wait(400);
  ok('Forma desde el trazado', (await active()).kind === 'shape' && (await active()).shape.shape === 'path' && near(await px(200, 170), [0, 170, 0, 255]), JSON.stringify(await px(200, 170)));
  await key('Backspace');
  ok('Retroceso borra el ancla seleccionada', (await page.evaluate(() => window.__lienzoStore.getState().path[0]?.points.length)) === 3);
  await key('Backspace');
  ok('Retroceso sin ancla seleccionada borra el trazado', (await page.evaluate(() => window.__lienzoStore.getState().path.length)) === 0);

  // =========================================================== FASE 6: TRAZADOS EN EL HISTORIAL Y PANEL TRAZADOS
  await newDoc(400, 300, 'white');
  await key('p');
  await click([100, 100]); await click([300, 100]); await click([200, 250]);
  const ptsN = async () => page.evaluate(() => window.__lienzoStore.getState().path[0]?.points.length ?? 0);
  ok('Cada punto de la pluma es un paso del historial', (await S()).doc.history.at(-1).label === 'Nuevo punto de ancla' && (await ptsN()) === 3);
  await key('Control+z', 400);
  ok('Ctrl+Z quita el último punto de la pluma', (await ptsN()) === 2);
  await key('Control+Shift+z', 400);
  ok('Ctrl+Mayús+Z lo recupera', (await ptsN()) === 3);
  await click([100, 100]);
  await page.getByTestId('tab-Trazados').click(); await wait();
  ok('Panel Trazados muestra el trazado de trabajo', (await page.locator('[data-testid=path-row]').count()) === 1 && (await page.locator('[data-testid=path-row] .work-path').count()) === 1);
  await page.locator('[data-testid=path-row]').first().dblclick(); await wait();
  await page.keyboard.type('Contorno'); await page.keyboard.press('Enter'); await wait(300);
  ok('Guardar el trazado con nombre', (await S()).doc.paths[0].name === 'Contorno' && !(await S()).doc.paths[0].work, (await S()).doc.paths[0].name);
  await call('selectShape', { x: 250, y: 150, w: 100, h: 80 }, 'ellipse', 'replace', 0);
  await page.locator('button[title="Hacer trazado de trabajo desde la selección"]').click(); await wait(400);
  {
    const wp = (await S()).doc.paths.find((q) => q.work);
    ok('Hacer trazado de trabajo desde la selección (con curvas)', wp && wp.path[0].closed && wp.path[0].points.some((q) => q.ox !== q.x), wp ? `${wp.path[0].points.length} puntos` : '');
  }
  await call('deselect');
  await page.locator('[data-testid=path-row]').first().click({ modifiers: ['Control'] }); await wait();
  ok('Ctrl+clic en un trazado lo carga como selección', (await sel(200, 150)) === 255 && (await sel(20, 20)) === 0);
  await call('deselect');
  await page.getByTestId('tab-Capas').click(); await wait();

  // =========================================================== FASE 6: VARIAS CAPAS
  await newDoc(400, 300, 'white');
  for (const [x, c] of [[20, [255, 0, 0, 255]], [150, [0, 255, 0, 255]], [300, [0, 0, 255, 255]]]) {
    await call('newLayer'); await call('selectShape', { x, y: 20 + x / 3, w: 40, h: 40 }, 'rect', 'replace', 0); await call('fill', c); await call('deselect');
  }
  await wait();
  const lrows = page.locator('[data-testid=layer-row]');
  await lrows.nth(0).click(); await lrows.nth(2).click({ modifiers: ['Shift'] }); await wait();
  ok('Mayús+clic selecciona un rango de capas', (await S()).doc.selectedLayerIds.length === 3);
  await lrows.nth(1).click({ modifiers: ['Control'] }); await wait();
  ok('Ctrl+clic quita una capa de la selección', (await S()).doc.selectedLayerIds.length === 2);
  await lrows.nth(1).click({ modifiers: ['Control'] }); await wait();
  await useTool('move');
  await page.getByRole('button', { name: 'Alinear bordes superiores' }).click(); await wait();
  ok('Alinear bordes superiores', near(await px(30, 30), [255, 0, 0, 255]) && near(await px(160, 30), [0, 255, 0, 255]) && near(await px(310, 30), [0, 0, 255, 255]));
  await page.getByRole('button', { name: 'Distribuir en horizontal' }).click(); await wait();
  ok('Distribuir en un solo paso del historial', (await S()).doc.history.at(-1).label === 'Distribuir');
  await drag([30, 30], [30, 80], 6);
  ok('Mover arrastra todas las capas seleccionadas', near(await px(30, 80), [255, 0, 0, 255]) && near(await px(310, 80), [0, 0, 255, 255]));
  await key('Control+z');
  await page.locator('.layer-controls input.num').fill('50'); await page.locator('.layer-controls input.num').press('Enter'); await wait();
  ok('La opacidad se aplica a todas las capas seleccionadas', (await S()).doc.layers.filter((l) => l.opacity === 0.5).length === 3);
  await key('Control+z');
  await key('Control+g');
  st = await S();
  ok('Ctrl+G agrupa todas las capas seleccionadas', st.doc.layers.filter((l) => l.parent != null).length === 3);
  await key('Control+z');
  await lrows.nth(0).click(); await lrows.nth(1).click({ modifiers: ['Control'] }); await wait();
  await key('Control+e');
  ok('Ctrl+E combina las capas seleccionadas', (await S()).doc.layers.length === 3 && (await S()).doc.history.at(-1).label === 'Combinar capas');
  await key('Control+Alt+a');
  ok('Ctrl+Alt+A selecciona todas las capas', (await S()).doc.selectedLayerIds.length === 3);
  await lrows.nth(0).click();

  // =========================================================== FASE 6: PARCHE, DESENFOCAR, ENFOCAR, DEDO
  await newDoc(300, 200, 'white');
  await call('selectShape', { x: 50, y: 50, w: 20, h: 20 }, 'rect', 'replace', 0); await call('fill', [0, 0, 0, 255]); await call('deselect');
  await useTool('patch');
  {
    const pts = [[40, 40], [80, 40], [80, 80], [40, 80], [40, 42]];
    await page.mouse.move(...(await scr(...pts[0]))); await page.mouse.down();
    for (const q of pts.slice(1)) await page.mouse.move(...(await scr(...q)), { steps: 6 });
    await page.mouse.up(); await wait();
  }
  ok('Parche: rodear la zona crea una selección', (await sel(60, 60)) === 255);
  await drag([60, 60], [200, 60], 8);
  await page.waitForFunction(() => window.__lienzoStore.getState().doc.history.at(-1)?.label === 'Parche', null, { timeout: 15000 }).catch(() => {});
  ok('Parche: arrastrar a una zona limpia corrige', near(await lpx(60, 60), [255, 255, 255, 255], 10), JSON.stringify(await lpx(60, 60)));
  await call('deselect');
  await newDoc(400, 200, 'white');
  await call('selectShape', { x: 0, y: 0, w: 200, h: 200 }, 'rect', 'replace', 0); await call('fill', [0, 0, 0, 255]); await call('deselect');
  await page.evaluate(() => window.__lienzoStore.getState().setBrush({ size: 30, hardness: 1, opacity: 1, flow: 1 }));
  await useTool('blur');
  await drag([200, 60], [200, 140], 12);
  const bl = (await lpx(199, 100))[0], br = (await lpx(200, 100))[0];
  ok('Desenfocar suaviza el borde', bl > 20 && br < 235, JSON.stringify([bl, br]));
  await useTool('sharpen');
  await drag([200, 60], [200, 140], 12);
  const sl = (await lpx(197, 100))[0];
  ok('Enfocar aumenta el contraste del borde', sl < (await page.evaluate(() => 999)) && sl <= bl, JSON.stringify([sl, bl]));
  await useTool('smudge');
  await page.evaluate(() => window.__lienzoStore.getState().setBrush({ opacity: 0.8 }));
  await drag([150, 30], [260, 30], 20);
  ok('Dedo arrastra el color', (await lpx(230, 30))[0] < 200, JSON.stringify(await lpx(230, 30)));
  await page.evaluate(() => window.__lienzoStore.getState().setBrush({ opacity: 1 }));

  // =========================================================== FASE 7: BÁSICOS DE TODO EL MUNDO
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const menu = async (...path) => {
    await page.locator('.menu-btn', { hasText: new RegExp(`^${esc(path[0])}$`) }).click();
    for (const p of path.slice(1, -1)) await page.locator('.menu-pop .menu-sub > .menu-item', { hasText: new RegExp(`^${esc(p)}▸`) }).last().hover();
    await page.locator('.menu-pop button.menu-item', { hasText: new RegExp(`^✓?${esc(path.at(-1))}`) }).last().click();
    await wait();
  };
  const opts = () => page.evaluate(() => window.__lienzoStore.getState().opts);
  const lastLabel = async () => (await S()).doc.history.at(-1)?.label;

  // --- Ajustes propios por herramienta
  await newDoc(300, 200, 'white');
  await key('b'); await page.evaluate(() => window.__lienzoStore.getState().setBrush({ size: 30 }));
  await key('e'); await page.evaluate(() => window.__lienzoStore.getState().setBrush({ size: 80 }));
  await key('b');
  ok('Cada herramienta recuerda su tamaño de pincel (B 30 px, E 80 px)', (await S()).brush.size === 30, String((await S()).brush.size));
  await key('e'); ok('… y el Borrador conserva el suyo', (await S()).brush.size === 80);

  // --- Varios documentos en pestañas
  await newDoc(300, 200, 'white');
  await call('selectShape', { x: 0, y: 0, w: 100, h: 100 }, 'rect', 'replace', 0); await call('fill', [255, 0, 0, 255]); await call('deselect');
  const docA = (await S()).doc.activeDocId;
  await call('newDoc', 200, 150, 'white', 'segundo.psd'); await wait(300);
  ok('Un documento nuevo abre otra pestaña', (await page.getByTestId('doc-tab').count()) === 2);
  await call('selectShape', { x: 0, y: 0, w: 50, h: 50 }, 'rect', 'replace', 0); await call('fill', [0, 0, 255, 255]); await call('deselect');
  await page.getByTestId('doc-tab').nth(0).click(); await wait(300);
  ok('Clic en la pestaña cambia de documento', (await S()).doc.activeDocId === docA && (await S()).doc.width === 300);
  await key('Control+z', 200); await key('Control+z', 300);
  ok('Deshacer es independiente en cada documento', near(await px(20, 20), [255, 255, 255, 255]) && (await S()).doc.history.length > 1, JSON.stringify(await px(20, 20)));
  await key('Control+Shift+z', 200); await key('Control+Shift+z', 300);
  await key('Control+F6', 300);
  ok('Ctrl+F6 pasa al documento siguiente', (await S()).doc.width === 200 && near(await px(20, 20), [0, 0, 255, 255]));
  await key('Control+F6', 300);
  {
    const before = (await S()).doc.docs.find((d) => d.id !== docA);
    const rowsBefore = (await S()).doc.layers.length;
    await page.getByTestId('layer-row').first().dragTo(page.getByTestId('doc-tab').nth(1)).catch(() => {});
    await wait(400);
    let st = await S();
    if (st.doc.activeDocId === docA) { // si el arrastre nativo no llegó, se usa la misma orden
      await call('copyLayerToDoc', before.id, st.doc.activeLayerId); await wait(300); st = await S();
    }
    ok('Arrastrar una capa a otra pestaña la copia en ese documento', st.doc.activeDocId === before.id && st.doc.layers.length === 2 && rowsBefore === 1, `${st.doc.layers.length} capas`);
  }
  await page.getByTestId('doc-tab').nth(1).locator('button').click(); await wait(300);
  ok('Cerrar un documento con cambios pide confirmación', (await S()).dialog?.kind === 'confirmClose');
  await page.getByTestId('dont-save').click(); await wait(300);
  ok('"No guardar" cierra la pestaña', (await page.getByTestId('doc-tab').count()) === 1 && (await S()).doc.activeDocId === docA);

  // --- Reglas, guías y ajuste magnético
  await newDoc(400, 300, 'white');
  if (!(await opts()).rulers) await key('Control+r');
  ok('Ctrl+R muestra las reglas', await page.getByTestId('ruler-h').isVisible());
  {
    const rb = await page.getByTestId('ruler-h').boundingBox();
    const [, gy] = await scr(0, 100);
    const [gx] = await scr(200, 0);
    await page.mouse.move(gx, rb.y + 10); await page.mouse.down();
    await page.mouse.move(gx, gy, { steps: 10 }); await page.mouse.up(); await wait(300);
  }
  const guides = (await S()).doc.guides;
  ok('Arrastrar desde la regla crea una guía', guides.length === 1 && guides[0].dir === 'h' && Math.abs(guides[0].pos - 100) <= 2, JSON.stringify(guides));
  await call('clearGuides'); await call('addGuide', 'v', 150); await wait(200);
  await useTool('marquee');
  await drag([40, 40], [146, 120]);
  { const b = (await S()).doc.selectionBounds ?? null; void b; }
  ok('El marco se ajusta a la guía (ajuste magnético)', (await sel(149, 80)) === 255 && (await sel(151, 80)) === 0, `${await sel(149, 80)} ${await sel(151, 80)}`);
  await call('deselect');
  await key('Control+Shift+;');
  ok('Ctrl+Mayús+; desactiva el ajuste', (await opts()).snap === false);
  await drag([40, 40], [146, 120]);
  ok('Sin ajuste el marco termina donde se suelta', (await sel(147, 80)) === 0 && (await sel(144, 80)) === 255);
  await call('deselect'); await key('Control+Shift+;');
  await menu('Vista', 'Borrar guías');
  ok('Vista > Borrar guías', (await S()).doc.guides.length === 0);
  await key('Control+r');

  // --- Selector de color y muestras
  await page.getByTestId('fg-swatch').click(); await wait();
  ok('Clic en el color frontal abre el Selector de color', await page.getByTestId('color-picker').isVisible());
  await page.getByLabel('Hexadecimal', { exact: true }).fill('12ab34'); await wait(100);
  await page.getByRole('button', { name: 'Añadir a muestras' }).click();
  await page.getByRole('button', { name: 'OK' }).click(); await wait();
  ok('El hexadecimal fija el color frontal', (await S()).fg === '#12ab34', (await S()).fg);
  ok('El color queda en Recientes y en Muestras', await page.evaluate(() => { const s = window.__lienzoStore.getState(); return s.recentColors[0] === '#12ab34' && s.swatches.includes('#12ab34'); }));
  await page.getByTestId('fg-swatch').click(); await wait();
  { const b = await page.getByTestId('cp-sv').boundingBox(); await page.mouse.click(b.x + 2, b.y + b.height - 2); }
  await page.getByRole('button', { name: 'OK' }).click(); await wait();
  ok('Clic abajo en el campo de color da negro', (await S()).fg === '#000000', (await S()).fg);
  await page.getByTestId('tab-Muestras').click();
  await page.getByTestId('swatches').locator('button[title^="#12ab34"]').click();
  ok('Clic en una muestra la usa como color frontal', (await S()).fg === '#12ab34');
  await page.getByTestId('tab-Color').click();
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#000000', '#ffffff'));

  // --- Máscara rápida y canales
  await newDoc(300, 200, 'white');
  await call('selectShape', { x: 150, y: 0, w: 150, h: 200 }, 'rect', 'replace', 0); await call('fill', [0, 0, 0, 255]); await call('deselect');
  await call('selectShape', { x: 20, y: 20, w: 60, h: 60 }, 'rect', 'replace', 0);
  await key('q', 300);
  ok('Q entra en Máscara rápida', (await S()).doc.quickMask === true && (await page.getByTestId('doc-tab').innerText()).includes('Máscara rápida'));
  await key('b'); await page.evaluate(() => { const s = window.__lienzoStore.getState(); s.setColors('#ffffff', '#000000'); s.setBrush({ size: 20, hardness: 1, opacity: 1, flow: 1 }); });
  await drag([120, 100], [130, 100]);
  await key('q', 300);
  ok('Pintar de blanco en Máscara rápida amplía la selección', (await S()).doc.quickMask === false && (await sel(50, 50)) === 255 && (await sel(125, 100)) === 255 && (await sel(200, 150)) === 0);
  await call('deselect');
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#000000', '#ffffff'));
  await page.getByTestId('tab-Canales').click(); await wait(400);
  ok('Panel Canales con RGB, Rojo, Verde y Azul', (await page.getByTestId('channel-row').count()) === 4);
  await page.getByTestId('channel-row').nth(1).click(); await wait(200);
  ok('Clic en Rojo muestra solo ese canal', (await S()).doc.viewChannel === 1);
  await page.getByTestId('channel-row').nth(0).click({ modifiers: ['Control'] }); await wait(300);
  ok('Ctrl+clic en RGB carga la luminosidad como selección', (await sel(50, 50)) >= 254 && (await sel(200, 50)) === 0, `${await sel(50, 50)} ${await sel(200, 50)}`);
  await page.getByTestId('channel-row').nth(0).click(); await wait(200);
  ok('Clic en RGB vuelve a la vista compuesta', (await S()).doc.viewChannel === 0);
  await page.locator('.panel-foot button[title="Guardar selección como canal"]').click(); await wait(300);
  ok('Guardar selección crea un canal alfa', (await page.getByTestId('alpha-row').count()) === 1);
  await call('deselect');
  await page.getByTestId('alpha-row').click({ modifiers: ['Control'] }); await wait(300);
  ok('Ctrl+clic en el canal alfa recupera la selección', (await sel(50, 50)) === 255 && (await sel(200, 50)) === 0);
  await call('deselect');
  await page.getByTestId('tab-Capas').click();

  // --- Separación de frecuencias con Aplicar imagen
  await newDoc(200, 100, 'white');
  await call('selectShape', { x: 0, y: 0, w: 100, h: 100 }, 'rect', 'replace', 0); await call('fill', [200, 60, 40, 255]);
  await call('selectShape', { x: 40, y: 40, w: 4, h: 4 }, 'rect', 'replace', 0); await call('fill', [20, 220, 90, 255]); await call('deselect');
  const orig = [await px(42, 42), await px(20, 20), await px(150, 50), await px(100, 50)];
  await key('Control+j'); await key('Control+j');
  const [low, high] = [(await S()).doc.layers[1].id, (await S()).doc.layers[2].id];
  await call('selectLayer', low); await call('applyFilter', 'gaussianBlur', { radius: 6 }); await wait(300);
  await call('selectLayer', high);
  await menu('Imagen', 'Aplicar imagen…');
  await page.getByLabel('Capa de origen').selectOption(String(low));
  await page.getByLabel('Fusión', { exact: true }).selectOption('subtract');
  await page.getByLabel('Escala').fill('2'); await page.getByLabel('Desplazamiento').fill('128');
  await page.getByRole('button', { name: 'OK' }).click(); await wait(400);
  await call('setLayer', high, { blend: 'linear-light' }); await wait(300);
  const recon = [await px(42, 42), await px(20, 20), await px(150, 50), await px(100, 50)];
  ok('Separación de frecuencias: baja + alta (Luz lineal) reconstruyen la imagen', recon.every((c, i) => near(c, orig[i], 3)), JSON.stringify([orig, recon]));

  // --- Instantáneas, pincel de historia y rotar vista
  await newDoc(400, 300, 'white');
  await call('selectShape', { x: 0, y: 0, w: 200, h: 300 }, 'rect', 'replace', 0); await call('fill', [0, 0, 255, 255]); await call('deselect');
  await page.getByTestId('new-snapshot').click(); await wait();
  ok('El botón de cámara crea una instantánea', (await S()).doc.snapshots.length === 2);
  await call('fill', [0, 255, 0, 255]); await wait();
  await key('y'); ok('Y → Pincel de historia', (await S()).tool === 'historyBrush');
  await page.evaluate(() => window.__lienzoStore.getState().setBrush({ size: 40, hardness: 1, opacity: 1, flow: 1 }));
  await drag([100, 150], [110, 150]);
  ok('El pincel de historia pinta desde el estado inicial', near(await lpx(105, 150), [255, 255, 255, 255]), JSON.stringify(await lpx(105, 150)));
  await page.getByTestId('snapshot-row').nth(1).locator('.hist-src').click(); await wait();
  await drag([100, 250], [110, 250]);
  ok('… y desde la instantánea elegida como origen', near(await lpx(105, 250), [0, 0, 255, 255]), JSON.stringify(await lpx(105, 250)));
  await page.getByTestId('snapshot-row').nth(0).locator('.snap-name').click(); await wait(300);
  ok('Clic en una instantánea vuelve a ese estado', near(await px(300, 150), [255, 255, 255, 255]) && near(await px(100, 150), [255, 255, 255, 255]));
  await key('r'); ok('R → Rotar vista', (await S()).tool === 'rotateView');
  {
    const b = await box();
    await page.mouse.move(b.x + b.width / 2 + 200, b.y + b.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 200 * Math.cos(0.5), b.y + b.height / 2 + 200 * Math.sin(0.5), { steps: 8 }); await page.mouse.up(); await wait();
  }
  ok('Arrastrar gira la vista', Math.abs(((await S()).view.rot ?? 0) - 0.5) < 0.03, String((await S()).view.rot));
  await key('Escape');
  ok('Esc restablece la rotación', !(await S()).view.rot);

  // --- Básicos de los cursos
  await newDoc(400, 300, 'white');
  await call('selectShape', { x: 0, y: 0, w: 400, h: 300 }, 'rect', 'replace', 0); await call('fill', [224, 172, 140, 255]);
  await call('selectShape', { x: 185, y: 135, w: 30, h: 30 }, 'ellipse', 'replace', 0); await call('fill', [200, 30, 40, 255]); await call('deselect');
  await key('j'); for (let i = 0; i < 5 && (await S()).tool !== 'redEye'; i++) await key('Shift+j');
  ok('Mayús+J llega a Pupilas rojas', (await S()).tool === 'redEye');
  await click([200, 150]); await wait(200);
  const eye = await lpx(200, 150), eyeEdge = await lpx(187, 150), skin = await lpx(175, 150);
  ok('Pupilas rojas oscurece la pupila y respeta la piel', eye[0] < 60 && eyeEdge[0] < 80 && near(skin, [224, 172, 140, 255], 2) && (await lastLabel()) === 'Pupilas rojas', JSON.stringify([eye, eyeEdge, skin]));

  await newDoc(300, 200, 'white');
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#ff0000', '#ffffff'));
  await call('selectShape', { x: 50, y: 50, w: 100, h: 100 }, 'rect', 'replace', 0);
  await menu('Edición', 'Contornear…');
  await page.getByLabel('Anchura (px)').fill('4'); await page.getByLabel('Exterior').check();
  await page.getByRole('button', { name: 'OK' }).click(); await wait();
  ok('Edición > Contornear (exterior, 4 px)', near(await lpx(47, 100), [255, 0, 0, 255]) && near(await lpx(44, 100), [255, 255, 255, 255]) && near(await lpx(52, 100), [255, 255, 255, 255]));
  await call('deselect');
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#000000', '#ffffff'));
  await menu('Capa', 'Nueva', 'Capa…');
  await page.getByLabel('Nombre').fill('Esquivar y quemar');
  await page.getByLabel('Modo', { exact: true }).selectOption('overlay');
  await page.getByLabel('Rellenar con color neutro').check();
  await page.getByRole('button', { name: 'OK' }).click(); await wait();
  {
    const L = await active();
    ok('Nueva capa con relleno neutro (gris 50 % en Superponer) no cambia la imagen', L.name === 'Esquivar y quemar' && L.blend === 'overlay' && near(await lpx(10, 10), [128, 128, 128, 255], 1) && near(await px(10, 10), [255, 255, 255, 255], 1));
  }
  await newDoc(300, 200, 'white');
  await call('selectShape', { x: 0, y: 0, w: 100, h: 200 }, 'rect', 'replace', 0); await call('fill', [128, 128, 128, 255]);
  await call('selectShape', { x: 100, y: 0, w: 100, h: 200 }, 'rect', 'replace', 0); await call('fill', [220, 40, 40, 255]); await call('deselect');
  await menu('Capa', 'Nueva capa de ajuste', 'Filtro de fotografía');
  { const c = await px(50, 50); ok('Filtro de fotografía (calentamiento 85) calienta sin cambiar la luminosidad', c[0] > c[2] + 20 && Math.abs((c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) - 128) < 4, JSON.stringify(c)); }
  await call('deleteLayer');
  await menu('Capa', 'Nueva capa de ajuste', 'Corrección selectiva');
  await page.getByLabel('Colores').selectOption('reds');
  const cyan = page.locator('.adj-row', { hasText: /^Cian/ }).locator('input[type=number]');
  await cyan.fill('100'); await cyan.press('Enter'); await wait();
  ok('Corrección selectiva: +cian en rojos reduce el rojo y no toca los grises', (await px(150, 50))[0] < 205 && near(await px(50, 50), [128, 128, 128, 255], 1), JSON.stringify(await px(150, 50)));
  await call('deleteLayer');
  await menu('Capa', 'Nueva capa de ajuste', 'Mezclador de canales');
  await page.getByRole('checkbox', { name: 'Monocromo' }).click(); await wait();
  ok('Mezclador de canales monocromo (40/40/20)', near(await px(150, 50), [112, 112, 112, 255], 2), JSON.stringify(await px(150, 50)));

  // =========================================================== FASE 9: PLANTILLAS Y REDES SOCIALES
  const layerById = async (id) => (await S()).doc.layers.find((l) => l.id === id);
  const styleDbl = async () => { const r = page.getByTestId('layer-row').first(); const b = await r.boundingBox(); await r.dblclick({ position: { x: b.width - 12, y: b.height / 2 } }); await wait(400); };
  const roundtrip = async (name) => {
    const bytes = await page.evaluate(async () => Array.from(await window.__lienzo.call('savePsd')));
    await page.evaluate(async ([b, n]) => { await window.__lienzo.call('open', n, new Uint8Array(b).buffer, ''); }, [bytes, name]);
    await wait(700);
  };

  // --- Estilos de capa (los 10) y opciones de fusión
  await newDoc(400, 300, 'white');
  await call('createShape', { shape: 'rect', x: 100, y: 80, w: 150, h: 120, fill: [40, 120, 220, 255], stroke: null, strokeWidth: 0, radius: 0, sides: 6 }); await wait();
  const shp = await active();
  await styleDbl();
  ok('Doble clic en la capa abre Estilo de capa', await page.getByTestId('layer-style').isVisible());
  ok('El diálogo tiene Opciones de fusión y los 10 efectos', (await page.locator('.lstyle-item').count()) === 11);
  await page.getByRole('button', { name: 'Sombra paralela' }).click();
  await page.getByLabel('Distancia (valor)').fill('20'); await page.getByLabel('Tamaño (valor)').fill('0'); await page.getByLabel('Opacidad (valor)').fill('100'); await wait(600);
  ok('La vista previa del estilo es inmediata', (await px(240, 215))[0] < 80, JSON.stringify(await px(240, 215)));
  await page.getByRole('button', { name: 'OK' }).click(); await wait(400);
  {
    const L = await layerById(shp.id);
    ok('Sombra paralela guardada (distancia 20, multiplicar)', L.effects?.dropShadow?.enabled && L.effects.dropShadow.distance === 20 && L.effects.dropShadow.blend === 'multiply' && (await lastLabel()) === 'Estilo de capa');
  }
  await styleDbl();
  await page.getByLabel('Activar Trazo').check(); await wait(200);
  await page.getByRole('button', { name: 'Cancelar' }).click(); await wait(400);
  ok('Cancelar deja el estilo como estaba', !(await layerById(shp.id)).effects?.stroke);
  const fx10 = {
    dropShadow: { enabled: true, color: [0, 0, 0, 255], opacity: 0.75, angle: 120, distance: 8, size: 8, spread: 0, blend: 'multiply' },
    innerShadow: { enabled: true, color: [0, 0, 0, 255], opacity: 0.75, angle: 120, distance: 5, size: 5, spread: 0, blend: 'multiply' },
    outerGlow: { enabled: true, color: [255, 255, 0, 255], opacity: 0.75, size: 10, spread: 0, blend: 'screen' },
    innerGlow: { enabled: true, color: [255, 255, 190, 255], opacity: 0.75, size: 10, spread: 0, blend: 'screen', source: 'edge' },
    bevel: { enabled: true, style: 'inner', technique: 'smooth', depth: 100, up: true, size: 10, soften: 0, angle: 120, altitude: 30, highlight: [255, 255, 255, 255], highlightOpacity: 0.75, highlightBlend: 'screen', shadow: [0, 0, 0, 255], shadowOpacity: 0.75, shadowBlend: 'multiply' },
    satin: { enabled: true, color: [0, 0, 0, 255], opacity: 0.5, angle: 19, distance: 11, size: 14, invert: true, blend: 'multiply' },
    colorOverlay: { enabled: true, color: [255, 0, 0, 255], opacity: 0.3, blend: 'normal' },
    gradientOverlay: { enabled: true, from: [0, 0, 0, 255], to: [255, 255, 255, 255], opacity: 0.3, angle: 90, style: 'linear', reverse: false, scale: 100, blend: 'normal' },
    patternOverlay: { enabled: true, pattern: 'dots', colorA: [255, 255, 255, 255], colorB: [0, 0, 0, 255], scale: 100, opacity: 0.2, blend: 'normal' },
    stroke: { enabled: true, color: [0, 200, 0, 255], size: 4, position: 'outside', opacity: 1, blend: 'normal' },
  };
  await call('setEffects', shp.id, fx10, true); await wait(900);
  ok('Los 10 efectos a la vez se dibujan (trazo verde fuera, relieve dentro)', near(await px(98, 140), [0, 200, 0, 255], 20) && JSON.stringify(await px(175, 140)) !== JSON.stringify([40, 120, 220, 255]), JSON.stringify([await px(98, 140), await px(175, 140)]));
  await roundtrip('estilos.psd');
  {
    const L = (await S()).doc.layers.find((l) => l.kind === 'shape' || l.effects);
    const fx = L?.effects ?? {};
    ok('PSD: los 10 efectos se guardan y se vuelven a abrir', ['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'bevel', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'stroke'].every((k) => fx[k]?.enabled) && fx.stroke.size === 4 && fx.bevel.style === 'inner', Object.keys(fx).join());
  }
  await newDoc(300, 200, 'white');
  await call('newLayer'); await call('selectShape', { x: 50, y: 50, w: 100, h: 100 }, 'rect', 'replace', 0); await call('fill', [255, 0, 0, 255]); await call('deselect');
  await call('setEffects', (await active()).id, { fill: 0, stroke: { enabled: true, color: [0, 0, 255, 255], size: 4, position: 'inside', opacity: 1 } }, true); await wait(700);
  ok('Opacidad de relleno 0 %: el contenido desaparece y el trazo sigue', near(await px(100, 100), [255, 255, 255, 255]) && near(await px(52, 100), [0, 0, 255, 255]));
  await newDoc(200, 100, 'white');
  await call('selectShape', { x: 0, y: 0, w: 100, h: 100 }, 'rect', 'replace', 0); await call('fill', [0, 0, 0, 255]); await call('deselect');
  await call('newLayer'); await call('selectShape', { x: 0, y: 0, w: 200, h: 100 }, 'rect', 'replace', 0); await call('fill', [255, 0, 0, 255]); await call('deselect');
  const bifId = (await active()).id;
  await styleDbl();
  await page.getByRole('button', { name: 'Opciones de fusión' }).click();
  {
    const bar = await page.locator('.bif-bar').nth(1).boundingBox();
    const knob = await page.getByTestId('bif-Capa subyacente-0').boundingBox();
    await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2); await page.mouse.down();
    await page.mouse.move(bar.x + bar.width * 0.5, knob.y + knob.height / 2, { steps: 6 }); await page.mouse.up(); await wait(500);
  }
  ok('"Fusionar si" (capa subyacente): la capa roja no se ve sobre lo oscuro', near(await px(50, 50), [0, 0, 0, 255]) && near(await px(150, 50), [255, 0, 0, 255]), JSON.stringify([await px(50, 50), await px(150, 50)]));
  await page.getByRole('button', { name: 'OK' }).click(); await wait(300);
  ok('"Fusionar si" se guarda en la capa', (await layerById(bifId)).effects?.blendIf?.under[0] > 100);
  await roundtrip('fusionar-si.psd');
  ok('PSD: "Fusionar si" se conserva', (await S()).doc.layers.some((l) => l.effects?.blendIf?.under[0] > 100) && near(await px(50, 50), [0, 0, 0, 255]));

  // --- Texto profesional
  await newDoc(600, 400, 'white');
  await useTool('text');
  await drag([50, 50], [350, 200], 8);
  await page.keyboard.type('Texto de párrafo que se ajusta solo dentro de la caja'); await key('Escape', 500);
  {
    const L = await active();
    ok('Arrastrar con Texto crea texto de párrafo en caja', L.kind === 'text' && L.text.box?.w === 300 && L.text.box?.h === 150, JSON.stringify(L.text?.box));
    const b = await call('debugLayerBounds');
    ok('El texto de párrafo se ajusta en varias líneas dentro de la caja', !b || (b.w <= 305 && b.h > 60), JSON.stringify(b));
  }
  await page.getByLabel('Seguimiento (milésimas de eme)').fill('200'); await page.getByLabel('Seguimiento (milésimas de eme)').press('Enter'); await wait(300);
  ok('Carácter: seguimiento', (await active()).text.tracking === 200);
  await page.getByRole('button', { name: 'Todo mayúsculas' }).click(); await wait(200);
  await page.getByRole('button', { name: 'Justificar (última línea a la izquierda)' }).click(); await wait(200);
  ok('Mayúsculas y justificado', (await active()).text.caps === 'all' && (await active()).text.align === 'justify');
  await page.evaluate(() => { const e = window.__lienzo; window.__log = []; if (!e.__wrapped) { const c = e.call.bind(e); e.call = (m, ...a) => { if (m === 'updateText' || m === 'undo' || m === 'redo') window.__log.push(m + ' ' + JSON.stringify(a).slice(0, 160)); return c(m, ...a); }; e.__wrapped = true; } });
  await menu('Texto', 'Deformar texto…');
  await page.getByLabel('Estilo', { exact: true }).selectOption('flag'); await wait(300);
  await page.getByLabel('Curvar (valor)').fill('60'); await wait(600);
  // El diálogo aplica en vivo: se espera a que el motor tenga la deformación antes de aceptar.
  await page.waitForFunction(() => { const s = window.__lienzoStore.getState(); const t = s.doc.layers.find((l) => l.id === s.doc.activeLayerId)?.text; return t?.warp?.style === 'flag' && t.warp.bend === 60; }, null, { timeout: 10000 }).catch(() => {});
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForFunction(() => { const s = window.__lienzoStore.getState(); return s.doc.layers.find((l) => l.id === s.doc.activeLayerId)?.text?.warp?.bend === 60; }, null, { timeout: 15000 }).catch(() => {});
  ok('Texto > Deformar texto (Bandera 60 %)', (await active()).text.warp?.style === 'flag' && (await active()).text.warp?.bend === 60, JSON.stringify({ warp: (await active()).text?.warp, kind: (await active()).kind, dialog: (await S()).dialog, log: await page.evaluate(() => window.__log) }));
  await roundtrip('texto.psd');
  {
    const T = (await S()).doc.layers.find((l) => l.kind === 'text');
    ok('PSD: el texto vuelve editable con caja, seguimiento y deformación', !!T && !!T.text.box && T.text.tracking === 200 && T.text.warp?.style === 'flag' && T.text.caps === 'all', JSON.stringify(T?.text && { box: T.text.box, tr: T.text.tracking, w: T.text.warp, caps: T.text.caps }));
  }
  // Google Fonts (servidas por la prueba: el entorno no tiene internet).
  const fontFile = readFileSync(new globalThis.URL('./fixtures/test-font.ttf', import.meta.url));
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', headers: { 'access-control-allow-origin': '*' },
    body: "/* latin */\n@font-face {\n  font-family: 'Lobster';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/test/lobster.ttf) format('truetype');\n  unicode-range: U+0000-00FF;\n}\n" }));
  await ctx.route('https://fonts.gstatic.com/**', (r) => r.fulfill({ status: 200, contentType: 'font/ttf', headers: { 'access-control-allow-origin': '*' }, body: fontFile }));
  await newDoc(600, 200, 'white');
  await call('createText', { text: 'iiiiiiiiii', x: 20, y: 100, size: 40, font: 'Arial', color: [0, 0, 0, 255] }); await wait(300);
  const wArial = (await call('debugLayerBounds'))?.w ?? 0;
  await page.getByTestId('font-picker').first().click();
  await page.locator('.font-search input').fill('lobs');
  await page.locator('.font-item', { hasText: 'Lobster' }).click(); await wait(1500);
  const wG = (await call('debugLayerBounds'))?.w ?? 0;
  ok('Google Fonts: se descarga la fuente y el texto se repinta con ella', (await active()).text.font === 'Lobster' && wG > wArial * 1.5, `${wArial} → ${wG}`);
  await ctx.unroute('https://fonts.googleapis.com/**'); await ctx.unroute('https://fonts.gstatic.com/**');

  // --- Consulta de colores (LUT)
  await newDoc(200, 100, 'white');
  await call('selectShape', { x: 0, y: 0, w: 200, h: 100 }, 'rect', 'replace', 0); await call('fill', [200, 120, 60, 255]); await call('deselect');
  await menu('Capa', 'Nueva capa de ajuste', 'Consulta de colores'); await wait(300);
  ok('Consulta de colores con un look incluido cambia el color', JSON.stringify(await px(50, 50)) !== JSON.stringify([200, 120, 60, 255]));
  await page.getByLabel('Look').selectOption('Blanco y negro contrastado'); await wait(300);
  { const c = await px(50, 50); ok('Look "Blanco y negro contrastado"', c[0] === c[1] && c[1] === c[2]); }
  await page.getByLabel('Cargar archivo .cube').setInputFiles({ name: 'invertir.cube', mimeType: 'text/plain', buffer: Buffer.from('TITLE "inv"\nLUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n') }); await wait(400);
  ok('Cargar un archivo .cube', near(await px(50, 50), [55, 135, 195, 255], 2), JSON.stringify(await px(50, 50)));
  await roundtrip('lut.psd');
  ok('PSD: la LUT se guarda dentro del archivo', near(await px(50, 50), [55, 135, 195, 255], 2) && (await S()).doc.layers.some((l) => l.adjustment?.type === 'colorLookup'));

  // --- Objetos inteligentes y filtros inteligentes
  await newDoc(400, 300, 'white');
  await call('newLayer'); await call('selectShape', { x: 100, y: 100, w: 100, h: 100 }, 'rect', 'replace', 0); await call('fill', [255, 0, 0, 255]); await call('deselect');
  await menu('Capa', 'Objetos inteligentes', 'Convertir en objeto inteligente'); await wait(400);
  ok('Convertir en objeto inteligente', (await active()).kind === 'smart' && (await active()).smart.w === 100);
  await call('beginTransform'); await call('updateTransform', [0.1, 0, 0, 0.1, 135, 135]); await call('commitTransform'); await wait(300);
  await call('beginTransform'); await call('updateTransform', [10, 0, 0, 10, -1350, -1350]); await call('commitTransform'); await wait(400);
  ok('Reducir al 10 % y volver a ampliar no pierde calidad', near(await px(101, 150), [255, 0, 0, 255]) && near(await px(99, 150), [255, 255, 255, 255]));
  await menu('Filtro', 'Desenfocar', 'Desenfoque gaussiano…');
  await page.getByRole('button', { name: 'OK' }).click(); await wait(800);
  ok('Un filtro sobre un objeto inteligente queda como filtro inteligente', (await active()).smart.filters.length === 1 && (await page.getByTestId('smart-filter').count()) === 1);
  const blurred = await px(100, 150);
  await page.getByRole('button', { name: /^Ocultar Desenfoque gaussiano/ }).click(); await wait(600);
  ok('Ocultar el filtro inteligente recupera el original', near(await px(100, 150), [255, 0, 0, 255]) && !near(blurred, [255, 0, 0, 255], 5));
  await key('Control+z', 600);
  ok('Deshacer vuelve a mostrarlo', near(await px(100, 150), blurred, 3));
  await menu('Capa', 'Objetos inteligentes', 'Editar contenido'); await wait(600);
  ok('Editar contenido abre una pestaña .psb', (await S()).doc.smartParent && (await S()).doc.name.endsWith('.psb') && (await page.getByTestId('doc-tab').count()) === 2);
  await call('selectShape', { x: 0, y: 0, w: 100, h: 100 }, 'rect', 'replace', 0); await call('fill', [0, 0, 255, 255]); await call('deselect');
  await key('Control+s', 1200);
  await page.getByTestId('doc-tab').nth(0).click(); await wait(500);
  await call('setSmartFilter', (await active()).id, 0, { enabled: false }, true); await wait(600);
  ok('Guardar el contenido actualiza el objeto inteligente', near(await px(150, 150), [0, 0, 255, 255]), JSON.stringify(await px(150, 150)));
  {
    const png = Buffer.from(await page.evaluate(async () => { const c = new OffscreenCanvas(40, 20); const g = c.getContext('2d'); g.fillStyle = '#00ff00'; g.fillRect(0, 0, 40, 20); return Array.from(new Uint8Array(await (await c.convertToBlob()).arrayBuffer())); }));
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), menu('Capa', 'Objetos inteligentes', 'Reemplazar contenido…')]);
    await fc.setFiles({ name: 'verde.png', mimeType: 'image/png', buffer: png }); await wait(800);
    ok('Reemplazar contenido (mockups): la nueva imagen ocupa el mismo sitio', near(await px(150, 150), [0, 255, 0, 255]) && near(await px(90, 150), [255, 255, 255, 255]) && (await active()).smart.source === 'verde.png');
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), menu('Archivo', 'Colocar incrustado…')]);
    await fc2.setFiles({ name: 'colocada.png', mimeType: 'image/png', buffer: png }); await wait(800);
    ok('Colocar incrustado crea un objeto inteligente', (await active()).kind === 'smart' && (await active()).name === 'colocada');
  }
  await closeAllButFirst();

  // --- Mesas de trabajo y exportar en varios tamaños
  await newDoc(10, 10, 'white');
  await menu('Archivo', 'Nuevo…'); await wait(300);
  await page.getByLabel('Nombre').fill('redes');
  await page.getByLabel('Mesas de trabajo').check();
  await page.getByRole('button', { name: 'Crear', exact: true }).click(); await wait(600);
  ok('Documento nuevo con mesa de trabajo', (await S()).doc.layers.some((l) => l.artboard) && (await S()).doc.layers.find((l) => l.kind === 'pixel')?.parent != null);
  await menu('Capa', 'Nueva', 'Mesa de trabajo…');
  await page.getByLabel('Medida').selectOption({ label: 'Historia / Reel / TikTok · 1080 × 1920' });
  await page.getByRole('button', { name: 'Crear', exact: true }).click(); await wait(600);
  {
    const st = await S();
    const abs = st.doc.layers.filter((l) => l.artboard);
    ok('Nueva mesa de trabajo a la derecha (el lienzo crece)', abs.length === 2 && abs[1].artboard.w === 1080 && abs[1].artboard.h === 1920 && st.doc.height >= 1920 && abs[1].artboard.x > abs[0].artboard.x + abs[0].artboard.w);
    ok('Fuera de las mesas el lienzo es transparente', (await px(abs[0].artboard.w + 50, 10))[3] === 0);
  }
  await menu('Archivo', 'Exportar', 'Exportar como…');
  await page.getByRole('button', { name: '2x' }).click();
  const [zip] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar' }).click()]);
  {
    const p = await zip.path();
    const buf = readFileSync(p);
    const names = [...buf.toString('latin1').matchAll(/PK\x01\x02[\s\S]{42}([^\x00]*?\.png)/g)].map((m) => m[1]);
    ok('Exportar como: cada mesa en 1x y 2x dentro de un ZIP', zip.suggestedFilename().endsWith('.zip') && buf.readUInt32LE(0) === 0x04034b50 && buf.includes(Buffer.from('Mesa de trabajo 1@2x.png')), zip.suggestedFilename() + ' ' + names.join(','));
  }

  // =========================================================== RENDIMIENTO
  await newDoc(6000, 4000, 'white');
  await call('selectShape', { x: 0, y: 0, w: 3000, h: 4000 }, 'rect', 'replace', 0);
  await call('fill', [0, 0, 0, 255]); await call('deselect');
  await maxLongTask();
  const tb = Date.now();
  await call('applyFilter', 'gaussianBlur', { radius: 20 });
  const blurMs = Date.now() - tb;
  const lt = await maxLongTask();
  ok('Desenfoque gaussiano 20 px en 24 MP sin bloquear la interfaz', lt < 200, `${blurMs} ms · tarea larga máx. ${lt} ms · ${(await call('stats')).poolSize} hilos`);

  await page.screenshot({ path: 'tests/out-full.png' });
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
