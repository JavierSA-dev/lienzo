/**
 * Visión por computador para Photomerge, Alinear capas y Combinar para HDR:
 * esquinas de Harris + descriptores binarios orientados (tipo ORB), emparejado por distancia de
 * Hamming con prueba de cociente y comprobación mutua, homografía robusta (RANSAC + mínimos
 * cuadrados), y para HDR alineación por mapas de umbral de la mediana y fusión de exposiciones.
 */
import { homography, applyH, invertH } from './meshwarp';

export type Pt = [number, number];

export interface Features { pts: Pt[]; desc: Uint32Array; scale: number }

/** Gris reducido a `maxSide` (para detectar rasgos rápido). */
export function grayDown(px: Uint8ClampedArray, w: number, h: number, maxSide: number): { g: Float32Array; w: number; h: number; s: number } {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const W = Math.max(8, Math.round(w * s)), H = Math.max(8, Math.round(h * s));
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y / s), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) / s)));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x / s), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) / s)));
      let acc = 0, n = 0;
      for (let yy = y0; yy < y1; yy += Math.max(1, ((y1 - y0) / 3) | 0)) for (let xx = x0; xx < x1; xx += Math.max(1, ((x1 - x0) / 3) | 0)) {
        const i = (yy * w + xx) * 4;
        acc += (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) * (px[i + 3] / 255); n++;
      }
      g[y * W + x] = acc / n / 255;
    }
  }
  return { g, w: W, h: H, s };
}

function blur3(g: Float32Array, w: number, h: number, passes = 2): Float32Array {
  let a = g.slice();
  const b = new Float32Array(g.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      b[i] = (a[y * w + Math.max(0, x - 1)] + 2 * a[i] + a[y * w + Math.min(w - 1, x + 1)]) / 4;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      a[i] = (b[Math.max(0, y - 1) * w + x] + 2 * b[i] + b[Math.min(h - 1, y + 1) * w + x]) / 4;
    }
  }
  return a;
}

// Parejas de muestreo del descriptor (fijas, deterministas) en un parche de radio 15.
const PAIRS: number[] = (() => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const g = () => { let v = 0; for (let i = 0; i < 4; i++) v += rnd(); return Math.max(-13, Math.min(13, (v - 2) * 9)); };
  const out: number[] = [];
  for (let i = 0; i < 256; i++) out.push(g(), g(), g(), g());
  return out;
})();

/** Rasgos: esquinas de Harris repartidas por la imagen, con orientación y descriptor de 256 bits. */
export function detect(g0: Float32Array, w: number, h: number, maxPts = 900): Features {
  const g = blur3(g0, w, h, 1);
  const Ixx = new Float32Array(w * h), Iyy = new Float32Array(w * h), Ixy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const ix = (g[i + 1] - g[i - 1]) * 0.5, iy = (g[i + w] - g[i - w]) * 0.5;
    Ixx[i] = ix * ix; Iyy[i] = iy * iy; Ixy[i] = ix * iy;
  }
  const sxx = blur3(Ixx, w, h, 2), syy = blur3(Iyy, w, h, 2), sxy = blur3(Ixy, w, h, 2);
  const R = new Float32Array(w * h);
  const B = 18;
  for (let y = B; y < h - B; y++) for (let x = B; x < w - B; x++) {
    const i = y * w + x, a = sxx[i], b = syy[i], c = sxy[i];
    R[i] = a * b - c * c - 0.04 * (a + b) * (a + b);
  }
  // Máximos locales, repartidos en una rejilla para cubrir toda la imagen.
  const cells = 8, cand: { x: number; y: number; r: number; cell: number }[] = [];
  for (let y = B; y < h - B; y++) for (let x = B; x < w - B; x++) {
    const i = y * w + x, r = R[i];
    if (r <= 1e-7) continue;
    let mx = true;
    for (let dy = -2; dy <= 2 && mx; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && R[i + dy * w + dx] > r) { mx = false; break; }
    if (mx) cand.push({ x, y, r, cell: Math.floor((y / h) * cells) * cells + Math.floor((x / w) * cells) });
  }
  cand.sort((a, b) => b.r - a.r);
  const per = Math.ceil(maxPts / (cells * cells)) * 2, count = new Map<number, number>();
  const chosen: typeof cand = [];
  for (const c of cand) {
    const n = count.get(c.cell) ?? 0;
    if (n >= per) continue;
    count.set(c.cell, n + 1); chosen.push(c);
    if (chosen.length >= maxPts) break;
  }
  const pts: Pt[] = [], desc = new Uint32Array(chosen.length * 8);
  const gs = blur3(g0, w, h, 2);
  chosen.forEach((c, k) => {
    // Orientación por centroide de intensidad (como ORB).
    let m01 = 0, m10 = 0;
    for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) { const v = gs[(c.y + dy) * w + c.x + dx]; m10 += dx * v; m01 += dy * v; }
    const ang = Math.atan2(m01, m10), ca = Math.cos(ang), sa = Math.sin(ang);
    for (let b = 0; b < 256; b++) {
      const [x1, y1, x2, y2] = [PAIRS[b * 4], PAIRS[b * 4 + 1], PAIRS[b * 4 + 2], PAIRS[b * 4 + 3]];
      const ax = Math.round(c.x + x1 * ca - y1 * sa), ay = Math.round(c.y + x1 * sa + y1 * ca);
      const bx = Math.round(c.x + x2 * ca - y2 * sa), by = Math.round(c.y + x2 * sa + y2 * ca);
      if (gs[ay * w + ax] < gs[by * w + bx]) desc[k * 8 + (b >> 5)] |= 1 << (b & 31);
    }
    pts.push([c.x, c.y]);
  });
  return { pts, desc, scale: 1 };
}

