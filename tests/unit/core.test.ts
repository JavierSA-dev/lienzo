import { describe, it, expect } from 'vitest';
import { EditorDocument, PixelLayer, tileKey } from '../../src/engine/document';
import { History, TilePatch, FnEntry } from '../../src/engine/history';
import { BrushStroke } from '../../src/engine/brush';
import { resample } from '../../src/engine/resample';
import { TILE, type BrushSettings } from '../../src/engine/types';

const brush: BrushSettings = { size: 20, hardness: 1, opacity: 1, flow: 1, spacing: 0.1, pressureSize: false, pressureOpacity: false };
const full = { x: 0, y: 0, w: 1000, h: 1000 };

function paint(L: PixelLayer, settings: Partial<BrushSettings> = {}, color: [number, number, number, number] = [255, 0, 0, 255]) {
  const s = new BrushStroke(L, { ...brush, ...settings }, color, false, full);
  s.addPoint(50, 50, 1);
  s.addPoint(150, 50, 1);
  return s.finish()!;
}

describe('capas y tiles', () => {
  it('las capas son dispersas: sólo existen tiles con contenido', () => {
    const L = new PixelLayer('a');
    paint(L);
    expect(L.tiles.size).toBe(1);
    expect(L.pixel(100, 50)[0]).toBe(255);
    expect(L.pixel(600, 600)).toEqual([0, 0, 0, 0]);
  });

  it('writeRegion/readRegion son inversas y cruzan bordes de tile', () => {
    const L = new PixelLayer('a');
    const w = 300, h = 10;
    const data = new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 251));
    L.writeRegion(data, w, h, 200, 250);
    expect(L.readRegion(200, 250, w, h)).toEqual(data);
    expect(L.tiles.size).toBe(4); // cruza x=256 e y=256
  });

  it('rellenar con transparente elimina los tiles', () => {
    const L = new PixelLayer('a');
    EditorDocument.fillLayer(L, { x: 0, y: 0, w: 600, h: 300 }, [1, 2, 3, 255]);
    expect(L.tiles.size).toBe(6);
    EditorDocument.fillLayer(L, { x: 0, y: 0, w: 768, h: 512 }, [0, 0, 0, 0]);
    expect(L.tiles.size).toBe(0);
  });
});

describe('pincel', () => {
  it('la opacidad del trazo es un tope aunque se repase la misma zona', () => {
    const L = new PixelLayer('a');
    const s = new BrushStroke(L, { ...brush, opacity: 0.5, flow: 0.3 }, [0, 0, 0, 255], false, full);
    for (let i = 0; i < 20; i++) { s.addPoint(40, 40, 1); s.addPoint(60, 40, 1); }
    s.finish();
    const a = L.pixel(50, 40)[3];
    expect(a).toBeGreaterThan(120);
    expect(a).toBeLessThanOrEqual(128);
  });

  it('el borrador reduce el alfa y se puede deshacer', () => {
    const doc = new EditorDocument('d', 500, 500);
    const L = new PixelLayer('a');
    doc.layers.push(L);
    EditorDocument.fillLayer(L, { x: 0, y: 0, w: 500, h: 500 }, [10, 20, 30, 255]);
    const s = new BrushStroke(L, brush, [0, 0, 0, 255], true, full);
    s.addPoint(100, 100, 1);
    const patch = s.finish()!;
    expect(L.pixel(100, 100)[3]).toBe(0);
    patch.undo(doc);
    expect(L.pixel(100, 100)).toEqual([10, 20, 30, 255]);
    patch.redo(doc);
    expect(L.pixel(100, 100)[3]).toBe(0);
  });

  it('respeta la selección como zona de recorte', () => {
    const L = new PixelLayer('a');
    const s = new BrushStroke(L, { ...brush, size: 100 }, [0, 0, 0, 255], false, { x: 0, y: 0, w: 50, h: 1000 });
    s.addPoint(50, 50, 1);
    s.finish();
    expect(L.pixel(40, 50)[3]).toBe(255);
    expect(L.pixel(60, 50)[3]).toBe(0);
  });
});

