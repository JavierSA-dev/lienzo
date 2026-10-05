import { describe, it, expect } from 'vitest';
import { planLocal, autoEnhance } from '../../src/app/assistant/local';
import { parseColor } from '../../src/app/assistant/color';

const tools = (t: string) => planLocal(t, null)?.map((s) => s.tool) ?? null;

describe('asistente local', () => {
  it('entiende órdenes sueltas en español e inglés', () => {
    expect(tools('quita el fondo')).toEqual(['remove_background']);
    expect(tools('Remove the background')).toEqual(['remove_background']);
    expect(planLocal('ponla en blanco y negro', null)![0].args).toEqual({ type: 'blackWhite' });
    expect(planLocal('recorta a 16:9', null)![0].args).toEqual({ ratio: '16:9' });
    expect(planLocal('crop square', null)![0].args).toEqual({ ratio: '1:1' });
    expect(planLocal('gira a la izquierda', null)![0].args).toEqual({ degrees: -90 });
    expect(planLocal('redimensiona al 50%', null)![0].args).toEqual({ percent: 50 });
    expect(planLocal('resize to 1080x1080', null)![0].args).toEqual({ width: 1080, height: 1080 });
    expect(planLocal('exporta en jpg', null)![0].args).toMatchObject({ format: 'jpeg' });
    expect(planLocal('desenfoca 12 px', null)![0].args).toEqual({ name: 'gaussianBlur', radius: 12 });
  });
  it('varias órdenes en una frase', () => {
    expect(tools('sube el contraste, hazla más cálida y luego recorta a 4:5')).toEqual(['develop', 'develop', 'crop']);
    expect(tools('quita el fondo y añade el texto "Oferta, hoy" arriba en blanco')).toEqual(['remove_background', 'add_text']);
    const t = planLocal('quita el fondo y añade el texto "Oferta, hoy" arriba en blanco', null)![1].args;
    expect(t).toMatchObject({ text: 'Oferta, hoy', position: 'top', color: 'blanco' });
  });
  it('revelado con cantidades y sentido', () => {
    expect(planLocal('baja el brillo', null)![0].args.exposure).toBeLessThan(0);
    expect(planLocal('más contraste', null)![0].args.contrast).toBeGreaterThan(0);
    expect(planLocal('menos saturación', null)![0].args.saturation).toBeLessThan(0);
    expect(planLocal('make it cooler', null)![0].args.temp).toBeLessThan(0);
  });
  it('mejora automática según la imagen', () => {
    const dark = autoEnhance({ meanLuma: 50, p2: 2, p50: 45, p98: 150, meanSaturation: 20, meanRGB: [60, 50, 40] });
    expect(dark.exposure).toBeGreaterThan(0.3);
    expect(dark.contrast).toBeGreaterThan(0);
    expect(dark.vibrance).toBeGreaterThan(0);
    expect(planLocal('mejora la foto', null)![0].tool).toBe('develop');
  });
  it('no inventa: devuelve null si no entiende', () => {
    expect(planLocal('cuéntame un chiste', null)).toBeNull();
  });
  it('colores', () => {
    expect(parseColor('#ff0000')).toEqual([255, 0, 0, 255]);
    expect(parseColor('azul')).toEqual([30, 136, 229, 255]);
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 255]);
  });
});