const pop = (v: number) => { v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

function nearest(a: Uint32Array, i: number, b: Uint32Array, nb: number): [number, number, number] {
  let best = 1e9, second = 1e9, bi = -1;
  for (let j = 0; j < nb; j++) {
    let d = 0;
    for (let k = 0; k < 8; k++) d += pop(a[i * 8 + k] ^ b[j * 8 + k]);
    if (d < best) { second = best; best = d; bi = j; } else if (d < second) second = d;
  }
  return [bi, best, second];
}

/** Parejas buenas: cociente < 0,8, distancia < 80 bits y mutuamente mejores. */
export function match(A: Features, B: Features): [Pt, Pt][] {
  const na = A.pts.length, nb = B.pts.length, out: [Pt, Pt][] = [];
  const back = new Int32Array(nb).fill(-1);
  for (let j = 0; j < nb; j++) back[j] = nearest(B.desc, j, A.desc, na)[0];
  for (let i = 0; i < na; i++) {
    const [j, d1, d2] = nearest(A.desc, i, B.desc, nb);
    if (j < 0 || d1 > 80 || d1 > 0.8 * d2 || back[j] !== i) continue;
    out.push([A.pts[i], B.pts[j]]);
  }
  return out;
}

/** Homografía por mínimos cuadrados (DLT normalizado con h33 = 1) a partir de n ≥ 4 parejas. */
export function fitHomography(pairs: [Pt, Pt][]): number[] | null {
  if (pairs.length < 4) return null;
  if (pairs.length === 4) return homography(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  // Normalización (Hartley) para estabilidad numérica.
  const norm = (ps: Pt[]) => {
    let mx = 0, my = 0; for (const [x, y] of ps) { mx += x; my += y; } mx /= ps.length; my /= ps.length;
    let d = 0; for (const [x, y] of ps) d += Math.hypot(x - mx, y - my); d = d / ps.length || 1;
    const s = Math.SQRT2 / d;
    return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1], f: (p: Pt): Pt => [(p[0] - mx) * s, (p[1] - my) * s] };
  };
  const na = norm(pairs.map((p) => p[0])), nbN = norm(pairs.map((p) => p[1]));
  const M = Array.from({ length: 8 }, () => new Array(8).fill(0)), v = new Array(8).fill(0);
  for (const [a, b] of pairs) {
    const [x, y] = na.f(a), [u, w] = nbN.f(b);
    const rows: [number[], number][] = [[[x, y, 1, 0, 0, 0, -u * x, -u * y], u], [[0, 0, 0, x, y, 1, -w * x, -w * y], w]];
    for (const [r, t] of rows) for (let i = 0; i < 8; i++) { v[i] += r[i] * t; for (let j = 0; j < 8; j++) M[i][j] += r[i] * r[j]; }
  }
  // Gauss con pivote.
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; [v[c], v[p]] = [v[p], v[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < 8; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; if (!f) continue; for (let k = c; k < 8; k++) M[r][k] -= f * M[c][k]; v[r] -= f * v[c]; }
  }
  const hn = [...v.map((x, i) => x / M[i][i]), 1];
  // Deshace la normalización: H = Tb⁻¹ · Hn · Ta
  const mul = (A: number[], Bm: number[]) => { const o = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += A[i * 3 + k] * Bm[k * 3 + j]; return o; };
  const H = mul(mul(invertH(nbN.T), hn), na.T);
  return H.map((x) => x / H[8]);
}

