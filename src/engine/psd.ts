import { readPsd, writePsdUint8Array, initializeCanvas, type Layer as PsdLayer, type Psd, type AdjustmentLayer } from 'ag-psd';
import { EditorDocument, PixelLayer, MaskChannel } from './document';
import { BLEND_MODES, type AdjustmentParams, type BlendMode } from './types';
import { layerFromPixels } from './ops';
import type { ImportResult } from './io';

// ag-psd necesita crear lienzos/ImageData; en el worker usamos OffscreenCanvas.
initializeCanvas(
  (w, h) => new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement,
  (w, h) => new ImageData(w, h),
);

const PSD_BLEND: Record<string, BlendMode> = Object.fromEntries(
  BLEND_MODES.map((m) => [m.replace(/-/g, ' '), m]),
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
    default: return null;
  }
}

/** Abre un PSD/PSB en el worker: capas, máscaras y capas de ajuste. Los grupos se aplanan. */
export function importPsd(name: string, buffer: ArrayBuffer): ImportResult {
  const psd: Psd = readPsd(new Uint8Array(buffer), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const doc = new EditorDocument(name, psd.width, psd.height);
  const warnings = new Set<string>();

  const walk = (layers: PsdLayer[], hidden: boolean, opacity: number) => {
    for (const l of layers) {
      const lHidden = hidden || !!l.hidden;
      const lOpacity = opacity * (l.opacity ?? 1);
      if (l.children) {
        if (l.blendMode && l.blendMode !== 'pass through' && l.blendMode !== 'normal') warnings.add('modos de fusión de grupo');
        if (l.mask) warnings.add('máscaras de grupo');
        walk(l.children, lHidden, lOpacity);
        continue;
      }
      let L: PixelLayer;
      if (l.adjustment) {
        const adj = fromPsdAdjustment(l.adjustment);
        if (!adj) { warnings.add(`ajuste "${l.adjustment.type}"`); continue; }
        L = new PixelLayer(l.name ?? 'Ajuste');
        L.kind = 'adjustment';
        L.adjustment = adj;
      } else {
        if (l.effects) warnings.add('estilos de capa (se muestran sin efectos)');
        if (l.text) warnings.add('texto (se importa rasterizado)');
        if (l.placedLayer) warnings.add('objetos inteligentes (se importan rasterizados)');
        const img = l.imageData;
        L = img && img.width > 0 && img.height > 0
          ? layerFromPixels(l.name ?? 'Capa', u8(img.data), img.width, img.height, l.left ?? 0, l.top ?? 0)
          : new PixelLayer(l.name ?? 'Capa');
      }
      // Máscara de capa.
      const m = l.mask;
      if (m && !m.fromVectorData) {
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
      }
      L.visible = !lHidden;
      L.opacity = lOpacity;
      L.blend = PSD_BLEND[l.blendMode ?? 'normal'] ?? 'normal';
      if (l.blendMode && !PSD_BLEND[l.blendMode]) warnings.add(`modo "${l.blendMode}"`);
      doc.layers.push(L);
    }
  };

  if (psd.children?.length) walk(psd.children, false, 1);
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
  const children: PsdLayer[] = [];
  for (const L of doc.layers) {
    const base: PsdLayer = {
      name: L.name,
      opacity: L.opacity,
      blendMode: L.blend.replace(/-/g, ' ') as PsdLayer['blendMode'],
      hidden: !L.visible,
    };
    if (L.kind === 'adjustment' && L.adjustment) {
      const a = toPsdAdjustment(L.adjustment);
      if (!a) continue; // ajustes que ag-psd aún no escribe
      base.adjustment = a;
    } else {
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
    children.push(base);
  }
  const psd: Psd = { width: doc.width, height: doc.height, imageData: { width: doc.width, height: doc.height, data: composite }, children };
  return writePsdUint8Array(psd, { generateThumbnail: false, trimImageData: true, noBackground: true, psb });
}
