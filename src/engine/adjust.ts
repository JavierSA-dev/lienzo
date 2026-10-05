import { sampleStops } from './ops';
import { SELECTIVE_RANGES, type AdjustmentParams, type AdjustmentType, type RGBA } from './types';
import { presetLut, encodeLut, decodeLut, type Lut3D } from './lut';

/** Parámetros por defecto de cada capa de ajuste (los mismos que Photoshop). */
export function defaultAdjustment(type: AdjustmentType, fg: RGBA = [0, 0, 0, 255], bg: RGBA = [255, 255, 255, 255]): AdjustmentParams {
  switch (type) {
    case 'brightness': return { type, brightness: 0, contrast: 0 };
    case 'levels': return { type, inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
    case 'curves': return { type, points: [[0, 0], [255, 255]] };
    case 'exposure': return { type, exposure: 0, offset: 0, gamma: 1 };
    case 'hueSat': return { type, hue: 0, saturation: 0, lightness: 0, colorize: false };
    case 'colorBalance': return { type, shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] };
    case 'blackWhite': return { type, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 };
    case 'invert': return { type };
    case 'threshold': return { type, level: 128 };
    case 'posterize': return { type, levels: 4 };
    case 'gradientMap': return { type, from: fg, to: bg };
    case 'vibrance': return { type, vibrance: 0, saturation: 0 };
    case 'solidColor': return { type, color: fg };
    case 'photoFilter': return { type, color: [236, 138, 0, 255], density: 25, preserveLuminosity: true };
    case 'selectiveColor': return { type, relative: true, ranges: Object.fromEntries(SELECTIVE_RANGES.map(([k]) => [k, [0, 0, 0, 0]])) as Record<string, [number, number, number, number]> } as AdjustmentParams;
    case 'channelMixer': return { type, red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], monochrome: false };
    case 'colorLookup': { const l = presetLut('Cine (turquesa y naranja)')!; return { type, name: 'Cine (turquesa y naranja)', size: l.size, data: encodeLut(l) }; }
  }
}

export const ADJUSTMENT_LABELS: Record<AdjustmentType, string> = {
  brightness: 'Brillo/Contraste', levels: 'Niveles', curves: 'Curvas', exposure: 'Exposición',
  vibrance: 'Intensidad', hueSat: 'Tono/Saturación', colorBalance: 'Equilibrio de color', blackWhite: 'Blanco y negro',
  invert: 'Invertir', posterize: 'Posterizar', threshold: 'Umbral', gradientMap: 'Mapa de degradado', solidColor: 'Color sólido',
  photoFilter: 'Filtro de fotografía', selectiveColor: 'Corrección selectiva', channelMixer: 'Mezclador de canales', colorLookup: 'Consulta de colores',
};

/** Filtros de fotografía predefinidos de Photoshop. */
export const PHOTO_FILTERS: [string, string][] = [
  ['Filtro de calentamiento (85)', '#ec8a00'], ['Filtro de calentamiento (LBA)', '#fa9600'], ['Filtro de calentamiento (81)', '#ebb113'],
  ['Filtro de enfriamiento (80)', '#006dff'], ['Filtro de enfriamiento (LBB)', '#005dff'], ['Filtro de enfriamiento (82)', '#00b5ff'],
  ['Rojo', '#ea1a1a'], ['Naranja', '#f38417'], ['Amarillo', '#f9e31c'], ['Verde', '#19c919'], ['Cian', '#1dcbea'],
  ['Azul', '#1d35ea'], ['Violeta', '#9b1dea'], ['Magenta', '#e318e3'], ['Sepia', '#ac7a33'],
  ['Subacuático', '#00c2b1'],
];

export interface AdjUniforms { kind: number; lut: Uint8Array | null; p0: number[]; p1: number[]; p2: number[]; sel?: number[]; lut3?: Lut3D }

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

function lutFrom(fn: (v: number) => number): Uint8Array {
  const l = new Uint8Array(256 * 4);
  for (let v = 0; v < 256; v++) {
    const o = clamp255(fn(v));
    l[v * 4] = l[v * 4 + 1] = l[v * 4 + 2] = o;
    l[v * 4 + 3] = 255;
  }
  return l;
}

