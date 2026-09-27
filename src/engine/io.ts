import { EditorDocument } from './document';
import { layerFromPixels } from './ops';

export interface ImportResult { doc: EditorDocument; warnings: string[] }

/** Decodifica PNG/JPEG/WebP/GIF/BMP/AVIF con el decodificador nativo del navegador. */
export async function importRaster(name: string, buffer: ArrayBuffer, type: string): Promise<ImportResult> {
  const bmp = await createImageBitmap(new Blob([buffer], { type }), { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  const doc = new EditorDocument(name, img.width, img.height);
  const L = layerFromPixels('Fondo', img.data, img.width, img.height);
  doc.layers.push(L);
  doc.activeLayerId = L.id;
  return { doc, warnings: [] };
}

export async function encodeRaster(data: Uint8ClampedArray, w: number, h: number, type: string, quality: number): Promise<Blob> {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return c.convertToBlob({ type, quality });
}
