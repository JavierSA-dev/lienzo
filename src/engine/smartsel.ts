// Selecciones "inteligentes": Selección rápida (distancia geodésica sensible a los bordes),
// filtro guiado (bordes finos y pelo), Gama de colores y Seleccionar y aplicar máscara.

/** Reduce RGBA a como mucho `max` px de lado (media de cajas). Devuelve RGB en float 0..255. */
export function downscale(px: Uint8ClampedArray, w: number, h: number, max: number) {
  const s = Math.min(1, max / Math.max(w, h));
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const out = new Float32Array(W * H * 3);
  const cnt = new Float32Array(W * H);
  for (let y = 0; y < h; y++) {
    const Y = Math.min(H - 1, Math.floor(y * s));
    for (let x = 0; x < w; x++) {
      const X = Math.min(W - 1, Math.floor(x * s)), i = (y * w + x) * 4, j = Y * W + X;
      const a = px[i + 3] / 255;
      // Lo transparente cuenta como blanco (como lo ve el usuario sobre el fondo).
      out[j * 3] += px[i] * a + 255 * (1 - a); out[j * 3 + 1] += px[i + 1] * a + 255 * (1 - a); out[j * 3 + 2] += px[i + 2] * a + 255 * (1 - a);
      cnt[j]++;
    }
  }
  for (let j = 0; j < W * H; j++) { const c = cnt[j] || 1; out[j * 3] /= c; out[j * 3 + 1] /= c; out[j * 3 + 2] /= c; }
  return { img: out, W, H, s };
}

/** Montículo binario mínimo de (coste, índice). */
class Heap {
  k: number[] = []; v: number[] = [];
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v, top = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  get size() { return this.k.length; }
}

/**
 * Selección rápida: desde los píxeles pintados, crece por las zonas parecidas y se para en los bordes.
 * `seeds`: índices (en la imagen reducida) bajo el pincel. Devuelve una máscara 0/1 en la imagen reducida.
 */
export function quickRegion(img: Float32Array, W: number, H: number, seeds: number[], strength = 1): Uint8Array {
  const n = W * H;
  const dist = new Float32Array(n).fill(Infinity);
  const diff = (a: number, b: number) => {
    const dr = img[a * 3] - img[b * 3], dg = img[a * 3 + 1] - img[b * 3 + 1], db = img[a * 3 + 2] - img[b * 3 + 2];
    return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11);
  };
  // Ruido típico dentro de lo pintado: por debajo de eso, avanzar no cuesta nada (texturas, grano).
  const local: number[] = [];
  const seedSet = new Uint8Array(n);
  for (const s of seeds) seedSet[s] = 1;
  for (const s of seeds) {
    const x = s % W;
    if (x + 1 < W && seedSet[s + 1]) local.push(diff(s, s + 1));
    if (s + W < n && seedSet[s + W]) local.push(diff(s, s + W));
  }
  local.sort((a, b) => a - b);
  const noise = Math.max(3, (local[Math.floor(local.length * 0.75)] ?? 4) * 1.2);
  // Color medio de lo pintado: alejarse de él también cuesta (para no "saltar" por degradados suaves).
  let mr = 0, mg = 0, mb = 0;
  for (const s of seeds) { mr += img[s * 3]; mg += img[s * 3 + 1]; mb += img[s * 3 + 2]; }
  const ns = Math.max(1, seeds.length);
  mr /= ns; mg /= ns; mb /= ns;
  let spread = 0;
  for (const s of seeds) spread += Math.hypot(img[s * 3] - mr, img[s * 3 + 1] - mg, img[s * 3 + 2] - mb);
  spread = spread / ns + 12;
  const heap = new Heap();
  for (const s of seeds) { dist[s] = 0; heap.push(0, s); }
  const limit = 60 * strength;
  while (heap.size) {
    const p = heap.pop();
    const dp = dist[p];
    if (dp > limit) break;
    const x = p % W;
    const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p >= W ? p - W : -1, p + W < n ? p + W : -1];
    for (const q of nb) {
      if (q < 0) continue;
      const edge = Math.max(0, diff(p, q) - noise);
      const far = Math.max(0, Math.hypot(img[q * 3] - mr, img[q * 3 + 1] - mg, img[q * 3 + 2] - mb) - spread * 1.6) * 0.08;
      const nd = dp + edge * 1.5 + far + 0.02;
      if (nd < dist[q]) { dist[q] = nd; heap.push(nd, q); }
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = dist[i] <= limit ? 1 : 0;
  // Rellena agujeros pequeños (motas dentro del objeto).
  return fillHoles(out, W, H, Math.max(16, (n / 400) | 0));
}

