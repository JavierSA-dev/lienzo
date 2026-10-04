import { readPsd, writePsdUint8Array, initializeCanvas, type Layer as PsdLayer, type Psd, type AdjustmentLayer, type LayerEffectsInfo, type Color as PsdColor, type UnitsValue } from 'ag-psd';
import { EditorDocument, PixelLayer, MaskChannel } from './document';
import { BLEND_MODES, SELECTIVE_RANGES, IDENTITY, type AdjustmentParams, type BlendMode, type RGBA, type LayerEffects, type BevelStyle, type TextParams, type Matrix, type WarpStyle } from './types';
import { SYSTEM_FONTS, GOOGLE_FONTS, fontReady } from './fonts';
import { parseCube, encodeLut, decodeLut, toCube } from './lut';
import { rasterizeText, rasterLimit } from './vector';
import type { LayerTextData } from 'ag-psd';
import { layerFromPixels } from './ops';
import type { ImportResult } from './io';

// ag-psd necesita crear lienzos/ImageData; en el worker usamos OffscreenCanvas.
initializeCanvas(
  (w, h) => new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement,
  (w, h) => new ImageData(w, h),
);

const PSD_BLEND: Record<string, BlendMode> = Object.fromEntries(
  [...BLEND_MODES, 'pass-through' as BlendMode].map((m) => [m.replace(/-/g, ' '), m]),
);

const u8 = (d: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) =>
  new Uint8ClampedArray(d.buffer, d.byteOffset, d.byteLength);

