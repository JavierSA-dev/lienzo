// Texto: composición (carácter y párrafo), texto de párrafo en caja y Deformar texto.
// Se rasteriza con OffscreenCanvas (funciona en el worker) cada vez que cambian los parámetros.
import type { Rect, TextParams, TextWarp } from './types';

export interface Raster { data: Uint8ClampedArray; x: number; y: number; w: number; h: number }

type Ctx = OffscreenCanvasRenderingContext2D;

/**
 * El navegador guarda en caché la fuente resuelta para cada texto de 'font'; si se pidió antes de
 * cargar una Google Font, seguiría usando la de reserva. Tras cada carga cambia un poquito el tamaño
 * (milésimas de píxel, invisible) para que se vuelva a resolver.
 */
let fontEpoch = 0;
export function fontString(t: Pick<TextParams, 'italic' | 'bold' | 'size' | 'font'>) {
  const size = Math.max(1, t.size) + fontEpoch * 0.0001;
  return `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${size}px "${t.font}", sans-serif`;
}

const css = (c: [number, number, number, number]) => `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;

function setup(ctx: Ctx, t: TextParams) {
  ctx.font = fontString(t);
  const c = ctx as Ctx & { letterSpacing?: string; fontVariantCaps?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${((t.tracking ?? 0) / 1000) * t.size}px`;
  if ('fontVariantCaps' in c) c.fontVariantCaps = t.caps === 'small' ? 'small-caps' : 'normal';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

const shown = (t: TextParams, s: string) => (t.caps === 'all' ? s.toUpperCase() : s);

export interface LaidLine { text: string; x: number; y: number; w: number; gap: number; spaces: number }
export interface Layout { lines: LaidLine[]; bounds: Rect; ascent: number; descent: number }

let measureCtx: Ctx | null = null;
/** Tras cargar una fuente nueva: el contexto de medida podría tener en caché la de reserva. */
export function resetTextCache() { measureCtx = null; fontEpoch = (fontEpoch + 1) % 50; }
function mctx(): Ctx {
  measureCtx ??= new OffscreenCanvas(1, 1).getContext('2d')!;
  return measureCtx;
}