/** Rellena los huecos (zonas no seleccionadas sin salida al borde) más pequeños que `max` píxeles. */
function fillHoles(m: Uint8Array, W: number, H: number, max: number): Uint8Array {
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (m[s] || seen[s]) continue;
    const comp: number[] = [];
    let border = false;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % W, y = (p - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && !m[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (!border && comp.length <= max) for (const p of comp) m[p] = 1;
  }
  return m;
}

/** Componente conexa (8-vecinos) de una máscara 0/1 que contiene `seed`, o la mayor si no hay semilla. */
export function component(m: Uint8Array, W: number, H: number, seed?: number): Uint8Array {
  const lab = new Int32Array(W * H).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  const sizes: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    const stack = [s]; lab[s] = id; let size = 0;
    while (stack.length) {
      const p = stack.pop()!; size++;
      const x = p % W, y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const q = Y * W + X;
        if (m[q] && lab[q] < 0) { lab[q] = id; stack.push(q); }
      }
    }
    sizes.push(size);
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  const want = seed !== undefined && lab[seed] >= 0 ? lab[seed] : best;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = lab[i] === want && want >= 0 ? 1 : 0;
  return out;
}

/** Amplía una máscara (0..1) de W×H a w×h con interpolación bilineal; devuelve 0..255. */
export function upscaleMask(m: Float32Array | Uint8Array, W: number, H: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), tx = fx - x0;
      const v = (m[y0 * W + x0] * (1 - tx) + m[y0 * W + x1] * tx) * (1 - ty) + (m[y1 * W + x0] * (1 - tx) + m[y1 * W + x1] * tx) * ty;
      out[y * w + x] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return out;
}

/** Media de caja (radio r) con tabla integral. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += src[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/**
 * Filtro guiado (He et al.): ajusta la máscara `p` (0..1) a los bordes de la imagen guía (luminancia).
 * Es lo que hace que el pelo y los bordes finos salgan bien al refinar.
 */
export function guidedFilter(guide: Float32Array, p: Float32Array, w: number, h: number, r: number, eps = 1e-3): Float32Array {
  const n = w * h;
  const mI = boxMean(guide, w, h, r), mp = boxMean(p, w, h, r);
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = guide[i] * p[i]; II[i] = guide[i] * guide[i]; }
  const mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i], v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps); b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, ma[i] * guide[i] + mb[i]));
  return q;
}

/** Luminancia 0..1 de RGBA (lo transparente como blanco). */
export function luminance(px: Uint8ClampedArray, n: number): Float32Array {
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3] / 255;
    g[i] = ((0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) * a + 255 * (1 - a)) / 255;
  }
  return g;
}

/** Ajusta el borde de una máscara a la imagen (Mejora automática / radio inteligente). */
export function snapEdges(px: Uint8ClampedArray, mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const n = w * h, p = new Float32Array(n);
  for (let i = 0; i < n; i++) p[i] = mask[i] / 255;
  const q = guidedFilter(luminance(px, n), p, w, h, Math.max(1, Math.round(radius)), 2e-3);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(q[i] * 255);
  return out;
}

// ------------------------------------------------------------------ Gama de colores

export interface ColorRangeParams {
  /** Colores de muestra (RGB). */
  samples: [number, number, number][];
  /** Tolerancia (0..200, como Photoshop). */
  fuzziness: number;
  /** Rango preestablecido en lugar de muestras. */
  preset?: 'sampled' | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas' | 'highlights' | 'midtones' | 'shadows' | 'skin';
  invert?: boolean;
}

function hueOf(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return { h: 0, s: 0 };
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return { h, s: d / mx };
}

/** Selección > Gama de colores: máscara 0..255 según las muestras o un rango. */
export function colorRange(px: Uint8ClampedArray, n: number, p: ColorRangeParams): Uint8Array {
  const out = new Uint8Array(n);
  const fz = Math.max(1, p.fuzziness);
  const preset = p.preset ?? 'sampled';
  const HUES: Record<string, number> = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };
  for (let i = 0; i < n; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    let v = 0;
    if (preset === 'sampled') {
      let best = Infinity;
      for (const [sr, sg, sb] of p.samples) best = Math.min(best, Math.hypot(r - sr, g - sg, b - sb));
      // Igual que Photoshop: dentro de la tolerancia, transición suave hasta 0.
      v = best <= fz * 0.5 ? 1 : Math.max(0, 1 - (best - fz * 0.5) / (fz * 0.5));
    } else if (preset in HUES) {
      const { h, s } = hueOf(r, g, b);
      let dh = Math.abs(h - HUES[preset]); if (dh > 180) dh = 360 - dh;
      v = s > 0.15 ? Math.max(0, 1 - Math.max(0, dh - 15) / 30) * Math.min(1, (s - 0.15) * 4) : 0;
    } else {
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      if (preset === 'highlights') v = Math.min(1, Math.max(0, (l - 0.65) / 0.15));
      else if (preset === 'shadows') v = Math.min(1, Math.max(0, (0.35 - l) / 0.15));
      else if (preset === 'midtones') v = Math.max(0, 1 - Math.abs(l - 0.5) / 0.25);
      else if (preset === 'skin') {
        const { h, s } = hueOf(r, g, b);
        v = h >= 5 && h <= 45 && s > 0.15 && s < 0.68 && r > 60 && r > b ? 1 : 0;
      }
    }
    v *= px[i * 4 + 3] / 255;
    out[i] = Math.round((p.invert ? 1 - v : v) * 255);
  }
  return out;
}

