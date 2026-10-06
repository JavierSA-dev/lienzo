import { describe, it, expect } from 'vitest';
import { planLocal, autoEnhance } from '../../src/app/assistant/local';
import { recolorParams, rgbToHsl } from '../../src/app/assistant/color';
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

describe('peticiones sobre una selección', () => {
  const sel = (t: string) => planLocal(t, null, true);
  it('eliminar lo seleccionado → relleno según el contenido', () => {
    for (const t of ['Elimínalo', 'elimina el sombrero', 'bórralo', 'quítalo', 'remove it', 'quita el texto']) expect(sel(t)?.[0].tool, t).toBe('content_aware_fill');
  });
  it('cambiar el color → recolor con el color pedido', () => {
    expect(sel('ponlo rojo')).toEqual([{ tool: 'recolor', args: { color: 'rojo' } }]);
    expect(sel('cámbiale el color a azul')?.[0]).toEqual({ tool: 'recolor', args: { color: 'azul' } });
    expect(sel('hazlo #00ff00')?.[0]).toEqual({ tool: 'recolor', args: { color: '#00ff00' } });
  });
  it('ajustes con capa de ajuste (se limitan a la selección con su máscara)', () => {
    expect(sel('hazlo más claro')?.[0]).toMatchObject({ tool: 'adjustment_layer', args: { type: 'brightness' } });
    expect(sel('más oscuro')?.[0].args).toMatchObject({ params: { brightness: -45 } });
    expect(sel('quítale el color')?.[0]).toMatchObject({ tool: 'adjustment_layer', args: { type: 'hueSat', params: { saturation: -100 } } });
    expect(sel('desenfócalo')?.[0]).toMatchObject({ tool: 'filter', args: { name: 'gaussianBlur' } });
    expect(sel('pixélalo')?.[0]).toMatchObject({ tool: 'filter', args: { name: 'mosaic' } });
  });
  it('sustituir por otra cosa va al modelo', () => {
    expect(sel('cámbialo por una estrella dorada')).toBeNull();
    expect(sel('conviértelo en un gato')).toBeNull();
    expect(sel('cambia el color por rojo')?.[0].tool).toBe('recolor');
  });
  it('sin selección no se confunde', () => {
    expect(planLocal('quita el fondo', null, true)?.[0].tool).toBe('remove_background');
    expect(planLocal('quita la selección', null, true)?.[0].tool).toBe('select');
    expect(planLocal('elimínalo', null, false)).toBeNull();
  });
});

describe('recolorParams', () => {
  it('rota el tono del color medio al pedido', () => {
    const p = recolorParams({ h: 0, s: 0.7, l: 0.45, chroma: 0.5 }, rgbToHsl(30, 136, 229)); // rojo → azul
    expect(p.colorize).toBe(false);
    expect(Math.abs(p.hue - (rgbToHsl(30, 136, 229)[0] * 360 - 360))).toBeLessThan(2);
  });
  it('colorea lo que es casi gris (sombrero negro → rojo)', () => {
    const p = recolorParams({ h: 0, s: 0.03, l: 0.12, chroma: 0.01 }, rgbToHsl(229, 57, 53));
    expect(p.colorize).toBe(true);
    expect(p.hue).toBeLessThan(5);
    expect(p.exposure).toBeGreaterThan(1); // se aclara con exposición, no lavando el color
    expect(p.lightness).toBe(0);
  });
  it('a gris: quita la saturación', () => {
    expect(recolorParams({ h: 0.3, s: 0.6, l: 0.5, chroma: 0.4 }, rgbToHsl(158, 158, 158)).saturation).toBe(-100);
  });
});

describe('cuadrícula de coordenadas para el modelo', () => {
  it('paso redondo con 6-12 líneas', async () => {
    const { gridStep } = await import('../../src/app/assistant/grid');
    expect(gridStep(1200)).toBe(100);
    expect(gridStep(4000)).toBe(500);
    expect(gridStep(300)).toBe(25);
  });
});
