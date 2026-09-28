import { TILE, type Rect } from './types';
import { tileKey, keyTx, keyTy } from './document';

export type CombineMode = 'replace' | 'add' | 'subtract' | 'intersect';

const T2 = TILE * TILE;

/**
 * Selección como máscara de 8 bits por tiles (0 = fuera, 255 = dentro, valores
 * intermedios = bordes suavizados o calados). Inmutable: cada operación devuelve
 * una selección nueva, lo que simplifica el historial.
 */
export class Selection {
  readonly tiles: Map<number, Uint8Array>;
  /** Si la selección es exactamente un rectángulo, se guarda para caminos rápidos. */
  readonly rect: Rect | null;

  constructor(tiles: Map<number, Uint8Array>, rect: Rect | null = null) {
    this.tiles = tiles;
    this.rect = rect;
  }

  // ------------------------------------------------------------ creación

  static fromRect(r: Rect): Selection {
    const tiles = new Map<number, Uint8Array>();
    if (r.w <= 0 || r.h <= 0) return new Selection(tiles);
    forTiles(r, (tx, ty, x0, y0, x1, y1) => {
      const t = new Uint8Array(T2);
      for (let y = y0; y < y1; y++) t.fill(255, y * TILE + x0, y * TILE + x1);
      tiles.set(tileKey(tx, ty), t);
    });
    return new Selection(tiles, { ...r });
  }

  static fromEllipse(r: Rect): Selection {
    const tiles = new Map<number, Uint8Array>();
    const rx = r.w / 2, ry = r.h / 2, cx = r.x + rx, cy = r.y + ry;
    if (rx < 0.5 || ry < 0.5) return new Selection(tiles);
    const k = Math.min(rx, ry);
    forTiles(r, (tx, ty, x0, y0, x1, y1) => {
      const t = new Uint8Array(T2);
      let any = false;
      for (let y = y0; y < y1; y++) {
        const dy = (ty * TILE + y + 0.5 - cy) / ry;
        for (let x = x0; x < x1; x++) {
          const dx = (tx * TILE + x + 0.5 - cx) / rx;
          const d = (Math.sqrt(dx * dx + dy * dy) - 1) * k; // distancia firmada aproximada en px
          const c = d <= -0.5 ? 255 : d >= 0.5 ? 0 : Math.round((0.5 - d) * 255);
          if (c) { t[y * TILE + x] = c; any = true; }
        }
      }
      if (any) tiles.set(tileKey(tx, ty), t);
    });
    return new Selection(tiles);
  }

  /** Polígono (lazo) con suavizado: 4 submuestras verticales y cobertura horizontal exacta. */
  static fromPolygon(pts: [number, number][], clip: Rect): Selection {
    return Selection.fromPolygons([pts], clip);
  }

