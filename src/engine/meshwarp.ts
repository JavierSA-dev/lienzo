/**
 * Transformaciones no afines: perspectiva/distorsionar (homografía), deformar (parche de Bézier
 * bicúbico, como Edición > Transformar > Deformar) y deformación de posición libre (MLS rígido).
 * Todas se reducen a una "especificación" que se puede previsualizar en la GPU como malla y
 * aplicar en CPU con muestreo inverso exacto (homografía) o rasterizando triángulos (malla).
 */
import type { Matrix, Rect } from './types';

export type Pt = [number, number];

/** Especificación de la transformación (todas en coordenadas de documento). */
export type WarpSpec =
  | { kind: 'affine'; m: Matrix }
  /** Rectángulo `src` → cuadrilátero `quad` (sup-izq, sup-der, inf-der, inf-izq). */
  | { kind: 'quad'; src: Rect; quad: number[] }
  /** Rejilla uniforme sobre `src` ((cols+1)×(rows+1) vértices) → posiciones `pts` (x,y). */
  | { kind: 'mesh'; src: Rect; cols: number; rows: number; pts: number[] }
  /** Homografía general (origen → destino) recortada a `dst` (Recortar con perspectiva). */
  | { kind: 'proj'; h: number[]; dst: Rect };

// ------------------------------------------------------------------ homografía

/** Homografía (3×3, fila mayor, h[8] = 1) que lleva los 4 puntos `a` a los 4 puntos `b`. */
export function homography(a: Pt[], b: Pt[]): number[] {
  // Sistema 8×8 (DLT) resuelto por eliminación gaussiana con pivote parcial.
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = a[i], [u, v] = b[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}

export function applyH(h: number[], x: number, y: number): Pt {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

export function invertH(h: number[]): number[] {
  const [a, b, c, d, e, f, g, i, k] = h;
  const A = e * k - f * i, B = -(d * k - f * g), C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const r = [A, -(b * k - c * i), b * f - c * e, B, a * k - c * g, -(a * f - c * d), C, -(a * i - b * g), a * e - b * d].map((v) => v / det);
  return r.map((v) => v / r[8]);
}

export const rectCorners = (r: Rect): Pt[] => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];

/** ¿El cuadrilátero es convexo y no está dado la vuelta (una perspectiva válida)? */
export function quadValid(q: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1e-9) return false;
    if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

// ------------------------------------------------------------------ parche de Bézier (Deformar)

const bern = (t: number): [number, number, number, number] => {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
};

/** Punto del parche bicúbico (16 puntos de control, fila mayor 4×4) en (u, v) ∈ [0,1]². */
export function bezierPatch(ctrl: Pt[], u: number, v: number): Pt {
  const bu = bern(u), bv = bern(v);
  let x = 0, y = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const w = bu[i] * bv[j], p = ctrl[j * 4 + i];
    x += w * p[0]; y += w * p[1];
  }
  return [x, y];
}

/** Pesos de Bernstein de los 16 puntos en (u, v) (para arrastrar el interior del parche). */
export function patchWeights(u: number, v: number): number[] {
  const bu = bern(u), bv = bern(v), w: number[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) w.push(bu[i] * bv[j]);
  return w;
}

/** Rejilla de control sin deformar sobre `b`. */
export function identityPatch(b: Rect): Pt[] {
  const c: Pt[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) c.push([b.x + (b.w * i) / 3, b.y + (b.h * j) / 3]);
  return c;
}

/** (u, v) aproximado de un punto del parche (búsqueda en rejilla + Newton). */
export function patchParam(ctrl: Pt[], p: Pt): { u: number; v: number; d: number } {
  let best = { u: 0.5, v: 0.5, d: Infinity };
  const N = 24;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const q = bezierPatch(ctrl, i / N, j / N), d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < best.d) best = { u: i / N, v: j / N, d };
  }
  let { u, v } = best;
  for (let it = 0; it < 8; it++) {
    const q = bezierPatch(ctrl, u, v), e = 1e-3;
    const qu = bezierPatch(ctrl, Math.min(1, u + e), v), qv = bezierPatch(ctrl, u, Math.min(1, v + e));
    const a = (qu[0] - q[0]) / e, b = (qv[0] - q[0]) / e, c = (qu[1] - q[1]) / e, d = (qv[1] - q[1]) / e;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) break;
    const rx = p[0] - q[0], ry = p[1] - q[1];
    u = Math.min(1, Math.max(0, u + (d * rx - b * ry) / det));
    v = Math.min(1, Math.max(0, v + (-c * rx + a * ry) / det));
  }
  const q = bezierPatch(ctrl, u, v);
  return { u, v, d: Math.hypot(q[0] - p[0], q[1] - p[1]) };
}

