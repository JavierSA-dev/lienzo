/** Colores en las peticiones del asistente: #hex, rgb(…) o nombres comunes (es/en). */
import type { RGBA } from '../../engine/types';

const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() && isFinite(Number(v)) ? Number(v) : d);
const hex = (h: string): RGBA => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]; };

/** Color a partir de #hex, "rgb(…)" o un nombre común (es/en). */
export function parseColor(v: unknown): RGBA | null {
  if (Array.isArray(v) && v.length >= 3) return [num(v[0]), num(v[1]), num(v[2]), v.length > 3 ? num(v[3], 255) : 255];
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (/^#?[0-9a-f]{6}$/.test(s)) return hex(s.startsWith('#') ? s : '#' + s);
  if (/^#?[0-9a-f]{3}$/.test(s)) { const h = s.replace('#', ''); return hex('#' + h.split('').map((c) => c + c).join('')); }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(',').map((x) => Number(x.trim())); return [p[0], p[1], p[2], p[3] != null ? Math.round(p[3] * 255) : 255]; }
  const named: Record<string, string> = {
    blanco: '#ffffff', white: '#ffffff', negro: '#000000', black: '#000000', rojo: '#e53935', red: '#e53935', verde: '#43a047', green: '#43a047',
    azul: '#1e88e5', blue: '#1e88e5', amarillo: '#fdd835', yellow: '#fdd835', naranja: '#fb8c00', orange: '#fb8c00', morado: '#8e24aa', purple: '#8e24aa',
    violeta: '#7e57c2', violet: '#7e57c2', rosa: '#ec407a', pink: '#ec407a', gris: '#9e9e9e', gray: '#9e9e9e', grey: '#9e9e9e', cian: '#00acc1', cyan: '#00acc1',
    marrón: '#6d4c41', marron: '#6d4c41', brown: '#6d4c41', dorado: '#d4af37', gold: '#d4af37', plata: '#c0c0c0', silver: '#c0c0c0',
  };
  return named[s] ? hex(named[s]) : null;
}


const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** RGB 0..255 → HSL 0..1. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, c = mx - mn;
  if (!c) return [0, 0, l];
  const s = c / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return [h / 6, s, l];
}

/**
 * Ajustes que llevan el color medio de una zona (st) al color pedido conservando el sombreado:
 * Tono/Saturación (las zonas casi grises, como un sombrero negro, se colorean) y, si hay que
 * aclarar bastante, una exposición previa (aclarar con Tono/Saturación lava el color hacia el blanco).
 */
export function recolorParams(st: { h: number; s: number; l: number; chroma: number }, [th, ts, tl]: [number, number, number]) {
  const dl = tl - st.l;
  const exposure = dl > 0.08 && ts >= 0.08 ? Math.round(clamp(2.2 * Math.log2(tl / Math.max(0.04, st.l)) * 0.85, 0, 4) * 100) / 100 : 0;
  const light = (k: number) => {
    if (exposure) return 0;
    const z = dl > 0 ? dl / Math.max(0.05, 1 - st.l) : dl / Math.max(0.05, st.l);
    return Math.round(clamp(z * k * 100, -100, 100));
  };
  let hueSat;
  if (ts < 0.08) hueSat = { hue: 0, saturation: -100, lightness: light(0.7), colorize: false }; // a gris, blanco o negro
  else if (st.s < 0.12 || st.chroma < 0.06) hueSat = { hue: Math.round(th * 360), saturation: Math.round(clamp((ts - 0.5) * 200, -100, 100)), lightness: light(0.55), colorize: true };
  else {
    let dh = (th - st.h) * 360;
    dh = ((dh + 540) % 360) - 180;
    hueSat = { hue: Math.round(dh), saturation: Math.round(clamp((ts / Math.max(0.05, st.s) - 1) * 100, -100, 100)), lightness: light(0.5), colorize: false };
  }
  return { ...hueSat, exposure };
}
