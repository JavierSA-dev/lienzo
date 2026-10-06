// Capturas para la página de presentación (public/landing/*.webp).
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const PORT = 4185;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', detached: true });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('localhost') && r()));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
process.on('exit', () => { try { process.kill(-server.pid); } catch {} });
mkdirSync('public/landing', { recursive: true });
const tmp = '/tmp/landing-shot.png';
const webp = (name, w, crop = null) => execSync(`python3 -c "from PIL import Image; im=Image.open('${tmp}').convert('RGB'); im=im.crop(${crop ? `(${crop.join(',')})` : 'im.getbbox()'}); im=im.resize((${w}, round(im.size[1]*${w}/im.size[0])), Image.LANCZOS) if im.size[0]>${w} else im; im.save('public/landing/${name}.webp', 'WEBP', quality=82, method=6)"`);
const noToasts = (page) => page.evaluate(() => window.__lienzoStore.setState({ toasts: [] }));

async function build(page) {
  const call = (m, ...a) => page.evaluate(([m, a]) => window.__lienzo.call(m, ...a), [m, a]);
  const id = () => page.evaluate(() => window.__lienzoStore.getState().doc.activeLayerId);
  await call('newDoc', 1600, 1000, 'white', 'Atardecer.psd');
  await call('applyGradient', [800, 0], [800, 1000], 'linear', false, false, { c: [[0, 22, 26, 70, 255], [0.45, 120, 50, 140, 255], [0.75, 235, 95, 120, 255], [1, 255, 170, 90, 255]], a: [[0, 255], [1, 255]], smooth: 1 });
  await call('createShape', { shape: 'ellipse', x: 560, y: 380, w: 480, h: 480, fill: [255, 214, 130, 255] });
  await call('setEffects', await id(), { outerGlow: { enabled: true, color: [255, 190, 120, 255], opacity: 0.8, size: 120, spread: 10 } }, true);
  await call('createShape', { shape: 'path', x: 0, y: 560, w: 1600, h: 440, fill: [72, 34, 92, 255], path: 'M0 760 L180 600 L330 700 L520 540 L720 720 L900 610 L1080 700 L1260 560 L1440 680 L1600 600 L1600 1000 L0 1000 Z' });
  await call('createShape', { shape: 'path', x: 0, y: 700, w: 1600, h: 300, fill: [38, 18, 58, 255], path: 'M0 880 L240 760 L420 850 L640 740 L860 870 L1060 780 L1280 880 L1460 790 L1600 850 L1600 1000 L0 1000 Z' });
  await call('createText', { text: 'LIENZO', x: 800, y: 300, size: 210, font: 'Arial', bold: true, color: [255, 255, 255, 255], align: 'center', tracking: 120 });
  await call('setEffects', await id(), { dropShadow: { enabled: true, color: [20, 10, 40, 255], opacity: 0.55, angle: 120, distance: 12, size: 24 } }, true);
  await call('createText', { text: 'Edición profesional en el navegador', x: 800, y: 380, size: 46, font: 'Arial', color: [255, 236, 220, 255], align: 'center' });
  await call('newAdjustmentLayer', 'vibrance', { type: 'vibrance', vibrance: 20, saturation: 5 });
  await page.waitForTimeout(800);
}

// Escritorio
{
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'es-ES' })).newPage();
  await page.goto(`http://localhost:${PORT}/app/`);
  await page.waitForFunction(() => window.__lienzoStore?.getState().ready);
  await build(page);
  await page.evaluate(() => window.__lienzo.call('fit', false));
  await page.waitForTimeout(600);
  await page.screenshot({ path: tmp }); webp('editor', 1600);
  // Asistente con una conversación
  await page.evaluate(() => window.__lienzoStore.setState({ assistantOpen: true }));
  await page.evaluate(() => { const s = window.__lienzoStore.getState(); return window.__lienzo.call('selectLayer', s.doc.layers[0].id); });
  await page.waitForTimeout(300);
  for (const q of ['Más cálida y con más contraste', 'añade una viñeta suave']) {
    await page.getByLabel('Petición al asistente').fill(q);
    await page.getByLabel('Petición al asistente').press('Enter');
    await page.waitForFunction(() => !document.querySelector('.amsg.pending'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  await noToasts(page); await page.waitForTimeout(200);
  await page.screenshot({ path: tmp }); webp('asistente', 1100, [560, 300, 1600, 960]);
  await page.evaluate(() => window.__lienzoStore.setState({ assistantOpen: false, timelineOpen: false }));
  // Revelado
  await page.evaluate(() => { const s = window.__lienzoStore.getState(); return window.__lienzo.call('selectLayer', s.doc.layers[0].id); });
  await page.evaluate(() => window.__lienzoStore.getState().setDialog({ kind: 'develop' }));
  await page.waitForTimeout(1500);
  await noToasts(page); await page.waitForTimeout(200);
  await page.screenshot({ path: tmp }); webp('revelado', 1600);
}
// Móvil
{
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'es-ES' })).newPage();
  await page.goto(`http://localhost:${PORT}/app/`);
  await page.waitForFunction(() => window.__lienzoStore?.getState().ready);
  await build(page);
  await page.evaluate(() => window.__lienzo.call('fit', false));
  await page.waitForTimeout(700);
  await page.screenshot({ path: tmp }); webp('movil', 780);
}
await browser.close();
process.kill(-server.pid);
console.log('ok');
