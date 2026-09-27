// Genera un PSD de prueba con N capas (formas de colores con transparencia y modos de fusión).
import { writePsdUint8Array } from 'ag-psd';
import { writeFileSync, mkdirSync } from 'node:fs';

export function makeLayers({ width = 3000, height = 2000, layers = 50 } = {}) {
  const modes = ['normal', 'multiply', 'screen', 'overlay', 'soft light', 'difference', 'color dodge', 'luminosity'];
  const children = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < layers; i++) {
    const w = Math.round(width * (0.25 + rnd() * 0.5));
    const h = Math.round(height * (0.25 + rnd() * 0.5));
    const left = Math.round(rnd() * (width - w));
    const top = Math.round(rnd() * (height - h));
    const data = new Uint8ClampedArray(w * h * 4);
    const [r, g, b] = [rnd() * 255, rnd() * 255, rnd() * 255];
    const cx = w / 2, cy = h / 2, rad = Math.min(w, h) / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - cx, y - cy) / rad;
        const a = i === 0 ? 255 : Math.max(0, Math.min(255, (1.1 - d) * 255));
        const o = (y * w + x) * 4;
        data[o] = r + (x / w) * 60; data[o + 1] = g; data[o + 2] = b + (y / h) * 60; data[o + 3] = a;
      }
    }
    children.push({
      name: i === 0 ? 'Fondo' : `Capa ${i}`,
      left: i === 0 ? 0 : left, top: i === 0 ? 0 : top,
      opacity: i === 0 ? 1 : 0.6 + rnd() * 0.4,
      blendMode: i === 0 ? 'normal' : modes[i % modes.length],
      imageData: i === 0 ? { width, height, data: (() => { const d = new Uint8ClampedArray(width * height * 4); for (let k = 0; k < d.length; k += 4) { d[k] = 240; d[k + 1] = 236; d[k + 2] = 228; d[k + 3] = 255; } return d; })() } : { width: w, height: h, data },
    });
  }
  return children;
}

export function makePsd({ width = 3000, height = 2000, layers = 50 } = {}) {
  const children = makeLayers({ width, height, layers });
  const composite = new Uint8ClampedArray(width * height * 4).fill(255);
  return writePsdUint8Array({ width, height, children, imageData: { width, height, data: composite } }, { generateThumbnail: false });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync('tests/fixtures', { recursive: true });
  const bytes = makePsd();
  writeFileSync('tests/fixtures/50-capas.psd', bytes);
  console.log(`tests/fixtures/50-capas.psd: ${(bytes.length / 1048576).toFixed(1)} MB`);
}
