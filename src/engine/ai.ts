/**
 * IA local: quitar fondo con U²-Net (u2netp, licencia Apache-2.0) en ONNX Runtime Web.
 * Corre en el propio navegador (WebAssembly con hilos): gratis, sin subir la imagen.
 */
import type * as OrtNS from 'onnxruntime-web';

type Ort = typeof OrtNS;
let ortMod: Ort | null = null;
let session: OrtNS.InferenceSession | null = null;

const SIZE = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

async function getSession(base: string) {
  if (!ortMod) {
    ortMod = (await import('onnxruntime-web/wasm')) as unknown as Ort;
    const cores = (globalThis.navigator?.hardwareConcurrency as number | undefined) ?? 4;
    ortMod.env.wasm.numThreads = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(4, cores) : 1;
  }
  if (!session) {
    session = await ortMod.InferenceSession.create(`${base}models/u2netp.onnx`, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  }
  return { ort: ortMod, session };
}

/** Devuelve una máscara w×h (0..255): 255 = sujeto, 0 = fondo. */
export async function subjectMask(rgba: Uint8ClampedArray, w: number, h: number, base: string): Promise<Uint8Array> {
  const { ort, session: s } = await getSession(base);
  // Reduce a 320×320 con el escalador nativo.
  const src = new OffscreenCanvas(w, h);
  src.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  const small = new OffscreenCanvas(SIZE, SIZE);
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, SIZE, SIZE);
  sctx.drawImage(src, 0, 0, SIZE, SIZE);
  const px = sctx.getImageData(0, 0, SIZE, SIZE).data;
  const input = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    for (let c = 0; c < 3; c++) input[c * SIZE * SIZE + i] = (px[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  }
  const feeds = { [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) };
  const out = await s.run(feeds);
  const pred = out[s.outputNames[0]].data as Float32Array;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < pred.length; i++) { mn = Math.min(mn, pred[i]); mx = Math.max(mx, pred[i]); }
  const g = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = ((pred[i] - mn) / Math.max(1e-6, mx - mn)) * 255;
    g[i * 4] = g[i * 4 + 1] = g[i * 4 + 2] = v;
    g[i * 4 + 3] = 255;
  }
  // Vuelve al tamaño original con interpolación bilineal.
  const m = new OffscreenCanvas(SIZE, SIZE);
  m.getContext('2d')!.putImageData(new ImageData(g, SIZE, SIZE), 0, 0);
  const big = new OffscreenCanvas(w, h);
  const bctx = big.getContext('2d', { willReadFrequently: true })!;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(m, 0, 0, w, h);
  const full = bctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // Contraste suave para bordes limpios sin perder pelo fino.
    const v = full[i * 4] / 255;
    mask[i] = Math.round(Math.min(1, Math.max(0, (v - 0.15) / 0.7)) * 255);
  }
  return mask;
}
