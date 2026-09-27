import { TILE, type RGBA } from './types';
import { PixelLayer, tileKey, isTileEmpty } from './document';
import { sourceRows } from './resample';
import type { Pool } from './pool';

/**
 * Redimensiona una capa escalando también su posición. El trabajo se divide en
 * bandas de filas que se calculan en paralelo en el pool de workers.
 */
export async function resampleLayer(L: PixelLayer, sx: number, sy: number, pool: Pool): Promise<PixelLayer> {
  const out = new PixelLayer(L.name);
  out.visible = L.visible; out.opacity = L.opacity; out.blend = L.blend;
  const b = L.bounds();
  if (!b) { out.x = Math.round(L.x * sx); out.y = Math.round(L.y * sy); return out; }
  const px = L.readRegion(b.x - L.x, b.y - L.y, b.w, b.h);
  const nx0 = Math.round(b.x * sx), ny0 = Math.round(b.y * sy);
  const nw = Math.max(1, Math.round((b.x + b.w) * sx) - nx0), nh = Math.max(1, Math.round((b.y + b.h) * sy) - ny0);
  const bands = Math.max(1, Math.min(nh, pool.size * 3));
  const bandRows = Math.ceil(nh / bands);
  const jobs: Promise<void>[] = [];
  for (let d0 = 0; d0 < nh; d0 += bandRows) {
    const d1 = Math.min(nh, d0 + bandRows);
    const [y0, y1] = sourceRows(b.h, nh, d0, d1);
    const slice = px.slice(y0 * b.w * 4, y1 * b.w * 4);
    jobs.push(pool.resample({ slice, sw: b.w, sh: b.h, y0, rows: y1 - y0, dw: nw, dh: nh, d0, d1 })
      .then((band) => out.writeRegion(band, nw, d1 - d0, nx0, ny0 + d0)));
  }
  await Promise.all(jobs);
  return out;
}

/** Aplica una tabla de consulta (LUT) por canal a todos los tiles de una capa. */
export function applyLut(L: PixelLayer, lut: Uint8Array /* 3×256 */, onTile: (k: number) => void) {
  for (const k of [...L.tiles.keys()]) {
    onTile(k);
    const t = L.ensureTile(k);
    for (let i = 0; i < t.length; i += 4) {
      if (!t[i + 3]) continue;
      t[i] = lut[t[i]]; t[i + 1] = lut[256 + t[i + 1]]; t[i + 2] = lut[512 + t[i + 2]];
    }
    L.touch(k);
  }
}

export function invertLut(): Uint8Array {
  const l = new Uint8Array(768);
  for (let c = 0; c < 3; c++) for (let v = 0; v < 256; v++) l[c * 256 + v] = 255 - v;
  return l;
}

/** Brillo/contraste al estilo moderno de Photoshop (curva que preserva extremos). */
export function brightnessContrastLut(brightness: number, contrast: number): Uint8Array {
  const l = new Uint8Array(768);
  const b = brightness / 150;           // -150..150 -> -1..1
  const c = contrast / 100;             // -50..100
  const k = c >= 0 ? 1 / Math.max(1e-3, 1 - c * 0.99) : 1 + c;
  for (let v = 0; v < 256; v++) {
    let x = v / 255;
    // Brillo como curva gamma para no recortar blancos/negros.
    x = b >= 0 ? 1 - Math.pow(1 - x, 1 + b * 1.5) : Math.pow(x, 1 - b * 1.5);
    x = (x - 0.5) * k + 0.5;
    const o = Math.round(Math.min(1, Math.max(0, x)) * 255);
    l[v] = l[256 + v] = l[512 + v] = o;
  }
  return l;
}

/** Desatura (luminosidad) todos los tiles. */
export function desaturate(L: PixelLayer, onTile: (k: number) => void) {
  for (const k of [...L.tiles.keys()]) {
    onTile(k);
    const t = L.ensureTile(k);
    for (let i = 0; i < t.length; i += 4) {
      const y = t[i] * 0.299 + t[i + 1] * 0.587 + t[i + 2] * 0.114;
      t[i] = t[i + 1] = t[i + 2] = y;
    }
    L.touch(k);
  }
}

/** Crea una capa desde RGBA (alfa directo), descartando tiles vacíos. */
export function layerFromPixels(name: string, data: Uint8ClampedArray, w: number, h: number, x = 0, y = 0): PixelLayer {
  const L = new PixelLayer(name);
  L.writeRegion(data, w, h, x, y);
  return L;
}

/** Miniatura RGBA de una capa (muestreo por vecino más cercano, barato). */
export function layerThumb(L: PixelLayer, docW: number, docH: number, max = 48) {
  const s = Math.min(max / docW, max / docH);
  const w = Math.max(1, Math.round(docW * s)), h = Math.max(1, Math.round(docH * s));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const dy = Math.floor((y + 0.5) / s) - L.y;
    const ty = Math.floor(dy / TILE);
    for (let x = 0; x < w; x++) {
      const dx = Math.floor((x + 0.5) / s) - L.x;
      const tx = Math.floor(dx / TILE);
      const t = L.tiles.get(tileKey(tx, ty));
      if (!t) continue;
      const i = ((dy - ty * TILE) * TILE + (dx - tx * TILE)) * 4, o = (y * w + x) * 4;
      data[o] = t[i]; data[o + 1] = t[i + 1]; data[o + 2] = t[i + 2]; data[o + 3] = t[i + 3];
    }
  }
  return { w, h, data };
}

export function pruneEmpty(L: PixelLayer) {
  for (const [k, t] of L.tiles) if (isTileEmpty(t)) L.setTile(k, null);
}

export const hexToRgba = (hex: string): RGBA => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
};
