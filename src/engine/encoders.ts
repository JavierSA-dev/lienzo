/**
 * Codificadores de archivo propios: TIFF (RGB, CMYK o gris, con Deflate), PDF (imagen a página,
 * RGB/CMYK/gris con FlateDecode) y GIF (paleta de 256 colores, tramado y animación).
 * Todos trabajan con RGBA de 8 bits no premultiplicado.
 */
import { GIFEncoder, quantize, nearestColorIndex } from 'gifenc';
import { toCmyk } from './color';

export type ColorOut = 'rgb' | 'cmyk' | 'gray';

/** Comprime con zlib (Deflate) usando el CompressionStream nativo. */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  void w.write(data as Uint8Array<ArrayBuffer>);
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  void w.write(data as Uint8Array<ArrayBuffer>);
  void w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

const luma = (r: number, g: number, b: number) => Math.round(0.299 * r + 0.587 * g + 0.114 * b);

/**
 * Separa los canales de salida.
 * `alpha`: conserva la transparencia como canal extra (RGB y gris); en CMYK se compone sobre papel blanco.
 */
export function planes(px: Uint8ClampedArray, mode: ColorOut, alpha: boolean): { data: Uint8Array; spp: number } {
  const n = px.length / 4;
  if (mode === 'cmyk') return { data: toCmyk(px), spp: 4 };
  if (mode === 'gray') {
    const spp = alpha ? 2 : 1, out = new Uint8Array(n * spp);
    for (let i = 0; i < n; i++) {
      const a = px[i * 4 + 3];
      let g = luma(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
      if (!alpha) g = Math.round((g * a + 255 * (255 - a)) / 255);
      out[i * spp] = g;
      if (alpha) out[i * spp + 1] = a;
    }
    return { data: out, spp };
  }
  const spp = alpha ? 4 : 3, out = new Uint8Array(n * spp);
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3];
    for (let k = 0; k < 3; k++) out[i * spp + k] = alpha ? px[i * 4 + k] : Math.round((px[i * 4 + k] * a + 255 * (255 - a)) / 255);
    if (alpha) out[i * spp + 3] = a;
  }
  return { data: out, spp };
}

/** ¿Tiene algún píxel no opaco? */
export function hasAlpha(px: Uint8ClampedArray) {
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
  return false;
}

// ------------------------------------------------------------------ TIFF

export interface TiffOptions { mode: ColorOut; alpha?: boolean; dpi?: number; compress?: boolean }

