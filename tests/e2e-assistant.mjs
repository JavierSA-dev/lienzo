// Asistente de IA: intérprete local, bucle con el modelo (simulado), deshacer, errores y móvil.
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const PORT = 4182;
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

  const panel = () => page.getByTestId('assistant');
  const ask = async (text, ms = 1500) => {
    await page.getByLabel('Petición al asistente').fill(text);
    await page.getByLabel('Petición al asistente').press('Enter');
    await page.waitForFunction(() => !document.querySelector('.amsg.pending'), null, { timeout: 30000 }).catch(() => {});
    await wait(ms);
  };
  const lastReply = () => page.getByTestId('amsg-assistant').last().innerText();

  await newDoc(400, 300, 'white');
  await call('fill', [60, 60, 60, 255]);
  await call('selectShape', { x: 50, y: 50, w: 100, h: 100 }, 'rect', 'replace', 0); await call('fill', [200, 40, 40, 255]); await call('deselect');
  await page.getByTestId('assistant-btn').click(); await wait(300);
  ok('Botón Asistente abre el panel', await panel().isVisible());
  ok('Sugerencias con el documento abierto', (await panel().locator('.assistant-chips .chip').count()) >= 4);

  // --- intérprete local
  await panel().locator('.chip', { hasText: 'Blanco y negro' }).click(); await wait(1200);
  {
    const st = await S();
    ok('Sugerencia "Blanco y negro" → capa de ajuste', st.doc.layers.some((l) => l.kind === 'adjustment'), st.doc.layers.map((l) => l.kind).join(','));
    const r = await lastReply();
    ok('Respuesta con la acción hecha y "Local"', /Capa de ajuste blackWhite/.test(r) && /Local/.test(r), r.replace(/\n/g, ' | '));
    const p = await px(100, 100);
    ok('El rojo se ve gris', Math.abs(p[0] - p[1]) < 6, JSON.stringify(p));
  }
  await ask('recorta a 1:1 y luego redimensiona al 50%');
  ok('Varias órdenes en una frase (recorte 1:1 y 50 %)', (await S()).doc.width === 150 && (await S()).doc.height === 150, `${(await S()).doc.width}×${(await S()).doc.height}`);
  await page.getByRole('button', { name: 'Deshacer' }).last().click(); await wait(600);
  ok('Deshacer todo lo que hizo el asistente de una vez', (await S()).doc.width === 400 && (await S()).doc.height === 300 && (await S()).doc.layers.some((l) => l.kind === 'adjustment'));
  {
    const adj = (await S()).doc.layers.find((l) => l.kind === 'adjustment');
    await call('setLayer', adj.id, { visible: false });
    await call('selectLayer', (await S()).doc.layers[0].id);
    const before = (await px(300, 250))[0];
    await ask('mejora la foto', 2500);
    const after = (await px(300, 250))[0];
    ok('"Mejora la foto" aclara una imagen oscura', after > before + 10, `${before} → ${after}`);
  }
  await ask('añade el texto "Hola" arriba en blanco');
  {
    const t = (await S()).doc.layers.find((l) => l.kind === 'text');
    ok('Añadir texto arriba en blanco', !!t && /Hola/.test(t.name), t?.name ?? '');
  }
  await ask('crop square');
  ok('Órdenes en inglés (crop square)', (await S()).doc.width === (await S()).doc.height);

  // --- modelo de IA (simulado)
  const calls = [];
  const devices = new Set();
  await page.route('**/api/assistant', async (route) => {
    devices.add(route.request().headers()['x-lienzo-device']);
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, limit: 10, left: 10 }) });
    const body = JSON.parse(route.request().postData());
    calls.push(body);
    const last = body.messages.at(-1);
    const isResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
    if (!isResult) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'Voy a darle un aire veraniego.' }, { type: 'tool_use', id: 'tu_1', name: 'develop', input: { temp: 40, vibrance: 30 } }] }) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Listo: más cálida y con colores más vivos.' }], left: 9, limit: 10 }) });
    }
  });
  {
    await call('selectLayer', (await S()).doc.layers[0].id);
    const before = await px(10, 10);
    await ask('haz que parezca una postal de verano', 2000);
    const after = await px(10, 10);
    const r = await lastReply();
    ok('Petición libre → modelo de IA (2 llamadas: herramienta y respuesta)', calls.length === 2, String(calls.length));
    ok('Se envían las herramientas, la miniatura y el resumen', calls[0].tools.some((t) => t.name === 'develop') && calls[0].messages.at(-1).content.some((b) => b.type === 'image') && /Documento: \{/.test(JSON.stringify(calls[0].messages.at(-1).content)));
    ok('El resultado de la herramienta vuelve al modelo', calls[1].messages.at(-1).content[0].type === 'tool_result' && calls[1].messages.at(-1).content[0].tool_use_id === 'tu_1');
    ok('La herramienta se ejecuta (más cálida)', after[0] - after[2] > before[0] - before[2] + 5, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    ok('Cuota de la versión de pruebas visible y actualizada (9 de 10)', /quedan 9 de 10 peticiones de IA hoy/i.test(await page.getByTestId('assistant-quota').innerText()), await page.getByTestId('assistant-quota').innerText());
    ok('Se envía un identificador de navegador estable', devices.size === 1 && /^[0-9a-f-]{36}$/.test([...devices][0] ?? ''), [...devices].join(','));
    ok('Respuesta del modelo en el chat, marcada "IA"', /Listo: más cálida/.test(r) && /\bIA\b/.test(r), r.replace(/\n/g, ' | '));
  }
  // Dibujar con SVG (el modelo escribe el dibujo) y ver el resultado.
  await page.unroute('**/api/assistant');
  const calls2 = [];
  const DOG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 160"><ellipse cx="100" cy="100" rx="70" ry="45" fill="#c98b4f"/><circle cx="150" cy="60" r="35" fill="#c98b4f"/><ellipse cx="170" cy="40" rx="12" ry="25" fill="#7a4b24"/><circle cx="160" cy="55" r="5" fill="#222"/></svg>';
  await page.route('**/api/assistant', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, limit: 10, left: 8 }) });
    const body = JSON.parse(route.request().postData());
    calls2.push(body);
    const last = body.messages.at(-1);
    const isResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(isResult
      ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'He dibujado **un perro**.' }], left: 7 }
      : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'd1', name: 'draw_svg', input: { svg: DOG, name: 'Perro' } }], left: 8 }) });
  });
  {
    const before = (await S()).doc.layers.length;
    await ask('dibuja un perro', 2500);
    const st = await S();
    const L = st.doc.layers.find((l) => /Perro/.test(l.name));
    ok('Dibujar con SVG: nueva capa (objeto inteligente) con el dibujo', st.doc.layers.length === before + 1 && L?.kind === 'smart', `${L?.kind} ${L?.name}`);
    const res = calls2[1]?.messages.at(-1).content[0];
    ok('Tras dibujar, el modelo recibe una imagen del resultado', Array.isArray(res?.content) && res.content.some((b) => b.type === 'image'));
    ok('Negrita de la respuesta como texto con formato', (await page.locator('.amsg-text b').last().innerText()) === 'un perro');
  }

  await page.unroute('**/api/assistant');
  await page.route('**/api/assistant', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, limit: 10, left: 0 }) })
    : route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'Has usado las 10 peticiones de IA de hoy. Lienzo está en pruebas: cada navegador tiene 10 peticiones de IA al día.', left: 0 }) }));
  await ask('convierte esto en un cuadro de Van Gogh');
  ok('Sin cuota: explica que es una versión de pruebas', /10 peticiones de IA de hoy.*en pruebas/.test(await lastReply()));
  await page.unroute('**/api/assistant');
  await page.route('**/api/assistant', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: false, limit: 10, left: 10 }) })
    : route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'no configurado' }) }));
  await ask('convierte esto en un cuadro de Van Gogh');
  ok('Sin servicio de IA: explica qué entiende en local', /necesita el modelo de IA/.test(await lastReply()));
  await page.unroute('**/api/assistant');
  await page.getByLabel('Petición al asistente').press('Escape'); await wait(200);
  ok('Esc cierra el asistente', !(await panel().isVisible().catch(() => false)));

  // --- IA sobre la selección (barra contextual)
  {
    await newDoc(400, 300, 'white');
    await call('selectShape', { x: 50, y: 50, w: 100, h: 100 }, 'rect', 'replace', 0); await call('fill', [200, 40, 40, 255]);
    await call('selectShape', { x: 40, y: 40, w: 120, h: 120 }, 'rect', 'replace', 0); await wait(300);
    const bar = page.getByTestId('selbar');
    ok('Selección → barra contextual con petición a la IA', await bar.isVisible());
    const bb = await bar.boundingBox(), [, sy] = await scr(0, 160);
    ok('La barra aparece bajo la selección', !!bb && bb.y >= sy - 2 && bb.y < sy + 40, `${bb?.y} vs ${sy}`);
    await page.getByTestId('selbar-input').fill('ponlo azul');
    await page.getByTestId('selbar-input').press('Enter');
    await page.waitForFunction(() => !document.querySelector('.amsg.pending'), null, { timeout: 30000 }).catch(() => {});
    await wait(1200);
    const p = await px(100, 100), out = await px(300, 250);
    ok('«ponlo azul» sobre la selección → azul solo dentro', p[2] > p[0] + 60 && near(out, [255, 255, 255, 255], 2), `${JSON.stringify(p)} fuera ${JSON.stringify(out)}`);
    ok('Lo hace una capa de ajuste Tono/Saturación con máscara', (await S()).doc.layers.some((l) => l.kind === 'adjustment' && l.hasMask), (await S()).doc.layers.map((l) => l.kind).join(','));
    ok('El asistente se abre y muestra lo hecho (local, sin gastar cuota)', /Color cambiado a azul en la selección/.test(await lastReply()) && /Local/.test(await lastReply()), await lastReply());
    await page.getByTestId('selbar-remove').click();
    await page.waitForFunction(() => window.__lienzoStore.getState().doc.history.some((h) => (h.label ?? h) === 'Relleno según contenido'), null, { timeout: 30000 }).catch(() => {});
    await wait(500);
    const q = await px(100, 100);
    ok('Botón Eliminar de la barra: borra lo seleccionado (relleno según contenido)', q[0] > 225 && q[1] > 225 && q[2] > 225, JSON.stringify(q));
    // Petición libre con selección: el modelo recibe la zona ampliada y el aviso de la selección.
    const calls3 = [];
    await page.route('**/api/assistant', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, limit: 10, left: 7 }) });
      calls3.push(JSON.parse(route.request().postData()));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Vale.' }] }) });
    });
    await page.getByTestId('selbar-input').fill('cámbialo por una estrella dorada');
    await page.getByTestId('selbar-go').click();
    await page.waitForFunction(() => !document.querySelector('.amsg.pending'), null, { timeout: 30000 }).catch(() => {});
    await wait(500);
    const msg = calls3[0]?.messages.at(-1).content ?? [];
    ok('Con selección, el modelo recibe la zona ampliada y sabe que hay selección', msg.filter((b) => b.type === 'image').length === 2 && /SELECCIÓN activa \(x=\d+, y=\d+, \d+×\d+ px\)/.test(JSON.stringify(msg)) && calls3[0]?.tools.some((t) => t.name === 'recolor'), `${calls3.length} llamadas; ${JSON.stringify(msg).replace(/"data":"[^"]+"/g, '').slice(0, 300)}`);
    await page.unroute('**/api/assistant');
    await call('deselect'); await wait(300);
    ok('Sin selección no hay barra', !(await bar.isVisible().catch(() => false)));
    await page.getByLabel('Cerrar asistente').click(); await wait(200);
  }

  // --- móvil
  {
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'es-ES' });
    const mp = await m.newPage();
    mp.on('pageerror', (e) => errors.push(String(e)));
    await mp.goto(URL);
    await mp.waitForFunction(() => window.__lienzoStore?.getState().ready, null, { timeout: 20000 });
    await mp.evaluate(() => window.__lienzo.call('newDoc', 800, 600, 'white', 'm.psd')); await mp.waitForTimeout(500);
    await mp.getByTestId('m-assistant').click(); await mp.waitForTimeout(300);
    const b = await mp.getByTestId('assistant').boundingBox();
    ok('Asistente en el móvil: cabe en la pantalla', !!b && b.x >= 0 && b.x + b.width <= 391 && b.y >= 0 && b.y + b.height <= 845, JSON.stringify(b));
    await mp.getByTestId('assistant').locator('.chip', { hasText: 'Recorta a 4:5' }).click();
    await mp.waitForTimeout(1500);
    const st = await mp.evaluate(() => window.__lienzoStore.getState().doc);
    ok('Sugerencia desde el móvil (recorte 4:5)', Math.abs(st.width / st.height - 0.8) < 0.01, `${st.width}×${st.height}`);
    await mp.getByLabel('Cerrar asistente').click(); await mp.waitForTimeout(200);
    await mp.evaluate(() => window.__lienzo.call('selectShape', { x: 20, y: 20, w: 100, h: 100 }, 'rect', 'replace', 0)); await mp.waitForTimeout(400);
    const ai = mp.getByRole('button', { name: '✨ Editar con IA' });
    ok('Móvil: con selección, la barra inferior ofrece «Editar con IA» (sin barra flotante)', await ai.isVisible() && !(await mp.getByTestId('selbar').isVisible().catch(() => false)));
    await ai.click(); await mp.waitForTimeout(300);
    ok('Móvil: «Editar con IA» abre el asistente con sugerencias para la selección', await mp.getByTestId('assistant').locator('.chip', { hasText: 'Elimínalo' }).isVisible());
    await m.close();
  }

  // --- página de presentación
  {
    const lp = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-ES' })).newPage();
    const lerr = [];
    lp.on('pageerror', (e) => lerr.push(String(e)));
    lp.on('response', (r) => { if (r.status() >= 400) lerr.push(`${r.status()} ${r.url()}`); });
    await lp.goto(URL.replace('/app/', '/'));
    await lp.waitForLoadState('networkidle');
    ok('Landing: carga sin errores (imágenes incluidas)', lerr.length === 0 && (await lp.locator('img').evaluateAll((im) => im.every((i) => i.complete && i.naturalWidth > 0))), lerr.join(' | '));
    const href = await lp.locator('.hero .btn.primary').getAttribute('href');
    ok('Landing: el botón principal abre el editor', /^\/app\/(\?lang=es)?$/.test(href ?? ''), href ?? '');
    ok('Landing: enlace al repositorio', (await lp.locator('a[href*="github.com/JavierSA-dev/lienzo"]').count()) >= 2);
    await lp.locator('#lang').click();
    ok('Landing: cambia a inglés', (await lp.locator('h1').innerText()).includes('right in your browser') && (await lp.locator('.hero .btn.primary').getAttribute('href')) === '/app/?lang=en');
    await Promise.all([lp.waitForNavigation(), lp.locator('.hero .btn.primary').click()]);
    await lp.waitForFunction(() => window.__lienzoStore?.getState().ready, null, { timeout: 20000 });
    ok('Landing → editor en inglés', (await lp.locator('.menu-btn').first().innerText()) === 'File');
    const mp = await (await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: 'es-ES' })).newPage();
    await mp.goto(URL.replace('/app/', '/'));
    ok('Landing en el móvil: sin desbordes horizontales', await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.goto(URL + '?lang=es');
    await page.waitForFunction(() => window.__lienzoStore?.getState().ready, null, { timeout: 20000 });
    ok('Inicio del editor enlaza a la landing', (await page.getByTestId('home-landing').getAttribute('href')) === '/');
    const old = await (await browser.newContext()).newPage();
    ok('La landing está en la raíz y el editor en /app/', (await old.goto(URL.replace('/app/', '/'))).ok() && (await old.locator('.hero .app-link').count()) === 1);
  }

  await page.screenshot({ path: 'tests/out-assistant.png' });
  const real = errors.filter((e) => !/status of (402|503)/.test(e));
  ok('Sin errores en consola (salvo los 402/503 simulados)', real.length === 0, real.slice(0, 3).join(' | '));
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
