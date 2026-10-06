// Pruebas de la interfaz móvil y táctil en Chromium: teléfono vertical y horizontal, tableta.
// Los toques se simulan con el protocolo de Chrome (varios dedos a la vez).
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = 4176;
const URL = `http://localhost:${PORT}/app/`;
const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? '✔' : '✘'} ${name} ${extra}`); };

if (!existsSync('dist/index.html')) execSync('npx vite build', { stdio: 'inherit' });
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', detached: true });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch {} };
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('localhost') && r()));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];

async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'es-ES' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => window.__lienzoStore?.getState().ready, null, { timeout: 20000 });
  const cdp = await ctx.newCDPSession(page);
  const S = () => page.evaluate(() => { const s = window.__lienzoStore.getState(); return { tool: s.tool, view: s.view, fg: s.fg, sheet: s.sheet, doc: s.doc, dialog: s.dialog }; });
  const wait = (ms = 250) => page.waitForTimeout(ms);
  const t = {
    page, ctx, S, wait,
    call: (m, ...a) => page.evaluate(([m, a]) => window.__lienzo.call(m, ...a), [m, a]),
    touch: (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i, radiusX: 5, radiusY: 5, force: 0.5 })) }),
    scr: async (dx, dy) => { const { view } = await S(); const b = await page.getByTestId('canvas-area').boundingBox(); return [b.x + view.panX + dx * view.zoom, b.y + view.panY + dy * view.zoom]; },
    sheet: () => page.getByTestId('m-sheet'),
  };
  t.drag = async (a, b, steps = 8) => {
    await t.touch('touchStart', [a]);
    for (let i = 1; i <= steps; i++) { await t.touch('touchMove', [[a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps]]); await wait(16); }
    await t.touch('touchEnd', []); await wait(350);
  };
  t.pickTool = async (tool) => {
    await page.locator(`.m-tool[data-tool=${tool}]`).click(); await wait();
    if ((await S()).sheet === 'tools') { await t.sheet().locator('.m-row.on').click(); await wait(); }
  };
  return t;
}

try {
  // =========================================================== TELÉFONO EN VERTICAL (390 × 844)
  const m = await open({ width: 390, height: 844 });
  const { page, S, wait, call, touch, scr, drag, pickTool, sheet } = m;
  ok('Pantalla estrecha → interfaz móvil', (await page.locator('.app.mobile').count()) === 1);
  ok('Sin desbordes horizontales (nada se sale de la pantalla)', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.app').getBoundingClientRect().width <= innerWidth));
  await page.getByRole('button', { name: /Instagram cuadrado/ }).click(); await wait(600);
  ok('Crear un proyecto desde la portada', (await S()).doc.open && (await S()).doc.width === 1080);
  ok('Barra superior, barra de herramientas y lienzo visibles', await page.locator('.m-top').isVisible() && await page.locator('.m-bottom').isVisible() && (await page.getByTestId('canvas-area').boundingBox()).height > 400);

  await pickTool('brush');
  await page.evaluate(() => window.__lienzoStore.getState().setBrush({ size: 40, hardness: 1, opacity: 1, flow: 1 }));
  await drag(await scr(300, 540), await scr(700, 540), 10);
  ok('Pintar con un dedo', (await call('debugLayerPixel', 500, 540))[3] === 255 && (await S()).doc.history.at(-1).label === 'Pincel');

  const z0 = (await S()).view.zoom, c = await scr(540, 540);
  await touch('touchStart', [[c[0] - 40, c[1]], [c[0] + 40, c[1]]]);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', [[c[0] - 40 - i * 10, c[1]], [c[0] + 40 + i * 10, c[1]]]); await wait(16); }
  await touch('touchEnd', []); await wait(300);
  const z1 = (await S()).view.zoom;
  ok('Pellizcar amplía (×3 al separar los dedos 3 veces más)', Math.abs(z1 / z0 - 3) < 0.15, `${z0.toFixed(3)} → ${z1.toFixed(3)}`);
  ok('El pellizco no pinta', (await S()).doc.history.at(-1).label === 'Pincel' && (await S()).doc.historyIndex === 1);
  const c2 = await scr(540, 540);
  ok('El punto bajo los dedos se queda bajo los dedos', Math.abs(c2[0] - c[0]) < 3 && Math.abs(c2[1] - c[1]) < 3, JSON.stringify([c, c2]));
  {
    const v0 = (await S()).view;
    await touch('touchStart', [[150, 400], [230, 400]]);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', [[150 + i * 10, 400 + i * 8], [230 + i * 10, 400 + i * 8]]); await wait(16); }
    await touch('touchEnd', []); await wait(300);
    const v1 = (await S()).view;
    ok('Arrastrar con dos dedos desplaza', Math.abs(v1.panX - v0.panX - 60) < 3 && Math.abs(v1.panY - v0.panY - 48) < 3 && Math.abs(v1.zoom - v0.zoom) < 1e-6);
  }
  await touch('touchStart', [[150, 400], [230, 400]]); await wait(60); await touch('touchEnd', []); await wait(400);
  ok('Toque con dos dedos = deshacer', (await S()).doc.historyIndex === 0);
  await touch('touchStart', [[150, 400], [230, 400], [300, 400]]); await wait(60); await touch('touchEnd', []); await wait(400);
  ok('Toque con tres dedos = rehacer', (await S()).doc.historyIndex === 1);

  // Un segundo dedo que llega tarde cancela el trazo empezado.
  {
    const a = await scr(450, 500);
    await touch('touchStart', [a]);
    for (let i = 1; i <= 4; i++) { await touch('touchMove', [[a[0] + i * 8, a[1] - 60]]); await wait(16); }
    await touch('touchMove', [[a[0] + 32, a[1] - 60], [a[0] + 120, a[1]]]); await wait(30);
    await touch('touchMove', [[a[0] + 40, a[1] - 60], [a[0] + 130, a[1]]]); await wait(30);
    await touch('touchEnd', []); await wait(500);
    ok('Si llega un segundo dedo, el trazo empezado se descarta', (await S()).doc.historyIndex === 1, String((await S()).doc.historyIndex));
  }

  await page.evaluate(() => window.__lienzoStore.getState().setColors('#00ff00', '#ffffff'));
  const lp = await scr(500, 540);
  await touch('touchStart', [lp]); await wait(800); await touch('touchEnd', []); await wait(300);
  ok('Mantener pulsado = cuentagotas', (await S()).fg === '#000000' && (await S()).doc.historyIndex === 1, (await S()).fg);
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#ff0000', '#ffffff'));
  await touch('touchStart', [await scr(540, 700)]); await wait(80); await touch('touchEnd', []); await wait(400);
  ok('Un toque corto pinta un punto', (await call('debugLayerPixel', 540, 700))[0] === 255 && (await S()).doc.historyIndex === 2);

  await pickTool('marquee');
  await drag(await scr(450, 450), await scr(650, 650));
  ok('Seleccionar con el dedo', !!(await S()).doc.selection);
  const ctxText = await page.getByTestId('m-context').innerText();
  ok('Barra contextual de la selección', /Deseleccionar/.test(ctxText) && /Rellenar según contenido/.test(ctxText) && /Máscara/.test(ctxText));
  await page.getByTestId('m-context').getByRole('button', { name: 'Invertir' }).click(); await wait();
  ok('Invertir desde la barra contextual', (await call('debugSelection', 10, 10)) === 255);
  await page.getByTestId('m-context').getByRole('button', { name: 'Deseleccionar' }).click(); await wait();
  ok('Deseleccionar desde la barra contextual', !(await S()).doc.selection);
  ok('Sin selección, la barra ofrece Seleccionar sujeto', /Seleccionar sujeto/.test(await page.getByTestId('m-context').innerText()));

  await call('selectShape', { x: 400, y: 400, w: 200, h: 200 }, 'rect', 'replace', 0);
  await page.getByTestId('m-context').getByRole('button', { name: 'Transformar' }).click(); await wait(400);
  ok('Transformar muestra Aplicar y Cancelar', /Aplicar/.test(await page.getByTestId('m-context').innerText()));
  await page.getByTestId('m-context').getByRole('button', { name: 'Cancelar' }).click(); await wait(300);
  ok('Cancelar la transformación', !(await page.evaluate(() => window.__lienzoStore.getState().transform)));
  await call('deselect');

  await call('fit', false); await wait(300);
  await pickTool('crop');
  ok('Recortar muestra el botón Recortar', /Recortar/.test(await page.getByTestId('m-context').innerText()));
  await drag(await scr(0, 0), await scr(100, 100), 6);
  await page.getByTestId('m-context').getByRole('button', { name: 'Recortar' }).click(); await wait(500);
  ok('Aplicar el recorte con el botón', (await S()).doc.width < 1080, String((await S()).doc.width));
  await touch('touchStart', [[150, 400], [230, 400]]); await wait(60); await touch('touchEnd', []); await wait(500);
  ok('… y deshacerlo con dos dedos', (await S()).doc.width === 1080);

  await pickTool('text');
  await touch('touchStart', [await scr(200, 300)]); await wait(80); await touch('touchEnd', []); await wait(500);
  await page.keyboard.type('Hola'); await wait(200);
  await page.getByTestId('m-context').getByRole('button', { name: 'OK' }).click(); await wait(400);
  ok('Escribir texto y confirmarlo con OK', (await S()).doc.layers.some((l) => l.kind === 'text' && l.name === 'Hola') && !(await page.evaluate(() => window.__lienzoStore.getState().textEdit)));

  await pickTool('brush');
  await page.locator('.m-tool[data-tool=brush]').click(); await wait();
  ok('Tocar la herramienta activa abre las de su grupo', (await S()).sheet === 'tools' && (await sheet().locator('.m-row').count()) >= 2);
  await sheet().getByRole('button', { name: /Lápiz/ }).click(); await wait();
  ok('Elegir otra herramienta del grupo', (await S()).tool === 'pencil' && (await S()).sheet === null);

  await page.getByTestId('m-layers').click(); await wait();
  ok('Hoja de Capas', (await S()).sheet === 'layers' && (await page.getByTestId('layer-row').count()) === 2);
  await page.getByTestId('layer-row').nth(1).click(); await wait();
  ok('Tocar una capa la selecciona', (await S()).doc.activeLayerId === (await S()).doc.layers[0].id);
  await sheet().getByRole('button', { name: 'Cerrar' }).click(); await wait();
  ok('Cerrar la hoja', (await S()).sheet === null);

  await page.getByTestId('m-adjust').click(); await wait();
  await sheet().getByRole('button', { name: 'Tono/Saturación' }).click(); await wait(500);
  { const st = await S(); ok('Ajustes → capa de ajuste y hoja de Propiedades', st.sheet === 'props' && st.doc.layers.find((x) => x.id === st.doc.activeLayerId)?.adjustment?.type === 'hueSat'); }
  await sheet().getByRole('button', { name: 'Atrás' }).click(); await wait();
  ok('Atrás en Propiedades vuelve a Capas', (await S()).sheet === 'layers');
  await sheet().getByRole('button', { name: 'Cerrar' }).click(); await wait();

  await page.getByTestId('m-menu').click(); await wait();
  await sheet().getByRole('button', { name: 'Imagen' }).click(); await wait();
  await sheet().getByRole('button', { name: 'Ajustes' }).click(); await wait();
  await sheet().getByRole('button', { name: 'Niveles…' }).click(); await wait();
  ok('Menú completo navegable (Imagen > Ajustes > Niveles…)', (await S()).dialog?.kind === 'adjust');
  const mb = await page.locator('.modal').boundingBox();
  ok('Los diálogos caben en la pantalla', mb.x >= 0 && mb.x + mb.width <= 390 && mb.y >= 0);
  await page.getByRole('button', { name: 'Cancelar' }).click(); await wait();

  await page.getByTestId('m-color').click(); await wait();
  ok('Hoja de Color', (await S()).sheet === 'color' && await page.getByTestId('fg-swatch').isVisible());
  await sheet().getByRole('button', { name: 'Cerrar' }).click(); await wait();
  await page.getByTestId('m-export').click(); await wait();
  ok('Hoja de Exportar con Compartir y formatos', /Compartir/.test(await sheet().innerText()) && /PSD/.test(await sheet().innerText()));
  const [dl] = await Promise.all([page.waitForEvent('download'), sheet().getByRole('button', { name: 'Guardar PNG' }).click()]);
  ok('Guardar PNG descarga el archivo', /\.png$/.test(dl.suggestedFilename()));

  // Fase 9 en el móvil: estilos de capa, texto y exportar como.
  await call('createShape', { shape: 'rect', x: 300, y: 300, w: 300, h: 300, fill: [40, 120, 220, 255], stroke: null, strokeWidth: 0, radius: 0, sides: 6 }); await wait(300);
  await page.evaluate(() => window.__lienzoStore.getState().setDialog({ kind: 'layerStyle' })); await wait(400);
  {
    const mb2 = await page.locator('.modal').boundingBox();
    ok('Estilo de capa cabe en la pantalla del móvil', mb2.x >= 0 && mb2.x + mb2.width <= 391 && (await page.locator('.lstyle-item').count()) === 11);
    await page.getByRole('button', { name: 'Sombra paralela' }).click(); await wait(200);
    await page.getByRole('button', { name: 'OK' }).click(); await wait(400);
    const stm = await S();
    ok('Aplicar un estilo desde el móvil', !!stm.doc.layers.find((l) => l.id === stm.doc.activeLayerId)?.effects?.dropShadow?.enabled);
  }
  await call('createText', { text: 'Hola', x: 300, y: 200, size: 60, color: [0, 0, 0, 255] }); await wait(300);
  await page.getByTestId('m-layers').click(); await wait();
  await page.getByTestId('layer-row').first().click(); await wait();
  await page.getByTestId('m-props').click(); await wait(300);
  ok('Propiedades del texto (Carácter y Párrafo) en la hoja del móvil', await page.getByTestId('m-sheet').getByLabel('Seguimiento (milésimas de eme)').isVisible());
  await page.getByTestId('m-sheet').getByRole('button', { name: 'Cerrar' }).click(); await wait();
  await page.getByTestId('m-export').click(); await wait();
  await page.getByTestId('m-sheet').getByRole('button', { name: 'Exportar como…' }).click(); await wait(300);
  ok('Exportar como (con tamaños) desde el móvil', await page.getByRole('button', { name: '2x' }).isVisible());
  await page.getByRole('button', { name: 'Cancelar' }).click(); await wait();

  // Fase 10: selección rápida con el dedo, gama de colores y seleccionar y aplicar máscara.
  await call('deselect');
  await call('selectShape', { x: 100, y: 100, w: 400, h: 400 }, 'ellipse', 'replace', 0);
  await call('fill', [30, 120, 220, 255]); await call('deselect');
  await page.evaluate(() => window.__lienzoStore.getState().setTool('quickSelect')); await wait();
  await call('fit', false); await wait(300);
  await drag(await scr(260, 300), await scr(340, 300), 6);
  await page.waitForFunction(() => !!window.__lienzoStore.getState().doc.selection, null, { timeout: 15000 }).catch(() => {});
  ok('Selección rápida con el dedo', (await call('debugSelection', 300, 300)) === 255 && (await call('debugSelection', 700, 700)) === 0);
  await page.getByTestId('m-context').getByRole('button', { name: 'Refinar' }).click(); await wait(400);
  await page.waitForFunction(() => { const c = document.querySelector('[data-testid=refine-preview]'); return c && c.width > 10; }, null, { timeout: 10000 }).catch(() => {});
  {
    const mb = await page.locator('.modal').boundingBox();
    const cv = await page.getByTestId('refine-preview').boundingBox();
    ok('Seleccionar y aplicar máscara cabe en el móvil y muestra la vista previa', mb.x >= 0 && mb.x + mb.width <= 391 && cv && cv.width > 100, JSON.stringify(mb));
  }
  await page.getByRole('button', { name: 'Cancelar' }).click(); await wait();
  await call('deselect'); await wait();
  await page.getByTestId('m-context').getByRole('button', { name: 'Gama de colores' }).click(); await wait(400);
  {
    const mb = await page.locator('.modal').boundingBox();
    ok('Gama de colores desde la barra contextual cabe en el móvil', (await S()).dialog?.kind === 'colorRange' && mb.x >= 0 && mb.x + mb.width <= 391);
    await page.waitForFunction(() => { const c = document.querySelector('[data-testid=cr-preview]'); return c && c.width > 10; });
    const cb = await page.getByTestId('cr-preview').boundingBox();
    // Tocar el azul del círculo en la vista previa (300/1080 del ancho).
    await page.touchscreen.tap(cb.x + cb.width * 300 / 1080, cb.y + cb.height * 300 / 1080); await wait(500);
    await page.getByRole('button', { name: 'OK' }).click(); await wait(500);
    ok('Gama de colores tocando la vista previa', (await call('debugSelection', 300, 300)) === 255 && (await call('debugSelection', 900, 900)) === 0);
  }
  await call('deselect');

  // Fase 11 en el móvil: Revelado y Galería de desenfoques caben en la pantalla.
  await page.getByTestId('m-menu').click(); await wait();
  await sheet().getByRole('button', { name: 'Filtro' }).click(); await wait();
  await sheet().getByRole('button', { name: 'Revelado…' }).click(); await wait(800);
  {
    const mb = await page.locator('.modal').boundingBox();
    ok('Revelado en el móvil: cabe y muestra la vista previa', (await S()).dialog?.kind === 'develop' && mb.x >= 0 && mb.x + mb.width <= 391 && (await page.getByTestId('develop-preview').boundingBox()).height > 100, JSON.stringify(mb));
    await page.getByLabel('Exposición (valor)').fill('0.5'); await wait(300);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForFunction(() => { const s = window.__lienzoStore.getState(); return s.doc.history[s.doc.historyIndex]?.label === 'Revelado'; }, null, { timeout: 30000 }).catch(() => {});
    ok('Aplicar el revelado desde el móvil', (await S()).doc.history[(await S()).doc.historyIndex]?.label === 'Revelado');
  }
  await page.getByTestId('m-menu').click(); await wait();
  await sheet().getByRole('button', { name: 'Filtro' }).click(); await wait();
  await sheet().getByRole('button', { name: 'Galería de desenfoques' }).click(); await wait();
  await sheet().getByRole('button', { name: 'Desenfoque de iris…' }).click(); await wait(800);
  {
    const mb = await page.locator('.modal').boundingBox();
    ok('Galería de desenfoques en el móvil', (await S()).dialog?.kind === 'blurGallery' && mb.x >= 0 && mb.x + mb.width <= 391);
    await page.getByRole('button', { name: 'Cancelar' }).click(); await wait(300);
  }

  // Fase 12 en el móvil: selector de pinceles.
  await page.evaluate(() => window.__lienzoStore.getState().setTool('brush')); await wait(200);
  await page.getByLabel('Valores preestablecidos de pincel').click(); await wait(300);
  {
    const bb = await page.getByTestId('brush-presets').boundingBox();
    ok('Selector de pinceles en el móvil: cabe en la pantalla', !!bb && bb.x >= 0 && bb.x + bb.width <= 391, JSON.stringify(bb));
    await page.locator('.brush-item', { hasText: 'Tiza' }).click(); await wait(300);
    ok('Elegir un pincel desde el móvil', (await page.evaluate(() => window.__lienzoStore.getState().brush.tip)) === 'gen:chalk');
    await page.evaluate(() => window.__lienzoStore.getState().setBrush({ tip: null, dyn: undefined, preset: undefined, spacing: 0.25 }));
  }

  // Fase 13 en el móvil: línea de tiempo, exportar como (formatos nuevos) y modo de color.
  await page.getByTestId('m-menu').click(); await wait();
  await sheet().getByRole('button', { name: 'Ventana' }).click(); await wait();
  await sheet().getByRole('button', { name: 'Línea de tiempo' }).click(); await wait(400);
  {
    const tb = await page.getByTestId('timeline').boundingBox();
    ok('Línea de tiempo en el móvil: cabe y deja sitio al lienzo', !!tb && tb.x >= 0 && tb.x + tb.width <= 391 && (await page.getByTestId('canvas-area').boundingBox()).height > 250, JSON.stringify(tb));
    await page.getByRole('button', { name: 'Crear animación de cuadros' }).click();
    await page.waitForFunction(() => window.__lienzoStore.getState().doc.frames?.length === 1, null, { timeout: 5000 }).catch(() => {});
    await wait(300);
    await page.getByRole('button', { name: 'Duplicar cuadro' }).click();
    await page.waitForFunction(() => window.__lienzoStore.getState().doc.frames?.length === 2, null, { timeout: 5000 }).catch(() => {});
    ok('Cuadros desde el móvil', (await S()).doc.frames?.length === 2 && (await page.getByTestId('frame').count()) === 2, JSON.stringify([(await S()).doc.frames?.length, await page.getByTestId('frame').count(), await page.getByTestId('timeline').boundingBox()]));
    await page.screenshot({ path: 'tests/out-mobile-timeline.png' });
    await page.getByRole('button', { name: 'Eliminar cuadro' }).click(); await wait(200);
    await page.getByRole('button', { name: 'Eliminar cuadro' }).click(); await wait(200);
    await page.getByLabel('Cerrar línea de tiempo').click(); await wait(300);
    ok('Cerrar la línea de tiempo en el móvil', !(await page.getByTestId('timeline').isVisible().catch(() => false)) && !(await S()).doc.frames?.length);
  }
  await page.evaluate(() => window.__lienzoStore.getState().setDialog({ kind: 'export' })); await wait(300);
  {
    const opts = await page.getByLabel('Formato').locator('option').allInnerTexts();
    const mb = await page.locator('.modal').boundingBox();
    ok('Exportar como en el móvil: TIFF, PDF, SVG y GIF; cabe en pantalla', ['TIFF', 'PDF', 'SVG', 'GIF'].every((f) => opts.includes(f)) && mb.x >= 0 && mb.x + mb.width <= 391, opts.join(','));
    await page.getByLabel('Formato').selectOption('application/pdf'); await wait(100);
    ok('PDF en el móvil ofrece CMYK', (await page.getByLabel('Color').locator('option').allInnerTexts()).some((t) => /CMYK/.test(t)));
    await page.getByRole('button', { name: 'Cancelar' }).click(); await wait(200);
  }
  await call('setMode', 'cmyk'); await wait(300);
  ok('Modo CMYK en el móvil (vista de prueba)', (await S()).doc.mode === 'cmyk');
  await call('undo'); await wait(200);

  // Deformación de posición libre con el dedo: tocar pone chinchetas y arrastrar deforma.
  await page.getByTestId('m-menu').click(); await wait();
  await sheet().getByRole('button', { name: 'Edición' }).click(); await wait();
  await sheet().getByRole('button', { name: 'Deformación de posición libre' }).click(); await wait(500);
  ok('Deformación de posición libre desde el menú del móvil', !!(await page.evaluate(() => window.__lienzoStore.getState().puppet)) && /Aplicar/.test(await page.getByTestId('m-context').innerText()));
  for (const p of [[200, 200], [400, 400]]) { await touch('touchStart', [await scr(...p)]); await wait(60); await touch('touchEnd', []); await wait(250); }
  ok('Tocar añade chinchetas', (await page.locator('.puppet-pin').count()) === 2);
  await drag(await scr(400, 400), await scr(480, 470), 8);
  await page.getByTestId('m-context').getByRole('button', { name: 'Aplicar' }).click(); await wait(800);
  ok('Arrastrar una chincheta y aplicar deforma la capa', !(await page.evaluate(() => window.__lienzoStore.getState().puppet)) && (await call('debugSelection', 0, 0)) === 0 && (await S()).doc.history[(await S()).doc.historyIndex]?.label === 'Deformación de posición libre');
  // Deformar desde la barra contextual de Transformar.
  await call('selectShape', { x: 100, y: 100, w: 400, h: 400 }, 'rect', 'replace', 0);
  await page.getByTestId('m-context').getByRole('button', { name: 'Transformar' }).click(); await wait(400);
  await page.getByTestId('m-context').getByRole('button', { name: 'Deformar' }).click(); await wait(300);
  ok('Transformar → Deformar en el móvil muestra la malla', (await page.evaluate(() => window.__lienzoStore.getState().transform?.mode)) === 'warp' && (await page.locator('.warp-grid').count()) >= 4);
  await page.getByTestId('m-context').getByRole('button', { name: 'Cancelar' }).click(); await wait(300);
  await call('deselect');

  // Lápiz: los dedos ya no pintan (rechazo de la palma) y desplazan.
  await page.evaluate(() => window.__lienzoStore.getState().setTool('brush'));
  await page.evaluate(() => {
    const el = document.querySelector('.canvas-area canvas');
    const r = el.getBoundingClientRect();
    const o = { pointerId: 99, pointerType: 'pen', clientX: r.x + 50, clientY: r.y + 50, bubbles: true, pressure: 0.5, button: 0, buttons: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
  });
  await wait(300);
  const hBefore = (await S()).doc.historyIndex, pan0 = (await S()).view.panX;
  await drag([100, 450], [200, 450], 6);
  ok('Tras usar un lápiz, un dedo desplaza y no pinta', (await S()).doc.historyIndex === hBefore && Math.abs((await S()).view.panX - pan0 - 100) < 3, `${(await S()).view.panX - pan0}`);

  await page.getByTestId('m-menu').click(); await wait();
  await page.getByTestId('m-desktop').click(); await wait(500);
  ok('Cambiar a la interfaz de escritorio', (await page.locator('.app.mobile').count()) === 0 && await page.locator('.toolbar').isVisible());
  ok('El documento sigue abierto y se ve tras cambiar de interfaz', (await S()).doc.open && (await call('debugPixel', 500, 540))[3] === 255);
  await page.evaluate(() => { const s = window.__lienzoStore.getState(); window.__lienzoStore.setState({ layout: 'auto' }); });
  await wait(400);
  ok('Volver a la interfaz automática (móvil)', (await page.locator('.app.mobile').count()) === 1);
  await page.evaluate(() => localStorage.removeItem('lienzo:layout'));
  await page.screenshot({ path: 'tests/out-mobile.png' });
  await m.ctx.close();

  // =========================================================== TELÉFONO EN HORIZONTAL (844 × 390)
  const l = await open({ width: 844, height: 390 });
  ok('Móvil en horizontal → interfaz móvil', (await l.page.locator('.app.mobile').count()) === 1);
  await l.call('newDoc', 800, 600, 'white', 'h.psd'); await l.wait(500);
  const cb = await l.page.getByTestId('canvas-area').boundingBox();
  ok('En horizontal el lienzo tiene sitio', cb.height > 150 && cb.width > 800, JSON.stringify(cb));
  await l.ctx.close();

  // =========================================================== TABLETA (1180 × 820, táctil)
  const tab = await open({ width: 1180, height: 820 });
  ok('Tableta → interfaz de escritorio', (await tab.page.locator('.app.mobile').count()) === 0 && await tab.page.locator('.toolbar').isVisible());
  const tb = await tab.page.locator('.tool').first().boundingBox();
  ok('En pantalla táctil los botones son más grandes', tb.width >= 40 && tb.height >= 36, `${tb.width}×${tb.height}`);
  await tab.call('newDoc', 800, 600, 'white', 't.psd'); await tab.wait(500);
  const tz0 = (await tab.S()).view.zoom, tc = await tab.scr(400, 300);
  await tab.touch('touchStart', [[tc[0] - 50, tc[1]], [tc[0] + 50, tc[1]]]);
  for (let i = 1; i <= 5; i++) { await tab.touch('touchMove', [[tc[0] - 50 - i * 10, tc[1]], [tc[0] + 50 + i * 10, tc[1]]]); await tab.wait(16); }
  await tab.touch('touchEnd', []); await tab.wait(300);
  ok('Pellizcar también funciona en la interfaz de escritorio', Math.abs((await tab.S()).view.zoom / tz0 - 2) < 0.1);
  await tab.ctx.close();

  // =========================================================== INGLÉS EN EL MÓVIL
  {
    const ctxE = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en-US' });
    const pe = await ctxE.newPage();
    pe.on('pageerror', (e) => errors.push(String(e)));
    await pe.goto(URL);
    await pe.waitForFunction(() => window.__lienzoStore?.getState().ready, null, { timeout: 20000 });
    ok('Navegador en inglés → interfaz en inglés (portada)', (await pe.locator('body').innerText()).includes('New project') || /Open/.test(await pe.locator('body').innerText()), (await pe.locator('body').innerText()).slice(0, 120).replace(/\n/g, ' | '));
    await pe.evaluate(() => window.__lienzo.call('newDoc', 800, 600, 'white', 'en.psd')); await pe.waitForTimeout(500);
    await pe.getByTestId('m-menu').click(); await pe.waitForTimeout(250);
    const rows = await pe.getByTestId('m-sheet').locator('.m-row').allInnerTexts();
    ok('Menú del móvil en inglés', rows.some((r) => /^File/.test(r)) && rows.some((r) => /^Image/.test(r)), rows.slice(0, 6).join(','));
    await ctxE.close();
  }

  ok('Sin errores en consola', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  ok('Excepción en la prueba', false, String(e.stack ?? e));
} finally {
  await browser.close();
  stopServer();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`);
if (failed.length) console.log('Fallos:\n' + failed.map((f) => ` - ${f.name}: ${f.extra}`).join('\n'));
process.exit(failed.length ? 1 : 0);