/** TIFF baseline (little-endian), una tira por bloque de filas, Deflate con predictor horizontal. */
export async function encodeTiff(px: Uint8ClampedArray, w: number, h: number, o: TiffOptions): Promise<Blob> {
  const alpha = o.mode !== 'cmyk' && !!o.alpha;
  const { data, spp } = planes(px, o.mode, alpha);
  const compress = o.compress !== false;
  const rowBytes = w * spp;
  const rowsPerStrip = Math.max(1, Math.min(h, Math.floor(262144 / Math.max(1, rowBytes))));
  const strips: Uint8Array[] = [];
  for (let y = 0; y < h; y += rowsPerStrip) {
    const r = Math.min(rowsPerStrip, h - y);
    const s = data.slice(y * rowBytes, (y + r) * rowBytes);
    if (compress) {
      // Predictor 2: diferencias horizontales por muestra.
      for (let j = 0; j < r; j++) {
        const o0 = j * rowBytes;
        for (let x = rowBytes - 1; x >= spp; x--) s[o0 + x] = (s[o0 + x] - s[o0 + x - spp]) & 255;
      }
      strips.push(await deflate(s));
    } else strips.push(s);
  }
  const photometric = o.mode === 'cmyk' ? 5 : o.mode === 'gray' ? 1 : 2;
  const dpi = Math.round((o.dpi ?? 72) * 1000);
  type Tag = [number, number, number[] | string]; // id, tipo (3 SHORT, 4 LONG, 5 RATIONAL, 2 ASCII), valores
  const tags: Tag[] = [
    [256, 4, [w]], [257, 4, [h]],
    [258, 3, Array(spp).fill(8)],
    [259, 3, [compress ? 8 : 1]],
    [262, 3, [photometric]],
    [273, 4, strips.map(() => 0)], // offsets: se rellenan después
    [277, 3, [spp]],
    [278, 4, [rowsPerStrip]],
    [279, 4, strips.map((s) => s.length)],
    [282, 5, [dpi, 1000]], [283, 5, [dpi, 1000]],
    [284, 3, [1]],
    [296, 3, [2]],
    [305, 2, 'Lienzo'],
  ];
  if (compress) tags.push([317, 3, [2]]);
  if (alpha) tags.push([338, 3, [2]]); // alfa no asociado
  if (o.mode === 'cmyk') tags.push([332, 3, [1]]); // InkSet = CMYK
  tags.sort((a, b) => a[0] - b[0]);
  // Tamaño de cada valor y de los datos externos.
  const size = (t: Tag) => (t[1] === 2 ? (t[2] as string).length + 1 : (t[2] as number[]).length * (t[1] === 3 ? 2 : t[1] === 4 ? 4 : 4));
  const ifdOff = 8, ifdSize = 2 + tags.length * 12 + 4;
  let extra = ifdOff + ifdSize;
  const extOff = new Map<number, number>();
  for (const t of tags) { const s = size(t); if (s > 4) { extOff.set(t[0], extra); extra += s + (s & 1); } }
  let dataOff = extra;
  const stripOff = strips.map((s) => { const o2 = dataOff; dataOff += s.length + (s.length & 1); return o2; });
  (tags.find((t) => t[0] === 273)![2] as number[]).splice(0, strips.length, ...stripOff);
  const buf = new Uint8Array(dataOff), dv = new DataView(buf.buffer);
  buf[0] = 0x49; buf[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true);
  dv.setUint16(ifdOff, tags.length, true);
  const put = (off: number, t: Tag) => {
    if (t[1] === 2) { const s = t[2] as string; for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); buf[off + s.length] = 0; return; }
    const v = t[2] as number[];
    v.forEach((x, i) => (t[1] === 3 ? dv.setUint16(off + i * 2, x, true) : dv.setUint32(off + i * 4, x, true)));
  };
  tags.forEach((t, i) => {
    const e = ifdOff + 2 + i * 12, n = t[1] === 2 ? (t[2] as string).length + 1 : t[1] === 5 ? (t[2] as number[]).length / 2 : (t[2] as number[]).length;
    dv.setUint16(e, t[0], true); dv.setUint16(e + 2, t[1], true); dv.setUint32(e + 4, n, true);
    const ext = extOff.get(t[0]);
    if (ext != null) { dv.setUint32(e + 8, ext, true); put(ext, t); } else put(e + 8, t);
  });
  dv.setUint32(ifdOff + 2 + tags.length * 12, 0, true);
  strips.forEach((s, i) => buf.set(s, stripOff[i]));
  return new Blob([buf], { type: 'image/tiff' });
}

/** Lee un TIFF de los que escribe Lienzo (y la mayoría de TIFF de 8 bits sin comprimir/Deflate/LZW no). Para pruebas. */
export async function decodeTiff(buf: ArrayBuffer): Promise<{ w: number; h: number; spp: number; photometric: number; data: Uint8Array }> {
  const dv = new DataView(buf), le = dv.getUint16(0) === 0x4949;
  const u16 = (o: number) => dv.getUint16(o, le), u32 = (o: number) => dv.getUint32(o, le);
  const ifd = u32(4), n = u16(ifd), tag = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, id = u16(e), type = u16(e + 2), cnt = u32(e + 4);
    const sz = type === 3 ? 2 : 4, off = cnt * sz > 4 ? u32(e + 8) : e + 8;
    const v: number[] = [];
    if (type === 3 || type === 4) for (let k = 0; k < cnt; k++) v.push(type === 3 ? u16(off + k * 2) : u32(off + k * 4));
    tag.set(id, v);
  }
  const w = tag.get(256)![0], h = tag.get(257)![0], spp = tag.get(277)?.[0] ?? 1, comp = tag.get(259)?.[0] ?? 1, pred = tag.get(317)?.[0] ?? 1;
  const offs = tag.get(273)!, lens = tag.get(279)!, rps = tag.get(278)?.[0] ?? h;
  const out = new Uint8Array(w * h * spp), rowBytes = w * spp;
  for (let s = 0; s < offs.length; s++) {
    let chunk: Uint8Array = new Uint8Array(buf, offs[s], lens[s]);
    if (comp === 8 || comp === 32946) chunk = await inflate(chunk);
    if (pred === 2) for (let j = 0; j * rowBytes < chunk.length; j++) for (let x = spp; x < rowBytes; x++) chunk[j * rowBytes + x] = (chunk[j * rowBytes + x] + chunk[j * rowBytes + x - spp]) & 255;
    out.set(chunk.subarray(0, Math.min(chunk.length, out.length - s * rps * rowBytes)), s * rps * rowBytes);
  }
  return { w, h, spp, photometric: tag.get(262)?.[0] ?? 2, data: out };
}

