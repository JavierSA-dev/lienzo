// Fase 13: salida (modos de color, prueba de colores, TIFF/PDF/SVG/GIF, animación, lotes e idioma).
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const PORT = 4180;
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

  const spx = (x, y) => call('debugScreenPixel', x, y);
  /** Exporta y guarda en tests/ ; devuelve la ruta y los bytes. */
  const exportTo = async (name, type, opts = {}, quality = 1, scales = [1]) => {
    const files = await page.evaluate(async ([type, quality, scales, opts]) => {
      const fs = await window.__lienzo.call('exportSet', type, quality, scales, 'document', opts);
      const out = [];
      for (const f of fs) { const b = new Uint8Array(await f.blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); out.push({ name: f.name, b64: btoa(s) }); }
      return out;
    }, [type, quality, scales, opts]);
    const buf = Buffer.from(files[0].b64, 'base64');
    const path = `tests/out-${name}`;
    writeFileSync(path, buf);
    return { path, buf, names: files.map((f) => f.name) };
  };
  const py = (code) => execSync(`python3 -c "${code.replace(/"/g, '\\"')}"`).toString().trim();

  // =========================================================== MODOS DE COLOR
  await newDoc(300, 200, 'white');
  await call('selectShape', { x: 0, y: 0, w: 100, h: 200 }, 'rect', 'replace', 0); await call('fill', [255, 0, 0, 255]);
  await call('selectShape', { x: 100, y: 0, w: 100, h: 200 }, 'rect', 'replace', 0); await call('fill', [0, 255, 0, 255]);
  await call('selectShape', { x: 200, y: 0, w: 100, h: 200 }, 'rect', 'replace', 0); await call('fill', [70, 110, 150, 255]);
  await call('deselect');
  {
    const s0 = await spx(50, 100);
    ok('Vista normal: rojo puro en pantalla', near(s0.slice(0, 3), [255, 0, 0], 3), JSON.stringify(s0));
    await key('Control+y', 300);
    const s1 = await spx(50, 100), s2 = await spx(250, 100);
    ok('Prueba de colores (Ctrl+Y) apaga el rojo fuera de gama', (await S()).doc.proof && s1[0] < 245 && s1[0] > 150, JSON.stringify(s1));
    ok('…y conserva un azul imprimible', near(s2.slice(0, 3), [70, 110, 150], 30), JSON.stringify(s2));
    ok('Prueba sin tocar los píxeles', near(await lpx(50, 100), [255, 0, 0, 255], 0));
    await key('Control+y', 200);
    await key('Control+Shift+y', 300);
    const g1 = await spx(150, 100), g2 = await spx(250, 100);
    ok('Avisar sobre gama: gris en el verde puro', near(g1.slice(0, 3), [128, 128, 128], 4) && !near(g2.slice(0, 3), [128, 128, 128], 20), JSON.stringify([g1, g2]));
    await key('Control+Shift+y', 200);
  }
  await menu('Imagen', 'Modo', 'Color CMYK');
  await wait(400);
  {
    const st = await S();
    ok('Imagen > Modo > Color CMYK', st.doc.mode === 'cmyk');
    const p = await lpx(50, 100);
    ok('CMYK lleva los píxeles a la gama imprimible', p[0] < 250 && p[0] > 150, JSON.stringify(p));
    await page.getByTestId('tab-Canales').click();
    await wait(500);
    const rows = await page.getByTestId('channel-row').allInnerTexts();
    ok('Panel Canales en CMYK: CMYK, Cian, Magenta, Amarillo, Negro', rows.join('|') === 'CMYK|Cian|Magenta|Amarillo|Negro', rows.join('|'));
    await page.getByTestId('channel-row').nth(1).click(); await wait(300);
    const c1 = await spx(50, 100), c2 = await spx(250, 100);
    ok('Canal Cian: poco cian en el rojo (claro) y mucho en el azul (oscuro)', c1[0] > 200 && c2[0] < 80, JSON.stringify([c1, c2]));
    await page.getByTestId('channel-row').nth(0).click(); await wait(200);
    await key('Control+z', 400);
    ok('Deshacer el cambio de modo', (await S()).doc.mode === 'rgb' && near(await lpx(50, 100), [255, 0, 0, 255], 0));
  }
  await menu('Imagen', 'Modo', 'Escala de grises');
  await wait(400);
  {
    const st = await S();
    const p = await lpx(50, 100), s = await spx(250, 100);
    ok('Escala de grises: píxeles grises', st.doc.mode === 'gray' && p[0] === p[1] && p[1] === p[2] && Math.abs(p[0] - 76) <= 2, JSON.stringify(p));
    ok('Escala de grises: colores de pintura grises', /^#([0-9a-f]{2})\1\1$/.test(st.fg) && /^#([0-9a-f]{2})\1\1$/.test(st.bg), st.fg + ' ' + st.bg);
    ok('Vista en gris', s[0] === s[1] && s[1] === s[2], JSON.stringify(s));
    const rows = await page.getByTestId('channel-row').allInnerTexts();
    ok('Panel Canales en gris: un canal', rows.join('|') === 'Gris', rows.join('|'));
    await key('Control+z', 300);
  }

  // =========================================================== SELECTOR DE COLOR: CMYK Y GAMA
  await page.evaluate(() => window.__lienzoStore.getState().setColors('#00ff00', '#ffffff'));
  await page.evaluate(() => window.__lienzoStore.getState().setDialog({ kind: 'colorPicker', which: 'fg' }));
  await wait(300);
  {
    const vals = await page.getByTestId('cp-cmyk').locator('input').evaluateAll((els) => els.map((e) => Number(e.value)));
    ok('Selector de color: valores CMYK', vals.length === 4 && vals[0] > 40 && vals[2] > 60 && vals[1] < 30, JSON.stringify(vals));
    ok('Selector de color: aviso de gama en el verde puro', await page.getByTestId('cp-gamut').isVisible());
    await page.getByTestId('cp-gamut').click(); await wait(150);
    ok('Clic en el aviso: color imprimible', !(await page.getByTestId('cp-gamut').isVisible().catch(() => false)));
    await page.getByRole('button', { name: 'Cancelar' }).click(); await wait(150);
  }

  // =========================================================== RESOLUCIÓN
  await key('Control+Alt+i', 300);
  await page.getByLabel('Resolución').fill('300'); await wait(100);
  ok('Tamaño de impresión a 300 ppp', (await page.getByTestId('print-size').innerText()).includes('2,54 × 1,69'), await page.getByTestId('print-size').innerText());
  await page.getByRole('button', { name: 'OK' }).click(); await wait(300);
  ok('Resolución del documento', (await S()).doc.dpi === 300 && (await S()).doc.width === 300);

  // =========================================================== TIFF
  {
    const { path } = await exportTo('rgb.tif', 'image/tiff', { color: 'rgb' });
    const info = py(`from PIL import Image; im=Image.open('${path}'); print(im.mode, im.size, im.getpixel((50,100)), im.getpixel((250,100)), round(im.info.get('dpi',(0,0))[0]))`);
    ok('TIFF RGB (Deflate) legible por PIL', info.startsWith('RGBA (300, 200) (255, 0, 0, 255) (70, 110, 150, 255) 300'), info);
    const c = await exportTo('cmyk.tif', 'image/tiff', { color: 'cmyk' });
    const ci = py(`from PIL import Image; im=Image.open('${c.path}'); print(im.mode, im.getpixel((250,100)), im.getpixel((50,100)))`);
    ok('TIFF CMYK', ci.startsWith('CMYK'), ci);
    const m = ci.match(/\((\d+), (\d+), (\d+), (\d+)\) \((\d+), (\d+), (\d+), (\d+)\)/);
    ok('TIFF CMYK: azul = mucho cian; rojo = magenta y amarillo', m && +m[1] > 150 && +m[2] < 140 && +m[6] > 180 && +m[7] > 180 && +m[5] < 40, ci);
    const g = await exportTo('gray.tif', 'image/tiff', { color: 'gray', alpha: false });
    const gi = py(`from PIL import Image; im=Image.open('${g.path}'); print(im.mode, im.getpixel((50,100)))`);
    ok('TIFF en escala de grises', gi === 'L 76', gi);
  }

  // =========================================================== PDF
  {
    const { path, buf } = await exportTo('rgb.pdf', 'application/pdf', { color: 'rgb' });
    let check = '';
    try { check = execSync(`qpdf --check ${path} 2>&1`).toString(); } catch (e) { check = String(e.stdout); }
    ok('PDF RGB válido (qpdf)', /No syntax or stream encoding errors/.test(check), check.split('\n').slice(0, 3).join(' / '));
    ok('PDF a 300 ppp: página de 72 × 48 pt', /MediaBox \[0 0 72\.000 48\.000\]/.test(buf.toString('latin1')));
    execSync(`pdftoppm -r 300 -png -singlefile ${path} tests/out-pdf`);
    const r = py(`from PIL import Image; im=Image.open('tests/out-pdf.png').convert('RGB'); print(im.size, im.getpixel((50,100)), im.getpixel((250,100)))`);
    ok('PDF renderizado (pdftoppm) con los colores', r.startsWith('(300, 200) (255, 0, 0) (70, 110, 150)') || /\(25[0-5], [0-4], [0-4]\)/.test(r), r);
    const c = await exportTo('cmyk.pdf', 'application/pdf', { color: 'cmyk' });
    ok('PDF CMYK (DeviceCMYK)', /DeviceCMYK/.test(c.buf.toString('latin1')));
    execSync(`pdftoppm -r 300 -png -singlefile ${c.path} tests/out-pdfc`);
    const rc = py(`from PIL import Image; im=Image.open('tests/out-pdfc.png').convert('RGB'); print(im.getpixel((250,100)))`);
    ok('PDF CMYK renderizado: el azul sigue siendo azul', /\((\d+), (\d+), (\d+)\)/.test(rc) && (() => { const [, r2, g2, b2] = rc.match(/\((\d+), (\d+), (\d+)\)/).map(Number); return b2 > r2 + 60 && b2 > 120; })(), rc);
    const j = await exportTo('jpeg.pdf', 'application/pdf', { color: 'rgb' }, 0.8);
    ok('PDF con compresión JPEG más pequeño', /DCTDecode/.test(j.buf.toString('latin1')) && j.buf.length < buf.length, `${j.buf.length} < ${buf.length}`);
  }

  // =========================================================== GIF
  {
    const { path } = await exportTo('img.gif', 'image/gif', { colors: 16 });
    const info = execSync(`identify -format "%m %w %h %k\n" ${path}`).toString().trim();
    ok('GIF de 16 colores', /^GIF 300 200 (1[0-6]|[2-9])$/.test(info), info);
    const p = py(`from PIL import Image; im=Image.open('${path}').convert('RGB'); print(im.getpixel((50,100)))`);
    ok('GIF conserva el rojo', /\(2[3-5]\d, \d{1,2}, \d{1,2}\)/.test(p), p);
  }

  // =========================================================== SVG
  await newDoc(400, 300, 'white');
  await useTool('shape');
  await page.evaluate(() => { const s = window.__lienzoStore.getState(); s.setOpts({ shapeKind: 'ellipse' }); s.setColors('#c81e1e', '#ffffff'); });
  await drag([50, 50], [150, 150]);
  await call('createText', { text: 'Hola SVG', x: 200, y: 200, size: 32, font: 'Arial', color: [0, 0, 255, 255] });
  await wait(300);
  {
    const st = await S();
    const { path, buf } = await exportTo('doc.svg', 'image/svg+xml');
    const svg = buf.toString('utf8');
    ok('SVG: la elipse como vector', /<ellipse [^>]*fill="rgb\(200,30,30\)"/.test(svg), svg.slice(0, 300));
    ok('SVG: el fondo como imagen', /<image [^>]*href="data:image\/png;base64,/.test(svg));
    const hasText = st.doc.layers.some((l) => l.kind === 'text');
    ok('SVG: el texto como <text>', !hasText || /<text [^>]*>.*Hola SVG/.test(svg), hasText ? '' : '(sin capa de texto)');
    // El navegador lo dibuja igual que el lienzo.
    const r = await page.evaluate(async (svg) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
      await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      return [c.width, c.height, [...x.getImageData(100, 100, 1, 1).data], [...x.getImageData(10, 10, 1, 1).data]];
    }, svg);
    ok('SVG renderizado igual que el lienzo', r[0] === 400 && r[1] === 300 && near(r[2], [200, 30, 30, 255], 2) && near(r[3], [255, 255, 255, 255], 1), JSON.stringify(r));
  }

  // =========================================================== EXPORTAR COMO (diálogo)
  await key('Control+Alt+Shift+w', 300);
  {
    const opts = await page.getByLabel('Formato').locator('option').allInnerTexts();
    ok('Exportar como: PNG, JPEG, WebP, GIF, TIFF, PDF y SVG', opts.join(',') === 'PNG,JPEG,WebP,GIF,TIFF,PDF,SVG', opts.join(','));
    await page.getByLabel('Formato').selectOption('image/tiff'); await wait(100);
    ok('TIFF ofrece RGB/CMYK/gris', (await page.getByLabel('Color').locator('option').count()) === 3);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar' }).click()]);
    ok('Descarga del TIFF desde el diálogo', dl.suggestedFilename().endsWith('.tif'), dl.suggestedFilename());
  }

  // =========================================================== LÍNEA DE TIEMPO
  await newDoc(200, 100, 'white');
  await call('newLayer');
  await call('selectShape', { x: 0, y: 30, w: 40, h: 40 }, 'rect', 'replace', 0); await call('fill', [255, 0, 0, 255]); await call('deselect');
  await menu('Ventana', 'Línea de tiempo');
  ok('Ventana > Línea de tiempo', await page.getByTestId('timeline').isVisible());
  await page.getByRole('button', { name: 'Crear animación de cuadros' }).click(); await wait(300);
  ok('Crear animación de cuadros', (await S()).doc.frames?.length === 1);
  await page.getByRole('button', { name: 'Duplicar cuadro' }).click(); await wait(300);
  ok('Duplicar cuadro', (await S()).doc.frames?.length === 2 && (await S()).doc.activeFrame === 1);
  await call('moveLayerBy', 150, 0);
  const lid = (await active()).id;
  await call('setLayer', lid, { opacity: 0.5 });
  await wait(200);
  await page.getByTestId('frame').nth(0).click(); await wait(300);
  ok('Cuadro 1: la capa vuelve a su sitio y opacidad', near(await px(20, 50), [255, 0, 0, 255], 2) && near(await px(170, 50), [255, 255, 255, 255], 2), JSON.stringify([await px(20, 50), await px(170, 50)]));
  await page.getByTestId('frame').nth(1).click(); await wait(300);
  ok('Cuadro 2: movida y al 50 %', near(await px(170, 50), [255, 128, 128, 255], 3) && near(await px(20, 50), [255, 255, 255, 255], 2), JSON.stringify(await px(170, 50)));
  await page.getByTestId('frame').nth(0).click(); await wait(200);
  await page.getByRole('button', { name: 'Interpolar' }).click(); await wait(200);
  await page.getByLabel('Cuadros que añadir').fill('3');
  await page.getByRole('button', { name: 'OK' }).click(); await wait(300);
  {
    const st = await S();
    ok('Interpolar 3 cuadros', st.doc.frames.length === 5, String(st.doc.frames.length));
    await page.getByTestId('frame').nth(2).click(); await wait(300);
    const mid = await px(95, 50);
    ok('Cuadro intermedio: a mitad de camino y opacidad intermedia', mid[0] === 255 && mid[1] > 50 && mid[1] < 80 && near(await px(20, 50), [255, 255, 255, 255], 2), JSON.stringify(mid));
  }
  await page.getByTestId('frame-delay').first().click(); await wait(100);
  await page.locator('.frame-menu button', { hasText: '0,5 s' }).click(); await wait(200);
  ok('Retardo del cuadro', (await S()).doc.frames[0].delay === 500);
  await page.getByLabel('Repetición').selectOption('3'); await wait(150);
  ok('Opciones de repetición', (await S()).doc.loop === 3);
  await page.getByRole('button', { name: 'Reproducir' }).click(); await wait(900);
  const seen = new Set();
  for (let i = 0; i < 6; i++) { seen.add((await S()).doc.activeFrame); await wait(120); }
  ok('Reproducir recorre los cuadros', seen.size >= 2, [...seen].join(','));
  await page.getByRole('button', { name: 'Detener' }).click(); await wait(200);
  {
    const files = await page.evaluate(async () => {
      const fs = await window.__lienzo.call('timelineExport', { colors: 64 });
      const b = new Uint8Array(await fs[0].blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return [{ name: fs[0].name, b64: btoa(s) }];
    });
    writeFileSync('tests/out-anim.gif', Buffer.from(files[0].b64, 'base64'));
    const info = execSync('identify -format "%T " tests/out-anim.gif').toString().trim().split(/\s+/);
    ok('GIF animado: 5 cuadros con sus retardos', info.length === 5 && info[0] === '50' && info[1] === '10', info.join(','));
    const loop = py("from PIL import Image; im=Image.open('tests/out-anim.gif'); print(im.info.get('loop'))");
    ok('GIF animado: repite 3 veces', loop === '2', loop);
  }
  {
    // La línea de tiempo se guarda en el PSD.
    const b64 = await page.evaluate(async () => { const u = await window.__lienzo.call('savePsd'); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); });
    await page.evaluate(async (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); await window.__lienzo.call('open', 'anim.psd', u.buffer, 'image/vnd.adobe.photoshop'); }, b64);
    await wait(400);
    const st = await S();
    ok('PSD conserva la animación', st.doc.frames?.length === 5 && st.doc.frames[0].delay === 500 && st.doc.loop === 3, JSON.stringify(st.doc.frames?.map((f) => f.delay)));
    await page.getByTestId('frame').nth(4).click(); await wait(300);
    ok('…y el estado de cada cuadro', near(await px(170, 50), [255, 128, 128, 255], 3), JSON.stringify(await px(170, 50)));
  }
  await menu('Ventana', 'Línea de tiempo');
  ok('Cerrar la línea de tiempo', !(await page.getByTestId('timeline').isVisible().catch(() => false)));

  // =========================================================== ACCIONES CON PARÁMETROS Y LOTE
  await newDoc(400, 300, 'white');
  await page.evaluate(() => { const s = window.__lienzoStore; s.setState({ actions: [...s.getState().actions, { name: 'Miniatura negativa', steps: [] }], recording: true }); });
  await key('Control+i', 300);
  await key('Control+Alt+i', 300);
  await page.locator('.modal input[type=number]').first().fill('100'); await wait(100);
  await page.getByRole('button', { name: 'OK' }).click(); await wait(500);
  await page.evaluate(() => window.__lienzoStore.setState({ recording: false }));
  {
    const act = (await S()).actions.at(-1);
    ok('Grabar acción con parámetros (Tamaño de imagen)', act.steps.length === 2 && act.steps[0].id === 'image.invert' && act.steps[1].id === 'call:resizeImage' && act.steps[1].args[0] === 100, JSON.stringify(act.steps));
  }
  await menu('Archivo', 'Automatizar', 'Lote…');
  await page.getByLabel('Archivos del lote').setInputFiles(['tests/fixtures/pano1.jpg', 'tests/fixtures/pano2.jpg', 'tests/fixtures/hdr1.jpg']);
  await wait(200);
  ok('Lote: 3 archivos', (await page.getByTestId('batch-count').innerText()).startsWith('3 archivos'));
  await page.getByLabel('Formato del lote').selectOption('image/png');
  await page.getByLabel('Sufijo').fill('_mini');
  {
    const docsBefore = (await S()).doc.docs.length;
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('button', { name: 'Ejecutar' }).click()]);
    const path = 'tests/out-lote.zip';
    await dl.saveAs(path);
    const list = execSync(`python3 -c "import zipfile; z=zipfile.ZipFile('${path}'); print(' '.join(sorted(z.namelist())))"`).toString().trim();
    ok('Lote: ZIP con los 3 resultados renombrados', list === 'hdr1_mini.png pano1_mini.png pano2_mini.png', list);
    const info = execSync(`python3 -c "import zipfile,io; from PIL import Image; z=zipfile.ZipFile('${path}'); im=Image.open(io.BytesIO(z.read('pano1_mini.png'))); print(im.size[0])"`).toString().trim();
    ok('Lote: la acción se aplicó (100 px de ancho)', info === '100', info);
    await wait(300);
    ok('Lote: no deja documentos abiertos', (await S()).doc.docs.length === docsBefore, `${(await S()).doc.docs.length} vs ${docsBefore}`);
  }

  // =========================================================== IDIOMA: INGLÉS
  await page.goto(URL + '?lang=en');
  await page.waitForFunction(() => window.__lienzoStore?.getState().ready, null, { timeout: 20000 });
  await call('newDoc', 400, 300, 'white', 'english.psd'); await wait(400);
  {
    const menus = await page.locator('.menu-btn').allInnerTexts();
    ok('Interfaz en inglés: menús', menus.slice(0, 4).join(',') === 'File,Edit,Image,Layer', menus.join(','));
    await page.locator('.menu-btn', { hasText: /^Image$/ }).click();
    await page.locator('.menu-pop .menu-sub > .menu-item', { hasText: /^Mode▸/ }).hover(); await wait(100);
    const items = await page.locator('.menu-pop.side').last().innerText();
    ok('Imagen > Modo en inglés', /Grayscale/.test(items) && /RGB Color/.test(items) && /CMYK Color/.test(items), items.replace(/\n/g, ' | '));
    await page.keyboard.press('Escape'); await page.mouse.click(700, 500); await wait(100);
    await key('Control+Alt+i', 300);
    ok('Diálogo en inglés (Image Size)', (await page.locator('.modal').innerText()).includes('Image Size') && (await page.locator('.modal').innerText()).includes('Resolution (ppi)'));
    await page.getByRole('button', { name: 'Cancel' }).click(); await wait(150);
    const layerName = await page.locator('.layer .name').first().innerText();
    ok('Nombre de capa por defecto en inglés', /Background|Layer/.test(layerName), layerName);
    const tip = await page.locator('[data-testid="tool-brush"], .toolbar button').first().getAttribute('title');
    ok('Información de herramientas en inglés', !!tip && !/Mayús|alterna/.test(tip), tip ?? '');
    ok('lang="en" en el documento', (await page.evaluate(() => document.documentElement.lang)) === 'en');
    await page.locator('.menu-btn', { hasText: /^Help$/ }).click();
    await page.locator('.menu-pop .menu-sub > .menu-item', { hasText: /^Language▸/ }).hover(); await wait(100);
    await Promise.all([page.waitForNavigation(), page.locator('.menu-pop button.menu-item', { hasText: /Español/ }).last().click()]);
    await page.waitForFunction(() => window.__lienzoStore?.getState().ready, null, { timeout: 20000 });
    ok('Volver al español', (await page.evaluate(() => document.documentElement.lang)) === 'es');
  }

  await page.screenshot({ path: 'tests/out-output.png' });
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