// ------------------------------------------------------------------ Seleccionar y aplicar máscara

export interface RefineParams {
  /** Radio de detección de bordes (px); con `smart`, se adapta a los bordes (pelo). */
  radius: number;
  smart: boolean;
  /** Suavizar (0..100), Calar (px), Contraste (0..100), Desplazar borde (-100..100 %). */
  smooth: number;
  feather: number;
  contrast: number;
  shift: number;
}

/** Refina una máscara 0..255 sobre la imagen (mismo tamaño). */
export function refineMask(px: Uint8ClampedArray, mask: Uint8Array, w: number, h: number, p: RefineParams): Uint8Array {
  const n = w * h;
  let m: Float32Array = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = mask[i] / 255;
  if (p.smooth > 0) {
    // Suavizar: quita escalones del contorno (media y vuelta a binarizar suave).
    const r = Math.max(1, Math.round(p.smooth / 15));
    const b = boxMean(m, w, h, r);
    for (let i = 0; i < n; i++) m[i] = Math.min(1, Math.max(0, (b[i] - 0.5) * 3 + 0.5));
  }
  if (p.radius > 0) {
    // Radio: en la franja del borde la máscara se recalcula siguiendo la imagen (filtro guiado).
    const g = luminance(px, n);
    const q = guidedFilter(g, m, w, h, Math.max(1, Math.round(p.radius)), p.smart ? 1e-4 : 4e-3);
    if (p.smart) {
      // Radio inteligente: solo dentro de la franja de incertidumbre (cerca del borde).
      const band = boxMean(m, w, h, Math.max(1, Math.round(p.radius)));
      for (let i = 0; i < n; i++) if (band[i] > 0.02 && band[i] < 0.98) m[i] = q[i];
    } else m = q;
  }
  if (p.shift) {
    const k = p.shift / 100;
    // Desplazar borde: se dilata o contrae con un desenfoque y un umbral desplazado.
    const r = Math.max(1, Math.round(Math.abs(p.shift) / 20));
    const b = boxMean(m, w, h, r), t = 0.5 - k * 0.45;
    for (let i = 0; i < n; i++) m[i] = Math.min(1, Math.max(0, (b[i] - t) / 0.1 + 0.5));
  }
  if (p.feather > 0) {
    const r = Math.max(1, Math.round(p.feather / 2));
    m = boxMean(boxMean(m, w, h, r), w, h, r);
  }
  if (p.contrast > 0) {
    const k = 1 + (p.contrast / 100) * 20;
    for (let i = 0; i < n; i++) m[i] = Math.min(1, Math.max(0, (m[i] - 0.5) * k + 0.5));
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(m[i] * 255);
  return out;
}

/**
 * Descontaminar colores: en los bordes semitransparentes, el color del fondo se sustituye por el
 * del objeto más cercano (se "estira" el color del interior hacia fuera).
 */
export function decontaminate(px: Uint8ClampedArray, mask: Uint8Array, w: number, h: number, amount = 1): Uint8ClampedArray {
  const n = w * h, out = px.slice();
  // Color del interior difundido hacia fuera (pull-push simple con varias pasadas de caja ponderada).
  const wgt = new Float32Array(n), cr = new Float32Array(n), cg = new Float32Array(n), cb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = mask[i] > 240 ? 1 : 0;
    wgt[i] = a; cr[i] = px[i * 4] * a; cg[i] = px[i * 4 + 1] * a; cb[i] = px[i * 4 + 2] * a;
  }
  let W = wgt, R = cr, G = cg, B = cb;
  for (const r of [2, 4, 8, 16]) {
    const mw = boxMean(W, w, h, r), mr = boxMean(R, w, h, r), mg = boxMean(G, w, h, r), mb = boxMean(B, w, h, r);
    for (let i = 0; i < n; i++) if (W[i] < 0.5 && mw[i] > 0) { W[i] = 1; R[i] = mr[i] / mw[i]; G[i] = mg[i] / mw[i]; B[i] = mb[i] / mw[i]; } else if (W[i] >= 0.5 && wgt[i]) { R[i] = cr[i]; G[i] = cg[i]; B[i] = cb[i]; }
    W = W.slice(); R = R.slice(); G = G.slice(); B = B.slice();
  }
  for (let i = 0; i < n; i++) {
    const m = mask[i] / 255;
    if (m <= 0.02 || m >= 0.98 || !W[i]) continue;
    const t = (1 - m) * amount;
    out[i * 4] = px[i * 4] + (R[i] - px[i * 4]) * t;
    out[i * 4 + 1] = px[i * 4 + 1] + (G[i] - px[i * 4 + 1]) * t;
    out[i * 4 + 2] = px[i * 4 + 2] + (B[i] - px[i * 4 + 2]) * t;
  }
  return out;
}