/** Convierte una capa de ajuste de Photoshop a la nuestra (las que soportamos). */
function fromPsdAdjustment(a: AdjustmentLayer): AdjustmentParams | null {
  switch (a.type) {
    case 'brightness/contrast': return { type: 'brightness', brightness: a.brightness ?? 0, contrast: a.contrast ?? 0 };
    case 'levels': {
      const c = a.rgb;
      if (!c) return { type: 'levels', inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
      const g = c.midtoneInput > 10 ? c.midtoneInput / 100 : c.midtoneInput || 1;
      return { type: 'levels', inBlack: c.shadowInput, inWhite: c.highlightInput, gamma: g, outBlack: c.shadowOutput, outWhite: c.highlightOutput };
    }
    case 'curves': return { type: 'curves', points: (a.rgb ?? [{ input: 0, output: 0 }, { input: 255, output: 255 }]).map((p) => [p.input, p.output]) };
    case 'exposure': return { type: 'exposure', exposure: a.exposure ?? 0, offset: a.offset ?? 0, gamma: a.gamma ?? 1 };
    case 'vibrance': return { type: 'vibrance', vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 };
    case 'hue/saturation': return { type: 'hueSat', hue: a.master?.hue ?? 0, saturation: a.master?.saturation ?? 0, lightness: a.master?.lightness ?? 0, colorize: false };
    case 'color balance': {
      const v = (c?: { cyanRed: number; magentaGreen: number; yellowBlue: number }): [number, number, number] => c ? [c.cyanRed, c.magentaGreen, c.yellowBlue] : [0, 0, 0];
      return { type: 'colorBalance', shadows: v(a.shadows), midtones: v(a.midtones), highlights: v(a.highlights) };
    }
    case 'black & white': return { type: 'blackWhite', reds: a.reds ?? 40, yellows: a.yellows ?? 60, greens: a.greens ?? 40, cyans: a.cyans ?? 60, blues: a.blues ?? 20, magentas: a.magentas ?? 80 };
    case 'invert': return { type: 'invert' };
    case 'posterize': return { type: 'posterize', levels: a.levels ?? 4 };
    case 'threshold': return { type: 'threshold', level: a.level ?? 128 };
    case 'photo filter': {
      const c = a.color as { r?: number; g?: number; b?: number; fr?: number; fg?: number; fb?: number } | undefined;
      const color: RGBA = c && c.r !== undefined ? [c.r, c.g ?? 0, c.b ?? 0, 255] : c && c.fr !== undefined ? [c.fr * 255, (c.fg ?? 0) * 255, (c.fb ?? 0) * 255, 255] : [236, 138, 0, 255];
      return { type: 'photoFilter', color, density: a.density ?? 25, preserveLuminosity: a.preserveLuminosity ?? true };
    }
    case 'selective color': {
      const ranges = Object.fromEntries(SELECTIVE_RANGES.map(([k]) => {
        const v = a[k];
        return [k, v ? [v.c, v.m, v.y, v.k] : [0, 0, 0, 0]];
      })) as Record<string, [number, number, number, number]>;
      return { type: 'selectiveColor', relative: a.mode !== 'absolute', ranges } as AdjustmentParams;
    }
    case 'color lookup': {
      try {
        if (a.lut3DFileData && (a.lutFormat ?? 'cube') === 'cube') {
          const l = parseCube(new TextDecoder().decode(a.lut3DFileData));
          return { type: 'colorLookup', name: a.lut3DFileName?.replace(/\.cube$/i, '') ?? a.name ?? 'LUT', size: l.size, data: encodeLut(l) };
        }
      } catch { /* formato no compatible */ }
      return null;
    }
    case 'channel mixer': {
      const ch = (c: { red: number; green: number; blue: number; constant: number } | undefined, d: [number, number, number, number]): [number, number, number, number] => c ? [c.red, c.green, c.blue, c.constant] : d;
      if (a.monochrome) { const g = ch(a.gray ?? a.red, [40, 40, 20, 0]); return { type: 'channelMixer', red: g, green: g, blue: g, monochrome: true }; }
      return { type: 'channelMixer', red: ch(a.red, [100, 0, 0, 0]), green: ch(a.green, [0, 100, 0, 0]), blue: ch(a.blue, [0, 0, 100, 0]), monochrome: false };
    }
    default: return null;
  }
}

function toPsdAdjustment(a: AdjustmentParams): AdjustmentLayer | null {
  switch (a.type) {
    case 'brightness': return { type: 'brightness/contrast', brightness: a.brightness, contrast: a.contrast };
    case 'curves': return { type: 'curves', rgb: a.points.map(([input, output]) => ({ input, output })) };
    case 'exposure': return { type: 'exposure', exposure: a.exposure, offset: a.offset, gamma: a.gamma };
    case 'vibrance': return { type: 'vibrance', vibrance: a.vibrance, saturation: a.saturation };
    case 'invert': return { type: 'invert' };
    case 'posterize': return { type: 'posterize', levels: a.levels };
    case 'threshold': return { type: 'threshold', level: a.level };
    case 'photoFilter': return { type: 'photo filter', color: { r: a.color[0], g: a.color[1], b: a.color[2] }, density: a.density, preserveLuminosity: a.preserveLuminosity };
    case 'selectiveColor': {
      const out: AdjustmentLayer = { type: 'selective color', mode: a.relative ? 'relative' : 'absolute' };
      for (const [k] of SELECTIVE_RANGES) { const [c, m, y, kk] = a.ranges[k]; (out as unknown as Record<string, unknown>)[k] = { c, m, y, k: kk }; }
      return out;
    }
    case 'colorLookup': {
      const cube = toCube(decodeLut(a.size, a.data), a.name);
      return { type: 'color lookup', lookupType: '3dlut', name: a.name, lutFormat: 'cube', dataOrder: 'rgb', tableOrder: 'rgb', lut3DFileName: `${a.name}.cube`, lut3DFileData: new TextEncoder().encode(cube) };
    }
    case 'channelMixer': {
      const ch = (v: [number, number, number, number]) => ({ red: v[0], green: v[1], blue: v[2], constant: v[3] });
      return a.monochrome ? { type: 'channel mixer', monochrome: true, gray: ch(a.red), red: ch(a.red), green: ch(a.red), blue: ch(a.red) }
        : { type: 'channel mixer', monochrome: false, red: ch(a.red), green: ch(a.green), blue: ch(a.blue) };
    }
    default: return null;
  }
}

// ------------------------------------------------------------------ estilos de capa

const px = (v: UnitsValue | undefined, d: number) => (v ? v.value : d);
const unit = (value: number): UnitsValue => ({ units: 'Pixels', value });
function colorIn(c: PsdColor | undefined, d: RGBA): RGBA {
  if (!c) return d;
  const o = c as { r?: number; g?: number; b?: number; fr?: number; fg?: number; fb?: number };
  const r8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  if (o.r !== undefined) return [r8(o.r), r8(o.g ?? 0), r8(o.b ?? 0), 255];
  if (o.fr !== undefined) return [r8(o.fr * 255), r8((o.fg ?? 0) * 255), r8((o.fb ?? 0) * 255), 255];
  return d;
}
const colorOut = (c: RGBA): PsdColor => ({ r: c[0], g: c[1], b: c[2] });
const modeIn = (m: string | undefined, d: BlendMode): BlendMode => (m && PSD_BLEND[m] && PSD_BLEND[m] !== 'pass-through' ? PSD_BLEND[m] : d);
const modeOut = (m: BlendMode | undefined, d: BlendMode) => (m ?? d).replace(/-/g, ' ') as PsdLayer['blendMode'];
const BEVEL_IN: Record<string, BevelStyle> = { 'inner bevel': 'inner', 'outer bevel': 'outer', emboss: 'emboss', 'pillow emboss': 'pillow', 'stroke emboss': 'emboss' };
const BEVEL_OUT: Record<BevelStyle, 'inner bevel' | 'outer bevel' | 'emboss' | 'pillow emboss'> = { inner: 'inner bevel', outer: 'outer bevel', emboss: 'emboss', pillow: 'pillow emboss' };

/** Estilos de capa de Photoshop → los nuestros (los 10 efectos). */
export function effectsFromPsd(e: LayerEffectsInfo): LayerEffects {
  const fx: LayerEffects = {};
  const on = (x: { enabled?: boolean } | undefined) => !!x && x.enabled !== false;
  const shadow = (x: NonNullable<LayerEffectsInfo['dropShadow']>[number], blend: BlendMode) => ({
    enabled: on(x), color: colorIn(x.color, [0, 0, 0, 255]), opacity: x.opacity ?? 0.75, angle: x.angle ?? 120,
    distance: px(x.distance, 5), size: px(x.size, 5), spread: px(x.choke, 0), blend: modeIn(x.blendMode, blend),
  });
  if (e.dropShadow?.[0]) fx.dropShadow = shadow(e.dropShadow[0], 'multiply');
  if (e.innerShadow?.[0]) fx.innerShadow = shadow(e.innerShadow[0], 'multiply');
  if (e.outerGlow) fx.outerGlow = { enabled: on(e.outerGlow), color: colorIn(e.outerGlow.color, [255, 255, 190, 255]), opacity: e.outerGlow.opacity ?? 0.75, size: px(e.outerGlow.size, 5), spread: px(e.outerGlow.choke, 0), blend: modeIn(e.outerGlow.blendMode, 'screen') };
  if (e.innerGlow) fx.innerGlow = { enabled: on(e.innerGlow), color: colorIn(e.innerGlow.color, [255, 255, 190, 255]), opacity: e.innerGlow.opacity ?? 0.75, size: px(e.innerGlow.size, 5), spread: px(e.innerGlow.choke, 0), blend: modeIn(e.innerGlow.blendMode, 'screen'), source: e.innerGlow.source === 'center' ? 'center' : 'edge' };
  if (e.bevel) {
    const b = e.bevel;
    fx.bevel = {
      enabled: on(b), style: BEVEL_IN[b.style ?? 'inner bevel'] ?? 'inner', technique: b.technique === 'smooth' || !b.technique ? 'smooth' : 'chisel',
      depth: b.strength ?? 100, up: b.direction !== 'down', size: px(b.size, 5), soften: px(b.soften, 0), angle: b.angle ?? 120, altitude: b.altitude ?? 30,
      highlight: colorIn(b.highlightColor, [255, 255, 255, 255]), highlightOpacity: b.highlightOpacity ?? 0.75, highlightBlend: modeIn(b.highlightBlendMode, 'screen'),
      shadow: colorIn(b.shadowColor, [0, 0, 0, 255]), shadowOpacity: b.shadowOpacity ?? 0.75, shadowBlend: modeIn(b.shadowBlendMode, 'multiply'),
    };
  }
  if (e.satin) fx.satin = { enabled: on(e.satin), color: colorIn(e.satin.color, [0, 0, 0, 255]), opacity: e.satin.opacity ?? 0.5, angle: e.satin.angle ?? 19, distance: px(e.satin.distance, 11), size: px(e.satin.size, 14), invert: !!e.satin.invert, blend: modeIn(e.satin.blendMode, 'multiply') };
  if (e.solidFill?.[0]) { const c = e.solidFill[0]; fx.colorOverlay = { enabled: on(c), color: colorIn(c.color, [255, 0, 0, 255]), opacity: c.opacity ?? 1, blend: modeIn(c.blendMode, 'normal') }; }
  if (e.gradientOverlay?.[0]) {
    const g = e.gradientOverlay[0];
    const stops = g.gradient && g.gradient.type === 'solid' ? g.gradient.colorStops : [];
    fx.gradientOverlay = {
      enabled: on(g), from: colorIn(stops[0]?.color, [0, 0, 0, 255]), to: colorIn(stops[stops.length - 1]?.color, [255, 255, 255, 255]),
      opacity: g.opacity ?? 1, angle: g.angle ?? 90, style: g.type ?? 'linear', reverse: !!g.reverse, scale: g.scale ?? 100, blend: modeIn(g.blendMode, 'normal'),
    };
  }
  if (e.patternOverlay) fx.patternOverlay = { enabled: on(e.patternOverlay), pattern: 'checker', colorA: [255, 255, 255, 255], colorB: [200, 200, 200, 255], scale: e.patternOverlay.scale ?? 100, opacity: e.patternOverlay.opacity ?? 1, blend: modeIn(e.patternOverlay.blendMode, 'normal') };
  if (e.stroke?.[0]) { const t = e.stroke[0]; fx.stroke = { enabled: on(t), color: colorIn(t.color, [0, 0, 0, 255]), size: px(t.size, 3), position: t.position ?? 'outside', opacity: t.opacity ?? 1, blend: modeIn(t.blendMode, 'normal') }; }
  return fx;
}

/** Los nuestros → Photoshop (el motivo se guarda como superposición sin motivo propio). */
export function effectsToPsd(fx: LayerEffects): LayerEffectsInfo | undefined {
  const e: LayerEffectsInfo = {};
  const sh = (x: NonNullable<LayerEffects['dropShadow']>, d: BlendMode) => ({ enabled: x.enabled, present: true, showInDialog: true, color: colorOut(x.color), opacity: x.opacity, angle: x.angle, distance: unit(x.distance), size: unit(x.size), choke: unit(x.spread ?? 0), blendMode: modeOut(x.blend, d), useGlobalLight: false });
  if (fx.dropShadow?.enabled) e.dropShadow = [sh(fx.dropShadow, 'multiply')];
  if (fx.innerShadow?.enabled) e.innerShadow = [sh(fx.innerShadow, 'multiply')];
  if (fx.outerGlow?.enabled) { const g = fx.outerGlow; e.outerGlow = { enabled: true, present: true, showInDialog: true, color: colorOut(g.color), opacity: g.opacity, size: unit(g.size), choke: unit(g.spread ?? 0), blendMode: modeOut(g.blend, 'screen') }; }
  if (fx.innerGlow?.enabled) { const g = fx.innerGlow; e.innerGlow = { enabled: true, present: true, showInDialog: true, color: colorOut(g.color), opacity: g.opacity, size: unit(g.size), choke: unit(g.spread ?? 0), blendMode: modeOut(g.blend, 'screen'), source: g.source ?? 'edge' }; }
  if (fx.bevel?.enabled) {
    const b = fx.bevel;
    e.bevel = {
      enabled: true, present: true, showInDialog: true, style: BEVEL_OUT[b.style], technique: b.technique === 'chisel' ? 'chisel hard' : 'smooth', strength: b.depth,
      direction: b.up ? 'up' : 'down', size: unit(b.size), soften: unit(b.soften), angle: b.angle, altitude: b.altitude, useGlobalLight: false,
      highlightColor: colorOut(b.highlight), highlightOpacity: b.highlightOpacity, highlightBlendMode: modeOut(b.highlightBlend, 'screen'),
      shadowColor: colorOut(b.shadow), shadowOpacity: b.shadowOpacity, shadowBlendMode: modeOut(b.shadowBlend, 'multiply'),
    };
  }
  if (fx.satin?.enabled) { const t = fx.satin; e.satin = { enabled: true, present: true, showInDialog: true, color: colorOut(t.color), opacity: t.opacity, angle: t.angle, distance: unit(t.distance), size: unit(t.size), invert: t.invert, blendMode: modeOut(t.blend, 'multiply') }; }
  if (fx.colorOverlay?.enabled) { const c = fx.colorOverlay; e.solidFill = [{ enabled: true, present: true, showInDialog: true, color: colorOut(c.color), opacity: c.opacity, blendMode: modeOut(c.blend, 'normal') }]; }
  if (fx.gradientOverlay?.enabled) {
    const g = fx.gradientOverlay;
    e.gradientOverlay = [{
      enabled: true, present: true, showInDialog: true, opacity: g.opacity, angle: g.angle, type: g.style, reverse: g.reverse, scale: g.scale, blendMode: modeOut(g.blend, 'normal'), align: true,
      gradient: { name: 'Lienzo', type: 'solid', smoothness: 1, colorStops: [{ color: colorOut(g.from), location: 0, midpoint: 50 }, { color: colorOut(g.to), location: 1, midpoint: 50 }], opacityStops: [{ opacity: 1, location: 0, midpoint: 50 }, { opacity: 1, location: 1, midpoint: 50 }] },
    }];
  }
  if (fx.stroke?.enabled) { const t = fx.stroke; e.stroke = [{ enabled: true, present: true, showInDialog: true, size: unit(t.size), position: t.position ?? 'outside', fillType: 'color', color: colorOut(t.color), opacity: t.opacity ?? 1, blendMode: modeOut(t.blend, 'normal') }]; }
  return Object.keys(e).length ? e : undefined;
}

// ------------------------------------------------------------------ texto editable

const KNOWN = [...SYSTEM_FONTS, ...GOOGLE_FONTS];
/** Nombre PostScript de Photoshop ("OpenSans-BoldItalic", "ArialMT") → familia y estilo. */
export function fontFromPostScript(ps: string): { family: string; bold: boolean; italic: boolean } {
  const [base0, style = ''] = ps.split('-');
  const base = base0.replace(/(PSMT|MT|PS)$/, '');
  const squash = (x: string) => x.replace(/\s+/g, '').toLowerCase();
  const known = KNOWN.find((f) => squash(f) === squash(base));
  const family = known ?? base.replace(/([a-z])([A-Z])/g, '$1 $2');
  return { family, bold: /bold|black|heavy|semibold/i.test(style), italic: /italic|oblique/i.test(style) };
}
const postScriptName = (t: TextParams) => `${t.font.replace(/\s+/g, '')}${t.bold || t.italic ? `-${t.bold ? 'Bold' : ''}${t.italic ? 'Italic' : ''}` : ''}`;

function inkHeight(data: Uint8ClampedArray, w: number, h: number) {
  let y0 = -1, y1 = -1;
  for (let y = 0; y < h && y0 < 0; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 40) { y0 = y; break; }
  for (let y = h - 1; y >= 0 && y1 < 0; y--) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 40) { y1 = y; break; }
  return y0 >= 0 ? y1 - y0 + 1 : 0;
}