/**
 * Ajusta (mínimos cuadrados) un parche de Bézier a una función de deformación: así los estilos
 * predefinidos (Arco, Bandera, Onda…) quedan como puntos de control editables, igual que en Photoshop.
 */
export function fitPatch(b: Rect, f: (x: number, y: number) => Pt): Pt[] {
  const N = 12, M: number[][] = Array.from({ length: 16 }, () => new Array(16).fill(0));
  const rx = new Array(16).fill(0), ry = new Array(16).fill(0);
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const u = i / N, v = j / N, w = patchWeights(u, v), [x, y] = f(b.x + u * b.w, b.y + v * b.h);
    for (let a = 0; a < 16; a++) {
      rx[a] += w[a] * x; ry[a] += w[a] * y;
      for (let c = 0; c < 16; c++) M[a][c] += w[a] * w[c];
    }
  }
  const sx = solve(M.map((r) => [...r]), rx), sy = solve(M.map((r) => [...r]), ry);
  return sx.map((x, i) => [x, sy[i]] as Pt);
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const x = [...b];
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [x[c], x[p]] = [x[p], x[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

// ------------------------------------------------------------------ deformación de posición libre (MLS)

export type PuppetMode = 'rigid' | 'normal' | 'distort';

/**
 * Mínimos cuadrados móviles (Schaefer et al. 2006): rígido (sin escala), normal (semejanza)
 * o distorsionar (afín). `p` = chinchetas originales, `q` = chinchetas movidas.
 */
export function mlsDeform(p: Pt[], q: Pt[], v: Pt, puppet: PuppetMode = 'rigid'): Pt {
  // Modos de Photoshop: Rígido y Normal no escalan (MLS rígido, más o menos local); Distorsionar admite escala.
  const alpha = puppet === 'rigid' ? 1.4 : 1;
  const mode = (puppet === 'distort' ? 'normal' : 'rigid') as 'rigid' | 'normal' | 'distort';
  const n = p.length;
  if (!n) return v;
  if (n === 1) return [v[0] + q[0][0] - p[0][0], v[1] + q[0][1] - p[0][1]];
  const w = new Array(n);
  let sw = 0, px = 0, py = 0, qx = 0, qy = 0;
  for (let i = 0; i < n; i++) {
    const d2 = (p[i][0] - v[0]) ** 2 + (p[i][1] - v[1]) ** 2;
    if (d2 < 1e-8) return [q[i][0], q[i][1]];
    w[i] = 1 / Math.pow(d2, alpha); sw += w[i];
    px += w[i] * p[i][0]; py += w[i] * p[i][1]; qx += w[i] * q[i][0]; qy += w[i] * q[i][1];
  }
  px /= sw; py /= sw; qx /= sw; qy /= sw;
  const vx = v[0] - px, vy = v[1] - py;
  if (mode === 'distort') {
    // Afín: M = (Σ ŵ p̂ᵀp̂)⁻¹ Σ ŵ p̂ᵀq̂
    let a = 0, b = 0, d = 0, m00 = 0, m01 = 0, m10 = 0, m11 = 0;
    for (let i = 0; i < n; i++) {
      const hx = p[i][0] - px, hy = p[i][1] - py, gx = q[i][0] - qx, gy = q[i][1] - qy;
      a += w[i] * hx * hx; b += w[i] * hx * hy; d += w[i] * hy * hy;
      m00 += w[i] * hx * gx; m01 += w[i] * hx * gy; m10 += w[i] * hy * gx; m11 += w[i] * hy * gy;
    }
    const det = a * d - b * b;
    if (Math.abs(det) < 1e-9) return [vx + qx, vy + qy];
    const i00 = d / det, i01 = -b / det, i11 = a / det;
    const ux = vx * i00 + vy * i01, uy = vx * i01 + vy * i11;
    return [ux * m00 + uy * m10 + qx, ux * m01 + uy * m11 + qy];
  }
  // Semejanza / rígido (en complejos: z = Σ ŵ·conj(p̂)·q̂ / Σ ŵ|p̂|²; rígido = sólo el giro de z).
  let zr = 0, zi = 0, mu = 0;
  for (let i = 0; i < n; i++) {
    const hx = p[i][0] - px, hy = p[i][1] - py, gx = q[i][0] - qx, gy = q[i][1] - qy;
    zr += w[i] * (hx * gx + hy * gy); zi += w[i] * (hx * gy - hy * gx);
    mu += w[i] * (hx * hx + hy * hy);
  }
  if (mode === 'rigid') { const l = Math.hypot(zr, zi) || 1; zr /= l; zi /= l; }
  else { zr /= mu || 1; zi /= mu || 1; }
  return [zr * vx - zi * vy + qx, zr * vy + zi * vx + qy];
}

// ------------------------------------------------------------------ mallas y aplicación

/** Malla (para la vista previa en GPU y para aplicar) de cualquier especificación. */
export function specToMesh(spec: WarpSpec, n = 16): { src: Rect; cols: number; rows: number; pts: Float32Array } {
  if (spec.kind === 'mesh') return { src: spec.src, cols: spec.cols, rows: spec.rows, pts: Float32Array.from(spec.pts) };
  if (spec.kind === 'proj') throw new Error('proj sin vista previa');
  const src = spec.kind === 'quad' ? spec.src : { x: 0, y: 0, w: 1, h: 1 };
  const map: (x: number, y: number) => Pt = spec.kind === 'quad'
    ? (() => { const h = homography(rectCorners(spec.src), toPts(spec.quad)); return (x: number, y: number) => applyH(h, x, y); })()
    : (x, y) => [spec.m[0] * x + spec.m[2] * y + spec.m[4], spec.m[1] * x + spec.m[3] * y + spec.m[5]];
  const k = spec.kind === 'affine' ? 1 : n;
  const pts = new Float32Array((k + 1) * (k + 1) * 2);
  for (let j = 0; j <= k; j++) for (let i = 0; i <= k; i++) {
    const [x, y] = map(src.x + (src.w * i) / k, src.y + (src.h * j) / k);
    pts[(j * (k + 1) + i) * 2] = x; pts[(j * (k + 1) + i) * 2 + 1] = y;
  }
  return { src, cols: k, rows: k, pts };
}

export const toPts = (a: number[]): Pt[] => [[a[0], a[1]], [a[2], a[3]], [a[4], a[5]], [a[6], a[7]]];

/** Límites del resultado (documento). */
export function specBounds(spec: WarpSpec, src: Rect): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  if (spec.kind === 'proj') return spec.dst;
  if (spec.kind === 'affine') for (const [x, y] of rectCorners(src)) add(spec.m[0] * x + spec.m[2] * y + spec.m[4], spec.m[1] * x + spec.m[3] * y + spec.m[5]);
  else if (spec.kind === 'quad') for (let i = 0; i < 8; i += 2) add(spec.quad[i], spec.quad[i + 1]);
  else for (let i = 0; i < spec.pts.length; i += 2) add(spec.pts[i], spec.pts[i + 1]);
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  const X0 = Math.floor(x0), Y0 = Math.floor(y0);
  return { x: X0, y: Y0, w: Math.ceil(x1) - X0, h: Math.ceil(y1) - Y0 };
}

/**
 * Mapa inverso de una banda del destino: para cada muestra (ss×ss por píxel) devuelve la posición
 * en el origen (doc) o NaN si cae fuera. Homografía/afín: exacto; malla: rasterizando triángulos.
 */
export function backMap(spec: WarpSpec, x0: number, y0: number, w: number, rows: number, ss: number): Float32Array {
  const W = w * ss, H = rows * ss;
  const out = new Float32Array(W * H * 2).fill(NaN);
  if (spec.kind !== 'mesh') {
    let f: (x: number, y: number) => Pt;
    if (spec.kind === 'affine') {
      const m = spec.m, det = m[0] * m[3] - m[1] * m[2];
      const ia = m[3] / det, ib = -m[1] / det, ic = -m[2] / det, id = m[0] / det;
      f = (x, y) => { const dx = x - m[4], dy = y - m[5]; return [ia * dx + ic * dy, ib * dx + id * dy]; };
    } else if (spec.kind === 'proj') {
      const hi = invertH(spec.h);
      f = (x, y) => applyH(hi, x, y);
    } else {
      const hi = invertH(homography(rectCorners(spec.src), toPts(spec.quad)));
      f = (x, y) => applyH(hi, x, y);
    }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const [sx, sy] = f(x0 + (i + 0.5) / ss, y0 + (j + 0.5) / ss);
      out[(j * W + i) * 2] = sx; out[(j * W + i) * 2 + 1] = sy;
    }
    return out;
  }
  const { cols, rows: R, pts, src } = spec, C1 = cols + 1;
  const tri = (a: number, b: number, c: number, ua: Pt, ub: Pt, uc: Pt) => {
    // Vértices en el espacio de muestras de la banda.
    const ax = (pts[a * 2] - x0) * ss, ay = (pts[a * 2 + 1] - y0) * ss;
    const bx = (pts[b * 2] - x0) * ss, by = (pts[b * 2 + 1] - y0) * ss;
    const cx = (pts[c * 2] - x0) * ss, cy = (pts[c * 2 + 1] - y0) * ss;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-9) return;
    const minY = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), maxY = Math.min(H - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    if (minY > maxY) return;
    const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), maxX = Math.min(W - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    if (minX > maxX) return;
    const e = -1e-6;
    for (let j = minY; j <= maxY; j++) {
      const py = j + 0.5;
      for (let i = minX; i <= maxX; i++) {
        const px = i + 0.5;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        if (l1 < e) continue;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        if (l2 < e) continue;
        const l3 = 1 - l1 - l2;
        if (l3 < e) continue;
        const o = (j * W + i) * 2;
        out[o] = l1 * ua[0] + l2 * ub[0] + l3 * uc[0];
        out[o + 1] = l1 * ua[1] + l2 * ub[1] + l3 * uc[1];
      }
    }
  };
  for (let j = 0; j < R; j++) for (let i = 0; i < cols; i++) {
    const a = j * C1 + i, b = a + 1, c = a + C1, d = c + 1;
    const u0 = src.x + (src.w * i) / cols, u1 = src.x + (src.w * (i + 1)) / cols;
    const v0 = src.y + (src.h * j) / R, v1 = src.y + (src.h * (j + 1)) / R;
    tri(a, b, d, [u0, v0], [u1, v0], [u1, v1]);
    tri(a, d, c, [u0, v0], [u1, v1], [u0, v1]);
  }
  return out;
}