/** Coloca las líneas (sin deformar), en coordenadas locales del texto. */
export function layoutText(t: TextParams): Layout {
  const ctx = mctx();
  setup(ctx, t);
  const hs = (t.hScale ?? 100) / 100, vs = (t.vScale ?? 100) / 100;
  const width = (s: string) => ctx.measureText(shown(t, s)).width * hs;
  const m = ctx.measureText('Hg');
  const ascent = (m.fontBoundingBoxAscent ?? t.size * 0.9) * vs, descent = (m.fontBoundingBoxDescent ?? t.size * 0.25) * vs;
  const lh = t.size * t.lineHeight;
  const il = t.indentLeft ?? 0, ir = t.indentRight ?? 0, ifst = t.indentFirst ?? 0, after = t.spaceAfter ?? 0;
  const box = t.box && t.box.w > 0 ? t.box : null;
  const lines: LaidLine[] = [];
  let y = box ? t.y + ascent : t.y;
  const paras = t.text.split('\n');
  paras.forEach((para, pi) => {
    // Ajuste de líneas dentro de la caja (texto de párrafo); el de punto no se corta.
    const rows: { s: string; last: boolean; first: boolean }[] = [];
    if (!box) rows.push({ s: para, last: true, first: true });
    else {
      let cur = '';
      const avail = (first: boolean) => Math.max(1, box.w - il - ir - (first ? ifst : 0));
      const words = para.split(/(\s+)/);
      for (const wd of words) {
        if (!wd) continue;
        const cand = cur + wd;
        if (width(cand.trimEnd()) <= avail(rows.length === 0) || !cur.trim()) {
          // Palabra más larga que la caja: se parte por caracteres.
          if (!cur.trim() && width(wd) > avail(rows.length === 0) && wd.trim()) {
            let part = '';
            for (const ch of wd) {
              if (width(part + ch) > avail(rows.length === 0) && part) { rows.push({ s: part, last: false, first: rows.length === 0 }); part = ch; }
              else part += ch;
            }
            cur = part;
          } else cur = cand;
        } else {
          rows.push({ s: cur.trimEnd(), last: false, first: rows.length === 0 });
          cur = wd.trimStart();
        }
      }
      rows.push({ s: cur.trimEnd(), last: true, first: rows.length === 0 });
    }
    for (const r of rows) {
      const w = width(r.s);
      const ind = il + (r.first ? ifst : 0);
      let x: number, gap = 0;
      const spaces = (r.s.match(/ /g) ?? []).length;
      if (box) {
        const avail = box.w - ind - ir;
        const align = t.align;
        if (align === 'center') x = t.x + ind + (avail - w) / 2;
        else if (align === 'right') x = t.x + box.w - ir - w;
        else {
          x = t.x + ind;
          if (align === 'justify' && !r.last && spaces > 0) gap = (avail - w) / spaces;
        }
      } else {
        x = t.align === 'center' ? t.x - w / 2 : t.align === 'right' ? t.x - w : t.x + ind;
      }
      lines.push({ text: r.s, x, y, w: gap ? w + gap * spaces : w, gap, spaces });
      y += lh;
    }
    if (pi < paras.length - 1) y += after;
  });
  // En la caja solo se ven las líneas que caben (como Photoshop, el resto queda oculto).
  const visible = box ? lines.filter((l) => l.y + descent <= t.y + box.h + 0.5 || l === lines[0]) : lines;
  let x0 = Infinity, x1 = -Infinity;
  for (const l of visible) { x0 = Math.min(x0, l.x); x1 = Math.max(x1, l.x + Math.max(l.w, 1)); }
  if (!visible.length || !isFinite(x0)) { x0 = t.x; x1 = t.x + 1; }
  const shift = t.baselineShift ?? 0;
  let bounds: Rect;
  if (box) bounds = { x: Math.floor(t.x - 2), y: Math.floor(t.y - 2), w: Math.ceil(box.w + 4), h: Math.ceil(box.h + 4) };
  else {
    const top = (visible[0]?.y ?? t.y) - ascent - Math.max(0, shift), bot = (visible[visible.length - 1]?.y ?? t.y) + descent + Math.max(0, -shift);
    const pad = Math.ceil(t.size * 0.15) + 2; // cursivas y rasgos que sobresalen
    bounds = { x: Math.floor(x0 - pad), y: Math.floor(top - 2), w: Math.ceil(x1 - x0 + pad * 2), h: Math.ceil(bot - top + 4) };
  }
  return { lines: visible, bounds, ascent, descent };
}

/** Dibuja el texto sin deformar en `ctx` (coordenadas locales del texto). */
function paintText(ctx: Ctx, t: TextParams, lay: Layout) {
  setup(ctx, t);
  ctx.fillStyle = css(t.color);
  const hs = (t.hScale ?? 100) / 100, vs = (t.vScale ?? 100) / 100, shift = t.baselineShift ?? 0;
  for (const l of lay.lines) {
    ctx.save();
    ctx.translate(l.x, l.y - shift);
    ctx.scale(hs, vs);
    const s = shown(t, l.text);
    if (l.gap) {
      // Justificado: el espacio sobrante se reparte entre las palabras.
      let x = 0;
      for (const part of s.split(/( )/)) {
        if (part === ' ') { x += ctx.measureText(' ').width + l.gap / hs; continue; }
        ctx.fillText(part, x, 0);
        x += ctx.measureText(part).width;
      }
    } else ctx.fillText(s, 0, 0);
    ctx.restore();
    const th = Math.max(1, t.size * 0.06);
    if (t.underline) ctx.fillRect(l.x, l.y - shift + t.size * 0.12, l.w, th);
    if (t.strike) ctx.fillRect(l.x, l.y - shift - t.size * 0.28 * vs, l.w, th);
  }
}