/** Capa de texto de Photoshop → nuestros parámetros (el tamaño se calibra con los píxeles guardados). */
function textFromPsd(td: LayerTextData, img: { width: number; height: number; data: Uint8ClampedArray } | null, docW: number, docH: number): TextParams {
  const st = td.style ?? {}, ps = td.paragraphStyle ?? {};
  const f = fontFromPostScript(st.font?.name ?? 'Arial');
  const tr = td.transform ?? [1, 0, 0, 1, 0, 0];
  const matrix: Matrix = [tr[0], tr[1], tr[2], tr[3], tr[4], tr[5]];
  const size = st.fontSize ?? 24;
  const just = ps.justification ?? 'left';
  const box = td.shapeType === 'box' && td.boxBounds ? { w: td.boxBounds[2] - td.boxBounds[0], h: td.boxBounds[3] - td.boxBounds[1] } : null;
  const t: TextParams = {
    text: td.text.replace(/\r/g, '\n'), font: f.family, size, color: colorIn(st.fillColor, [0, 0, 0, 255]),
    bold: !!st.fauxBold || f.bold, italic: !!st.fauxItalic || f.italic,
    align: just === 'center' ? 'center' : just === 'right' ? 'right' : just.startsWith('justify') ? 'justify' : 'left',
    lineHeight: st.autoLeading === false && st.leading ? st.leading / size : 1.2,
    x: box ? td.boxBounds![0] : 0, y: box ? td.boxBounds![1] : 0, matrix,
    tracking: st.tracking || undefined, hScale: st.horizontalScale ? st.horizontalScale * 100 : undefined, vScale: st.verticalScale ? st.verticalScale * 100 : undefined,
    baselineShift: st.baselineShift || undefined, caps: st.fontCaps === 1 ? 'small' : st.fontCaps === 2 ? 'all' : undefined,
    underline: st.underline || undefined, strike: st.strikethrough || undefined, box,
    indentLeft: ps.startIndent || undefined, indentRight: ps.endIndent || undefined, indentFirst: ps.firstLineIndent || undefined, spaceAfter: ps.spaceAfter || undefined,
    warp: td.warp && td.warp.style && td.warp.style !== 'none' && td.warp.style !== 'custom' && td.warp.style !== 'cylinder'
      ? { style: td.warp.style as WarpStyle, bend: td.warp.value ?? 0, hDist: td.warp.perspective ?? 0, vDist: td.warp.perspectiveOther ?? 0 } : null,
  };
  // El cuerpo puede venir en puntos: se ajusta para que la altura coincida con la de Photoshop.
  if (img && !t.warp && fontReady(t.font)) {
    const want = inkHeight(img.data, img.width, img.height);
    const r = rasterizeText(t, rasterLimit(docW, docH));
    const got = r ? inkHeight(r.data, r.w, r.h) : 0;
    if (want > 4 && got > 4) {
      const k = want / got;
      if (k > 0.2 && k < 8 && Math.abs(k - 1) > 0.04) t.size = Math.round(t.size * k * 10) / 10;
    }
  }
  return t;
}

