/**
 * Modos de color: CMYK (modelo de impresión aproximado, sin perfil ICC) y escala de grises.
 * El modelo simula tintas de cuatricromía sobre papel estucado; con él se calcula, para cada RGB,
 * la mezcla CMYK que más se le parece (con generación de negro media y límite de tinta del 300 %),
 * y el RGB con el que se verá impreso. Todo se precalcula en tablas 3D (33³) e interpola.
 */

/**
 * Absorción de cada tinta por canal (R, G, B), ajustada para que las tintas sólidas sobre el papel
 * den los colores típicos de cuatricromía estucada: cian ≈ (0,160,227), magenta ≈ (230,0,126),
 * amarillo ≈ (255,237,0) y negro ≈ (35,31,32). El blanco del papel se toma como blanco (intento relativo).
 */
const PAPER = [1, 1, 1];
const INK = {
  c: [0.995, 0.649, 0.241],
  m: [0.209, 0.995, 0.791],
  y: [0.0, 0.153, 0.995],
  k: [0.983, 0.986, 0.985],
};

/** RGB (0..1, sRGB) que resulta de imprimir c, m, y, k (0..1). */
export function printModel(c: number, m: number, y: number, k: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    // Luz reflejada (lineal), producto de transmitancias; luego a sRGB.
    const lin = PAPER[i] * (1 - INK.c[i] * c) * (1 - INK.m[i] * m) * (1 - INK.y[i] * y) * (1 - INK.k[i] * k);
    out[i] = lin <= 0.0031308 ? lin * 12.92 : 1.055 * lin ** (1 / 2.4) - 0.055;
  }
  return out;
}

