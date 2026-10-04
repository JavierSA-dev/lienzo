/**
 * Remuestreo separable por bandas (filtro triangular escalado: bilineal al ampliar,
 * promedio de área al reducir). Cada banda de filas de salida es independiente,
 * así que se reparte entre varios workers.
 */

export interface Weights { starts: Int32Array; counts: Int32Array; w: Float32Array; maxTaps: number }

/** Métodos de remuestreo (como Tamaño de imagen de Photoshop). */
export type ResampleMethod = 'bilinear' | 'bicubic' | 'smoother' | 'sharper' | 'nearest';

const KERNELS: Record<Exclude<ResampleMethod, 'nearest'>, { r: number; f: (x: number) => number }> = {
  bilinear: { r: 1, f: (x) => (x < 1 ? 1 - x : 0) },
  // Catmull-Rom (bicúbica de Photoshop).
  bicubic: { r: 2, f: (x) => (x < 1 ? 1.5 * x ** 3 - 2.5 * x * x + 1 : x < 2 ? -0.5 * x ** 3 + 2.5 * x * x - 4 * x + 2 : 0) },
  // Mitchell-Netravali (más suavizada, para ampliar sin halos).
  smoother: { r: 2, f: (x) => (x < 1 ? (7 * x ** 3 - 12 * x * x + 16 / 3) / 6 : x < 2 ? (-7 / 3 * x ** 3 + 12 * x * x - 20 * x + 32 / 3) / 6 : 0) },
  // Lanczos 3 (más nítida, para reducir y para Conservar detalles).
  sharper: { r: 3, f: (x) => { if (x < 1e-6) return 1; if (x >= 3) return 0; const p = Math.PI * x; return (3 * Math.sin(p) * Math.sin(p / 3)) / (p * p); } },
};

export function weights(srcLen: number, dstLen: number, method: ResampleMethod = 'bilinear'): Weights {
  const scale = dstLen / srcLen;
  if (method === 'nearest') {
    const starts = new Int32Array(dstLen), counts = new Int32Array(dstLen).fill(1), w = new Float32Array(dstLen).fill(1);
    for (let d = 0; d < dstLen; d++) starts[d] = Math.min(srcLen - 1, Math.floor((d + 0.5) / scale));
    return { starts, counts, w, maxTaps: 1 };
  }
  const K = KERNELS[method];
  const support = K.r * (scale < 1 ? 1 / scale : 1);
  const starts = new Int32Array(dstLen);
  const counts = new Int32Array(dstLen);
  const maxTaps = Math.ceil(support * 2) + 2;
  const w = new Float32Array(dstLen * maxTaps);
  for (let d = 0; d < dstLen; d++) {
    const center = (d + 0.5) / scale - 0.5;
    const lo = Math.max(0, Math.floor(center - support + 1e-6));
    const hi = Math.min(srcLen - 1, Math.ceil(center + support - 1e-6));
    let sum = 0, n = 0;
    for (let s = lo; s <= hi && n < maxTaps; s++, n++) {
      const x = (Math.abs(s - center) / support) * K.r;
      const v = K.f(x);
      w[d * maxTaps + n] = v;
      sum += v;
    }
    if (sum > 0) for (let i = 0; i < n; i++) w[d * maxTaps + i] /= sum;
    else { w[d * maxTaps] = 1; n = 1; }
    starts[d] = lo;
    counts[d] = n;
  }
  return { starts, counts, w, maxTaps };
}

/** Filas de origen [y0, y1) necesarias para producir las filas de salida [d0, d1). */
export function sourceRows(sh: number, dh: number, d0: number, d1: number, method: ResampleMethod = 'bilinear'): [number, number] {
  const { starts, counts } = weights(sh, dh, method);
  let y0 = Infinity, y1 = -Infinity;
  for (let d = d0; d < d1; d++) {
    y0 = Math.min(y0, starts[d]);
    y1 = Math.max(y1, starts[d] + counts[d]);
  }
  return [y0, y1];
}