// ------------------------------------------------------------------ Deformar texto

type Pt = [number, number];

/** Función de deformación en coordenadas locales (la caja `b` es el texto sin deformar). */
export function warpFn(w: TextWarp, b: Rect): (x: number, y: number) => Pt {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, hw = b.w / 2, hh = b.h / 2;
  const k = Math.max(-1, Math.min(1, w.bend / 100)), hd = (w.hDist ?? 0) / 100, vd = (w.vDist ?? 0) / 100;
  return (x, y) => {
    let u = (x - cx) / hw, v = (y - cy) / hh;
    let dx = 0, dy = 0;
    switch (w.style) {
      case 'arc': {
        if (Math.abs(k) < 1e-3) break;
        const R = hw / (k * Math.PI / 2), px = u * hw, py = v * hh, th = px / R;
        return distort(cx + (R - py) * Math.sin(th), cy + R - (R - py) * Math.cos(th));
      }
      case 'arch': dy = -k * (1 - u * u) * hh; break;
      case 'arcLower': dy = k * (1 - u * u) * hh * (v + 1) / 2; break;
      case 'arcUpper': dy = -k * (1 - u * u) * hh * (1 - v) / 2; break;
      case 'bulge': v *= 1 + k * (1 - u * u); break;
      case 'shellLower': dy = k * (1 - u * u) * hh * (v + 1) / 2; u *= 1 - 0.3 * k * (v + 1) / 2; break;
      case 'shellUpper': dy = -k * (1 - u * u) * hh * (1 - v) / 2; u *= 1 - 0.3 * k * (1 - v) / 2; break;
      case 'flag': dy = k * hh * 0.6 * Math.sin(Math.PI * u); break;
      case 'wave': dy = k * hh * 0.5 * Math.sin(Math.PI * 1.5 * u + (v + 1) * Math.PI / 4); break;
      case 'fish': v *= 1 + k * 0.7 * Math.sin(Math.PI * (u + 1) / 2) * (1 - u) ; break;
      case 'rise': dy = -k * u * hh; break;
      case 'fisheye': { const r2 = Math.min(1, u * u + v * v); const f = 1 + k * 0.6 * (1 - r2); u *= f; v *= f; break; }
      case 'inflate': { const fu = 1 + k * 0.5 * (1 - v * v), fv = 1 + k * 0.5 * (1 - u * u); u *= fu; v *= fv; break; }
      case 'squeeze': { u *= 1 - k * 0.4 * (1 - v * v); v *= 1 + k * 0.3 * (1 - u * u); break; }
      case 'twist': {
        const r = Math.min(1, Math.hypot(u, v * hh / hw)), a = k * Math.PI * (1 - r);
        const px = u * hw, py = v * hh, c = Math.cos(a), s = Math.sin(a);
        return distort(cx + px * c - py * s, cy + px * s + py * c);
      }
      default: break;
    }
    return distort(cx + u * hw + dx, cy + v * hh + dy);
  };
  // Distorsión horizontal/vertical: un lado más grande que el otro (perspectiva).
  function distort(x: number, y: number): Pt {
    if (!hd && !vd) return [x, y];
    const u = (x - cx) / hw, v = (y - cy) / hh;
    const nv = v * (1 + hd * u * 0.5), nu = u * (1 + vd * v * 0.5);
    return [cx + nu * hw, cy + nv * hh];
  }
}

const warping = (t: TextParams) => !!t.warp && t.warp.style !== 'none' && (t.warp.bend !== 0 || t.warp.hDist !== 0 || t.warp.vDist !== 0);

