/**
 * Núcleos de cálculo en CPU que se ejecutan en el pool de workers:
 * filtros, transformación afín y deformación (licuar). Funciones puras sobre RGBA
 * con alfa directo; los desenfoques trabajan en premultiplicado.
 */
import { backMap, type WarpSpec } from './meshwarp';
import { resampleBand, type BandJob } from './resample';
import { inpaint, heal } from './inpaint';

export type FilterName =
  | 'gaussianBlur' | 'boxBlur' | 'motionBlur' | 'unsharpMask' | 'sharpen' | 'addNoise' | 'mosaic'
  | 'highPass' | 'findEdges' | 'emboss' | 'clouds' | 'median';

export interface FilterParams {
  radius?: number;
  amount?: number;
  threshold?: number;
  angle?: number;
  distance?: number;
  cell?: number;
  monochrome?: boolean;
  gaussian?: boolean;
  height?: number;
  seed?: number;
  fg?: [number, number, number, number];
  bg?: [number, number, number, number];
}

/** Filas de margen que necesita cada filtro por encima y por debajo de la banda. */
export function filterApron(name: FilterName, p: FilterParams): number {
  switch (name) {
    case 'gaussianBlur': case 'unsharpMask': case 'highPass': return Math.ceil((p.radius ?? 1) * 3) + 2;
    case 'boxBlur': return Math.ceil(p.radius ?? 1) + 1;
    case 'median': return Math.ceil(p.radius ?? 1) + 1;
    case 'motionBlur': return Math.ceil(p.distance ?? 10) + 1;
    case 'sharpen': case 'findEdges': return 2;
    case 'emboss': return Math.ceil(p.height ?? 3) + 1;
    default: return 0;
  }
}

/** Filtros que no se pueden trocear por bandas (se calculan de una vez). */
export const WHOLE_FILTERS = new Set<FilterName>(['mosaic']);

export interface FilterJob {
  op: 'filter';
  name: FilterName;
  params: FilterParams;
  src: Uint8ClampedArray; // w × rows, RGBA
  w: number;
  rows: number;
  top: number;            // fila de src donde empieza la salida
  outRows: number;
  /** Coordenadas de documento del píxel (0,0) de src (para ruido y mosaico estables). */
  ox: number;
  oy: number;
}

export interface AffineJob {
  op: 'affine';
  src: Uint8ClampedArray; // región de origen (puede ser SharedArrayBuffer)
  sw: number; sh: number; sx: number; sy: number; // tamaño y posición (doc) del origen
  inv: [number, number, number, number, number, number]; // destino(doc) -> origen(doc)
  x: number; y: number; w: number; rows: number;  // banda de salida (doc)
  ss: number;                                      // supermuestreo por eje
}

export interface WarpJob {
  op: 'warp';
  src: Uint8ClampedArray; sw: number; sh: number;
  field: Float32Array; fw: number; fh: number; scale: number; // desplazamiento (dx,dy) por celda
  y0: number; rows: number;
}

/** Relleno según contenido / pincel corrector puntual: `hole` = 1 donde hay que rellenar. */
export interface InpaintJob {
  op: 'inpaint';
  src: Uint8ClampedArray; w: number; h: number;
  hole: Uint8Array;
  /** Si se da, el resultado se mezcla con el original según esta máscara (0..1): bordes suaves. */
  blend?: Float32Array;
  seed?: number;
}

/** Pincel corrector: textura de `src`, color del entorno de `dst`, en la zona `mask` (0..1). */
export interface HealJob {
  op: 'heal';
  src: Uint8ClampedArray; dst: Uint8ClampedArray; mask: Float32Array; w: number; h: number;
}

/** Transformación no afín (perspectiva, deformar, posición libre) por muestreo inverso. */
export interface MapWarpJob {
  op: 'mapwarp';
  src: Uint8ClampedArray; sw: number; sh: number; sx: number; sy: number;
  spec: WarpSpec;
  x: number; y: number; w: number; rows: number; ss: number;
}

export type PoolJob = ({ op: 'resample' } & BandJob) | FilterJob | AffineJob | WarpJob | InpaintJob | HealJob | MapWarpJob;