/** RANSAC: la homografía con más parejas dentro de `thr` px (y reajustada con todas ellas). */
export function ransac(pairs: [Pt, Pt][], thr = 3, iters = 1200, affineOnly = false): { H: number[]; inliers: number } | null {
  if (pairs.length < 4) return null;
  let seed = 987654;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let best: number[] | null = null, bestN = 0;
  const err = (H: number[], [a, b]: [Pt, Pt]) => { const [x, y] = applyH(H, a[0], a[1]); return Math.hypot(x - b[0], y - b[1]); };
  for (let it = 0; it < iters; it++) {
    const idx = new Set<number>();
    while (idx.size < 4) idx.add(rnd(pairs.length));
    const sample = [...idx].map((i) => pairs[i]);
    let H = homography(sample.map((p) => p[0]), sample.map((p) => p[1]));
    if (affineOnly) H = [H[0], H[1], H[2], H[3], H[4], H[5], 0, 0, 1];
    // Rechaza homografías degeneradas (espejo o perspectiva extrema).
    const det = H[0] * H[4] - H[1] * H[3];
    if (!(det > 0.05 && det < 20) || Math.abs(H[6]) > 0.01 || Math.abs(H[7]) > 0.01) continue;
    let n = 0;
    for (const p of pairs) if (err(H, p) < thr) n++;
    if (n > bestN) { bestN = n; best = H; }
  }
  if (!best || bestN < 8) return null;
  const inl = pairs.filter((p) => err(best!, p) < thr);
  const refined = fitHomography(inl) ?? best;
  return { H: refined, inliers: inl.length };
}

/** Escala una homografía calculada en imágenes reducidas (sa, sb) a tamaño real. */
export function scaleH(H: number[], sa: number, sb: number): number[] {
  // x_b = S_b⁻¹ · H · S_a · x_a
  const o = [H[0], H[1] / sa * sa, H[2], H[3], H[4], H[5], H[6], H[7], H[8]];
  const Sa = [sa, 0, 0, 0, sa, 0, 0, 0, 1], Sbi = [1 / sb, 0, 0, 0, 1 / sb, 0, 0, 0, 1];
  const mul = (A: number[], B: number[]) => { const r = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j]; return r; };
  const R = mul(mul(Sbi, o), Sa);
  return R.map((x) => x / R[8]);
}

export const mulH = (A: number[], B: number[]) => { const r = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j]; return r.map((x) => x / r[8]); };

// ------------------------------------------------------------------ HDR

/** Desplazamiento entero (dx, dy) que alinea `b` con `a` por mapas de umbral de la mediana (Ward). */
export function mtbAlign(a: Float32Array, b: Float32Array, w: number, h: number, levels = 5): Pt {
  const med = (g: Float32Array) => { const s = Float32Array.from(g.filter((_, i) => i % 7 === 0)).sort(); return s[s.length >> 1]; };
  const down = (g: Float32Array, W: number, H: number) => {
    const w2 = W >> 1, h2 = H >> 1, o = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) o[y * w2 + x] = (g[2 * y * W + 2 * x] + g[2 * y * W + 2 * x + 1] + g[(2 * y + 1) * W + 2 * x] + g[(2 * y + 1) * W + 2 * x + 1]) / 4;
    return o;
  };
  const pyr: { a: Float32Array; b: Float32Array; w: number; h: number }[] = [{ a, b, w, h }];
  for (let l = 1; l < levels && pyr[l - 1].w > 32; l++) { const p = pyr[l - 1]; pyr.push({ a: down(p.a, p.w, p.h), b: down(p.b, p.w, p.h), w: p.w >> 1, h: p.h >> 1 }); }
  let sx = 0, sy = 0;
  for (let l = pyr.length - 1; l >= 0; l--) {
    const { a: A, b: Bm, w: W, h: H } = pyr[l];
    const ma = med(A), mb = med(Bm);
    let best = Infinity, bx = 0, by = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ox = sx * 2 * (l < pyr.length - 1 ? 1 : 0) + dx, oy = sy * 2 * (l < pyr.length - 1 ? 1 : 0) + dy;
      let e = 0;
      for (let y = 2; y < H - 2; y += 1) for (let x = 2; x < W - 2; x += 1) {
        const xb = x + ox, yb = y + oy;
        if (xb < 0 || yb < 0 || xb >= W || yb >= H) continue;
        const va = A[y * W + x], vb = Bm[yb * W + xb];
        if (Math.abs(va - ma) < 0.02 || Math.abs(vb - mb) < 0.02) continue; // máscara de exclusión
        if ((va > ma) !== (vb > mb)) e++;
      }
      if (e < best) { best = e; bx = ox; by = oy; }
    }
    sx = bx; sy = by;
  }
  return [sx, sy];
}

