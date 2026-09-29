// Retoques puntuales de los cursos: pupilas rojas y contornear la selección.

/** Transformada de distancia euclídea 1D (Felzenszwalb-Huttenlocher) sobre `f` (distancias al cuadrado). */
function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distancia (en píxeles) de cada píxel al píxel más cercano con `target[i] = 1`. */
export function distanceTo(target: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20, n = Math.max(w, h);
  const g = new Float64Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = target[i] ? 0 : INF;
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

export type StrokeLocation = 'inside' | 'center' | 'outside';

/**
 * Cobertura del contorno de una máscara de selección (0..255), como Edición > Contornear.
 * `mask` es la selección dentro de la región (con margen suficiente para el borde exterior).
 */
export function strokeCoverage(mask: Uint8Array, w: number, h: number, width: number, location: StrokeLocation): Uint8Array {
  const inside = new Uint8Array(w * h), outside = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) { if (mask[i] >= 128) inside[i] = 1; else outside[i] = 1; }
  // Distancia del borde: a medio camino entre los centros de un píxel dentro y uno fuera.
  const dIn = distanceTo(outside, w, h), dOut = distanceTo(inside, w, h);
  const [a, b] = location === 'inside' ? [width, 0] : location === 'outside' ? [0, width] : [width / 2, width / 2];
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const c = inside[i] ? Math.min(1, Math.max(0, a + 0.5 - (dIn[i] - 0.5))) : Math.min(1, Math.max(0, b + 0.5 - (dOut[i] - 0.5)));
    out[i] = Math.round(c * 255);
  }
  return out;
}

/** La piel también es rojiza (R/(G+B)/2 ≈ 1,3–1,6); una pupila roja pasa de 2. */
function redness(r: number, g: number, b: number) {
  if (r < 60 || r <= Math.max(g, b)) return 0;
  const ratio = r / ((g + b) / 2 + 8);
  return Math.min(1, Math.max(0, (ratio - 1.6) / 1.4));
}

/**
 * Pupilas rojas: dentro de la región busca la mancha roja conectada más cercana al centro,
 * la desatura y la oscurece. `pupil` (1..100) amplía la zona; `darken` (1..100) la oscurece.
 * Devuelve cuántos píxeles se corrigieron.
 */
export function fixRedEye(px: Uint8ClampedArray, w: number, h: number, pupil = 50, darken = 50, seedIn?: { x: number; y: number; w: number; h: number }): number {
  const red = new Float32Array(w * h);
  for (let i = 0, j = 0; j < red.length; i += 4, j++) red[j] = px[i + 3] ? redness(px[i], px[i + 1], px[i + 2]) : 0;
  // Semilla: el píxel más rojo, ponderando la cercanía al centro.
  let seed = -1, best = 0.25;
  const s = seedIn ?? { x: 0, y: 0, w, h };
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2, R = Math.hypot(s.w / 2, s.h / 2) || 1;
  for (let y = Math.max(0, s.y); y < Math.min(h, s.y + s.h); y++) for (let x = Math.max(0, s.x); x < Math.min(w, s.x + s.w); x++) {
    const v = red[y * w + x] * (1 - 0.5 * Math.hypot(x - cx, y - cy) / R);
    if (v > best) { best = v; seed = y * w + x; }
  }
  if (seed < 0) return 0;
  // Relleno por inundación de los píxeles rojizos conectados (umbral según el tamaño de pupila).
  const thr = 0.35 - (pupil / 100) * 0.25;
  const inMask = new Uint8Array(w * h);
  const stack = [seed];
  inMask[seed] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i - x) / w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && !inMask[j] && red[j] > thr) { inMask[j] = 1; stack.push(j); }
  }
  // Borde suave: se amplía 1–3 px según la pupila, con peso por rojez.
  const grow = 1 + Math.round((pupil / 100) * 2);
  const dist = distanceTo(inMask, w, h);
  const k = 0.25 + (darken / 100) * 0.7; // fracción de oscurecimiento
  let n = 0;
  for (let j = 0, i = 0; j < red.length; j++, i += 4) {
    const dd = dist[j];
    if (dd > grow) continue;
    const edge = dd === 0 ? 1 : 1 - dd / (grow + 1);
    const wgt = Math.min(1, edge * (dd === 0 ? 1 : Math.min(1, red[j] * 3)));
    if (wgt <= 0) continue;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const base = (g + b) / 2 * (1 - k);
    const nr = Math.min(r, base), ng = g * (1 - k), nb2 = b * (1 - k);
    px[i] = r + (nr - r) * wgt; px[i + 1] = g + (ng - g) * wgt; px[i + 2] = b + (nb2 - b) * wgt;
    n++;
  }
  return n;
}