export function runJob(j: PoolJob): Uint8ClampedArray {
  switch (j.op) {
    case 'resample': return resampleBand(j);
    case 'filter': return runFilter(j);
    case 'affine': return runAffine(j);
    case 'mapwarp': return runMapWarp(j);
    case 'warp': return runWarp(j);
    case 'inpaint': {
      const filled = inpaint(j.src, j.w, j.h, j.hole, j.seed);
      return j.blend ? heal(filled, j.src, j.blend, j.w, j.h) : filled;
    }
    case 'heal': return heal(j.src, j.dst, j.mask, j.w, j.h);
  }
}


// ------------------------------------------------------------------ utilidades

function premultiply(src: Uint8ClampedArray): Float32Array {
  const f = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] / 255;
    f[i] = src[i] * a; f[i + 1] = src[i + 1] * a; f[i + 2] = src[i + 2] * a; f[i + 3] = src[i + 3];
  }
  return f;
}

function unpremultiplyRows(f: Float32Array, w: number, top: number, rows: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * rows * 4);
  const base = top * w * 4;
  for (let i = 0; i < out.length; i += 4) {
    const a = f[base + i + 3];
    if (a <= 0.5) continue;
    const k = 255 / a;
    out[i] = f[base + i] * k; out[i + 1] = f[base + i + 1] * k; out[i + 2] = f[base + i + 2] * k; out[i + 3] = a;
  }
  return out;
}

function boxH(f: Float32Array, w: number, h: number, r: number) {
  if (r < 1) return;
  const tmp = new Float32Array(w * 4);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w * 4;
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += x < 0 || x >= w ? 0 : f[o + x * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[x * 4 + c] = acc * inv;
        const add = x + r + 1, sub = x - r;
        acc += (add < w ? f[o + add * 4 + c] : 0) - (sub >= 0 ? f[o + sub * 4 + c] : 0);
      }
    }
    f.set(tmp, o);
  }
}

function boxV(f: Float32Array, w: number, h: number, r: number) {
  if (r < 1) return;
  const inv = 1 / (2 * r + 1);
  const stride = w * 4;
  const col = new Float32Array(h);
  for (let x = 0; x < stride; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += y < 0 || y >= h ? 0 : f[y * stride + x];
    for (let y = 0; y < h; y++) {
      col[y] = acc * inv;
      const add = y + r + 1, sub = y - r;
      acc += (add < h ? f[add * stride + x] : 0) - (sub >= 0 ? f[sub * stride + x] : 0);
    }
    for (let y = 0; y < h; y++) f[y * stride + x] = col[y];
  }
}

/** Tamaños de caja para aproximar un gaussiano con 3 pasadas (W. Jarosz). */
function gaussBoxes(sigma: number): number[] {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  return Array.from({ length: n }, (_, i) => ((i < m ? wl : wu) - 1) / 2);
}

function gaussian(f: Float32Array, w: number, h: number, sigma: number) {
  if (sigma < 0.3) return;
  for (const r of gaussBoxes(sigma)) { boxH(f, w, h, r); boxV(f, w, h, r); }
}

