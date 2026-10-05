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

