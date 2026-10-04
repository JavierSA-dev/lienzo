import { TILE, type RGBA } from './types';
import { PixelLayer, tileKey, isTileEmpty } from './document';
import type { Selection } from './selection';
import type { TilePatch } from './history';
import type { Rect as R2 } from './types';
import { sourceRows, type ResampleMethod } from './resample';
import type { Pool } from './pool';

/**
 * Redimensiona una capa escalando también su posición. El trabajo se divide en
 * bandas de filas que se calculan en paralelo en el pool de workers.
 */
export async function resampleLayer(L: PixelLayer, sx: number, sy: number, pool: Pool, method: ResampleMethod = 'bilinear'): Promise<PixelLayer> {
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
    const [y0, y1] = sourceRows(b.h, nh, d0, d1, method);
    const slice = px.slice(y0 * b.w * 4, y1 * b.w * 4);
    jobs.push(pool.resample({ slice, sw: b.w, sh: b.h, y0, rows: y1 - y0, dw: nw, dh: nh, d0, d1, method })
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

// ------------------------------------------------------------------ utilidades de fase 2


/**
 * Escribe `px` (RGBA de la región, coordenadas de documento) en la capa,
 * mezclándolo con el original según la selección (bordes suavizados y calados).
 */
export function applyRegion(L: PixelLayer, patch: TilePatch, region: R2, px: Uint8ClampedArray, sel: Selection | null) {
  const selMask = sel && !sel.rect ? sel.region(region) : null;
  const selRect = sel?.rect ?? null;
  const lx0 = region.x - L.x, ly0 = region.y - L.y;
  const tx0 = Math.floor(lx0 / TILE), ty0 = Math.floor(ly0 / TILE);
  const tx1 = Math.floor((lx0 + region.w - 1) / TILE), ty1 = Math.floor((ly0 + region.h - 1) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const k = tileKey(tx, ty);
      const ox = tx * TILE, oy = ty * TILE;
      const x0 = Math.max(lx0, ox), x1 = Math.min(lx0 + region.w, ox + TILE);
      const y0 = Math.max(ly0, oy), y1 = Math.min(ly0 + region.h, oy + TILE);
      // ¿Hay algo que escribir en este tile?
      let anyNew = false;
      for (let y = y0; y < y1 && !anyNew; y++) {
        for (let x = x0; x < x1; x++) {
          const ri = (y - ly0) * region.w + (x - lx0);
          if (px[ri * 4 + 3] || L.getTile(k)) { anyNew = true; break; }
        }
      }
      if (!anyNew) continue;
      patch.capture(L, k);
      const t = L.ensureTile(k);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const ri = (y - ly0) * region.w + (x - lx0);
          let m = 255;
          if (selMask) m = selMask[ri];
          else if (selRect) {
            const dx = x + L.x, dy = y + L.y;
            m = dx >= selRect.x && dy >= selRect.y && dx < selRect.x + selRect.w && dy < selRect.y + selRect.h ? 255 : 0;
          }
          if (!m) continue;
          const ti = ((y - oy) * TILE + (x - ox)) * 4, si = ri * 4;
          if (m === 255) { t[ti] = px[si]; t[ti + 1] = px[si + 1]; t[ti + 2] = px[si + 2]; t[ti + 3] = px[si + 3]; continue; }
          const f = m / 255;
          // Mezcla en premultiplicado para no oscurecer bordes.
          const oa = t[ti + 3] / 255, na = px[si + 3] / 255;
          const a = oa + (na - oa) * f;
          if (a <= 0) { t[ti + 3] = 0; continue; }
          for (let c = 0; c < 3; c++) t[ti + c] = (t[ti + c] * oa + (px[si + c] * na - t[ti + c] * oa) * f) / a;
          t[ti + 3] = a * 255;
        }
      }
      L.setTile(k, isTileEmpty(t) ? null : t);
    }
  }
}

export type GradientType = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

/** Genera un degradado (fg -> bg, o fg -> transparente) en una región de documento. */
export function gradientPixels(region: R2, p0: [number, number], p1: [number, number], type: GradientType,
  from: RGBA, to: RGBA, reverse: boolean): Uint8ClampedArray {
  const out = new Uint8ClampedArray(region.w * region.h * 4);
  const [ax, ay] = p0, dx = p1[0] - ax, dy = p1[1] - ay;
  const len2 = dx * dx + dy * dy || 1, len = Math.sqrt(len2);
  const a0 = Math.atan2(dy, dx);
  const [c0, c1] = reverse ? [to, from] : [from, to];
  for (let y = 0; y < region.h; y++) {
    const py = region.y + y + 0.5 - ay;
    for (let x = 0; x < region.w; x++) {
      const px = region.x + x + 0.5 - ax;
      let t: number;
      switch (type) {
        case 'linear': t = (px * dx + py * dy) / len2; break;
        case 'radial': t = Math.sqrt(px * px + py * py) / len; break;
        case 'angle': t = (((Math.atan2(py, px) - a0) / (2 * Math.PI)) % 1 + 1) % 1; break;
        case 'reflected': t = Math.abs((px * dx + py * dy) / len2); break;
        case 'diamond': {
          const u = (px * dx + py * dy) / len2, v = (-px * dy + py * dx) / len2;
          t = Math.abs(u) + Math.abs(v); break;
        }
      }
      t = Math.min(1, Math.max(0, t));
      const o = (y * region.w + x) * 4;
      const a = c0[3] + (c1[3] - c0[3]) * t;
      // Interpola en premultiplicado (un degradado a transparente no se oscurece).
      const w0 = (c0[3] * (1 - t)) / (a || 1), w1 = (c1[3] * t) / (a || 1);
      out[o] = c0[0] * w0 + c1[0] * w1;
      out[o + 1] = c0[1] * w0 + c1[1] * w1;
      out[o + 2] = c0[2] * w0 + c1[2] * w1;
      out[o + 3] = a;
    }
  }
  return out;
}

