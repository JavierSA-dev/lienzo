import type { LayerEffects, RGBA } from './types';
import { PixelLayer } from './document';
import { boxBlurH, boxBlurV } from './selection';

/**
 * Estilos de capa (sombra paralela, resplandor exterior, trazo exterior y
 * superposición de color). Se calculan a partir del alfa de la capa y se guardan
 * en dos capas auxiliares: una bajo el contenido y otra encima.
 */
export function buildEffects(L: PixelLayer): { under: PixelLayer | null; over: PixelLayer | null } {
  const fx = L.effects;
  const b = L.bounds();
  if (!fx || !b || !anyEnabled(fx)) return { under: null, over: null };
  const ds = fx.dropShadow?.enabled ? fx.dropShadow : null;
  const og = fx.outerGlow?.enabled ? fx.outerGlow : null;
  const st = fx.stroke?.enabled ? fx.stroke : null;
  const co = fx.colorOverlay?.enabled ? fx.colorOverlay : null;

  const pad = Math.ceil(Math.max(
    ds ? ds.distance + ds.size * 1.5 : 0,
    og ? og.size * 1.5 : 0,
    st ? st.size + 1 : 0,
  )) + 2;
  const r = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  const px = L.readRegion(r.x - L.x, r.y - L.y, r.w, r.h);
  const n = r.w * r.h;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = px[i * 4 + 3];

  const under = new Float32Array(n * 4); // premultiplicado 0..255
  const over = new Float32Array(n * 4);
  const composite = (dst: Float32Array, a: Float32Array, color: RGBA, opacity: number) => {
    for (let i = 0; i < n; i++) {
      const sa = (a[i] / 255) * opacity;
      if (sa <= 0) continue;
      const j = i * 4, inv = 1 - sa;
      dst[j] = color[0] * sa + dst[j] * inv;
      dst[j + 1] = color[1] * sa + dst[j + 1] * inv;
      dst[j + 2] = color[2] * sa + dst[j + 2] * inv;
      dst[j + 3] = sa * 255 + dst[j + 3] * inv;
    }
  };
  const blurred = (src: Float32Array, size: number) => {
    const f = src.slice();
    const box = Math.max(1, Math.round(size / 3));
    for (let p = 0; p < 3; p++) { boxBlurH(f, r.w, r.h, box); boxBlurV(f, r.w, r.h, box); }
    return f;
  };

  if (ds) {
    const ang = (ds.angle * Math.PI) / 180;
    const ox = Math.round(-Math.cos(ang) * ds.distance), oy = Math.round(Math.sin(ang) * ds.distance);
    const shifted = new Float32Array(n);
    for (let y = 0; y < r.h; y++) {
      const sy = y - oy;
      if (sy < 0 || sy >= r.h) continue;
      for (let x = 0; x < r.w; x++) {
        const sx = x - ox;
        if (sx >= 0 && sx < r.w) shifted[y * r.w + x] = alpha[sy * r.w + sx];
      }
    }
    composite(under, ds.size > 0 ? blurred(shifted, ds.size) : shifted, ds.color, ds.opacity);
  }
  if (og) {
    const g = blurred(alpha, og.size);
    for (let i = 0; i < n; i++) g[i] = Math.min(255, g[i] * 2);
    composite(under, g, og.color, og.opacity);
  }
  if (st) {
    // Trazo exterior: dilatación del alfa (máximo en ventana circular aproximada) menos el contenido.
    const d = dilate(alpha, r.w, r.h, st.size);
    for (let i = 0; i < n; i++) d[i] = Math.max(0, d[i] - alpha[i]);
    composite(over, d, st.color, 1);
  }
  if (co) composite(over, alpha, co.color, co.opacity);

  return { under: toLayer(under, r), over: toLayer(over, r) };
}

function anyEnabled(fx: LayerEffects) {
  return !!(fx.dropShadow?.enabled || fx.outerGlow?.enabled || fx.stroke?.enabled || fx.colorOverlay?.enabled);
}

function dilate(a: Float32Array, w: number, h: number, size: number): Float32Array {
  // Dilatación separable con ventana cuadrada; suficiente para trazos de pocos píxeles.
  const s = Math.max(1, Math.round(size));
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, x - s); k <= Math.min(w - 1, x + s); k++) m = Math.max(m, a[y * w + k]);
    tmp[y * w + x] = m;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 0;
    for (let k = Math.max(0, y - s); k <= Math.min(h - 1, y + s); k++) m = Math.max(m, tmp[k * w + x]);
    out[y * w + x] = m;
  }
  return out;
}

function toLayer(pm: Float32Array, r: { x: number; y: number; w: number; h: number }): PixelLayer | null {
  const n = r.w * r.h;
  const data = new Uint8ClampedArray(n * 4);
  let any = false;
  for (let i = 0; i < n; i++) {
    const j = i * 4, a = pm[j + 3];
    if (a < 0.5) continue;
    any = true;
    const k = 255 / a;
    data[j] = pm[j] * k; data[j + 1] = pm[j + 1] * k; data[j + 2] = pm[j + 2] * k; data[j + 3] = a;
  }
  if (!any) return null;
  const L = new PixelLayer('fx');
  L.writeRegion(data, r.w, r.h, r.x, r.y);
  return L;
}