function textToPsd(t: TextParams): LayerTextData {
  const m = t.matrix ?? IDENTITY;
  // Texto de punto: el origen de Photoshop es el punto de la línea base.
  const transform = t.box ? [...m] : [m[0], m[1], m[2], m[3], m[0] * t.x + m[2] * t.y + m[4], m[1] * t.x + m[3] * t.y + m[5]];
  const td: LayerTextData = {
    text: t.text, transform, antiAlias: 'smooth', shapeType: t.box ? 'box' : 'point',
    style: {
      font: { name: postScriptName(t) }, fontSize: t.size, fauxBold: t.bold, fauxItalic: t.italic, fillColor: colorOut(t.color),
      autoLeading: Math.abs(t.lineHeight - 1.2) < 0.01, leading: t.size * t.lineHeight, tracking: t.tracking ?? 0,
      horizontalScale: (t.hScale ?? 100) / 100, verticalScale: (t.vScale ?? 100) / 100, baselineShift: t.baselineShift ?? 0,
      fontCaps: t.caps === 'small' ? 1 : t.caps === 'all' ? 2 : 0, underline: !!t.underline, strikethrough: !!t.strike,
    },
    paragraphStyle: {
      justification: t.align === 'justify' ? 'justify-left' : t.align, startIndent: t.indentLeft ?? 0, endIndent: t.indentRight ?? 0,
      firstLineIndent: t.indentFirst ?? 0, spaceAfter: t.spaceAfter ?? 0,
    },
  };
  if (t.box) td.boxBounds = [t.x, t.y, t.x + t.box.w, t.y + t.box.h];
  if (t.warp && t.warp.style !== 'none') td.warp = { style: t.warp.style, value: t.warp.bend, perspective: t.warp.hDist, perspectiveOther: t.warp.vDist, rotate: 'horizontal' };
  return td;
}