export interface BandJob {
  slice: Uint8ClampedArray; // filas [y0, y0+rows) del origen, RGBA alfa directo
  sw: number;
  sh: number;
  y0: number;
  rows: number;
  dw: number;
  dh: number;
  d0: number;
  d1: number;
  method?: ResampleMethod;
}

/** Calcula las filas [d0, d1) de la imagen redimensionada. Devuelve RGBA dw×(d1-d0). */
export function resampleBand(j: BandJob): Uint8ClampedArray {
  const { slice, sw, sh, y0, rows, dw, dh, d0, d1 } = j;
  const method = j.method ?? 'bilinear';
  // 1) Premultiplica (evita halos oscuros en bordes transparentes).
  const pm = new Uint8ClampedArray(slice.length);
  for (let i = 0; i < slice.length; i += 4) {
    const a = slice[i + 3];
    if (a === 255) { pm[i] = slice[i]; pm[i + 1] = slice[i + 1]; pm[i + 2] = slice[i + 2]; pm[i + 3] = 255; }
    else if (a) { const f = a / 255; pm[i] = slice[i] * f; pm[i + 1] = slice[i + 1] * f; pm[i + 2] = slice[i + 2] * f; pm[i + 3] = a; }
  }
  // 2) Pasada horizontal: sw -> dw sobre las filas de la banda.
  const H = weights(sw, dw, method);
  const tmp = new Float32Array(dw * rows * 4); // en coma flotante: los lóbulos negativos no se recortan a medias
  for (let y = 0; y < rows; y++) {
    const row = y * sw * 4, orow = y * dw * 4;
    for (let d = 0; d < dw; d++) {
      let r = 0, g = 0, b = 0, a = 0;
      const base = d * H.maxTaps;
      let si = row + H.starts[d] * 4;
      for (let i = 0, n = H.counts[d]; i < n; i++, si += 4) {
        const k = H.w[base + i];
        r += pm[si] * k; g += pm[si + 1] * k; b += pm[si + 2] * k; a += pm[si + 3] * k;
      }
      const o = orow + d * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }
  // 3) Pasada vertical: filas de salida [d0, d1).
  const V = weights(sh, dh, method);
  const stride = dw * 4;
  const out = new Uint8ClampedArray((d1 - d0) * stride);
  const acc = new Float32Array(stride);
  for (let d = d0; d < d1; d++) {
    acc.fill(0);
    const base = d * V.maxTaps;
    for (let i = 0, n = V.counts[d]; i < n; i++) {
      const k = V.w[base + i];
      const row = (V.starts[d] + i - y0) * stride;
      for (let x = 0; x < stride; x++) acc[x] += tmp[row + x] * k;
    }
    const o = (d - d0) * stride;
    for (let x = 0; x < stride; x += 4) {
      const a = Math.max(0, Math.min(255, acc[x + 3]));
      if (a < 0.5) { out[o + x] = out[o + x + 1] = out[o + x + 2] = out[o + x + 3] = 0; continue; }
      if (a < 254.5) {
        const f = 255 / a;
        out[o + x] = acc[x] * f; out[o + x + 1] = acc[x + 1] * f; out[o + x + 2] = acc[x + 2] * f;
      } else {
        out[o + x] = acc[x]; out[o + x + 1] = acc[x + 1]; out[o + x + 2] = acc[x + 2];
      }
      out[o + x + 3] = a;
    }
  }
  return out;
}

/** Automático (como Photoshop): Conservar detalles al ampliar, más nítida al reducir. */
export function autoMethod(scale: number): ResampleMethod { return scale === 1 ? 'bicubic' : 'sharper'; }

/** Versión de una sola pieza (tests y archivos pequeños). */
export function resample(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  return resampleBand({ slice: src, sw, sh, y0: 0, rows: sh, dw, dh, d0: 0, d1: dh });
}
