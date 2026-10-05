/**
 * Exportar como SVG: las formas y los textos se escriben como vectores; el resto (píxeles,
 * estilos, máscaras…) como imágenes PNG incrustadas. Lo que depende de lo de debajo (capas de
 * ajuste, modos de fusión, máscaras de recorte) se acopla con todo lo inferior en una imagen base.
 */
import type { PixelLayer, EditorDocument } from './document';
import type { Rect, ShapeParams, TextParams } from './types';
import { layoutText } from './text';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (c: [number, number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
const mat = (m: number[]) => (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0 ? '' : ` transform="matrix(${m.map(n).join(' ')})"`);

function shapeEl(s: ShapeParams, opacity: number): string {
  const x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h), w = Math.abs(s.w), h = Math.abs(s.h);
  const stroke = s.shape === 'line' ? (s.stroke ?? s.fill) : s.stroke;
  const paint = [
    s.fill && s.shape !== 'line' ? `fill="${col(s.fill)}"${s.fill[3] < 255 ? ` fill-opacity="${n(s.fill[3] / 255)}"` : ''} fill-rule="evenodd"` : 'fill="none"',
    stroke && s.strokeWidth > 0 ? `stroke="${col(stroke)}" stroke-width="${n(s.strokeWidth)}" stroke-linejoin="round" stroke-linecap="round"${stroke[3] < 255 ? ` stroke-opacity="${n(stroke[3] / 255)}"` : ''}` : '',
    opacity < 1 ? `opacity="${n(opacity)}"` : '',
  ].filter(Boolean).join(' ');
  const t = mat(s.matrix);
  switch (s.shape) {
    case 'rect': {
      const r = s.radius > 0 ? Math.min(s.radius, w / 2, h / 2) : 0;
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${r ? ` rx="${n(r)}"` : ''} ${paint}${t}/>`;
    }
    case 'ellipse': return `<ellipse cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" rx="${n(w / 2)}" ry="${n(h / 2)}" ${paint}${t}/>`;
    case 'line': return `<line x1="${n(s.x)}" y1="${n(s.y)}" x2="${n(s.x + s.w)}" y2="${n(s.y + s.h)}" ${paint}${t}/>`;
    case 'polygon': {
      const k = Math.max(3, Math.round(s.sides)), pts: string[] = [];
      for (let i = 0; i < k; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / k;
        pts.push(`${n(x + w / 2 + (Math.cos(a) * w) / 2)},${n(y + h / 2 + (Math.sin(a) * h) / 2)}`);
      }
      return `<polygon points="${pts.join(' ')}" ${paint}${t}/>`;
    }
    default: return `<path d="${esc(s.path ?? '')}" ${paint}${t}/>`;
  }
}

function textEl(t: TextParams, opacity: number): string {
  const lay = layoutText(t);
  const shift = t.baselineShift ?? 0;
  const attrs = [
    `font-family="${esc(t.font)}, sans-serif"`, `font-size="${n(t.size)}"`,
    t.bold ? 'font-weight="bold"' : '', t.italic ? 'font-style="italic"' : '',
    t.tracking ? `letter-spacing="${n(((t.tracking ?? 0) / 1000) * t.size)}"` : '',
    t.caps === 'small' ? 'font-variant="small-caps"' : '',
    t.underline || t.strike ? `text-decoration="${[t.underline ? 'underline' : '', t.strike ? 'line-through' : ''].filter(Boolean).join(' ')}"` : '',
    `fill="${col(t.color)}"`, t.color[3] < 255 ? `fill-opacity="${n(t.color[3] / 255)}"` : '',
    opacity < 1 ? `opacity="${n(opacity)}"` : '',
    'xml:space="preserve"',
  ].filter(Boolean).join(' ');
  const lines = lay.lines.map((l) => {
    const s = t.caps === 'all' ? l.text.toUpperCase() : l.text;
    const ws = l.gap && l.spaces ? ` word-spacing="${n(l.gap)}"` : '';
    return `<tspan x="${n(l.x)}" y="${n(l.y - shift)}"${ws}>${esc(s)}</tspan>`;
  }).join('');
  return `<text ${attrs}${mat(t.matrix)}>${lines}</text>`;
}

const warping = (t: TextParams) => !!t.warp && t.warp.style !== 'none' && (t.warp.bend !== 0 || (t.warp.hDist ?? 0) !== 0 || (t.warp.vDist ?? 0) !== 0);
const fxOn = (L: PixelLayer) => !!L.effects && Object.values(L.effects).some((e) => (Array.isArray(e) ? e.some((x) => x?.enabled) : (e as { enabled?: boolean } | undefined)?.enabled));

export interface SvgHost {
  /** Acopla esas capas en el rectángulo (RGBA). */
  flatten(layers: PixelLayer[], rect: Rect): Uint8ClampedArray;
  /** PNG en data: URL. */
  png(px: Uint8ClampedArray, w: number, h: number): Promise<string>;
}

/** Recorta al contenido no transparente. */
function trim(px: Uint8ClampedArray, w: number, h: number): Rect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function crop(px: Uint8ClampedArray, w: number, r: Rect) {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(px.subarray(((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4), y * r.w * 4);
  return out;
}

export async function buildSvg(d: EditorDocument, layers: PixelLayer[], rect: Rect, host: SvgHost): Promise<{ svg: string; vectors: number; rasters: number }> {
  const parents = (L: PixelLayer) => { const out: PixelLayer[] = []; for (let p = L.parent != null ? d.layer(L.parent) : undefined; p; p = p.parent != null ? d.layer(p.parent) : undefined) out.push(p); return out; };
  const visible = layers.filter((L) => L.kind !== 'group' && d.effectivelyVisible(L));
  // ¿Necesita lo de debajo para verse bien?
  const dependent = (L: PixelLayer) => L.kind === 'adjustment' || L.clipped || (L.blend !== 'normal' && L.blend !== 'pass-through')
    || parents(L).some((g) => (g.blend !== 'normal' && g.blend !== 'pass-through') || !!g.compMask() || fxOn(g));
  // Base acoplada: hasta la última capa dependiente (y sus grupos, que van después en el orden).
  let cut = -1;
  for (const L of visible) if (dependent(L)) {
    cut = Math.max(cut, layers.indexOf(L));
    for (const g of parents(L)) cut = Math.max(cut, layers.indexOf(g));
  }
  const body: string[] = [];
  let vectors = 0, rasters = 0;
  const image = async (px: Uint8ClampedArray, opacity = 1) => {
    const r = trim(px, rect.w, rect.h);
    if (!r) return;
    const url = await host.png(crop(px, rect.w, r), r.w, r.h);
    body.push(`<image x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"${opacity < 1 ? ` opacity="${n(opacity)}"` : ''} href="${url}"/>`);
    rasters++;
  };
  if (cut >= 0) await image(host.flatten(layers.slice(0, cut + 1), rect));
  for (const L of visible.filter((l) => layers.indexOf(l) > cut)) {
    const op = parents(L).reduce((o, g) => o * g.opacity, L.opacity);
    const plain = !fxOn(L) && !L.compMask();
    if (plain && L.kind === 'shape' && L.shape) {
      body.push(`<g transform="translate(${-rect.x} ${-rect.y})">${shapeEl(L.shape, op)}</g>`.replace('<g transform="translate(0 0)">', '<g>'));
      vectors++;
    } else if (plain && L.kind === 'text' && L.text && !warping(L.text) && (L.text.hScale ?? 100) === 100 && (L.text.vScale ?? 100) === 100) {
      body.push(`<g transform="translate(${-rect.x} ${-rect.y})">${textEl(L.text, op)}</g>`.replace('<g transform="translate(0 0)">', '<g>'));
      vectors++;
    } else {
      // flatten ya aplica la opacidad de la capa; la de los grupos se añade aquí.
      await image(host.flatten([L], rect), op / Math.max(1e-6, L.opacity));
    }
  }
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${rect.w}" height="${rect.h}" viewBox="0 0 ${rect.w} ${rect.h}">\n<title>${esc(d.name)}</title>\n${body.join('\n')}\n</svg>\n`;
  return { svg, vectors, rasters };
}