  /** Varios contornos con la regla par-impar (agujeros incluidos), como un trazado de la pluma. */
  static fromPolygons(rings: [number, number][][], clip: Rect): Selection {
    const tiles = new Map<number, Uint8Array>();
    rings = rings.filter((r) => r.length >= 3);
    if (!rings.length) return new Selection(tiles);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) for (const [x, y] of ring) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const x0 = Math.max(clip.x, Math.floor(minX)), y0 = Math.max(clip.y, Math.floor(minY));
    const x1 = Math.min(clip.x + clip.w, Math.ceil(maxX)), y1 = Math.min(clip.y + clip.h, Math.ceil(maxY));
    if (x1 <= x0 || y1 <= y0) return new Selection(tiles);
    const w = x1 - x0;
    const row = new Float32Array(w + 1);
    const SUB = 4;
    const xs: number[] = [];
    for (let y = y0; y < y1; y++) {
      row.fill(0);
      for (let s = 0; s < SUB; s++) {
        const sy = y + (s + 0.5) / SUB;
        xs.length = 0;
        for (const pts of rings) {
          const n = pts.length;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const [xi, yi] = pts[i], [xj, yj] = pts[j];
            if ((yi > sy) !== (yj > sy)) xs.push(xi + ((sy - yi) * (xj - xi)) / (yj - yi));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const a = Math.max(x0, xs[k]) - x0, b = Math.min(x1, xs[k + 1]) - x0;
          if (b <= a) continue;
          const ia = Math.floor(a), ib = Math.floor(b);
          if (ia === ib) { row[ia] += (b - a) / SUB; continue; }
          row[ia] += (ia + 1 - a) / SUB;
          for (let q = ia + 1; q < ib; q++) row[q] += 1 / SUB;
          if (ib < w) row[ib] += (b - ib) / SUB;
        }
      }
      const ty = Math.floor(y / TILE), ly = y - ty * TILE;
      for (let x = 0; x < w; x++) {
        const v = row[x];
        if (v <= 0.001) continue;
        const gx = x0 + x, tx = Math.floor(gx / TILE);
        const k = tileKey(tx, ty);
        let t = tiles.get(k);
        if (!t) { t = new Uint8Array(T2); tiles.set(k, t); }
        t[ly * TILE + (gx - tx * TILE)] = Math.min(255, Math.round(v * 255));
      }
    }
    return new Selection(tiles);
  }

  /** Crea una selección a partir de una máscara plana (w×h) situada en (ox, oy). */
  static fromMask(mask: Uint8Array, w: number, h: number, ox = 0, oy = 0): Selection {
    const tiles = new Map<number, Uint8Array>();
    forTiles({ x: ox, y: oy, w, h }, (tx, ty, x0, y0, x1, y1) => {
      let t: Uint8Array | null = null;
      for (let y = y0; y < y1; y++) {
        const src = (ty * TILE + y - oy) * w - ox + tx * TILE;
        for (let x = x0; x < x1; x++) {
          const v = mask[src + x];
          if (v) { if (!t) t = new Uint8Array(T2); t[y * TILE + x] = v; }
        }
      }
      if (t) tiles.set(tileKey(tx, ty), t);
    });
    return new Selection(tiles);
  }

  // ------------------------------------------------------------ consulta

  isEmpty() { return this.tiles.size === 0; }

  get(x: number, y: number): number {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    const t = this.tiles.get(tileKey(tx, ty));
    return t ? t[(y - ty * TILE) * TILE + (x - tx * TILE)] : 0;
  }

  /** Límites exactos de los píxeles seleccionados. */
  bounds(): Rect | null {
    if (this.rect) return { ...this.rect };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [k, t] of this.tiles) {
      const ox = keyTx(k) * TILE, oy = keyTy(k) * TILE;
      for (let y = 0; y < TILE; y++) {
        const r = y * TILE;
        let first = -1, last = -1;
        for (let x = 0; x < TILE; x++) if (t[r + x]) { if (first < 0) first = x; last = x; }
        if (first < 0) continue;
        x0 = Math.min(x0, ox + first); x1 = Math.max(x1, ox + last + 1);
        y0 = Math.min(y0, oy + y); y1 = Math.max(y1, oy + y + 1);
      }
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Máscara plana de una región (0 fuera de la selección). */
  region(r: Rect): Uint8Array {
    const out = new Uint8Array(r.w * r.h);
    forTiles(r, (tx, ty, x0, y0, x1, y1) => {
      const t = this.tiles.get(tileKey(tx, ty));
      if (!t) return;
      for (let y = y0; y < y1; y++) {
        const dst = (ty * TILE + y - r.y) * r.w + (tx * TILE - r.x);
        out.set(t.subarray(y * TILE + x0, y * TILE + x1), dst + x0);
      }
    });
    return out;
  }

  // ------------------------------------------------------------ operaciones

  combine(other: Selection, mode: CombineMode): Selection {
    if (mode === 'replace') return other;
    const out = new Map<number, Uint8Array>();
    const keys = new Set([...this.tiles.keys(), ...other.tiles.keys()]);
    for (const k of keys) {
      const a = this.tiles.get(k), b = other.tiles.get(k);
      let t: Uint8Array | null = null;
      if (mode === 'add') {
        if (!a) t = b!.slice(); else if (!b) t = a.slice();
        else { t = new Uint8Array(T2); for (let i = 0; i < T2; i++) t[i] = a[i] > b[i] ? a[i] : b[i]; }
      } else if (mode === 'subtract') {
        if (!a) continue;
        if (!b) t = a.slice();
        else { t = new Uint8Array(T2); for (let i = 0; i < T2; i++) t[i] = (a[i] * (255 - b[i]) + 127) / 255; }
      } else {
        if (!a || !b) continue;
        t = new Uint8Array(T2);
        for (let i = 0; i < T2; i++) t[i] = a[i] < b[i] ? a[i] : b[i];
      }
      if (t && !allZero(t)) out.set(k, t);
    }
    return new Selection(out);
  }

  invert(docW: number, docH: number): Selection {
    const out = new Map<number, Uint8Array>();
    forTiles({ x: 0, y: 0, w: docW, h: docH }, (tx, ty, x0, y0, x1, y1) => {
      const k = tileKey(tx, ty);
      const a = this.tiles.get(k);
      const t = new Uint8Array(T2);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * TILE + x; t[i] = 255 - (a ? a[i] : 0); }
      if (!allZero(t)) out.set(k, t);
    });
    return new Selection(out);
  }

  /** Calar: desenfoque de caja ×3 (≈ gaussiano) del borde de la máscara. */
  feather(radius: number, docW: number, docH: number): Selection {
    const b = this.bounds();
    if (!b || radius < 0.5) return this;
    const pad = Math.ceil(radius * 3);
    const r = clampRect({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, docW, docH);
    const m = this.region(r);
    const f = new Float32Array(m.length);
    for (let i = 0; i < m.length; i++) f[i] = m[i];
    const box = Math.max(1, Math.round(radius / 1.6));
    for (let p = 0; p < 3; p++) { boxBlurH(f, r.w, r.h, box); boxBlurV(f, r.w, r.h, box); }
    const out = new Uint8Array(m.length);
    for (let i = 0; i < f.length; i++) out[i] = Math.round(f[i]);
    return Selection.fromMask(out, r.w, r.h, r.x, r.y);
  }

  /** Amplía (+) o contrae (−) la selección n píxeles (umbral al 50 %). */
  grow(n: number, docW: number, docH: number): Selection {
    const b = this.bounds();
    if (!b || n === 0) return this;
    const pad = Math.abs(n) + 1;
    const r = clampRect({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, docW, docH);
    const m = this.region(r);
    const f = new Float32Array(m.length);
    const expand = n > 0;
    for (let i = 0; i < m.length; i++) f[i] = expand ? (m[i] >= 128 ? 255 : 0) : (m[i] >= 128 ? 0 : 255);
    // Dilatación cuadrada separable (máximo de ventana).
    maxFilter(f, r.w, r.h, Math.abs(n));
    const out = new Uint8Array(m.length);
    for (let i = 0; i < f.length; i++) out[i] = expand ? f[i] : 255 - f[i];
    return Selection.fromMask(out, r.w, r.h, r.x, r.y);
  }

  /**
   * Contorno para las "hormigas": trazado SVG con los bordes entre píxeles dentro/fuera.
   * En selecciones enormes se calcula a menor resolución para no saturar la interfaz.
   */
  outline(docW: number, docH: number): string {
    if (this.rect) {
      const r = this.rect;
      return `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}z`;
    }
    const b = this.bounds();
    if (!b) return '';
    let step = 1;
    while ((b.w / step) * (b.h / step) > 8_000_000) step *= 2;
    const x0 = b.x, y0 = b.y;
    const W = Math.ceil(b.w / step) + 2, H = Math.ceil(b.h / step) + 2;
    const g = new Uint8Array(W * H);
    for (let gy = 1; gy < H - 1; gy++) {
      const y = y0 + (gy - 1) * step;
      if (y >= docH) break;
      for (let gx = 1; gx < W - 1; gx++) {
        const x = x0 + (gx - 1) * step;
        if (x >= docW) break;
        g[gy * W + gx] = this.get(x, y) >= 128 ? 1 : 0;
      }
    }
    const parts: string[] = [];
    let segs = 0;
    // Bordes horizontales (entre filas).
    for (let gy = 1; gy < H; gy++) {
      let run = -1;
      for (let gx = 0; gx <= W; gx++) {
        const edge = gx < W && g[(gy - 1) * W + gx] !== g[gy * W + gx];
        if (edge && run < 0) run = gx;
        if (!edge && run >= 0) {
          parts.push(`M${x0 + (run - 1) * step} ${y0 + (gy - 1) * step}h${(gx - run) * step}`);
          run = -1; segs++;
        }
      }
    }
    // Bordes verticales (entre columnas).
    for (let gx = 1; gx < W; gx++) {
      let run = -1;
      for (let gy = 0; gy <= H; gy++) {
        const edge = gy < H && g[gy * W + gx - 1] !== g[gy * W + gx];
        if (edge && run < 0) run = gy;
        if (!edge && run >= 0) {
          parts.push(`M${x0 + (gx - 1) * step} ${y0 + (run - 1) * step}v${(gy - run) * step}`);
          run = -1; segs++;
        }
      }
      if (segs > 400_000) break;
    }
    return parts.join('');
  }
}

// ------------------------------------------------------------ utilidades

function allZero(t: Uint8Array) {
  const u = new Uint32Array(t.buffer, t.byteOffset, t.length >> 2);
  for (let i = 0; i < u.length; i++) if (u[i]) return false;
  return true;
}

export function clampRect(r: Rect, W: number, H: number): Rect {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const x1 = Math.min(W, r.x + r.w), y1 = Math.min(H, r.y + r.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Recorre los tiles que cubre un rectángulo, con el subrectángulo local de cada uno. */
export function forTiles(r: Rect, fn: (tx: number, ty: number, x0: number, y0: number, x1: number, y1: number) => void) {
  if (r.w <= 0 || r.h <= 0) return;
  const tx0 = Math.floor(r.x / TILE), ty0 = Math.floor(r.y / TILE);
  const tx1 = Math.floor((r.x + r.w - 1) / TILE), ty1 = Math.floor((r.y + r.h - 1) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const ox = tx * TILE, oy = ty * TILE;
      fn(tx, ty,
        Math.max(r.x, ox) - ox, Math.max(r.y, oy) - oy,
        Math.min(r.x + r.w, ox + TILE) - ox, Math.min(r.y + r.h, oy + TILE) - oy);
    }
  }
}

export function boxBlurH(f: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(w);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += f[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[x] = acc * inv;
      acc += f[o + Math.min(w - 1, x + r + 1)] - f[o + Math.max(0, x - r)];
    }
    f.set(tmp, o);
  }
}

export function boxBlurV(f: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(h);
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += f[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      tmp[y] = acc * inv;
      acc += f[Math.min(h - 1, y + r + 1) * w + x] - f[Math.max(0, y - r) * w + x];
    }
    for (let y = 0; y < h; y++) f[y * w + x] = tmp[y];
  }
}

