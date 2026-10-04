/**
 * Archivos RAW de cámara (CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF…) con LibRaw en WebAssembly
 * (en su propio worker). Se revela con el balance de blancos de la cámara a sRGB de 8 bits y después
 * se abre el diálogo Revelado, como hace Photoshop.
 */
export const RAW_EXT = /\.(cr2|cr3|crw|nef|nrw|arw|srf|sr2|dng|raf|orf|rw2|pef|srw|x3f|3fr|iiq|erf|kdc|mef|mos|mrw|raw|rwl)$/i;
export const RAW_ACCEPT = '.cr2,.cr3,.crw,.nef,.nrw,.arw,.srf,.sr2,.dng,.raf,.orf,.rw2,.pef,.srw,.x3f,.3fr,.iiq,.erf,.kdc,.mef,.mos,.mrw,.raw,.rwl';

export async function decodeRaw(buffer: ArrayBuffer, halfSize = false): Promise<{ w: number; h: number; rgba: Uint8ClampedArray; meta: Record<string, unknown> }> {
  const { default: LibRaw } = await import('libraw-wasm');
  const raw = new LibRaw();
  try {
    await raw.open(new Uint8Array(buffer), { useCameraWb: true, outputBps: 8, outputColor: 1, userQual: 3, halfSize, highlight: 2 } as never);
    const meta = (await raw.metadata()) as Record<string, unknown>;
    const img = (await raw.imageData()) as unknown as { width: number; height: number; colors?: number; bits?: number; data: Uint8Array };
    const w = img.width, h = img.height, c = img.colors ?? 3;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++, j += c) { rgba[i * 4] = img.data[j]; rgba[i * 4 + 1] = img.data[j + 1]; rgba[i * 4 + 2] = img.data[j + 2]; rgba[i * 4 + 3] = 255; }
    return { w, h, rgba, meta };
  } finally {
    (raw as unknown as { dispose?: () => void }).dispose?.();
  }
}