/** Hash determinista por píxel de documento (ruido estable entre bandas). */
function hash(x: number, y: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ filtros

function runFilter(j: FilterJob): Uint8ClampedArray {
  const { name, params: p, src, w, rows, top, outRows, ox, oy } = j;
  const out = new Uint8ClampedArray(w * outRows * 4);
  const at = (x: number, y: number) => ((top + y) * w + x) * 4; // índice en src de la fila de salida y

  switch (name) {
    case 'gaussianBlur':
    case 'boxBlur': {
      const f = premultiply(src);
      if (name === 'gaussianBlur') gaussian(f, w, rows, p.radius ?? 1);
      else { const r = Math.round(p.radius ?? 1); boxH(f, w, rows, r); boxV(f, w, rows, r); }
      return unpremultiplyRows(f, w, top, outRows);
    }
    case 'motionBlur': {
      const f = premultiply(src);
      const d = Math.max(1, Math.round(p.distance ?? 10));
      const ang = ((p.angle ?? 0) * Math.PI) / 180;
      const dx = Math.cos(ang), dy = -Math.sin(ang);
      const res = new Float32Array(w * outRows * 4);
      for (let y = 0; y < outRows; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0, a = 0, n = 0;
          for (let t = -d; t <= d; t++) {
            const sx = Math.round(x + dx * t), sy = Math.round(top + y + dy * t);
            n++;
            if (sx < 0 || sx >= w || sy < 0 || sy >= rows) continue;
            const i = (sy * w + sx) * 4;
            r += f[i]; g += f[i + 1]; b += f[i + 2]; a += f[i + 3];
          }
          const o = (y * w + x) * 4;
          res[o] = r / n; res[o + 1] = g / n; res[o + 2] = b / n; res[o + 3] = a / n;
        }
      }
      return unpremultiplyRows(res, w, 0, outRows);
    }
    case 'unsharpMask':
    case 'sharpen':
    case 'highPass': {
      const radius = name === 'sharpen' ? 1 : p.radius ?? 1;
      const blur = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) blur[i] = src[i];
      gaussian(blur, w, rows, radius);
      const amount = name === 'sharpen' ? 0.6 : (p.amount ?? 100) / 100;
      const th = p.threshold ?? 0;
      for (let y = 0; y < outRows; y++) {
        for (let x = 0; x < w; x++) {
          const i = at(x, y), o = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            const d = src[i + c] - blur[i + c];
            out[o + c] = name === 'highPass' ? 128 + d : Math.abs(d) >= th ? src[i + c] + d * amount : src[i + c];
          }
          out[o + 3] = src[i + 3];
        }
      }
      return out;
    }
    case 'addNoise': {
      const amt = ((p.amount ?? 10) / 100) * 255;
      const seed = p.seed ?? 1;
      for (let y = 0; y < outRows; y++) {
        for (let x = 0; x < w; x++) {
          const i = at(x, y), o = (y * w + x) * 4;
          const gx = ox + x, gy = oy + top + y;
          const rnd = (c: number) => {
            const u = hash(gx, gy, seed + c * 7919);
            if (!p.gaussian) return (u - 0.5) * 2;
            const u2 = hash(gx, gy, seed + c * 7919 + 1) || 1e-7;
            return Math.sqrt(-2 * Math.log(u2)) * Math.cos(2 * Math.PI * u) / 2.5;
          };
          const m = p.monochrome ? rnd(0) : 0;
          for (let c = 0; c < 3; c++) out[o + c] = src[i + c] + (p.monochrome ? m : rnd(c)) * amt;
          out[o + 3] = src[i + 3];
        }
      }
      return out;
    }
    case 'mosaic': {
      const cell = Math.max(2, Math.round(p.cell ?? 10));
      for (let cy = Math.floor(oy / cell) * cell - oy; cy < outRows; cy += cell) {
        for (let cx = Math.floor(ox / cell) * cell - ox; cx < w; cx += cell) {
          const x0 = Math.max(0, cx), y0 = Math.max(0, cy), x1 = Math.min(w, cx + cell), y1 = Math.min(outRows, cy + cell);
          let r = 0, g = 0, b = 0, a = 0, n = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = at(x, y), al = src[i + 3];
            r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n++;
          }
          if (!n) continue;
          const R = a ? r / a : 0, G = a ? g / a : 0, B = a ? b / a : 0, A = a / n;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const o = (y * w + x) * 4;
            out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = A;
          }
        }
      }
      return out;
    }
    case 'median': {
      const r = Math.max(1, Math.round(p.radius ?? 1));
      const buf: number[][] = [[], [], []];
      for (let y = 0; y < outRows; y++) {
        for (let x = 0; x < w; x++) {
          buf[0].length = buf[1].length = buf[2].length = 0;
          for (let yy = -r; yy <= r; yy++) {
            const sy = top + y + yy;
            if (sy < 0 || sy >= rows) continue;
            for (let xx = -r; xx <= r; xx++) {
              const sx = x + xx;
              if (sx < 0 || sx >= w) continue;
              const i = (sy * w + sx) * 4;
              buf[0].push(src[i]); buf[1].push(src[i + 1]); buf[2].push(src[i + 2]);
            }
          }
          const o = (y * w + x) * 4, i = at(x, y);
          for (let c = 0; c < 3; c++) { const b = buf[c].sort((m, n) => m - n); out[o + c] = b[b.length >> 1]; }
          out[o + 3] = src[i + 3];
        }
      }
      return out;
    }
    case 'findEdges': {
      const lum = (x: number, y: number, c: number) => {
        const sx = Math.min(w - 1, Math.max(0, x)), sy = Math.min(rows - 1, Math.max(0, top + y));
        return src[(sy * w + sx) * 4 + c];
      };
      for (let y = 0; y < outRows; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            const gx = -lum(x - 1, y - 1, c) - 2 * lum(x - 1, y, c) - lum(x - 1, y + 1, c) + lum(x + 1, y - 1, c) + 2 * lum(x + 1, y, c) + lum(x + 1, y + 1, c);
            const gy = -lum(x - 1, y - 1, c) - 2 * lum(x, y - 1, c) - lum(x + 1, y - 1, c) + lum(x - 1, y + 1, c) + 2 * lum(x, y + 1, c) + lum(x + 1, y + 1, c);
            out[o + c] = 255 - Math.min(255, Math.sqrt(gx * gx + gy * gy) / 2);
          }
          out[o + 3] = src[at(x, y) + 3];
        }
      }
      return out;
    }
    case 'emboss': {
      const ang = ((p.angle ?? 135) * Math.PI) / 180;
      const hgt = Math.max(1, Math.round(p.height ?? 3));
      const amount = (p.amount ?? 100) / 100;
      const ddx = Math.round(Math.cos(ang) * hgt), ddy = Math.round(-Math.sin(ang) * hgt);
      const L = (x: number, y: number) => {
        const sx = Math.min(w - 1, Math.max(0, x)), sy = Math.min(rows - 1, Math.max(0, top + y));
        const i = (sy * w + sx) * 4;
        return src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114;
      };
      for (let y = 0; y < outRows; y++) {
        for (let x = 0; x < w; x++) {
          const v = 128 + (L(x - ddx, y - ddy) - L(x + ddx, y + ddy)) * amount;
          const o = (y * w + x) * 4;
          out[o] = out[o + 1] = out[o + 2] = v;
          out[o + 3] = src[at(x, y) + 3];
        }
      }
      return out;
    }
    case 'clouds': {
      const fg = p.fg ?? [0, 0, 0, 255], bg = p.bg ?? [255, 255, 255, 255];
      const seed = p.seed ?? 1;
      const noise = (x: number, y: number) => {
        const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
        const s = (t: number) => t * t * (3 - 2 * t);
        const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
        const u = s(xf), v = s(yf);
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
      };
      for (let y = 0; y < outRows; y++) {
        for (let x = 0; x < w; x++) {
          const gx = (ox + x) / 256, gy = (oy + top + y) / 256;
          let v = 0, amp = 0.5, f = 1;
          for (let o = 0; o < 6; o++) { v += noise(gx * f, gy * f) * amp; amp /= 2; f *= 2; }
          const o = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) out[o + c] = fg[c] + (bg[c] - fg[c]) * v;
          out[o + 3] = 255;
        }
      }
      return out;
    }
  }
}