// ------------------------------------------------------------------ PDF

export interface PdfOptions { mode: ColorOut; dpi?: number; title?: string; jpeg?: Blob | null }

/**
 * PDF de una página del tamaño del documento (a su resolución) con la imagen.
 * RGB conserva la transparencia como SMask; CMYK y gris se componen sobre blanco.
 * Si se da `jpeg` (RGB opaco), se incrusta tal cual con DCTDecode (archivos mucho más pequeños).
 */
export async function encodePdf(px: Uint8ClampedArray, w: number, h: number, o: PdfOptions): Promise<Blob> {
  const dpi = o.dpi ?? 72;
  const pw = (w * 72) / dpi, ph = (h * 72) / dpi;
  const alpha = o.mode === 'rgb' && hasAlpha(px);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const emit = (b: Uint8Array | string) => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); pos += u.length; };
  const obj = (n: number, dict: string, stream?: Uint8Array) => {
    offsets[n] = pos;
    if (stream) { emit(`${n} 0 obj\n${dict.replace(/>>$/, ` /Length ${stream.length} >>`)}\nstream\n`); emit(stream); emit('\nendstream\nendobj\n'); }
    else emit(`${n} 0 obj\n${dict}\nendobj\n`);
  };
  emit('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'.replace(/[\u0080-ÿ]/g, (c) => c)); // cabecera con bytes binarios (aprox.)
  const cs = o.mode === 'cmyk' ? '/DeviceCMYK' : o.mode === 'gray' ? '/DeviceGray' : '/DeviceRGB';
  let image: Uint8Array, filter = '/FlateDecode';
  if (o.jpeg && o.mode === 'rgb' && !alpha) { image = new Uint8Array(await o.jpeg.arrayBuffer()); filter = '/DCTDecode'; }
  else image = await deflate(planes(px, o.mode, false).data);
  const title = (o.title ?? 'Lienzo').replace(/[()\\]/g, '\\$&');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(3)} ${ph.toFixed(3)}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
  const content = enc.encode(`q ${pw.toFixed(3)} 0 0 ${ph.toFixed(3)} 0 0 cm /Im0 Do Q`);
  obj(4, '<< >>', content);
  obj(5, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter ${filter}${alpha ? ' /SMask 7 0 R' : ''} >>`, image);
  obj(6, `<< /Title (${title}) /Producer (Lienzo) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}) >>`);
  let count = 7;
  if (alpha) {
    const a = new Uint8Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3];
    obj(7, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>`, await deflate(a));
    count = 8;
  }
  const xref = pos;
  let x = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  emit(x);
  emit(`trailer\n<< /Size ${count} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as Uint8Array<ArrayBuffer>[], { type: 'application/pdf' });
}

// ------------------------------------------------------------------ GIF

export interface GifFrame { px: Uint8ClampedArray; delay: number }
export interface GifOptions { colors?: number; dither?: boolean; loop?: number; transparent?: boolean }

/** Paleta común a todos los fotogramas (muestreo repartido entre ellos). */
function sharedPalette(frames: GifFrame[], colors: number, transparent: boolean) {
  const total = frames.reduce((s, f) => s + f.px.length / 4, 0);
  const step = Math.max(1, Math.floor(total / 600000));
  const n = Math.ceil(total / step);
  const sample = new Uint8ClampedArray(n * 4);
  let k = 0, t = 0;
  for (const f of frames) for (let i = 0; i < f.px.length; i += 4, t++) {
    if (t % step) continue;
    if (k >= n) break;
    sample.set(f.px.subarray(i, i + 4), k * 4);
    k++;
  }
  const format = transparent ? 'rgba4444' : 'rgb565';
  const palette = quantize(sample.subarray(0, k * 4), transparent ? colors - 1 : colors, { format, oneBitAlpha: true }) as number[][];
  // Color transparente al final (índice fijo).
  const tIndex = transparent ? palette.length : -1;
  if (transparent) palette.push([0, 0, 0, 0]);
  return { palette: palette.map((c) => [c[0], c[1], c[2]]), tIndex };
}

/** Indexa con difusión de error (Floyd-Steinberg) o al color más próximo. */
function indexFrame(px: Uint8ClampedArray, w: number, h: number, palette: number[][], tIndex: number, dither: boolean) {
  const out = new Uint8Array(w * h);
  const opaque = tIndex >= 0 ? palette.slice(0, tIndex) : palette;
  const cache = new Map<number, number>();
  const near = (r: number, g: number, b: number) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let i = cache.get(key);
    if (i == null) { i = nearestColorIndex(opaque, [r, g, b]) as number; cache.set(key, i); }
    return i;
  };
  if (!dither) {
    for (let i = 0; i < w * h; i++) out[i] = tIndex >= 0 && px[i * 4 + 3] < 128 ? tIndex : near(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    return out;
  }
  const err = new Float32Array((w + 2) * 2 * 3);
  for (let y = 0; y < h; y++) {
    const cur = (y & 1) * (w + 2) * 3, nxt = ((y + 1) & 1) * (w + 2) * 3;
    err.fill(0, nxt, nxt + (w + 2) * 3);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (tIndex >= 0 && px[i * 4 + 3] < 128) { out[i] = tIndex; continue; }
      const e = cur + (x + 1) * 3;
      const r = Math.max(0, Math.min(255, px[i * 4] + err[e])), g = Math.max(0, Math.min(255, px[i * 4 + 1] + err[e + 1])), b = Math.max(0, Math.min(255, px[i * 4 + 2] + err[e + 2]));
      const q = near(r | 0, g | 0, b | 0), c = opaque[q];
      out[i] = q;
      const er = r - c[0], eg = g - c[1], eb = b - c[2];
      const add = (o: number, f: number) => { err[o] += er * f; err[o + 1] += eg * f; err[o + 2] += eb * f; };
      add(e + 3, 7 / 16); add(nxt + x * 3, 3 / 16); add(nxt + (x + 1) * 3, 5 / 16); add(nxt + (x + 2) * 3, 1 / 16);
    }
  }
  return out;
}

/** GIF (uno o varios fotogramas). `delay` en milisegundos; `loop` 0 = infinito. */
export function encodeGif(frames: GifFrame[], w: number, h: number, o: GifOptions = {}): Blob {
  const colors = Math.max(2, Math.min(256, o.colors ?? 256));
  const transparent = o.transparent ?? frames.some((f) => hasAlpha(f.px));
  const { palette, tIndex } = sharedPalette(frames, colors, transparent);
  const gif = GIFEncoder();
  frames.forEach((f, i) => {
    const index = indexFrame(f.px, w, h, palette, tIndex, o.dither !== false);
    gif.writeFrame(index, w, h, {
      palette: i === 0 ? palette : undefined,
      delay: Math.max(20, f.delay),
      repeat: frames.length > 1 ? (o.loop ?? 0) : -1,
      transparent: tIndex >= 0,
      transparentIndex: Math.max(0, tIndex),
      dispose: tIndex >= 0 ? 2 : -1,
    });
  });
  gif.finish();
  return new Blob([gif.bytes() as Uint8Array<ArrayBuffer>], { type: 'image/gif' });
}
