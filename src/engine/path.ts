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
