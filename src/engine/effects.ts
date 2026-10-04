// Estilos de capa de Photoshop (los 10) y opción de relleno, calculados en CPU a partir del alfa de la capa.
//
// Resultado:
// - `under`: efectos por debajo del contenido (sombra paralela, resplandor exterior y la parte exterior
//   del bisel), cada uno en su propia capa auxiliar con su modo de fusión;
// - `styled`: el contenido de la capa (con la opacidad de relleno y la máscara ya aplicadas) más los
//   efectos interiores y el trazo, en el orden de Photoshop. Se compone con el modo, la opacidad
//   y "Fusionar si" de la capa original.
import type { BlendMode, LayerEffects, RGBA, GradientStyle, PatternId } from './types';
import { PixelLayer } from './document';
import { boxBlurH, boxBlurV } from './selection';
import { distanceTo } from './retouch';

export interface BuiltEffects { under: PixelLayer[]; styled: PixelLayer | null }

type R = { x: number; y: number; w: number; h: number };

/** ¿Hay algo que calcular? (efectos activos o relleno por debajo del 100 %). */
export function hasEffects(fx: LayerEffects | undefined): boolean {
  if (!fx) return false;
  if (fx.fill !== undefined && fx.fill < 1) return true;
  return !!(fx.dropShadow?.enabled || fx.innerShadow?.enabled || fx.outerGlow?.enabled || fx.innerGlow?.enabled || fx.bevel?.enabled
    || fx.satin?.enabled || fx.colorOverlay?.enabled || fx.gradientOverlay?.enabled || fx.patternOverlay?.enabled || fx.stroke?.enabled);
}

