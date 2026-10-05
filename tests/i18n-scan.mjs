// Busca textos de la interfaz que se quedan en español con el idioma inglés.
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const PORT = 4181;
if (!existsSync('dist/index.html')) execSync('npx vite build', { stdio: 'inherit' });
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', detached: true });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('localhost') && r()));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const found = new Map();
const SPANISH = /[áéíóúñ¿¡]|\b(de|del|la|las|los|el|con|para|una?|capa|capas|clic|imagen|selección|fondo|nuevo|nueva|abrir|guardar|pincel|herramienta|máscara|ajustes?|tamaño|cuadro|exportar|rellenar|borrar|texto|forma|filtro|vista|ventana|ayuda|edición|archivo|trazado|degradado|muestras|opacidad|modo|fusión|sin|en)\b/i;
async function scan(page, where) {
  const texts = await page.evaluate(() => {
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) { const p = n.parentElement; if (p && !p.closest('[translate="no"],script,style') && p.offsetParent !== null) out.push(n.nodeValue.trim()); }
      else for (const a of ['title', 'placeholder', 'aria-label']) { const v = n.getAttribute(a); if (v && !n.closest('[translate="no"]')) out.push(v); }
    }
    return out.filter(Boolean);
  });
  for (const t of texts) if (SPANISH.test(t) && !found.has(t)) found.set(t, where);
}
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', locale: 'en-US' });
const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => window.__lienzoStore?.getState().ready, null, { timeout: 20000 });
await scan(page, 'home');
await page.evaluate(() => window.__lienzo.call('newDoc', 800, 600, 'white', 'test.psd'));
await page.waitForTimeout(500);
await scan(page, 'doc');
// Menús y submenús.
const menus = await page.locator('.menu-btn').count();
for (let i = 0; i < menus; i++) {
  await page.locator('.menu-btn').nth(i).click(); await page.waitForTimeout(100);
  await scan(page, 'menu');
  const subs = await page.locator('.menu-pop .menu-sub').count();
  for (let j = 0; j < subs; j++) { await page.locator('.menu-pop .menu-sub').nth(j).hover(); await page.waitForTimeout(60); await scan(page, 'submenu'); }
  await page.keyboard.press('Escape'); await page.mouse.click(700, 500); await page.waitForTimeout(80);
}
// Diálogos.
const dialogs = [{ kind: 'new' }, { kind: 'imageSize' }, { kind: 'canvasSize' }, { kind: 'export' }, { kind: 'feather' }, { kind: 'grow', dir: 1 }, { kind: 'fill' }, { kind: 'layerStyle' }, { kind: 'shortcuts' }, { kind: 'generative' }, { kind: 'about' }, { kind: 'newGuide' }, { kind: 'colorPicker', which: 'fg' }, { kind: 'applyImage' }, { kind: 'stroke' }, { kind: 'newLayer' }, { kind: 'newArtboard' }, { kind: 'rotateArbitrary' }, { kind: 'automate', mode: 'photomerge' }, { kind: 'automate', mode: 'hdr' }, { kind: 'brushSettings' }, { kind: 'tween' }, { kind: 'exportAnim' }, { kind: 'batch' }, { kind: 'develop' }, { kind: 'blurGallery', mode: 'iris' }, { kind: 'liquify' }, { kind: 'colorRange' },
  ...['levels', 'curves', 'hueSat', 'colorBalance', 'blackWhite', 'photoFilter', 'channelMixer', 'colorLookup', 'gradientMap', 'selectiveColor', 'brightness', 'exposure', 'vibrance', 'posterize', 'threshold'].map((type) => ({ kind: 'adjust', type })),
  ...['gaussianBlur', 'boxBlur', 'motionBlur', 'unsharpMask', 'addNoise', 'median', 'mosaic', 'highPass', 'emboss', 'dustScratches', 'reduceNoise', 'lensCorrection'].map((name) => ({ kind: 'filter', name }))];
for (const d of dialogs) {
  await page.evaluate((d) => window.__lienzoStore.getState().setDialog(d), d).catch(() => {});
  await page.waitForTimeout(250);
  await scan(page, `dialog ${d.kind} ${d.type ?? d.name ?? d.mode ?? ''}`);
  // pestañas internas del estilo de capa
  if (d.kind === 'layerStyle') { const n = await page.locator('.fx-list button, .fx-list li').count(); for (let i = 0; i < n; i++) { await page.locator('.fx-list button, .fx-list li').nth(i).click().catch(() => {}); await page.waitForTimeout(60); await scan(page, 'layerStyle tab'); } }
  await page.evaluate(() => window.__lienzoStore.getState().setDialog(null));
  await page.waitForTimeout(80);
}
// Herramientas (barra de opciones) y paneles.
const tools = await page.evaluate(() => Object.keys(window.__lienzoStore.getState().toolOpts ?? {}));
for (const t of ['move', 'marquee', 'lasso', 'quickSelect', 'crop', 'eyedropper', 'spotHeal', 'brush', 'clone', 'history', 'eraser', 'gradient', 'blur', 'dodge', 'pen', 'type', 'pathSelect', 'shape', 'hand', 'zoom', 'mixer', 'remove', 'objectSelect', 'patch', 'perspectiveCrop']) {
  await page.evaluate((t) => window.__lienzoStore.getState().setTool(t), t).catch(() => {});
  await page.waitForTimeout(80);
  await scan(page, `tool ${t}`);
}
for (const tab of ['Canales', 'Channels', 'Trazados', 'Paths', 'Capas', 'Layers']) await page.getByTestId(`tab-${tab}`).click().catch(() => {});
await page.evaluate(() => window.__lienzoStore.setState({ timelineOpen: true, assistantOpen: true }));
await page.getByLabel('Assistant settings').click().catch(() => {});
await page.waitForTimeout(200); await scan(page, 'timeline');
// Móvil.
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en-US' });
const mp = await m.newPage();
await mp.goto(`http://localhost:${PORT}/`);
await mp.waitForFunction(() => window.__lienzoStore?.getState().ready, null, { timeout: 20000 });
await scan(mp, 'mobile home');
await mp.evaluate(() => window.__lienzo.call('newDoc', 800, 600, 'white', 'test.psd'));
await mp.waitForTimeout(400);
await scan(mp, 'mobile doc');
for (const s of ['menu', 'layers', 'adjust', 'props', 'history', 'color', 'export', 'tools', 'select']) { await mp.evaluate((s) => window.__lienzoStore.setState({ sheet: s }), s); await mp.waitForTimeout(150); await scan(mp, `sheet ${s}`); }
await browser.close();
try { process.kill(-server.pid, 'SIGTERM'); } catch {}
const list = [...found].map(([t, w]) => `${t}\t${w}`);
writeFileSync('tests/out-i18n-missing.txt', list.join('\n') + '\n');
console.log(`${list.length} textos sin traducir → tests/out-i18n-missing.txt`);