function maxFilter(f: Float32Array, w: number, h: number, r: number) {
  const row = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (f[y * w + k] > m) m = f[y * w + k];
      row[x] = m;
    }
    for (let x = 0; x < w; x++) f[y * w + x] = row[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (f[k * w + x] > m) m = f[k * w + x];
      row[y] = m;
    }
    for (let y = 0; y < h; y++) f[y * w + x] = row[y];
  }
}

/**
 * Relleno por inundación sobre RGBA plano (varita mágica y bote de pintura).
 * Devuelve una máscara w×h con 255 donde el color está dentro de la tolerancia.
 */
export function floodMask(px: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, tolerance: number, contiguous: boolean): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const s = (sy * w + sx) * 4;
  const r0 = px[s], g0 = px[s + 1], b0 = px[s + 2], a0 = px[s + 3];
  const tol = tolerance;
  const match = (i: number) => {
    const j = i * 4;
    return Math.abs(px[j] - r0) <= tol && Math.abs(px[j + 1] - g0) <= tol && Math.abs(px[j + 2] - b0) <= tol && Math.abs(px[j + 3] - a0) <= tol;
  };
  if (!contiguous) {
    for (let i = 0; i < w * h; i++) if (match(i)) mask[i] = 255;
    return mask;
  }
  // Relleno por líneas de barrido con pila explícita.
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!, x = stack.pop()!;
    let l = x;
    const row = y * w;
    if (mask[row + x] || !match(row + x)) continue;
    while (l > 0 && !mask[row + l - 1] && match(row + l - 1)) l--;
    let r = x;
    while (r < w - 1 && !mask[row + r + 1] && match(row + r + 1)) r++;
    mask.fill(255, row + l, row + r + 1);
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let i = l; i <= r; i++) {
        const ok = !mask[nrow + i] && match(nrow + i);
        if (ok && !inRun) { stack.push(i, ny); inRun = true; } else if (!ok) inRun = false;
      }
    }
  }
  return mask;
}