export function buildEffects(L: PixelLayer): BuiltEffects {
  const fx = L.effects;
  const b = L.bounds();
  if (!fx || !b || !hasEffects(fx)) return { under: [], styled: null };
  const on = <T extends { enabled: boolean }>(e: T | undefined) => (e?.enabled ? e : null);
  const ds = on(fx.dropShadow), is = on(fx.innerShadow), og = on(fx.outerGlow), ig = on(fx.innerGlow), bv = on(fx.bevel);
  const sa = on(fx.satin), co = on(fx.colorOverlay), go = on(fx.gradientOverlay), po = on(fx.patternOverlay), st = on(fx.stroke);
  const fill = fx.fill ?? 1;

  const outer = bv && bv.style !== 'inner' ? bv.size : 0;
  const stOut = st && (st.position ?? 'outside') !== 'inside' ? st.size : 0;
  const pad = Math.ceil(Math.max(ds ? ds.distance + ds.size * 1.2 : 0, og ? og.size * 1.2 : 0, stOut + 1, outer + 2)) + 2;
  const r: R = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  const n = r.w * r.h;
  const px = L.readRegion(r.x - L.x, r.y - L.y, r.w, r.h);
  // Alfa de la forma (0..1) con la máscara de capa aplicada.
  const A = new Float32Array(n);
  const useMask = !!L.mask && L.maskEnabled;
  for (let y = 0, i = 0; y < r.h; y++) for (let x = 0; x < r.w; x++, i++) {
    let a = px[i * 4 + 3] / 255;
    if (useMask && a > 0) a *= L.mask!.get(r.x - L.x + x, r.y - L.y + y) / 255;
    A[i] = a;
  }
  const inside = new Uint8Array(n), outsideM = new Uint8Array(n);
  for (let i = 0; i < n; i++) { if (A[i] >= 0.5) inside[i] = 1; else outsideM[i] = 1; }
  let dIn: Float32Array | null = null, dOut: Float32Array | null = null;
  const din = () => (dIn ??= distanceTo(outsideM, r.w, r.h));
  const dout = () => (dOut ??= distanceTo(inside, r.w, r.h));

  const blur = (src: Float32Array, size: number) => {
    const f = src.slice();
    const box = Math.max(1, Math.round(size / 3));
    if (size < 0.5) return f;
    for (let p = 0; p < 3; p++) { boxBlurH(f, r.w, r.h, box); boxBlurV(f, r.w, r.h, box); }
    return f;
  };
  /** Dilata la forma `radius` píxeles (bordes suavizados), conservando el alfa original dentro. */
  const dilate = (radius: number) => {
    if (radius <= 0) return A.slice();
    const d = dout(), out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.max(A[i], Math.min(1, Math.max(0, radius + 0.5 - d[i])));
    return out;
  };
  const shift = (src: Float32Array, dx: number, dy: number, outside: number) => {
    const out = new Float32Array(n);
    for (let y = 0; y < r.h; y++) {
      const sy = y - dy;
      for (let x = 0; x < r.w; x++) {
        const sx = x - dx;
        out[y * r.w + x] = sx >= 0 && sx < r.w && sy >= 0 && sy < r.h ? src[sy * r.w + sx] : outside;
      }
    }
    return out;
  };
  const offset = (angle: number, dist: number): [number, number] => {
    const a = (angle * Math.PI) / 180;
    return [Math.round(-Math.cos(a) * dist), Math.round(Math.sin(a) * dist)];
  };

  // ---------------------------------------------------------------- efectos por debajo
  const under: PixelLayer[] = [];
  const pushUnder = (alpha: Float32Array, color: RGBA, opacity: number, blend: BlendMode, name: string) => {
    const Lx = alphaLayer(alpha, color, opacity, r, name);
    if (Lx) { Lx.blend = blend; under.push(Lx); }
  };
  if (ds) {
    const sp = Math.max(0, Math.min(100, ds.spread ?? 0)) / 100;
    const base = dilate(ds.size * sp);
    const [ox, oy] = offset(ds.angle, ds.distance);
    pushUnder(blur(shift(base, ox, oy, 0), ds.size * (1 - sp)), ds.color, ds.opacity, ds.blend ?? 'multiply', 'Sombra paralela');
  }
  if (og) {
    const sp = Math.max(0, Math.min(100, og.spread ?? 0)) / 100;
    const g = blur(dilate(og.size * (0.5 + sp * 0.5)), og.size * (1 - sp) * 0.5);
    pushUnder(g, og.color, og.opacity, og.blend ?? 'screen', 'Resplandor exterior');
  }

  // ---------------------------------------------------------------- contenido + efectos interiores
  // Búfer premultiplicado (0..1).
  const D = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = A[i] * fill;
    D[i * 4] = (px[i * 4] / 255) * a; D[i * 4 + 1] = (px[i * 4 + 1] / 255) * a; D[i * 4 + 2] = (px[i * 4 + 2] / 255) * a; D[i * 4 + 3] = a;
  }
  /** Compone un efecto sobre D con su modo; `alpha(i)` ya incluye opacidad y recorte. */
  const over = (alpha: (i: number) => number, color: (i: number) => RGBA, mode: BlendMode) => {
    const m = MODE[mode] ?? 0;
    for (let i = 0; i < n; i++) {
      const as = alpha(i);
      if (as <= 0) continue;
      const j = i * 4, ab = D[j + 3], c = color(i);
      const cs0 = c[0] / 255, cs1 = c[1] / 255, cs2 = c[2] / 255;
      const cb0 = ab > 0 ? D[j] / ab : 0, cb1 = ab > 0 ? D[j + 1] / ab : 0, cb2 = ab > 0 ? D[j + 2] / ab : 0;
      const [B0, B1, B2] = blendRGB(m, cb0, cb1, cb2, cs0, cs1, cs2);
      D[j] = as * (1 - ab) * cs0 + as * ab * B0 + (1 - as) * D[j];
      D[j + 1] = as * (1 - ab) * cs1 + as * ab * B1 + (1 - as) * D[j + 1];
      D[j + 2] = as * (1 - ab) * cs2 + as * ab * B2 + (1 - as) * D[j + 2];
      D[j + 3] = as + ab * (1 - as);
    }
  };
  const k = (c: RGBA) => () => c;

  if (po) {
    const cell = Math.max(2, 16 * (po.scale / 100));
    over((i) => A[i] * po.opacity, (i) => {
      const x = r.x + (i % r.w), y = r.y + Math.floor(i / r.w);
      return mixC(po.colorA, po.colorB, pattern(po.pattern, x, y, cell));
    }, po.blend ?? 'normal');
  }
  if (go) {
    const t = gradientT(b, go.angle, go.style, go.scale / 100);
    over((i) => A[i] * go.opacity, (i) => {
      let v = t(r.x + (i % r.w) + 0.5, r.y + Math.floor(i / r.w) + 0.5);
      if (go.reverse) v = 1 - v;
      return mixC(go.from, go.to, v);
    }, go.blend ?? 'normal');
  }
  if (co) over((i) => A[i] * co.opacity, k(co.color), co.blend ?? 'normal');
  if (sa) {
    const [ox, oy] = offset(sa.angle, sa.distance);
    const a1 = blur(shift(A, ox, oy, 0), sa.size), a2 = blur(shift(A, -ox, -oy, 0), sa.size);
    over((i) => { const v = Math.abs(a1[i] - a2[i]); return (sa.invert ? 1 - v : v) * A[i] * sa.opacity; }, k(sa.color), sa.blend ?? 'multiply');
  }
  if (ig) {
    const sp = Math.max(0, Math.min(100, ig.spread ?? 0)) / 100;
    const d = din();
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!A[i]) continue;
      const e = Math.min(1, Math.max(0, 1 - (d[i] - ig.size * sp) / Math.max(1, ig.size * (1 - sp))));
      g[i] = ig.source === 'center' ? 1 - e : e;
    }
    const gb = blur(g, Math.min(ig.size * 0.3, 6));
    over((i) => gb[i] * A[i] * ig.opacity, k(ig.color), ig.blend ?? 'screen');
  }
  if (is) {
    const sp = Math.max(0, Math.min(100, is.spread ?? 0)) / 100;
    const inv = new Float32Array(n);
    for (let i = 0; i < n; i++) inv[i] = 1 - A[i];
    const [ox, oy] = offset(is.angle, is.distance);
    let s = shift(inv, ox, oy, 1);
    if (sp > 0) {
      // Estrangular: engorda la zona exterior antes de desenfocar.
      const grow = sp * is.size, ins = new Uint8Array(n);
      for (let i = 0; i < n; i++) ins[i] = s[i] >= 0.5 ? 1 : 0;
      const dd = distanceTo(ins, r.w, r.h);
      for (let i = 0; i < n; i++) s[i] = Math.max(s[i], Math.min(1, Math.max(0, grow + 0.5 - dd[i])));
    }
    s = blur(s, is.size * (1 - sp));
    over((i) => s[i] * A[i] * is.opacity, k(is.color), is.blend ?? 'multiply');
  }
  if (bv) {
    const { hi, sh } = bevelShading(bv, A, r, din(), dout(), blur);
    const inner = bv.style !== 'outer';
    over((i) => (inner ? A[i] : 0) * hi[i] * bv.highlightOpacity, k(bv.highlight), bv.highlightBlend ?? 'screen');
    over((i) => (inner ? A[i] : 0) * sh[i] * bv.shadowOpacity, k(bv.shadow), bv.shadowBlend ?? 'multiply');
    if (bv.style !== 'inner') {
      // Parte exterior del bisel (relieve, almohadilla o bisel exterior): sobre el fondo.
      const ho = new Float32Array(n), so = new Float32Array(n);
      for (let i = 0; i < n; i++) { const o = 1 - A[i]; ho[i] = hi[i] * o; so[i] = sh[i] * o; }
      pushUnder(ho, bv.highlight, bv.highlightOpacity, bv.highlightBlend ?? 'screen', 'Bisel (iluminación)');
      pushUnder(so, bv.shadow, bv.shadowOpacity, bv.shadowBlend ?? 'multiply', 'Bisel (sombra)');
    }
  }
  if (st) {
    const pos = st.position ?? 'outside', size = st.size, op = st.opacity ?? 1;
    const d1 = din(), d2 = dout();
    const cov = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (pos === 'outside') cov[i] = inside[i] ? 0 : Math.min(1, Math.max(0, size + 0.5 - (d2[i] - 0.5))) * (1 - A[i]);
      else if (pos === 'inside') cov[i] = inside[i] ? Math.min(1, Math.max(0, size + 0.5 - (d1[i] - 0.5))) * A[i] : 0;
      else cov[i] = inside[i] ? Math.min(1, Math.max(0, size / 2 + 0.5 - (d1[i] - 0.5))) : Math.min(1, Math.max(0, size / 2 + 0.5 - (d2[i] - 0.5)));
    }
    over((i) => cov[i] * op, k(st.color), st.blend ?? 'normal');
  }

  const out = new Uint8ClampedArray(n * 4);
  let any = false;
  for (let i = 0; i < n; i++) {
    const j = i * 4, a = D[j + 3];
    if (a <= 0.5 / 255) continue;
    any = true;
    out[j] = (D[j] / a) * 255; out[j + 1] = (D[j + 1] / a) * 255; out[j + 2] = (D[j + 2] / a) * 255; out[j + 3] = a * 255;
  }
  let styled: PixelLayer | null = null;
  if (any) {
    styled = new PixelLayer('Estilo');
    styled.x = L.x; styled.y = L.y;
    styled.writeRegion(out, r.w, r.h, r.x - L.x, r.y - L.y);
  } else {
    styled = new PixelLayer('Estilo'); // vacío: el contenido no se ve (relleno 0 % sin efectos)
  }
  return { under, styled };
}