// ------------------------------------------------------------------ datos propios de Lienzo en el XMP

/** Lo que Photoshop no sabe guardar a nuestra manera (p. ej. los motivos generados) va en el XMP del archivo. */
interface Extra { patternOverlay?: LayerEffects['patternOverlay'] }
function writeExtras(x: Record<number, Extra>): string {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(x))));
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:lienzo="https://lienzo.app/ns/1.0/" lienzo:data="${b64}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}
function readExtras(psd: Psd): Record<number, Extra> {
  const m = /lienzo:data="([^"]+)"/.exec(psd.imageResources?.xmpMetadata ?? '');
  if (!m) return {};
  try { return JSON.parse(decodeURIComponent(escape(atob(m[1])))); } catch { return {}; }
}

/** Abre un PSD/PSB en el worker: grupos, capas, máscaras, máscaras de recorte y capas de ajuste. */
export function importPsd(name: string, buffer: ArrayBuffer): ImportResult {
  const psd: Psd = readPsd(new Uint8Array(buffer), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const doc = new EditorDocument(name, psd.width, psd.height);
  const warnings = new Set<string>();
  const extras = readExtras(psd);

  const readMask = (l: PsdLayer, L: PixelLayer) => {
    const m = l.mask;
    if (!m || m.fromVectorData) return;
    const mask = new MaskChannel(m.defaultColor ?? 255);
    const mi = m.imageData;
    if (mi && mi.width > 0 && mi.height > 0) {
      const data = u8(mi.data);
      const ml = m.left ?? 0, mt = m.top ?? 0;
      // La máscara está en coordenadas de documento; la nuestra, en coordenadas de la capa (x=y=0 aquí).
      const tmp = new PixelLayer('m');
      tmp.writeRegion(new Uint8ClampedArray(mi.width * mi.height * 4).map((_, i) => (i % 4 === 3 ? 255 : data[(i >> 2) * 4])), mi.width, mi.height, ml, mt);
      for (const [k, t] of tmp.tiles) {
        const mt8 = new Uint8Array(t.length / 4).fill(mask.fill);
        for (let i = 0; i < mt8.length; i++) if (t[i * 4 + 3]) mt8[i] = t[i * 4];
        mask.setTile(k, mt8);
      }
    }
    L.mask = mask;
    L.maskEnabled = !m.disabled;
  };

  const walk = (layers: PsdLayer[], parent: number | null) => {
    for (const l of layers) {
      let L: PixelLayer;
      if (l.children) {
        L = new PixelLayer(l.name ?? 'Grupo');
        L.kind = 'group';
        L.collapsed = !l.opened;
        L.parent = parent;
        walk(l.children, L.id);
      } else if (l.adjustment) {
        const adj = fromPsdAdjustment(l.adjustment);
        if (!adj) { warnings.add(`ajuste "${l.adjustment.type}"`); continue; }
        L = new PixelLayer(l.name ?? 'Ajuste');
        L.kind = 'adjustment';
        L.adjustment = adj;
      } else {
        if (l.placedLayer) warnings.add('objetos inteligentes (se importan rasterizados)');
        const img = l.imageData;
        L = img && img.width > 0 && img.height > 0
          ? layerFromPixels(l.name ?? 'Capa', u8(img.data), img.width, img.height, l.left ?? 0, l.top ?? 0)
          : new PixelLayer(l.name ?? 'Capa');
        if (l.text) {
          // Texto editable: se conservan los píxeles de Photoshop hasta que se edite.
          try {
            L.kind = 'text';
            L.text = textFromPsd(l.text, img && img.width > 0 ? { width: img.width, height: img.height, data: u8(img.data) } : null, psd.width, psd.height);
          } catch { L.kind = 'pixel'; L.text = undefined; warnings.add('algún texto (se importa rasterizado)'); }
        }
      }
      readMask(l, L);
      if (!l.children && !l.adjustment) {
        const fx: LayerEffects = l.effects && !l.effects.disabled ? effectsFromPsd(l.effects) : {};
        if (l.fillOpacity !== undefined && l.fillOpacity < 1) fx.fill = l.fillOpacity;
        const br = l.blendingRanges?.compositeGrayBlendSource, bd = l.blendingRanges?.compositeGraphBlendDestinationRange;
        if (br && bd && (br.join() !== '0,0,255,255' || bd.join() !== '0,0,255,255')) fx.blendIf = { channel: 'gray', self: br as [number, number, number, number], under: bd as [number, number, number, number] };
        const mine = l.id !== undefined ? extras[l.id] : undefined;
        if (mine?.patternOverlay) fx.patternOverlay = mine.patternOverlay;
        else if (l.effects?.patternOverlay) warnings.add('motivos de "Superposición de motivo" (se sustituyen por uno propio)');
        if (Object.keys(fx).length) L.effects = fx;
      }
      L.parent = parent;
      L.clipped = !!l.clipping && !l.children;
      L.visible = !l.hidden;
      L.opacity = l.opacity ?? 1;
      L.blend = PSD_BLEND[l.blendMode ?? 'normal'] ?? 'normal';
      if (L.blend === 'pass-through' && L.kind !== 'group') L.blend = 'normal';
      if (l.blendMode && !PSD_BLEND[l.blendMode]) warnings.add(`modo "${l.blendMode}"`);
      doc.layers.push(L);
    }
  };

  if (psd.children?.length) walk(psd.children, null);
  else if (psd.imageData) {
    const img = psd.imageData;
    doc.layers.push(layerFromPixels('Fondo', u8(img.data), img.width, img.height));
  }
  if (!doc.layers.length) doc.layers.push(new PixelLayer('Capa 1'));
  doc.activeLayerId = doc.layers[doc.layers.length - 1].id;
  return { doc, warnings: [...warnings] };
}

/** Guarda PSD (o PSB): capas, opacidad, fusión, visibilidad, máscaras y algunos ajustes. */
export function exportPsd(doc: EditorDocument, composite: Uint8ClampedArray, psb = false): Uint8Array {
  const toPsd = (L: PixelLayer): PsdLayer | null => {
    const base: PsdLayer = {
      id: L.id,
      name: L.name,
      opacity: L.opacity,
      blendMode: L.blend.replace(/-/g, ' ') as PsdLayer['blendMode'],
      hidden: !L.visible,
      clipping: L.clipped,
    };
    const fx = L.effects;
    if (fx && L.kind !== 'group' && L.kind !== 'adjustment') {
      const e = effectsToPsd(fx);
      if (e) base.effects = e;
      if (fx.patternOverlay?.enabled) extras[L.id] = { patternOverlay: fx.patternOverlay };
      if (fx.fill !== undefined) base.fillOpacity = fx.fill;
      if (fx.blendIf) base.blendingRanges = { compositeGrayBlendSource: [...fx.blendIf.self], compositeGraphBlendDestinationRange: [...fx.blendIf.under], ranges: [] };
    }
    if (L.kind === 'group') {
      base.opened = !L.collapsed;
      base.children = level(L.id);
      base.clipping = false;
    } else if (L.kind === 'adjustment' && L.adjustment) {
      const a = toPsdAdjustment(L.adjustment);
      if (!a) return null; // ajustes que ag-psd aún no escribe
      base.adjustment = a;
    } else {
      if (L.kind === 'text' && L.text) base.text = textToPsd(L.text);
      const b = L.bounds();
      if (b) {
        base.left = b.x; base.top = b.y;
        base.imageData = { width: b.w, height: b.h, data: L.readRegion(b.x - L.x, b.y - L.y, b.w, b.h) };
      }
    }
    if (L.mask) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const k of L.mask.tiles.keys()) {
        const tx = (k % 65536) - 32768, ty = Math.floor(k / 65536) - 32768;
        x0 = Math.min(x0, tx * 256); y0 = Math.min(y0, ty * 256); x1 = Math.max(x1, tx * 256 + 256); y1 = Math.max(y1, ty * 256 + 256);
      }
      if (x0 < x1) {
        const w = x1 - x0, h = y1 - y0;
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const v = L.mask.get(x0 + x, y0 + y), i = (y * w + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
        }
        base.mask = { left: x0 + L.x, top: y0 + L.y, right: x1 + L.x, bottom: y1 + L.y, defaultColor: L.mask.fill, disabled: !L.maskEnabled, imageData: { width: w, height: h, data } };
      } else {
        base.mask = { defaultColor: L.mask.fill, disabled: !L.maskEnabled };
      }
    }
    return base;
  };
  const extras: Record<number, Extra> = {};
  const level = (pid: number | null): PsdLayer[] => doc.children(pid).map(toPsd).filter((x): x is PsdLayer => !!x);
  const children = level(null);
  const psd: Psd = { width: doc.width, height: doc.height, imageData: { width: doc.width, height: doc.height, data: composite }, children };
  if (Object.keys(extras).length) psd.imageResources = { xmpMetadata: writeExtras(extras) };
  return writePsdUint8Array(psd, { generateThumbnail: false, trimImageData: true, noBackground: true, psb });
}
