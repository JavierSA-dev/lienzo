/**
 * Máscaras vectoriales (Capa > Máscara vectorial): un trazado que recorta la capa con bordes nítidos
 * a cualquier escala. Se combina con la máscara de píxeles (multiplicando) para componer.
 */
import { MaskChannel, tileKey, setVectorMaskRaster } from './document';
import { TILE } from './types';
import { pathBounds, toSvg, type VectorPath } from './path';

export interface VectorMask {
  /** Trazado en coordenadas locales de la capa (se mueve con ella). */
  path: VectorPath;
  enabled: boolean;
  /** true = visible fuera del trazado (Mostrar todo + formas que ocultan). */
  invert: boolean;
  /** Densidad (0..100 %) y calado (px), como el panel Propiedades de Photoshop. */
  density: number;
  feather: number;
  /** Revisión: cambia con cada edición (para las cachés). */
  rev: number;
}

let REV = 1;
export const nextRev = () => ++REV;

export function newVectorMask(path: VectorPath, invert = false): VectorMask {
  return { path, enabled: true, invert, density: 100, feather: 0, rev: nextRev() };
}

/** Cobertura del trazado en teselas locales (255 = dentro), con calado y densidad aplicados. */
export function rasterVectorMask(vm: VectorMask): MaskChannel {
  const dens = Math.max(0, Math.min(100, vm.density)) / 100;
  // Con densidad < 100 %, lo oculto deja ver un poco (como Photoshop).
  const lo = Math.round(255 * (1 - dens));
  const fillOut = vm.invert ? 255 : lo, fillIn = vm.invert ? lo : 255;
  const ch = new MaskChannel(fillOut);
  const b = pathBounds(vm.path);
  if (!b || b.w <= 0 || b.h <= 0) return ch;
  const pad = Math.ceil(vm.feather * 2) + 2;
  const x0 = Math.floor(b.x) - pad, y0 = Math.floor(b.y) - pad;
  const w = Math.min(16384, Math.ceil(b.w) + pad * 2), h = Math.min(16384, Math.ceil(b.h) + pad * 2);
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  if (vm.feather > 0) ctx.filter = `blur(${vm.feather / 2}px)`;
  ctx.translate(-x0, -y0);
  ctx.fillStyle = '#fff';
  ctx.fill(new Path2D(toSvg(vm.path)), 'evenodd');
  const px = ctx.getImageData(0, 0, w, h).data;
  const tx0 = Math.floor(x0 / TILE), ty0 = Math.floor(y0 / TILE), tx1 = Math.floor((x0 + w - 1) / TILE), ty1 = Math.floor((y0 + h - 1) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const t = new Uint8Array(TILE * TILE).fill(fillOut);
    let any = false;
    for (let y = 0; y < TILE; y++) {
      const gy = ty * TILE + y - y0;
      if (gy < 0 || gy >= h) continue;
      for (let x = 0; x < TILE; x++) {
        const gx = tx * TILE + x - x0;
        if (gx < 0 || gx >= w) continue;
        const a = px[(gy * w + gx) * 4 + 3] / 255;
        if (!a) continue;
        t[y * TILE + x] = Math.round(fillOut + (fillIn - fillOut) * a);
        any = true;
      }
    }
    if (any) ch.tiles.set(tileKey(tx, ty), t);
  }
  return ch;
}

/** Máscara efectiva = píxeles × vectorial (ambas en coordenadas locales). */
export function combineMasks(vec: MaskChannel, pix: MaskChannel | null): MaskChannel {
  if (!pix) return vec;
  const out = new MaskChannel(Math.round((vec.fill * pix.fill) / 255));
  const keys = new Set<number>([...vec.tiles.keys(), ...pix.tiles.keys()]);
  for (const k of keys) {
    const a = vec.tiles.get(k), b = pix.tiles.get(k);
    const t = new Uint8Array(TILE * TILE);
    for (let i = 0; i < t.length; i++) t[i] = Math.round(((a ? a[i] : vec.fill) * (b ? b[i] : pix.fill)) / 255);
    out.tiles.set(k, t);
  }
  return out;
}

setVectorMaskRaster(rasterVectorMask, combineMasks);
