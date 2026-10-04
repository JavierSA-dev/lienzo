import type { Matrix, Rect, ShapeParams, TextParams } from './types';
import { textBox, drawText } from './text';

/**
 * Capas vectoriales (texto y formas): guardan sus parámetros y se rasterizan
 * con OffscreenCanvas cada vez que cambian, así siguen siendo editables.
 * La matriz actúa en coordenadas de documento (la aplica la transformación libre).
 */

export { SYSTEM_FONTS as FONTS } from './fonts';

export interface Raster { data: Uint8ClampedArray; x: number; y: number; w: number; h: number }

const MAX_SIDE = 16384;

export function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function transformRect(m: Matrix, r: Rect): Rect {
  const pts = [apply(m, r.x, r.y), apply(m, r.x + r.w, r.y), apply(m, r.x, r.y + r.h), apply(m, r.x + r.w, r.y + r.h)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
  return { x: x0, y: y0, w: Math.ceil(Math.max(...xs)) - x0, h: Math.ceil(Math.max(...ys)) - y0 };
}

function clipTo(r: Rect, limit: Rect): Rect {
  const x0 = Math.max(r.x, limit.x), y0 = Math.max(r.y, limit.y);
  const x1 = Math.min(r.x + r.w, limit.x + limit.w), y1 = Math.min(r.y + r.h, limit.y + limit.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

const css = (c: [number, number, number, number]) => `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;

function draw(local: Rect, m: Matrix, limit: Rect, paint: (ctx: OffscreenCanvasRenderingContext2D) => void): Raster | null {
  let box = clipTo(transformRect(m, local), limit);
  if (box.w > MAX_SIDE || box.h > MAX_SIDE) box = { ...box, w: Math.min(box.w, MAX_SIDE), h: Math.min(box.h, MAX_SIDE) };
  if (box.w <= 0 || box.h <= 0) return null;
  const c = new OffscreenCanvas(box.w, box.h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4] - box.x, m[5] - box.y);
  paint(ctx);
  const img = ctx.getImageData(0, 0, box.w, box.h);
  return { data: img.data, x: box.x, y: box.y, w: box.w, h: box.h };
}

export { fontString, textBox } from './text';

export function rasterizeText(t: TextParams, limit: Rect): Raster | null {
  const scale = Math.sqrt(Math.abs(t.matrix[0] * t.matrix[3] - t.matrix[1] * t.matrix[2]));
  return draw(textBox(t), t.matrix, limit, (ctx) => drawText(ctx, t, scale));
}

export function shapeBox(s: ShapeParams): Rect {
  const pad = (s.stroke ? s.strokeWidth / 2 : 0) + 2;
  const x0 = Math.min(s.x, s.x + s.w), y0 = Math.min(s.y, s.y + s.h);
  return { x: Math.floor(x0 - pad), y: Math.floor(y0 - pad), w: Math.ceil(Math.abs(s.w) + pad * 2), h: Math.ceil(Math.abs(s.h) + pad * 2) };
}

export function shapePath(s: ShapeParams): Path2D {
  if (s.shape === 'path') return new Path2D(s.path ?? '');
  const p = new Path2D();
  const x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h), w = Math.abs(s.w), h = Math.abs(s.h);
  switch (s.shape) {
    case 'rect':
      if (s.radius > 0) p.roundRect(x, y, w, h, Math.min(s.radius, w / 2, h / 2)); else p.rect(x, y, w, h);
      break;
    case 'ellipse':
      p.ellipse(x + w / 2, y + h / 2, Math.max(0.1, w / 2), Math.max(0.1, h / 2), 0, 0, Math.PI * 2);
      break;
    case 'line':
      p.moveTo(s.x, s.y);
      p.lineTo(s.x + s.w, s.y + s.h);
      break;
    case 'polygon': {
      const n = Math.max(3, Math.round(s.sides));
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        const px = x + w / 2 + (Math.cos(a) * w) / 2, py = y + h / 2 + (Math.sin(a) * h) / 2;
        if (i) p.lineTo(px, py); else p.moveTo(px, py);
      }
      p.closePath();
      break;
    }
  }
  return p;
}

export function rasterizeShape(s: ShapeParams, limit: Rect): Raster | null {
  return draw(shapeBox(s), s.matrix, limit, (ctx) => {
    const path = shapePath(s);
    if (s.fill && s.shape !== 'line') { ctx.fillStyle = css(s.fill); ctx.fill(path, 'evenodd'); }
    const stroke = s.shape === 'line' ? (s.stroke ?? s.fill) : s.stroke;
    if (stroke && s.strokeWidth > 0) {
      ctx.strokeStyle = css(stroke);
      ctx.lineWidth = s.strokeWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke(path);
    }
  });
}

/** Límite de rasterizado: el documento con margen (el contenido puede salirse un poco). */
export function rasterLimit(docW: number, docH: number): Rect {
  const m = Math.max(docW, docH);
  return { x: -m, y: -m, w: docW + 2 * m, h: docH + 2 * m };
}
