/**
 * Filtro > Corrección de lente: distorsión de barril/cojín, aberración cromática lateral, viñeta,
 * perspectiva vertical/horizontal, ángulo y escala. Muestreo inverso por canal (bilineal).
 */
import type { FilterParams } from './filters';

function sample(src: Uint8ClampedArray, w: number, h: number, x: number, y: number, c: number): number {
  const fx = x - 0.5, fy = y - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
  let acc = 0, wsum = 0;
  for (let k = 0; k < 4; k++) {
    const px = x0 + (k & 1), py = y0 + (k >> 1);
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const wt = ((k & 1) ? ax : 1 - ax) * ((k >> 1) ? ay : 1 - ay);
    const i = (py * w + px) * 4;
    const a = src[i + 3] / 255;
    acc += (c === 3 ? src[i + 3] : src[i + c] * a) * wt;
    wsum += (c === 3 ? 1 : a) * wt;
  }
  return c === 3 ? acc : wsum > 1e-6 ? acc / wsum : 0;
}

export function lensCorrection(src: Uint8ClampedArray, w: number, h: number, p: FilterParams): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const cx = w / 2, cy = h / 2, R = Math.hypot(cx, cy);
  const d = (p.distortion ?? 0) / 100, cr = (p.caRed ?? 0) / 100, cb = (p.caBlue ?? 0) / 100;
  const vig = (p.vignette ?? 0) / 100, mid = 0.2 + ((p.vigMid ?? 50) / 100) * 0.7;
  const kv = (p.vertical ?? 0) / 100 * 0.6, kh = (p.horizontal ?? 0) / 100 * 0.6;
  const s = (p.scale ?? 100) / 100, a = ((p.angle ?? 0) * Math.PI) / 180, ca = Math.cos(-a), sa = Math.sin(-a);
  const ny = h / 2 / R, nx = w / 2 / R;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Coordenadas normalizadas al radio de la diagonal (inverso: salida → origen).
      let u = (x + 0.5 - cx) / R / s, v = (y + 0.5 - cy) / R / s;
      const ru = u * ca - v * sa, rv = u * sa + v * ca;
      u = ru; v = rv;
      // Perspectiva: vertical estrecha arriba o abajo (convergencia de verticales), horizontal a un lado.
      if (kv) u *= 1 + kv * (v / ny);
      if (kh) v *= 1 + kh * (u / nx);
      const r2 = u * u + v * v;
      // Distorsión: + corrige el barril (estira el borde), - corrige el cojín.
      const f = 1 + d * 0.35 * r2;
      const o = (y * w + x) * 4;
      const base = [u * f, v * f];
      const alpha = sample(src, w, h, base[0] * R + cx, base[1] * R + cy, 3);
      if (alpha <= 0.5) continue;
      const fr = 1 + cr * 0.006, fb = 1 + cb * 0.006;
      let rr = sample(src, w, h, base[0] * fr * R + cx, base[1] * fr * R + cy, 0);
      let gg = sample(src, w, h, base[0] * R + cx, base[1] * R + cy, 1);
      let bb = sample(src, w, h, base[0] * fb * R + cx, base[1] * fb * R + cy, 2);
      if (vig) {
        const r = Math.sqrt(r2);
        const t = Math.max(0, Math.min(1, (r - mid * 0.6) / (1.05 - mid * 0.6)));
        const k = 1 + vig * t * t * 1.2;
        rr *= k; gg *= k; bb *= k;
      }
      out[o] = rr; out[o + 1] = gg; out[o + 2] = bb; out[o + 3] = alpha;
    }
  }
  return out;
}
