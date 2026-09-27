import { readPsd, writePsdUint8Array, initializeCanvas, type Layer as PsdLayer, type Psd } from 'ag-psd';
import { EditorDocument, PixelLayer } from './document';
import { BLEND_MODES, type BlendMode } from './types';
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

/** Abre un PSD/PSB en el worker. Las capas de grupo se aplanan en esta fase. */
export function importPsd(name: string, buffer: ArrayBuffer): ImportResult {
  const psd: Psd = readPsd(new Uint8Array(buffer), {
    useImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
  });
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
      if (l.adjustment) { warnings.add('capas de ajuste'); continue; }
      if (l.mask) warnings.add('máscaras de capa');
      if (l.effects) warnings.add('estilos de capa');
      if (l.text) warnings.add('texto editable (se importa rasterizado)');
      if (l.placedLayer) warnings.add('objetos inteligentes (se importan rasterizados)');
      const img = l.imageData;
      const L = img && img.width > 0 && img.height > 0
        ? layerFromPixels(l.name ?? 'Capa', new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height, l.left ?? 0, l.top ?? 0)
        : new PixelLayer(l.name ?? 'Capa');
      L.visible = !lHidden;
      L.opacity = lOpacity;
      L.blend = PSD_BLEND[l.blendMode ?? 'normal'] ?? 'normal';
      if (l.blendMode && !PSD_BLEND[l.blendMode]) warnings.add(`modo "${l.blendMode}"`);
      doc.layers.push(L);
    }
  };

  if (psd.children?.length) {
    walk(psd.children, false, 1);
  } else if (psd.imageData) {
    const img = psd.imageData;
    doc.layers.push(layerFromPixels('Fondo', new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height));
  }
  if (!doc.layers.length) doc.layers.push(new PixelLayer('Capa 1'));
  doc.activeLayerId = doc.layers[doc.layers.length - 1].id;
  return { doc, warnings: [...warnings] };
}

/** Guarda el documento como PSD (capas, opacidad, modos de fusión, visibilidad). */
export function exportPsd(doc: EditorDocument, composite: Uint8ClampedArray): Uint8Array {
  const psd: Psd = {
    width: doc.width,
    height: doc.height,
    imageData: { width: doc.width, height: doc.height, data: composite },
    children: doc.layers.map((L) => {
      const b = L.bounds();
      const base: PsdLayer = {
        name: L.name,
        opacity: L.opacity,
        blendMode: L.blend.replace(/-/g, ' ') as PsdLayer['blendMode'],
        hidden: !L.visible,
      };
      if (!b) return base;
      return {
        ...base,
        left: b.x,
        top: b.y,
        imageData: { width: b.w, height: b.h, data: L.readRegion(b.x - L.x, b.y - L.y, b.w, b.h) },
      };
    }),
  };
  return writePsdUint8Array(psd, { generateThumbnail: false, trimImageData: true, noBackground: true });
}