describe('historial', () => {
  it('deshacer/rehacer por deltas de tiles', () => {
    const doc = new EditorDocument('d', 500, 500);
    const L = new PixelLayer('a');
    doc.layers.push(L);
    const h = new History();
    h.push(paint(L));
    h.push(paint(L, {}, [0, 255, 0, 255]));
    expect(L.pixel(100, 50)[1]).toBe(255);
    h.undo(doc);
    expect(L.pixel(100, 50)).toEqual([255, 0, 0, 255]);
    h.undo(doc);
    expect(L.pixel(100, 50)[3]).toBe(0);
    h.jump(doc, 2);
    expect(L.pixel(100, 50)[1]).toBe(255);
  });

  it('un paso nuevo descarta los pasos de rehacer', () => {
    const doc = new EditorDocument('d', 10, 10);
    const h = new History();
    let v = 0;
    const e = (n: number) => new FnEntry(`e${n}`, () => { v = n - 1; }, () => { v = n; });
    h.push(e(1)); h.push(e(2));
    h.undo(doc);
    h.push(e(3));
    expect(h.entries.map((x) => x.label)).toEqual(['e1', 'e3']);
    expect(h.canRedo()).toBe(false);
  });

  it('respeta el límite de pasos', () => {
    const h = new History();
    h.maxSteps = 3;
    for (let i = 0; i < 10; i++) h.push(new FnEntry(`e${i}`, () => {}, () => {}));
    expect(h.entries.length).toBe(3);
    expect(h.index).toBe(3);
  });
});

describe('duplicar con copia en escritura', () => {
  it('pintar el original no altera la copia', () => {
    const A = new PixelLayer('a');
    EditorDocument.fillLayer(A, { x: 0, y: 0, w: 256, h: 256 }, [9, 9, 9, 255]);
    const B = A.clone('b');
    expect(B.tiles.get(tileKey(0, 0))).toBe(A.tiles.get(tileKey(0, 0))); // compartido
    paint(A);
    expect(B.pixel(100, 50)).toEqual([9, 9, 9, 255]);
    expect(A.pixel(100, 50)).toEqual([255, 0, 0, 255]);
  });

  it('sigue siendo seguro cuando el historial devuelve un tile compartido', () => {
    const doc = new EditorDocument('d', 256, 256);
    const A = new PixelLayer('a');
    doc.layers.push(A);
    const h = new History();
    h.push(paint(A));                    // A pintada
    const B = A.clone('b');              // B comparte los tiles de A
    doc.layers.push(B);
    h.push(new FnEntry('dup', (d) => { d.layers.pop(); }, (d) => { d.layers.push(B); }));
    h.undo(doc);                         // quita B
    h.undo(doc);                         // deshace la pintura (el tile compartido pasa al historial)
    h.redo(doc);                         // lo devuelve a A
    h.redo(doc);                         // B vuelve, compartiendo otra vez
    paint(A, {}, [0, 0, 255, 255]);      // pintar A no debe tocar B
    expect(B.pixel(100, 50)).toEqual([255, 0, 0, 255]);
    expect(A.pixel(100, 50)).toEqual([0, 0, 255, 255]);
  });
});

describe('remuestreo', () => {
  it('un color uniforme sigue uniforme al reducir y ampliar', () => {
    const w = 64, h = 48;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < src.length; i += 4) src.set([200, 100, 50, 255], i);
    for (const [dw, dh] of [[32, 24], [100, 75], [7, 5]]) {
      const out = resample(src, w, h, dw, dh);
      for (let i = 0; i < out.length; i += 4) expect([...out.subarray(i, i + 4)]).toEqual([200, 100, 50, 255]);
    }
  });

  it('no oscurece bordes transparentes (trabaja premultiplicado)', () => {
    const w = 8, h = 1;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let x = 0; x < 4; x++) src.set([255, 255, 255, 255], x * 4); // mitad blanca opaca, mitad transparente negra
    const out = resample(src, w, h, 4, 1);
    // El píxel del borde es semitransparente pero sigue siendo blanco.
    expect(out[4 * 2 + 3]).toBeGreaterThan(0);
    expect(out[4 * 2]).toBeGreaterThanOrEqual(250);
  });

  it('las dimensiones de salida son las pedidas', () => {
    const out = resample(new Uint8ClampedArray(TILE * 4 * 4), TILE, 4, 100, 3);
    expect(out.length).toBe(100 * 3 * 4);
  });
});

describe('TilePatch', () => {
  it('capture sólo guarda la primera versión de cada tile', () => {
    const L = new PixelLayer('a');
    EditorDocument.fillLayer(L, { x: 0, y: 0, w: 10, h: 10 }, [1, 1, 1, 255]);
    const p = new TilePatch('x', L);
    p.capture(L, tileKey(0, 0));
    EditorDocument.fillLayer(L, { x: 0, y: 0, w: 10, h: 10 }, [2, 2, 2, 255]);
    p.capture(L, tileKey(0, 0));
    expect(p.saved.get(tileKey(0, 0))![0]).toBe(1);
  });
});