/** Curva monótona (Fritsch-Carlson) que pasa por los puntos: como las Curvas de Photoshop. */
export function curveLut(points: [number, number][]): (v: number) => number {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  if (p.length < 2) return (v) => v;
  const n = p.length;
  const d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / Math.max(1e-6, p[i + 1][0] - p[i][0]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (v) => {
    if (v <= p[0][0]) return p[0][1];
    if (v >= p[n - 1][0]) return p[n - 1][1];
    let i = 0;
    while (v > p[i + 1][0]) i++;
    const h = p[i + 1][0] - p[i][0], t = (v - p[i][0]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}

export function adjustmentUniforms(a: AdjustmentParams): AdjUniforms {
  const z = [0, 0, 0, 0];
  switch (a.type) {
    case 'brightness': {
      const b = a.brightness / 150, c = a.contrast / 100;
      const k = c >= 0 ? 1 / Math.max(1e-3, 1 - c * 0.99) : 1 + c;
      return { kind: 0, lut: lutFrom((v) => {
        let x = v / 255;
        x = b >= 0 ? 1 - Math.pow(1 - x, 1 + b * 1.5) : Math.pow(x, 1 - b * 1.5);
        return ((x - 0.5) * k + 0.5) * 255;
      }), p0: z, p1: z, p2: z };
    }
    case 'levels':
      return { kind: 0, lut: lutFrom((v) => {
        const x = Math.min(1, Math.max(0, (v - a.inBlack) / Math.max(1, a.inWhite - a.inBlack)));
        return a.outBlack + Math.pow(x, 1 / Math.max(0.01, a.gamma)) * (a.outWhite - a.outBlack);
      }), p0: z, p1: z, p2: z };
    case 'curves':
      return { kind: 0, lut: lutFrom(curveLut(a.points)), p0: z, p1: z, p2: z };
    case 'exposure':
      return { kind: 0, lut: lutFrom((v) => {
        const lin = Math.pow(v / 255, 2.2) * Math.pow(2, a.exposure) + a.offset;
        return Math.pow(Math.max(0, lin), 1 / (2.2 * Math.max(0.01, a.gamma))) * 255;
      }), p0: z, p1: z, p2: z };
    case 'invert':
      return { kind: 0, lut: lutFrom((v) => 255 - v), p0: z, p1: z, p2: z };
    case 'posterize': {
      const n = Math.max(2, Math.round(a.levels));
      return { kind: 0, lut: lutFrom((v) => Math.round(Math.floor((v / 256) * n) * (255 / (n - 1)))), p0: z, p1: z, p2: z };
    }
    case 'threshold':
      return { kind: 7, lut: null, p0: [a.level / 255, 0, 0, 0], p1: z, p2: z };
    case 'gradientMap': {
      const l = new Uint8Array(256 * 4);
      for (let v = 0; v < 256; v++) {
        const t = v / 255;
        if (a.stops) { const c = sampleStops(a.stops, t); for (let k = 0; k < 3; k++) l[v * 4 + k] = clamp255(c[k]); }
        else for (let c = 0; c < 3; c++) l[v * 4 + c] = clamp255(a.from[c] + (a.to[c] - a.from[c]) * t);
        l[v * 4 + 3] = 255;
      }
      return { kind: 1, lut: l, p0: z, p1: z, p2: z };
    }
    case 'hueSat':
      return { kind: 2, lut: null, p0: [(((a.hue % 360) + 360) % 360) / 360, a.saturation / 100, a.lightness / 100, a.colorize ? 1 : 0], p1: z, p2: z };
    case 'blackWhite':
      return { kind: 3, lut: null, p0: [a.reds / 100, a.yellows / 100, a.greens / 100, a.cyans / 100], p1: [a.blues / 100, a.magentas / 100, 0, 0], p2: z };
    case 'colorBalance': {
      const f = (v: [number, number, number]) => [v[0] / 300, v[1] / 300, v[2] / 300, 0];
      return { kind: 4, lut: null, p0: f(a.shadows), p1: f(a.midtones), p2: f(a.highlights) };
    }
    case 'vibrance':
      return { kind: 5, lut: null, p0: [a.vibrance / 100, a.saturation / 100, 0, 0], p1: z, p2: z };
    case 'solidColor':
      return { kind: 6, lut: null, p0: [a.color[0] / 255, a.color[1] / 255, a.color[2] / 255, 1], p1: z, p2: z };
    case 'selectiveColor':
      return { kind: 8, lut: null, p0: [a.relative ? 1 : 0, 0, 0, 0], p1: z, p2: z, sel: SELECTIVE_RANGES.flatMap(([k]) => a.ranges[k].map((v) => v / 100)) };
    case 'photoFilter':
      return { kind: 9, lut: null, p0: [a.color[0] / 255, a.color[1] / 255, a.color[2] / 255, a.density / 100], p1: [a.preserveLuminosity ? 1 : 0, 0, 0, 0], p2: z };
    case 'colorLookup': {
      const l = decodeLut(a.size, a.data), n = l.size;
      return { kind: 11, lut: null, p0: [(n - 1) / n, 0.5 / n, 0, 0], p1: z, p2: z, lut3: l };
    }
    case 'channelMixer': {
      const m = a.monochrome ? [a.red, a.red, a.red] : [a.red, a.green, a.blue];
      return { kind: 10, lut: null, p0: m[0].map((v) => v / 100), p1: m[1].map((v) => v / 100), p2: m[2].map((v) => v / 100) };
    }
  }
}

/** Aplica el ajuste en CPU a un color (para pruebas y exportaciones sin GPU). */
export function applyAdjustmentCpu(a: AdjustmentParams, rgb: [number, number, number]): [number, number, number] {
  const u = adjustmentUniforms(a);
  if (u.kind === 0 && u.lut) return [u.lut[rgb[0] * 4], u.lut[rgb[1] * 4 + 1], u.lut[rgb[2] * 4 + 2]];
  return rgb;
}