/** Escala mínima aproximada (para decidir el supermuestreo al reducir). */
export function specMinScale(spec: WarpSpec, src: Rect): number {
  if (spec.kind === 'affine') return Math.sqrt(Math.abs(spec.m[0] * spec.m[3] - spec.m[1] * spec.m[2]));
  const b = specBounds(spec, src);
  return Math.sqrt(Math.max(1, b.w * b.h) / Math.max(1, src.w * src.h));
}

/** Transformación directa de un punto (para llevar con la capa trazados como la máscara vectorial). */
export function specForward(spec: WarpSpec): (x: number, y: number) => Pt {
  if (spec.kind === 'affine') { const m = spec.m; return (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  if (spec.kind === 'proj') return (x, y) => applyH(spec.h, x, y);
  if (spec.kind === 'quad') { const h = homography(rectCorners(spec.src), toPts(spec.quad)); return (x, y) => applyH(h, x, y); }
  const { src, cols, rows, pts } = spec, C1 = cols + 1;
  return (x, y) => {
    const gx = Math.min(cols - 1e-6, Math.max(0, ((x - src.x) / src.w) * cols)), gy = Math.min(rows - 1e-6, Math.max(0, ((y - src.y) / src.h) * rows));
    const i = Math.floor(gx), j = Math.floor(gy), u = gx - i, v = gy - j;
    const at = (a: number, b: number, c: number) => pts[((b * C1) + a) * 2 + c];
    const lerp = (c: number) => (at(i, j, c) * (1 - u) + at(i + 1, j, c) * u) * (1 - v) + (at(i, j + 1, c) * (1 - u) + at(i + 1, j + 1, c) * u) * v;
    // Fuera de la rejilla se extrapola con el desplazamiento del borde.
    const ex = x - (src.x + (gx / cols) * src.w), ey = y - (src.y + (gy / rows) * src.h);
    return [lerp(0) + ex, lerp(1) + ey];
  };
}
