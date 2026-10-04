// Consulta de colores: LUT 3D (.cube de Resolve/Premiere/Photoshop) y un juego de "looks" propios.
// La tabla se guarda en la capa de ajuste como base64 (8 bits por canal, rojo el índice más rápido).

export interface Lut3D { size: number; data: Uint8Array }

const MAX = 33;

/** Lee un archivo .cube (3D, o 1D convertido a 3D). */
export function parseCube(text: string): Lut3D {
  let size3 = 0, size1 = 0;
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) continue;
    if (up.startsWith('LUT_3D_SIZE')) { size3 = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('LUT_1D_SIZE')) { size1 = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('DOMAIN_MIN')) { dmin = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { dmax = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (/^[A-Z_]/.test(up)) continue;
    const p = line.split(/\s+/).map(Number);
    if (p.length >= 3 && p.every((v) => isFinite(v))) vals.push(p[0], p[1], p[2]);
  }
  const norm = (v: number, c: number) => (v - dmin[c]) / Math.max(1e-6, dmax[c] - dmin[c]);
  if (size3 >= 2 && vals.length >= size3 ** 3 * 3) {
    const src = new Float32Array(vals.slice(0, size3 ** 3 * 3).map((v, i) => norm(v, i % 3)));
    return resample(src, size3, Math.min(MAX, size3));
  }
  if (size1 >= 2 && vals.length >= size1 * 3) {
    const n = 17, out = new Uint8Array(n ** 3 * 3);
    const at = (c: number, t: number) => {
      const x = t * (size1 - 1), i = Math.floor(x), f = x - i, j = Math.min(size1 - 1, i + 1);
      return norm(vals[i * 3 + c] * (1 - f) + vals[j * 3 + c] * f, c);
    };
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const o = ((b * n + g) * n + r) * 3;
      out[o] = q(at(0, r / (n - 1))); out[o + 1] = q(at(1, g / (n - 1))); out[o + 2] = q(at(2, b / (n - 1)));
    }
    return { size: n, data: out };
  }
  throw new Error('El archivo .cube no tiene una tabla válida');
}

const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Remuestrea (trilineal) una tabla de `n` a `m` puntos por lado. */
function resample(src: Float32Array, n: number, m: number): Lut3D {
  const out = new Uint8Array(m ** 3 * 3);
  const s = (r: number, g: number, b: number, c: number) => src[((b * n + g) * n + r) * 3 + c];
  for (let b = 0; b < m; b++) for (let g = 0; g < m; g++) for (let r = 0; r < m; r++) {
    const fr = (r / (m - 1)) * (n - 1), fg = (g / (m - 1)) * (n - 1), fb = (b / (m - 1)) * (n - 1);
    const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
    const r1 = Math.min(n - 1, r0 + 1), g1 = Math.min(n - 1, g0 + 1), b1 = Math.min(n - 1, b0 + 1);
    const tr = fr - r0, tg = fg - g0, tb = fb - b0;
    for (let c = 0; c < 3; c++) {
      const c00 = s(r0, g0, b0, c) * (1 - tr) + s(r1, g0, b0, c) * tr, c10 = s(r0, g1, b0, c) * (1 - tr) + s(r1, g1, b0, c) * tr;
      const c01 = s(r0, g0, b1, c) * (1 - tr) + s(r1, g0, b1, c) * tr, c11 = s(r0, g1, b1, c) * (1 - tr) + s(r1, g1, b1, c) * tr;
      out[((b * m + g) * m + r) * 3 + c] = q((c00 * (1 - tg) + c10 * tg) * (1 - tb) + (c01 * (1 - tg) + c11 * tg) * tb);
    }
  }
  return { size: m, data: out };
}

/** Tabla a partir de una función de color (0..1). */
export function lutFrom(fn: (r: number, g: number, b: number) => [number, number, number], n = 17): Lut3D {
  const out = new Uint8Array(n ** 3 * 3);
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const [R, G, B] = fn(r / (n - 1), g / (n - 1), b / (n - 1));
    const o = ((b * n + g) * n + r) * 3;
    out[o] = q(R); out[o + 1] = q(G); out[o + 2] = q(B);
  }
  return { size: n, data: out };
}