// ------------------------------------------------------------------ bisel y relieve

function bevelShading(bv: NonNullable<LayerEffects['bevel']>, A: Float32Array, r: R, dIn: Float32Array, dOut: Float32Array,
  blur: (f: Float32Array, s: number) => Float32Array) {
  const n = A.length, size = Math.max(1, bv.size);
  let h: Float32Array = new Float32Array(n);
  const c = (v: number) => Math.min(1, Math.max(0, v));
  if ((bv.technique ?? 'smooth') === 'smooth') {
    // Suavizar: perfil redondeado a partir del alfa desenfocado (sin aristas).
    const g = blur(A, size * (bv.style === 'emboss' || bv.style === 'pillow' ? 0.8 : 1.2));
    for (let i = 0; i < n; i++) {
      const ins = A[i] >= 0.5, v = g[i];
      switch (bv.style) {
        case 'inner': h[i] = ins ? c(2 * (v - 0.5)) : 0; break;
        case 'outer': h[i] = ins ? 1 : c(2 * v); break;
        case 'emboss': h[i] = v; break;
        case 'pillow': h[i] = ins ? c(2 * (v - 0.5)) : c(1 - 2 * v); break;
      }
    }
  } else {
    // Cincelar: perfil lineal según la distancia al borde (aristas marcadas).
    for (let i = 0; i < n; i++) {
      const ins = A[i] >= 0.5;
      switch (bv.style) {
        case 'inner': h[i] = ins ? c(dIn[i] / size) : 0; break;
        case 'outer': h[i] = ins ? 1 : 1 - c(dOut[i] / size); break;
        case 'emboss': h[i] = ins ? 0.5 + 0.5 * c(dIn[i] / (size / 2)) : 0.5 - 0.5 * c(dOut[i] / (size / 2)); break;
        case 'pillow': h[i] = ins ? c(dIn[i] / (size / 2)) : c(dOut[i] / (size / 2)); break;
      }
    }
    h = blur(h, 1.5);
  }
  if (bv.soften > 0) h = blur(h, bv.soften);
  const kz = (bv.depth / 100) * size * (bv.up ? 1 : -1);
  const az = (bv.angle * Math.PI) / 180, alt = (bv.altitude * Math.PI) / 180;
  const lx = Math.cos(alt) * Math.cos(az), ly = -Math.cos(alt) * Math.sin(az), lz = Math.sin(alt);
  const hi = new Float32Array(n), sh = new Float32Array(n);
  for (let y = 1; y < r.h - 1; y++) for (let x = 1; x < r.w - 1; x++) {
    const i = y * r.w + x;
    const gx = (h[i + 1] - h[i - 1]) / 2, gy = (h[i + r.w] - h[i - r.w]) / 2;
    if (!gx && !gy) continue;
    const nx = -gx * kz, ny = -gy * kz, len = Math.hypot(nx, ny, 1);
    const shade = (nx * lx + ny * ly + lz) / len;
    const d = shade - lz;
    if (d > 0) hi[i] = Math.min(1, d / Math.max(0.05, 1 - lz));
    else sh[i] = Math.min(1, -d / Math.max(0.05, lz));
  }
  return { hi, sh };
}

