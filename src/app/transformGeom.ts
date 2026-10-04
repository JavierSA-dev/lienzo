/**
 * Geometría de Edición > Transformar (sesgar, distorsionar, perspectiva, deformar) y de la
 * deformación de posición libre. La transformación final es  A ∘ H ∘ W :
 *   W = parche de Bézier (Deformar), H = homografía rectángulo → cuadrilátero, A = matriz afín.
 */
import { engine } from '../engine/client';
import type { Matrix, Rect } from '../engine/types';
import { homography, applyH, invertH, rectCorners, bezierPatch, identityPatch, fitPatch, mlsDeform, quadValid, type WarpSpec } from '../engine/meshwarp';
import { warpFn } from '../engine/text';
import type { TransformState, PuppetState, TPt } from './store';
import type { TextWarp } from '../engine/types';

export type Pt = TPt;

export const applyM = (m: Matrix, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invM(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export const quadOf = (t: TransformState): Pt[] => t.quad ?? rectCorners(t.bounds);

export function quadIsRect(t: TransformState) {
  if (!t.quad) return true;
  return rectCorners(t.bounds).every((c, i) => Math.abs(c[0] - t.quad![i][0]) < 1e-6 && Math.abs(c[1] - t.quad![i][1]) < 1e-6);
}

export function warpIsIdentity(t: TransformState) {
  if (!t.warp) return true;
  const id = identityPatch(t.bounds);
  return t.warp.ctrl.every((c, i) => Math.abs(c[0] - id[i][0]) < 1e-6 && Math.abs(c[1] - id[i][1]) < 1e-6);
}

/** H (rectángulo → cuadrilátero) y su inversa, en el espacio local. */
export function hOf(t: TransformState) {
  if (quadIsRect(t)) return null;
  const h = homography(rectCorners(t.bounds), quadOf(t));
  return { h, inv: invertH(h) };
}

/** Del espacio local (tras W) a documento: A ∘ H. */
export function localToDoc(t: TransformState): (x: number, y: number) => Pt {
  const H = hOf(t);
  return (x, y) => { const [u, v] = H ? applyH(H.h, x, y) : [x, y]; return applyM(t.matrix, u, v); };
}

/** De documento al espacio local (antes de H): (A ∘ H)⁻¹. */
export function docToLocal(t: TransformState): (x: number, y: number) => Pt {
  const H = hOf(t), ia = invM(t.matrix);
  return (x, y) => { const [u, v] = applyM(ia, x, y); return H ? applyH(H.inv, u, v) : [u, v]; };
}

/** Transformación completa de un punto del origen. */
export function fullMap(t: TransformState): (x: number, y: number) => Pt {
  const L = localToDoc(t), b = t.bounds;
  if (warpIsIdentity(t)) return L;
  const ctrl = t.warp!.ctrl;
  return (x, y) => { const [u, v] = bezierPatch(ctrl, (x - b.x) / b.w, (y - b.y) / b.h); return L(u, v); };
}

/** Especificación para el motor (afín si se puede, cuadrilátero exacto o malla). */
export function composeSpec(t: TransformState): WarpSpec {
  const b = t.bounds;
  if (!warpIsIdentity(t)) {
    const n = Math.max(16, Math.min(64, Math.round(Math.max(b.w, b.h) / 24)));
    const f = fullMap(t), pts: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const [x, y] = f(b.x + (b.w * i) / n, b.y + (b.h * j) / n); pts.push(x, y); }
    return { kind: 'mesh', src: b, cols: n, rows: n, pts };
  }
  if (!quadIsRect(t)) {
    const q = quadOf(t).map(([x, y]) => applyM(t.matrix, x, y));
    return { kind: 'quad', src: b, quad: q.flat() };
  }
  return { kind: 'affine', m: t.matrix };
}

export const pushSpec = (t: TransformState) => engine.call('updateTransformSpec', composeSpec(t));

// ------------------------------------------------------------------ edición del cuadrilátero

const H_NEIGHBOR = [1, 0, 3, 2], V_NEIGHBOR = [3, 2, 1, 0];
const CORNER_IDX: Record<string, number> = { nw: 0, ne: 1, se: 2, sw: 3 };
const SIDE_IDX: Record<string, [number, number]> = { n: [0, 1], e: [1, 2], s: [3, 2], w: [0, 3] };

/**
 * Arrastre de un asa en modo sesgar / distorsionar / perspectiva. `d` es el desplazamiento en el
 * espacio local (sin la matriz afín). Devuelve el cuadrilátero nuevo o null si quedaría inválido.
 */
export function dragQuad(orig: Pt[], handle: string, d: Pt, mode: 'skew' | 'distort' | 'perspective'): Pt[] | null {
  const q = orig.map((p) => [...p] as Pt);
  const ci = CORNER_IDX[handle], side = SIDE_IDX[handle];
  if (ci != null) {
    if (mode === 'perspective') {
      if (Math.abs(d[0]) >= Math.abs(d[1])) { q[ci][0] += d[0]; q[H_NEIGHBOR[ci]][0] -= d[0]; }
      else { q[ci][1] += d[1]; q[V_NEIGHBOR[ci]][1] -= d[1]; }
    } else if (mode === 'skew') {
      // Sesgar desde una esquina: sólo se mueve en horizontal o en vertical.
      if (Math.abs(d[0]) >= Math.abs(d[1])) q[ci][0] += d[0];
      else q[ci][1] += d[1];
    } else { q[ci][0] += d[0]; q[ci][1] += d[1]; }
  } else if (side) {
    const [a, b] = side;
    let dx = d[0], dy = d[1];
    if (mode === 'skew' || mode === 'perspective') {
      // Sesgar: el lado se desliza sobre sí mismo.
      const ex = orig[b][0] - orig[a][0], ey = orig[b][1] - orig[a][1], l = Math.hypot(ex, ey) || 1;
      const k = (dx * ex + dy * ey) / l;
      dx = (ex / l) * k; dy = (ey / l) * k;
    }
    q[a][0] += dx; q[a][1] += dy; q[b][0] += dx; q[b][1] += dy;
  } else return null;
  return quadValid(q) ? q : null;
}

// ------------------------------------------------------------------ deformar

export const PATCH_CORNERS = [0, 3, 15, 12];
/** Al mover una esquina del parche se mueven con ella sus tiradores (como un punto de ancla). */
export const CORNER_GROUP: Record<number, number[]> = { 0: [0, 1, 4, 5], 3: [3, 2, 7, 6], 12: [12, 8, 13, 9], 15: [15, 11, 14, 10] };
/** Tiradores de cada esquina (para dibujar las líneas). */
export const CORNER_TANGENTS: [number, number][] = [[0, 1], [0, 4], [3, 2], [3, 7], [12, 8], [12, 13], [15, 11], [15, 14]];

export function presetPatch(b: Rect, style: string, bend: number): Pt[] {
  if (style === 'none' || style === 'custom') return identityPatch(b);
  const f = warpFn({ style, bend, hDist: 0, vDist: 0 } as TextWarp, b);
  return fitPatch(b, f);
}

/** Curvas de la rejilla del parche (borde y tercios), ya en coordenadas de documento. */
export function patchGrid(t: TransformState, samples = 24): Pt[][] {
  const ctrl = t.warp?.ctrl ?? identityPatch(t.bounds), L = localToDoc(t), lines: Pt[][] = [];
  for (const k of [0, 1 / 3, 2 / 3, 1]) {
    const a: Pt[] = [], b: Pt[] = [];
    for (let i = 0; i <= samples; i++) {
      const s = i / samples;
      const p = bezierPatch(ctrl, s, k), q = bezierPatch(ctrl, k, s);
      a.push(L(p[0], p[1])); b.push(L(q[0], q[1]));
    }
    lines.push(a, b);
  }
  return lines;
}

// ------------------------------------------------------------------ deformación de posición libre

export function puppetGrid(p: PuppetState) {
  const b = p.bounds;
  const target = [10, 18, 30][p.density];
  const cell = Math.max(b.w, b.h) / target;
  const cols = Math.max(2, Math.round(b.w / cell)), rows = Math.max(2, Math.round(b.h / cell));
  return { cols, rows };
}

/** Malla deformada por MLS (posiciones de documento). */
export function puppetMesh(p: PuppetState): { cols: number; rows: number; pts: number[] } {
  const b = p.bounds, { cols, rows } = puppetGrid(p);
  const P = p.pins.map((x) => x.p), Q = p.pins.map((x) => x.q), pts: number[] = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    const v: Pt = [b.x + (b.w * i) / cols, b.y + (b.h * j) / rows];
    const [x, y] = mlsDeform(P, Q, v, p.mode);
    pts.push(x, y);
  }
  return { cols, rows, pts };
}

export function pushPuppet(p: PuppetState) {
  const moved = p.pins.some((x) => Math.hypot(x.p[0] - x.q[0], x.p[1] - x.q[1]) > 1e-6);
  if (!moved) { engine.call('updateTransform', [1, 0, 0, 1, 0, 0]); return; }
  const m = puppetMesh(p);
  engine.call('updateTransformSpec', { kind: 'mesh', src: p.bounds, cols: m.cols, rows: m.rows, pts: m.pts } satisfies WarpSpec);
}

/** Punto original aproximado bajo un punto deformado (MLS inverso: chinchetas intercambiadas). */
export function invertPuppet(p: PuppetState, v: Pt): Pt {
  return mlsDeform(p.pins.map((x) => x.q), p.pins.map((x) => x.p), v, p.mode);
}