/** Texto .cube (para guardar el PSD o exportar la tabla). */
export function toCube(l: Lut3D, title = 'Lienzo'): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${l.size}`];
  for (let i = 0; i < l.data.length; i += 3) lines.push(`${(l.data[i] / 255).toFixed(6)} ${(l.data[i + 1] / 255).toFixed(6)} ${(l.data[i + 2] / 255).toFixed(6)}`);
  return lines.join('\n') + '\n';
}

export function encodeLut(l: Lut3D): string {
  let s = '';
  for (let i = 0; i < l.data.length; i += 8192) s += String.fromCharCode(...l.data.subarray(i, i + 8192));
  return btoa(s);
}
export function decodeLut(size: number, b64: string): Lut3D {
  const s = atob(b64), data = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) data[i] = s.charCodeAt(i);
  return { size, data };
}

// ------------------------------------------------------------------ looks incluidos

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const scurve = (v: number, k: number) => clamp(0.5 + (v - 0.5) * (1 + k) - k * 4 * (v - 0.5) ** 3);
const sat = (r: number, g: number, b: number, s: number): [number, number, number] => { const l = lum(r, g, b); return [clamp(mix(l, r, s)), clamp(mix(l, g, s)), clamp(mix(l, b, s))]; };

export const LUT_PRESETS: [string, (r: number, g: number, b: number) => [number, number, number]][] = [
  ['Cálido', (r, g, b) => [clamp(r * 1.06 + 0.02), clamp(g * 1.01), clamp(b * 0.9)]],
  ['Frío', (r, g, b) => [clamp(r * 0.92), clamp(g * 1.0), clamp(b * 1.08 + 0.02)]],
  ['Cine (turquesa y naranja)', (r, g, b) => {
    const l = lum(r, g, b), t = l;
    const [R, G, B] = sat(r, g, b, 1.15);
    return [clamp(scurve(R + (t - 0.5) * 0.12, 0.25)), clamp(scurve(G + 0.02, 0.25)), clamp(scurve(B - (t - 0.5) * 0.18, 0.25))];
  }],
  ['Película desvaída', (r, g, b) => { const f = (v: number) => clamp(0.08 + v * 0.84); const [R, G, B] = sat(r, g, b, 0.8); return [f(R), f(G), clamp(0.1 + B * 0.82)]; }],
  ['Blanco y negro contrastado', (r, g, b) => { const l = scurve(lum(r, g, b), 0.6); return [l, l, l]; }],
  ['Sepia', (r, g, b) => { const l = lum(r, g, b); return [clamp(l * 1.07 + 0.08), clamp(l * 0.95 + 0.03), clamp(l * 0.75)]; }],
  ['Noche americana', (r, g, b) => { const l = lum(r, g, b) * 0.55; return [clamp(l * 0.7), clamp(l * 0.9), clamp(l * 1.35 + 0.03)]; }],
  ['Proceso cruzado', (r, g, b) => [clamp(scurve(r, 0.5)), clamp(scurve(g, 0.3) * 1.05), clamp(0.12 + b * 0.7)]],
  ['Blanqueo omitido', (r, g, b) => { const l = lum(r, g, b); const [R, G, B] = sat(r, g, b, 0.45); return [scurve(mix(R, l, 0.2), 0.5), scurve(mix(G, l, 0.2), 0.5), scurve(mix(B, l, 0.2), 0.5)]; }],
  ['Vintage', (r, g, b) => { const [R, G, B] = sat(r, g, b, 0.75); return [clamp(0.06 + R * 0.9 + 0.04), clamp(0.04 + G * 0.88), clamp(0.12 + B * 0.7)]; }],
  ['Intenso', (r, g, b) => { const [R, G, B] = sat(r, g, b, 1.35); return [scurve(R, 0.3), scurve(G, 0.3), scurve(B, 0.3)]; }],
];

export function presetLut(name: string): Lut3D | null {
  const p = LUT_PRESETS.find(([n]) => n === name);
  return p ? lutFrom(p[1], 17) : null;
}