const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** CMYK que mejor reproduce un RGB (Gauss-Newton sobre CMY con K por generación de negro). */
export function solveCmyk(r: number, g: number, b: number, gcr = 0.6, inkLimit = 3): [number, number, number, number] {
  // Inicio: separación ingenua.
  let c = 1 - r, m = 1 - g, y = 1 - b;
  const k = Math.max(0, Math.min(c, m, y) - (1 - gcr) * 0.35) * gcr / Math.max(0.01, gcr);
  c = Math.max(0, c - k); m = Math.max(0, m - k); y = Math.max(0, y - k);
  const target = [toLin(r), toLin(g), toLin(b)];
  const lin = (cc: number, mm: number, yy: number) => {
    const o = [0, 0, 0];
    for (let i = 0; i < 3; i++) o[i] = PAPER[i] * (1 - INK.c[i] * cc) * (1 - INK.m[i] * mm) * (1 - INK.y[i] * yy) * (1 - INK.k[i] * k);
    return o;
  };
  for (let it = 0; it < 14; it++) {
    const f = lin(c, m, y), e = [f[0] - target[0], f[1] - target[1], f[2] - target[2]];
    if (Math.abs(e[0]) + Math.abs(e[1]) + Math.abs(e[2]) < 1e-5) break;
    // Jacobiano numérico 3×3.
    const J: number[][] = [];
    const h = 1e-3;
    for (const [dc, dm, dy] of [[h, 0, 0], [0, h, 0], [0, 0, h]]) { const f2 = lin(c + dc, m + dm, y + dy); J.push([(f2[0] - f[0]) / h, (f2[1] - f[1]) / h, (f2[2] - f[2]) / h]); }
    // Resolver (JᵀJ + λI) d = -Jᵀ e
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { for (let q = 0; q < 3; q++) A[i][j] += J[i][q] * J[j][q]; if (i === j) A[i][j] += 1e-4; }
    for (let i = 0; i < 3; i++) for (let q = 0; q < 3; q++) v[i] -= J[i][q] * e[q];
    const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    if (Math.abs(det) < 1e-12) break;
    const solve = (col: number) => { const M = A.map((row) => [...row]); for (let i = 0; i < 3; i++) M[i][col] = v[i]; return (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / det; };
    c = Math.min(1, Math.max(0, c + solve(0))); m = Math.min(1, Math.max(0, m + solve(1))); y = Math.min(1, Math.max(0, y + solve(2)));
    const total = c + m + y + k;
    if (total > inkLimit) { const s = (inkLimit - k) / Math.max(1e-6, c + m + y); c *= s; m *= s; y *= s; }
  }
  return [c, m, y, k];
}

const N = 33;
let LUTS: { proof: Uint8Array; cmyk: Uint8Array } | null = null;

/** Tablas 33³: RGB → RGB impreso (prueba) y RGB → CMYK. */
export function cmykLuts() {
  if (LUTS) return LUTS;
  const proof = new Uint8Array(N * N * N * 3), cmyk = new Uint8Array(N * N * N * 4);
  for (let bi = 0; bi < N; bi++) for (let gi = 0; gi < N; gi++) for (let ri = 0; ri < N; ri++) {
    const i = (bi * N + gi) * N + ri;
    const q = solveCmyk(ri / (N - 1), gi / (N - 1), bi / (N - 1));
    const p = printModel(q[0], q[1], q[2], q[3]);
    for (let k = 0; k < 3; k++) proof[i * 3 + k] = Math.round(Math.max(0, Math.min(1, p[k])) * 255);
    for (let k = 0; k < 4; k++) cmyk[i * 4 + k] = Math.round(q[k] * 255);
  }
  return (LUTS = { proof, cmyk });
}

/** Interpolación trilineal en una tabla 33³ de `ch` canales. */
function lookup(lut: Uint8Array, ch: number, r: number, g: number, b: number, out: number[]) {
  const s = (N - 1) / 255;
  const fr = r * s, fg = g * s, fb = b * s;
  const r0 = Math.min(N - 2, Math.floor(fr)), g0 = Math.min(N - 2, Math.floor(fg)), b0 = Math.min(N - 2, Math.floor(fb));
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  for (let k = 0; k < ch; k++) {
    const at = (x: number, y: number, z: number) => lut[(((b0 + z) * N + (g0 + y)) * N + (r0 + x)) * ch + k];
    const c00 = at(0, 0, 0) * (1 - dr) + at(1, 0, 0) * dr, c10 = at(0, 1, 0) * (1 - dr) + at(1, 1, 0) * dr;
    const c01 = at(0, 0, 1) * (1 - dr) + at(1, 0, 1) * dr, c11 = at(0, 1, 1) * (1 - dr) + at(1, 1, 1) * dr;
    out[k] = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
  }
}

/** Píxeles RGBA → cómo se verían impresos (en el sitio). */
export function proofPixels(px: Uint8ClampedArray) {
  const { proof } = cmykLuts(), o = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3]) continue;
    lookup(proof, 3, px[i], px[i + 1], px[i + 2], o);
    px[i] = o[0]; px[i + 1] = o[1]; px[i + 2] = o[2];
  }
}

/** RGBA → CMYK (4 bytes por píxel, 0 = sin tinta), sobre papel blanco donde hay transparencia. */
export function toCmyk(px: Uint8ClampedArray): Uint8Array {
  const { cmyk } = cmykLuts(), o = [0, 0, 0, 0], out = new Uint8Array((px.length / 4) * 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 4) {
    const a = px[i + 3] / 255;
    const r = px[i] * a + 255 * (1 - a), g = px[i + 1] * a + 255 * (1 - a), b = px[i + 2] * a + 255 * (1 - a);
    lookup(cmyk, 4, r, g, b, o);
    out[j] = o[0]; out[j + 1] = o[1]; out[j + 2] = o[2]; out[j + 3] = o[3];
  }
  return out;
}

/** Color concreto → su versión imprimible (selector de color en modo CMYK). */
export function proofColor(r: number, g: number, b: number): [number, number, number] {
  const o = [0, 0, 0];
  lookup(cmykLuts().proof, 3, r, g, b, o);
  return [Math.round(o[0]), Math.round(o[1]), Math.round(o[2])];
}

/** Porcentajes CMYK de un color (para mostrarlos en el selector). */
export function cmykOf(r: number, g: number, b: number): [number, number, number, number] {
  const o = [0, 0, 0, 0];
  lookup(cmykLuts().cmyk, 4, r, g, b, o);
  return [Math.round((o[0] / 255) * 100), Math.round((o[1] / 255) * 100), Math.round((o[2] / 255) * 100), Math.round((o[3] / 255) * 100)];
}
