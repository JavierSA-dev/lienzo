// Trazados de la pluma (curvas de Bézier cúbicas), compartidos por la interfaz y el motor.

/** Punto de ancla con sus dos manejadores (coordenadas absolutas de documento). */
export interface PathPoint {
  x: number; y: number;
  /** Manejador de entrada (hacia el punto anterior). */
  ix: number; iy: number;
  /** Manejador de salida (hacia el punto siguiente). */
  ox: number; oy: number;
}

export interface SubPath { points: PathPoint[]; closed: boolean }
export type VectorPath = SubPath[];

export const corner = (x: number, y: number): PathPoint => ({ x, y, ix: x, iy: y, ox: x, oy: y });

type Seg = [PathPoint, PathPoint];

export function segments(sp: SubPath): Seg[] {
  const out: Seg[] = [];
  const p = sp.points;
  for (let i = 1; i < p.length; i++) out.push([p[i - 1], p[i]]);
  if (sp.closed && p.length > 1) out.push([p[p.length - 1], p[0]]);
  return out;
}

const isLine = ([a, b]: Seg) => a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y;

/** Datos "d" de SVG / Path2D. `map` convierte coordenadas (p. ej. a pantalla). */
export function toSvg(path: VectorPath, map: (x: number, y: number) => [number, number] = (x, y) => [x, y]): string {
  const f = (x: number, y: number) => { const [a, b] = map(x, y); return `${+a.toFixed(2)} ${+b.toFixed(2)}`; };
  let d = '';
  for (const sp of path) {
    if (!sp.points.length) continue;
    d += `M${f(sp.points[0].x, sp.points[0].y)}`;
    for (const s of segments(sp)) {
      const [a, b] = s;
      d += isLine(s) ? `L${f(b.x, b.y)}` : `C${f(a.ox, a.oy)} ${f(b.ix, b.iy)} ${f(b.x, b.y)}`;
    }
    if (sp.closed) d += 'Z';
  }
  return d;
}

function bez(a: PathPoint, b: PathPoint, t: number): [number, number] {
  const u = 1 - t;
  const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return [k0 * a.x + k1 * a.ox + k2 * b.ix + k3 * b.x, k0 * a.y + k1 * a.oy + k2 * b.iy + k3 * b.y];
}

/** Convierte cada subtrazado en un polígono (las curvas se subdividen según su longitud). */
export function flatten(path: VectorPath): [number, number][][] {
  const rings: [number, number][][] = [];
  for (const sp of path) {
    if (sp.points.length < 2) continue;
    const ring: [number, number][] = [[sp.points[0].x, sp.points[0].y]];
    for (const s of segments(sp)) {
      const [a, b] = s;
      if (isLine(s)) { ring.push([b.x, b.y]); continue; }
      const len = Math.hypot(a.ox - a.x, a.oy - a.y) + Math.hypot(b.ix - a.ox, b.iy - a.oy) + Math.hypot(b.x - b.ix, b.y - b.iy);
      const n = Math.max(4, Math.min(256, Math.ceil(len / 2)));
      for (let i = 1; i <= n; i++) ring.push(bez(a, b, i / n));
    }
    rings.push(ring);
  }
  return rings;
}

export function pathBounds(path: VectorPath): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of flatten(path)) for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function isEmpty(path: VectorPath) {
  return !path.some((sp) => sp.points.length >= 2);
}

export const clonePath = (p: VectorPath): VectorPath => p.map((sp) => ({ closed: sp.closed, points: sp.points.map((q) => ({ ...q })) }));

/** Douglas-Peucker sobre una polilínea abierta. */
function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Contorno de una máscara (>= 128 = dentro) como trazado: sigue los bordes de los píxeles,
 * separa cada contorno (incluidos los agujeros) y lo simplifica con `tol` píxeles.
 */
export function traceMask(mask: Uint8Array, w: number, h: number, ox: number, oy: number, tol = 2): VectorPath {
  const W = w + 1;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] >= 128;
  // Aristas dirigidas (el interior queda a la derecha): hasta 2 salientes por vértice.
  const out1 = new Int32Array(W * (h + 1)).fill(-1), out2 = new Int32Array(W * (h + 1)).fill(-1);
  const edgeTo: number[] = [], edgeFrom: number[] = [];
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const from = y0 * W + x0, id = edgeTo.length;
    edgeTo.push(y1 * W + x1);
    edgeFrom.push(from);
    if (out1[from] < 0) out1[from] = id; else out2[from] = id;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inside(x, y)) continue;
    if (!inside(x, y - 1)) add(x, y, x + 1, y);
    if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!inside(x - 1, y)) add(x, y + 1, x, y);
  }
  const used = new Uint8Array(edgeTo.length);
  const path: VectorPath = [];
  for (let e0 = 0; e0 < edgeTo.length; e0++) {
    if (used[e0]) continue;
    const ring: [number, number][] = [];
    let e = e0;
    const from = edgeFrom[e0];
    let px = from % W, py = (from - px) / W;
    while (e >= 0 && !used[e]) {
      used[e] = 1;
      ring.push([px, py]);
      const to = edgeTo[e];
      const tx = to % W, ty = (to - tx) / W;
      const dx = tx - px, dy = ty - py;
      px = tx; py = ty;
      const a = out1[to], b = out2[to];
      if (b < 0 || used[b]) e = a >= 0 && !used[a] ? a : -1;
      else if (used[a]) e = b;
      else {
        // Vértice en silla: se gira a la derecha para no mezclar contornos.
        const ta = edgeTo[a], ax = ta % W - tx, ay = (ta - ta % W) / W - ty;
        e = dx * ay - dy * ax > 0 ? a : b;
      }
    }
    if (ring.length < 4) continue;
    // Quita puntos alineados y simplifica (el anillo se parte en dos por el punto más lejano).
    const far = ring.reduce((bi, p, i) => (Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]) > Math.hypot(ring[bi][0] - ring[0][0], ring[bi][1] - ring[0][1]) ? i : bi), 0);
    const pts = [...simplify(ring.slice(0, far + 1), tol), ...simplify([...ring.slice(far), ring[0]], tol).slice(1, -1)];
    if (pts.length < 3) continue;
    path.push({ closed: true, points: smoothRing(pts.map(([x, y]) => [x + ox, y + oy])) });
  }
  return path;
}

/**
 * Convierte un polígono cerrado en puntos de ancla: los vértices con giro suave pasan a
 * ser puntos suaves (Catmull-Rom) y los giros bruscos se quedan como esquinas.
 */
export function smoothRing(pts: [number, number][], maxTurnDeg = 50): PathPoint[] {
  const n = pts.length;
  return pts.map(([x, y], i) => {
    const [px, py] = pts[(i - 1 + n) % n], [nx, ny] = pts[(i + 1) % n];
    const a1 = Math.atan2(y - py, x - px), a2 = Math.atan2(ny - y, nx - x);
    let turn = Math.abs(a2 - a1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn * 180 / Math.PI > maxTurnDeg) return corner(x, y);
    const tx = nx - px, ty = ny - py, tl = Math.hypot(tx, ty) || 1;
    const l1 = Math.hypot(x - px, y - py) / 3, l2 = Math.hypot(nx - x, ny - y) / 3;
    return { x, y, ix: x - (tx / tl) * l1, iy: y - (ty / tl) * l1, ox: x + (tx / tl) * l2, oy: y + (ty / tl) * l2 };
  });
}