/** Rota una imagen RGBA 90° (sentido horario), -90° o 180°. */
export function rotateRGBA(src: Uint8ClampedArray, w: number, h: number, deg: 90 | -90 | 180) {
  const out = new Uint8ClampedArray(src.length);
  const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h), o32 = new Uint32Array(out.buffer);
  const nw = deg === 180 ? w : h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number, ny: number;
      if (deg === 90) { nx = h - 1 - y; ny = x; }
      else if (deg === -90) { nx = y; ny = w - 1 - x; }
      else { nx = w - 1 - x; ny = h - 1 - y; }
      o32[ny * nw + nx] = s32[y * w + x];
    }
  }
  return { data: out, w: nw, h: deg === 180 ? h : w };
}

export function flipRGBA(src: Uint8ClampedArray, w: number, h: number, horizontal: boolean) {
  const out = new Uint8ClampedArray(src.length);
  const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h), o32 = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    o32[(horizontal ? y : h - 1 - y) * w + (horizontal ? w - 1 - x : x)] = s32[y * w + x];
  }
  return out;
}

/**
 * Composición en CPU para el caso más común (capas de píxeles en modo Normal, sin
 * estilos): evita la lectura síncrona de la GPU al combinar/estampar/exportar.
 * Devuelve null si alguna capa necesita el compositor completo.
 */
export function cpuFlatten(layers: PixelLayer[], region: R2, background?: RGBA): Uint8ClampedArray | null {
  if (layers.some((l) => l.kind === 'group' || l.parent != null && layers.some((g) => g.id === l.parent))) return null;
  const vis = layers.filter((l) => l.visible && l.opacity > 0);
  for (const L of vis) {
    if (L.kind === 'adjustment' || L.kind === 'group' || L.clipped || L.blend !== 'normal' || L.fxUnder.length || L.fxStyled || L.effects?.blendIf) return null;
  }
  const out = new Uint8ClampedArray(region.w * region.h * 4);
  const acc = new Float32Array(TILE * TILE * 4);
  const bg = background ? [background[0] / 255 * background[3] / 255, background[1] / 255 * background[3] / 255, background[2] / 255 * background[3] / 255, background[3] / 255] : [0, 0, 0, 0];
  for (let by = region.y; by < region.y + region.h; by += TILE) {
    for (let bx = region.x; bx < region.x + region.w; bx += TILE) {
      const w = Math.min(TILE, region.x + region.w - bx), h = Math.min(TILE, region.y + region.h - by);
      const n = w * h;
      for (let i = 0; i < n; i++) { acc[i * 4] = bg[0]; acc[i * 4 + 1] = bg[1]; acc[i * 4 + 2] = bg[2]; acc[i * 4 + 3] = bg[3]; }
      let any = bg[3] > 0;
      for (const L of vis) {
        const lb = L.bounds();
        if (!lb || lb.x + lb.w <= bx || lb.y + lb.h <= by || lb.x >= bx + w || lb.y >= by + h) continue;
        const src = L.readRegion(bx - L.x, by - L.y, w, h);
        const useMask = !!L.mask && L.maskEnabled;
        const op = L.opacity / 255;
        for (let y = 0, i = 0; y < h; y++) {
          for (let x = 0; x < w; x++, i++) {
            const o = i * 4;
            let a = src[o + 3];
            if (!a) continue;
            let sa = a * op;
            if (useMask) sa *= L.maskAt(bx + x, by + y) / 255;
            if (sa <= 0) continue;
            const inv = 1 - sa;
            acc[o] = src[o] / 255 * sa + acc[o] * inv;
            acc[o + 1] = src[o + 1] / 255 * sa + acc[o + 1] * inv;
            acc[o + 2] = src[o + 2] / 255 * sa + acc[o + 2] * inv;
            acc[o + 3] = sa + acc[o + 3] * inv;
            any = true;
          }
        }
      }
      if (!any) continue;
      for (let y = 0, i = 0; y < h; y++) {
        let di = ((by - region.y + y) * region.w + (bx - region.x)) * 4;
        for (let x = 0; x < w; x++, i++, di += 4) {
          const o = i * 4, a = acc[o + 3];
          if (a <= 0) continue;
          out[di] = acc[o] / a * 255; out[di + 1] = acc[o + 1] / a * 255; out[di + 2] = acc[o + 2] / a * 255; out[di + 3] = a * 255;
        }
      }
    }
  }
  return out;
}