/**
 * Fusión de exposiciones (Mertens): pesos de contraste, saturación y buena exposición, suavizados
 * a escala reducida para evitar halos. Devuelve RGBA.
 */
export function exposureFusion(imgs: Uint8ClampedArray[], w: number, h: number, shifts: Pt[], strength = 1): Uint8ClampedArray {
  const n = imgs.length, s = Math.min(1, 512 / Math.max(w, h));
  const W = Math.max(4, Math.round(w * s)), H = Math.max(4, Math.round(h * s));
  const weights: Float32Array[] = [];
  for (let k = 0; k < n; k++) {
    const px = imgs[k], [dx, dy] = shifts[k];
    const wt = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const X = Math.min(w - 1, Math.max(0, Math.floor((x + 0.5) / s) + dx)), Y = Math.min(h - 1, Math.max(0, Math.floor((y + 0.5) / s) + dy));
      const i = (Y * w + X) * 4;
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255, m = (r + g + b) / 3;
      const sat = Math.sqrt(((r - m) ** 2 + (g - m) ** 2 + (b - m) ** 2) / 3);
      const we = Math.exp(-((r - 0.5) ** 2) / 0.08) * Math.exp(-((g - 0.5) ** 2) / 0.08) * Math.exp(-((b - 0.5) ** 2) / 0.08);
      // Contraste: Laplaciano del gris en la imagen original alrededor del punto.
      const at = (xx: number, yy: number) => { const j = (Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))) * 4; return (px[j] + px[j + 1] + px[j + 2]) / 765; };
      const st = Math.max(1, Math.round(1 / s));
      const lap = Math.abs(4 * at(X, Y) - at(X - st, Y) - at(X + st, Y) - at(X, Y - st) - at(X, Y + st));
      wt[y * W + x] = (lap + 0.02) * (sat + 0.05) * (we ** strength) + 1e-6;
    }
    weights.push(blur3(wt, W, H, 6));
  }
  const out = new Uint8ClampedArray(w * h * 4);
  const ws = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(H - 1.001, Math.max(0, (y + 0.5) * s - 0.5)), y0 = Math.floor(fy), ay = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(W - 1.001, Math.max(0, (x + 0.5) * s - 0.5)), x0 = Math.floor(fx), ax = fx - x0;
      let tot = 0;
      for (let k = 0; k < n; k++) {
        const g = weights[k], i = y0 * W + x0;
        ws[k] = (g[i] * (1 - ax) + g[i + 1] * ax) * (1 - ay) + (g[i + W] * (1 - ax) + g[i + W + 1] * ax) * ay;
        tot += ws[k];
      }
      let r = 0, gg = 0, b = 0;
      for (let k = 0; k < n; k++) {
        const [dx, dy] = shifts[k];
        const X = Math.min(w - 1, Math.max(0, x + dx)), Y = Math.min(h - 1, Math.max(0, y + dy)), j = (Y * w + X) * 4, f = ws[k] / tot;
        r += imgs[k][j] * f; gg += imgs[k][j + 1] * f; b += imgs[k][j + 2] * f;
      }
      const o = (y * w + x) * 4;
      out[o] = r; out[o + 1] = gg; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return out;
}