// ------------------------------------------------------------------ degradados y motivos

function gradientT(b: R, angle: number, style: GradientStyle, scale: number) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const a = (angle * Math.PI) / 180, dx = Math.cos(a), dy = -Math.sin(a);
  const half = Math.max(1, ((Math.abs(b.w * dx) + Math.abs(b.h * dy)) / 2) * Math.max(0.1, scale));
  const rad = Math.max(1, (Math.hypot(b.w, b.h) / 2) * Math.max(0.1, scale));
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return (x: number, y: number) => {
    const px = x - cx, py = y - cy;
    switch (style) {
      case 'linear': return c(0.5 + (px * dx + py * dy) / (2 * half));
      case 'reflected': return c(Math.abs(px * dx + py * dy) / half);
      case 'radial': return c(Math.hypot(px, py) / rad);
      case 'diamond': return c((Math.abs(px) + Math.abs(py)) / rad);
      case 'angle': { let t = (Math.atan2(-py, px) - a) / (2 * Math.PI); t -= Math.floor(t); return t; }
    }
  };
}

function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Motivos propios (generados), con valor 0..1 entre el color A y el B. */
export function pattern(id: PatternId, x: number, y: number, cell: number): number {
  switch (id) {
    case 'checker': return (Math.floor(x / cell) + Math.floor(y / cell)) & 1;
    case 'dots': {
      const fx = (x / cell) % 1, fy = (y / cell) % 1;
      const d = Math.hypot(fx - 0.5, fy - 0.5);
      return Math.min(1, Math.max(0, (0.3 - d) * cell + 0.5));
    }
    case 'stripes': { const t = ((x + y) / cell) % 1; return t < 0.5 ? 1 : 0; }
    case 'grid': { const w = Math.max(1, cell / 12); return x % cell < w || y % cell < w ? 1 : 0; }
    case 'noise': return hash(Math.floor(x / Math.max(1, cell / 16)), Math.floor(y / Math.max(1, cell / 16)));
    case 'canvas': {
      const s = cell / 4;
      const warp = Math.sin((x / s) * Math.PI) * 0.5 + 0.5, weft = Math.sin((y / s) * Math.PI) * 0.5 + 0.5;
      const over = (Math.floor(x / s) + Math.floor(y / s)) & 1;
      return Math.min(1, (over ? warp : weft) * 0.7 + hash(x, y) * 0.3);
    }
  }
}

