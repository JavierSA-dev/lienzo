import { describe, it, expect } from 'vitest';
import { solveCmyk, printModel, cmykOf, proofColor } from '../../src/engine/color';
import { encodeTiff, decodeTiff, encodePdf, encodeGif, planes } from '../../src/engine/encoders';

const img = (w: number, h: number, f: (x: number, y: number) => number[]) => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(f(x, y), (y * w + x) * 4);
  return px;
};

describe('color CMYK', () => {
  it('los colores dentro de gama vuelven igual tras imprimirse', () => {
    for (const c of [[128, 128, 128], [70, 110, 150], [200, 30, 30], [255, 255, 255]]) {
      const q = solveCmyk(c[0] / 255, c[1] / 255, c[2] / 255);
      const p = printModel(...q).map((v) => Math.round(v * 255));
      p.forEach((v, i) => expect(Math.abs(v - c[i])).toBeLessThanOrEqual(2));
      expect(q[0] + q[1] + q[2] + q[3]).toBeLessThanOrEqual(3.0001);
    }
  });
  it('el blanco no lleva tinta y el rojo es magenta + amarillo', () => {
    expect(cmykOf(255, 255, 255)).toEqual([0, 0, 0, 0]);
    const r = cmykOf(255, 0, 0);
    expect(r[0]).toBeLessThan(5); expect(r[1]).toBeGreaterThan(90); expect(r[2]).toBeGreaterThan(90);
  });
  it('el verde puro queda fuera de gama', () => {
    const p = proofColor(0, 255, 0);
    expect(p[1]).toBeLessThan(200);
  });
});

describe('codificadores', () => {
  const px = img(37, 23, (x, y) => [x * 6, y * 10, 128, x < 5 ? 0 : 255]);
  it('TIFF RGB con alfa: ida y vuelta exacta', async () => {
    const b = await encodeTiff(px, 37, 23, { mode: 'rgb', alpha: true });
    const t = await decodeTiff(await b.arrayBuffer());
    expect([t.w, t.h, t.spp, t.photometric]).toEqual([37, 23, 4, 2]);
    expect(Array.from(t.data)).toEqual(Array.from(px));
  });
  it('TIFF CMYK y gris', async () => {
    const c = await decodeTiff(await (await encodeTiff(px, 37, 23, { mode: 'cmyk' })).arrayBuffer());
    expect([c.spp, c.photometric]).toEqual([4, 5]);
    const g = await decodeTiff(await (await encodeTiff(px, 37, 23, { mode: 'gray' })).arrayBuffer());
    expect([g.spp, g.photometric]).toEqual([1, 1]);
    expect(Array.from(g.data)).toEqual(Array.from(planes(px, 'gray', false).data));
  });
  it('PDF con xref coherente', async () => {
    const b = new Uint8Array(await (await encodePdf(px, 37, 23, { mode: 'cmyk', dpi: 300 })).arrayBuffer());
    const s = new TextDecoder('latin1').decode(b);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    const start = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(start, start + 4)).toBe('xref');
    for (const m of s.matchAll(/^(\d{10}) 00000 n $/gm)) expect(/^\d+ 0 obj/.test(s.slice(Number(m[1]), Number(m[1]) + 12))).toBe(true);
    expect(s).toContain('/DeviceCMYK');
  });
  it('GIF animado con transparencia', () => {
    const b = encodeGif([{ px, delay: 100 }, { px: img(37, 23, () => [255, 0, 0, 255]), delay: 200 }], 37, 23, { colors: 16 });
    expect(b.type).toBe('image/gif');
    expect(b.size).toBeGreaterThan(100);
  });
});
