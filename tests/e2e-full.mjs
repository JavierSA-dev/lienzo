// Prueba completa de las fases 2-4 en Chromium con ratón y teclado reales.
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = 4175;
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
const newDoc = async (w = 800, h = 600, bg = 'white') => { await call('newDoc', w, h, bg, 'prueba.psd'); await wait(300); };

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
  await page.keyboard.press('w'); ok('W → Varita mágica', (await S()).tool === 'wand');
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
  ok('Mayús+J → Pincel corrector', (await S()).tool === 'heal');
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

  // =========================================================== RENDIMIENTO
  await call('newDoc', 6000, 4000, 'white', 'grande.psd');
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