const mixC = (a: RGBA, b: RGBA, t: number): RGBA => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 255];

function alphaLayer(alpha: Float32Array, color: RGBA, opacity: number, r: R, name: string): PixelLayer | null {
  const n = r.w * r.h;
  const data = new Uint8ClampedArray(n * 4);
  let any = false;
  for (let i = 0; i < n; i++) {
    const a = alpha[i] * opacity * 255;
    if (a < 0.5) continue;
    any = true;
    const j = i * 4;
    data[j] = color[0]; data[j + 1] = color[1]; data[j + 2] = color[2]; data[j + 3] = a;
  }
  if (!any) return null;
  const L = new PixelLayer(name);
  L.writeRegion(data, r.w, r.h, r.x, r.y);
  return L;
}

// ------------------------------------------------------------------ modos de fusión en CPU (los del shader)

const MODE: Partial<Record<BlendMode, number>> = {
  normal: 0, dissolve: 0, darken: 2, multiply: 3, 'color-burn': 4, 'linear-burn': 5, 'darker-color': 6, lighten: 7, screen: 8,
  'color-dodge': 9, 'linear-dodge': 10, 'lighter-color': 11, overlay: 12, 'soft-light': 13, 'hard-light': 14, 'vivid-light': 15,
  'linear-light': 16, 'pin-light': 17, 'hard-mix': 18, difference: 19, exclusion: 20, subtract: 21, divide: 22,
  hue: 23, saturation: 24, color: 25, luminosity: 26,
};