/** Caja del texto en coordenadas locales (deformación incluida). */
export function textBox(t: TextParams): Rect {
  const lay = layoutText(t);
  if (!warping(t)) return lay.bounds;
  const f = warpFn(t.warp!, lay.bounds), b = lay.bounds;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j <= 16; j++) for (let i = 0; i <= 32; i++) {
    const [x, y] = f(b.x + (b.w * i) / 32, b.y + (b.h * j) / 16);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x: Math.floor(x0 - 2), y: Math.floor(y0 - 2), w: Math.ceil(x1 - x0 + 4), h: Math.ceil(y1 - y0 + 4) };
}

/** Pinta el texto (deformado si toca) en un contexto que ya tiene la matriz del documento. */
export function drawText(ctx: Ctx, t: TextParams, scale = 1) {
  const lay = layoutText(t);
  if (!warping(t)) { paintText(ctx, t, lay); return; }
  // Se pinta sin deformar en un lienzo auxiliar y se reparte en triángulos deformados.
  const b = lay.bounds, res = Math.min(4, Math.max(1, scale));
  const src = new OffscreenCanvas(Math.max(1, Math.ceil(b.w * res)), Math.max(1, Math.ceil(b.h * res)));
  const sc = src.getContext('2d')!;
  sc.setTransform(res, 0, 0, res, -b.x * res, -b.y * res);
  paintText(sc, t, lay);
  const f = warpFn(t.warp!, b);
  const nx = Math.min(64, Math.max(8, Math.ceil(b.w / 20))), ny = Math.min(20, Math.max(4, Math.ceil(b.h / 20)));
  const grid: Pt[][] = [];
  for (let j = 0; j <= ny; j++) {
    const row: Pt[] = [];
    for (let i = 0; i <= nx; i++) row.push(f(b.x + (b.w * i) / nx, b.y + (b.h * j) / ny));
    grid.push(row);
  }
  const sp = (i: number, j: number): Pt => [(b.w * i) / nx * res, (b.h * j) / ny * res];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    tri(ctx, src, [sp(i, j), sp(i + 1, j), sp(i, j + 1)], [grid[j][i], grid[j][i + 1], grid[j + 1][i]]);
    tri(ctx, src, [sp(i + 1, j), sp(i + 1, j + 1), sp(i, j + 1)], [grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]]);
  }
}

/** Dibuja el triángulo `s` de la imagen en el triángulo `d` (transformación afín + recorte). */
function tri(ctx: Ctx, img: OffscreenCanvas, s: Pt[], d: Pt[]) {
  const [[x0, y0], [x1, y1], [x2, y2]] = s, [[u0, v0], [u1, v1], [u2, v2]] = d;
  const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (!den) return;
  const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / den;
  const c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / den;
  const b2 = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / den;
  const d2 = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / den;
  const e = u0 - a * x0 - c * y0, f = v0 - b2 * x0 - d2 * y0;
  // Recorte un poco ampliado para que no se vean las juntas entre triángulos.
  const mx = (u0 + u1 + u2) / 3, my = (v0 + v1 + v2) / 3, grow = (u: number, v: number): Pt => {
    const dx = u - mx, dy = v - my, l = Math.hypot(dx, dy) || 1;
    return [u + (dx / l) * 0.6, v + (dy / l) * 0.6];
  };
  ctx.save();
  ctx.beginPath();
  const p0 = grow(u0, v0), p1 = grow(u1, v1), p2 = grow(u2, v2);
  ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.closePath();
  ctx.clip();
  ctx.transform(a, b2, c, d2, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

export const WARP_STYLES: [TextWarp['style'], string][] = [
  ['none', 'Ninguno'], ['arc', 'Arco'], ['arcLower', 'Arco inferior'], ['arcUpper', 'Arco superior'], ['arch', 'Arco (edificio)'],
  ['bulge', 'Abombado'], ['shellLower', 'Concha inferior'], ['shellUpper', 'Concha superior'], ['flag', 'Bandera'], ['wave', 'Onda'],
  ['fish', 'Pez'], ['rise', 'Ascender'], ['fisheye', 'Ojo de pez'], ['inflate', 'Inflar'], ['squeeze', 'Estrechar'], ['twist', 'Giro'],
];