// ------------------------------------------------------------------ transformaciones

function sampleBilinear(src: Uint8ClampedArray, sw: number, sh: number, x: number, y: number, acc: Float32Array) {
  // x, y en píxeles del origen (centros en .5). Acumula premultiplicado en acc[0..3].
  const fx = x - 0.5, fy = y - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const ax = fx - x0, ay = fy - y0;
  for (let k = 0; k < 4; k++) {
    const px = x0 + (k & 1), py = y0 + (k >> 1);
    if (px < 0 || py < 0 || px >= sw || py >= sh) continue;
    const wgt = ((k & 1) ? ax : 1 - ax) * ((k >> 1) ? ay : 1 - ay);
    if (wgt <= 0) continue;
    const i = (py * sw + px) * 4;
    const a = src[i + 3] * wgt;
    acc[0] += src[i] * a; acc[1] += src[i + 1] * a; acc[2] += src[i + 2] * a; acc[3] += a;
  }
}

function runAffine(j: AffineJob): Uint8ClampedArray {
  const { src, sw, sh, sx, sy, inv, x, y, w, rows, ss } = j;
  const out = new Uint8ClampedArray(w * rows * 4);
  const acc = new Float32Array(4);
  const n = ss * ss;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < w; c++) {
      acc.fill(0);
      for (let q = 0; q < n; q++) {
        const dx = x + c + ((q % ss) + 0.5) / ss, dy = y + r + (Math.floor(q / ss) + 0.5) / ss;
        const ux = inv[0] * dx + inv[2] * dy + inv[4] - sx;
        const uy = inv[1] * dx + inv[3] * dy + inv[5] - sy;
        sampleBilinear(src, sw, sh, ux, uy, acc);
      }
      const a = acc[3] / n;
      if (a < 0.5) continue;
      const o = (r * w + c) * 4;
      out[o] = acc[0] / acc[3]; out[o + 1] = acc[1] / acc[3]; out[o + 2] = acc[2] / acc[3]; out[o + 3] = a;
    }
  }
  return out;
}