const colorBurn = (b: number, s: number) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const colorDodge = (b: number, s: number) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const hardLight = (b: number, s: number) => (s <= 0.5 ? b * 2 * s : 1 - (1 - b) * (1 - (2 * s - 1)));
const softLight = (b: number, s: number) => {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
};
function sep(m: number, b: number, s: number): number {
  switch (m) {
    case 2: return Math.min(b, s);
    case 3: return b * s;
    case 4: return colorBurn(b, s);
    case 5: return Math.max(0, b + s - 1);
    case 7: return Math.max(b, s);
    case 8: return b + s - b * s;
    case 9: return colorDodge(b, s);
    case 10: return Math.min(1, b + s);
    case 12: return hardLight(s, b);
    case 13: return softLight(b, s);
    case 14: return hardLight(b, s);
    case 15: return s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * (s - 0.5));
    case 16: return Math.min(1, Math.max(0, b + 2 * s - 1));
    case 17: return s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1);
    case 18: return b + s >= 1 ? 1 : 0;
    case 19: return Math.abs(b - s);
    case 20: return b + s - 2 * b * s;
    case 21: return Math.max(0, b - s);
    case 22: return s <= 0 ? (b <= 0 ? 0 : 1) : Math.min(1, b / s);
  }
  return s;
}
const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(r: number, g: number, b: number): [number, number, number] {
  const l = lum(r, g, b), mn = Math.min(r, g, b), mx = Math.max(r, g, b);
  if (mn < 0) { const k = l / Math.max(l - mn, 1e-6); r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k; }
  if (mx > 1) { const k = (1 - l) / Math.max(mx - l, 1e-6); r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k; }
  return [r, g, b];
}
const setLum = (r: number, g: number, b: number, l: number) => { const d = l - lum(r, g, b); return clipColor(r + d, g + d, b + d); };
const satOf = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b);
function setSat(r: number, g: number, b: number, s: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx <= mn) return [0, 0, 0];
  return [(r - mn) * s / (mx - mn), (g - mn) * s / (mx - mn), (b - mn) * s / (mx - mn)];
}
function blendRGB(m: number, br: number, bg: number, bb: number, sr: number, sg: number, sb: number): [number, number, number] {
  if (m === 0) return [sr, sg, sb];
  if (m === 6) return lum(sr, sg, sb) < lum(br, bg, bb) ? [sr, sg, sb] : [br, bg, bb];
  if (m === 11) return lum(sr, sg, sb) > lum(br, bg, bb) ? [sr, sg, sb] : [br, bg, bb];
  if (m === 23) return setLum(...setSat(sr, sg, sb, satOf(br, bg, bb)), lum(br, bg, bb));
  if (m === 24) return setLum(...setSat(br, bg, bb, satOf(sr, sg, sb)), lum(br, bg, bb));
  if (m === 25) return setLum(sr, sg, sb, lum(br, bg, bb));
  if (m === 26) return setLum(br, bg, bb, lum(sr, sg, sb));
  return [sep(m, br, sr), sep(m, bg, sg), sep(m, bb, sb)];
}