function runMapWarp(j: MapWarpJob): Uint8ClampedArray {
  const { src, sw, sh, sx, sy, spec, x, y, w, rows, ss } = j;
  const map = backMap(spec, x, y, w, rows, ss);
  const out = new Uint8ClampedArray(w * rows * 4);
  const acc = new Float32Array(4), W = w * ss, n = ss * ss;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < w; c++) {
      acc.fill(0);
      for (let q = 0; q < n; q++) {
        const k = ((r * ss + Math.floor(q / ss)) * W + c * ss + (q % ss)) * 2;
        const ux = map[k];
        if (ux !== ux) continue; // NaN: fuera de la malla
        sampleBilinear(src, sw, sh, ux - sx, map[k + 1] - sy, acc);
      }
      const a = acc[3] / n;
      if (a < 0.5 / n) continue; // bordes suavizados por el supermuestreo
      const o = (r * w + c) * 4;
      out[o] = acc[0] / acc[3]; out[o + 1] = acc[1] / acc[3]; out[o + 2] = acc[2] / acc[3]; out[o + 3] = a;
    }
  }
  return out;
}

function runWarp(j: WarpJob): Uint8ClampedArray {
  const { src, sw, sh, field, fw, fh, scale, y0, rows } = j;
  const out = new Uint8ClampedArray(sw * rows * 4);
  const acc = new Float32Array(4);
  for (let r = 0; r < rows; r++) {
    const y = y0 + r;
    for (let x = 0; x < sw; x++) {
      // Interpola el campo de desplazamiento (en px de la imagen).
      const gx = Math.min(fw - 1.001, Math.max(0, (x + 0.5) / scale - 0.5));
      const gy = Math.min(fh - 1.001, Math.max(0, (y + 0.5) / scale - 0.5));
      const ix = Math.floor(gx), iy = Math.floor(gy), ax = gx - ix, ay = gy - iy;
      const i00 = (iy * fw + ix) * 2, i10 = i00 + 2, i01 = i00 + fw * 2, i11 = i01 + 2;
      const ddx = (field[i00] * (1 - ax) + field[i10] * ax) * (1 - ay) + (field[i01] * (1 - ax) + field[i11] * ax) * ay;
      const ddy = (field[i00 + 1] * (1 - ax) + field[i10 + 1] * ax) * (1 - ay) + (field[i01 + 1] * (1 - ax) + field[i11 + 1] * ax) * ay;
      acc.fill(0);
      sampleBilinear(src, sw, sh, x + 0.5 + ddx, y + 0.5 + ddy, acc);
      if (acc[3] < 0.5) continue;
      const o = (r * sw + x) * 4;
      out[o] = acc[0] / acc[3]; out[o + 1] = acc[1] / acc[3]; out[o + 2] = acc[2] / acc[3]; out[o + 3] = acc[3];
    }
  }
  return out;
}
