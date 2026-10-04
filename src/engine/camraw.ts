/**
 * Filtro de Camera Raw: revelado de fotos con los controles de Lightroom/ACR (balance de blancos,
 * exposición, tono, presencia, mezclador HSL, curva paramétrica, gradación de color, detalle,
 * efectos). Trabaja por bandas (con margen) para repartirse entre los hilos del pool.
 */

export interface CameraRaw {
  temp: number; tint: number;                     // -100..100
  exposure: number;                               // -5..5 EV
  contrast: number; highlights: number; shadows: number; whites: number; blacks: number; // -100..100
  texture: number; clarity: number; dehaze: number;       // -100..100
  vibrance: number; saturation: number;                    // -100..100
  /** Mezclador: [rojos, naranjas, amarillos, verdes, aguamarinas, azules, morados, magentas] × (tono, sat, lum) -100..100. */
  hsl: number[];
  /** Curva paramétrica: sombras, oscuros, claros, iluminaciones (-100..100). */
  curve: [number, number, number, number];
  /** Gradación de color: sombras/medios/iluminaciones (tono 0..360, saturación 0..100), fusión y equilibrio. */
  grade: { sh: [number, number]; mid: [number, number]; hi: [number, number]; blending: number; balance: number };
  /** Detalle: enfoque (cantidad 0..150, radio 0.5..3, máscara 0..100) y reducción de ruido (0..100). */
  sharpen: number; sharpenRadius: number; sharpenMasking: number;
  noise: number; colorNoise: number;
  /** Efectos: viñeta (cantidad -100..100, punto medio 0..100, desvanecer 0..100, redondez -100..100) y grano. */
  vignette: number; vigMidpoint: number; vigFeather: number; vigRoundness: number;
  grain: number; grainSize: number;
  /** Marco (doc) para la viñeta y escala espacial (1 = tamaño real; < 1 en la vista previa). */
  frame?: { x: number; y: number; w: number; h: number };
  scale?: number;
  /** Radio local a tamaño real (si no, se deduce del marco). */
  radius?: number;
}

export const CAMERA_RAW_DEFAULTS: CameraRaw = {
  temp: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0,
  hsl: new Array(24).fill(0), curve: [0, 0, 0, 0],
  grade: { sh: [0, 0], mid: [0, 0], hi: [0, 0], blending: 50, balance: 0 },
  sharpen: 0, sharpenRadius: 1, sharpenMasking: 0, noise: 0, colorNoise: 0,
  vignette: 0, vigMidpoint: 50, vigFeather: 50, vigRoundness: 0, grain: 0, grainSize: 25,
};

/** Radio de los ajustes locales (sombras/iluminaciones, claridad, neblina) según el tamaño de la foto. */
export function localRadius(cr: CameraRaw): number {
  if (cr.radius) return cr.radius;
  const f = cr.frame;
  return Math.max(4, Math.min(48, Math.round(Math.min(f?.w ?? 1000, f?.h ?? 1000) * 0.02)));
}

/** Margen (filas/columnas) que necesita una banda. */
export function cameraRawApron(cr: CameraRaw): number {
  const s = cr.scale ?? 1;
  return Math.ceil(localRadius(cr) * s * 3 + (cr.sharpenRadius ?? 1) * s * 3 + 12);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const LIN = new Float32Array(256).map((_, i) => toLin(i / 255));

/** Desenfoque aproximadamente gaussiano (3 cajas) de un canal float. */
export function blurF(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return src.slice();
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  let a = src.slice(), b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    // Horizontal
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[o + x] = acc / (2 * r + 1);
        acc += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
    }
    // Vertical
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc / (2 * r + 1);
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  void b;
  return a;
}

/** Filtro guiado por sí mismo: suaviza conservando bordes (reducción de ruido de luminancia). */
function selfGuided(I: Float32Array, w: number, h: number, sigma: number, eps: number): Float32Array {
  const n = I.length;
  const mI = blurF(I, w, h, sigma);
  const II = new Float32Array(n);
  for (let i = 0; i < n; i++) II[i] = I[i] * I[i];
  const mII = blurF(II, w, h, sigma);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = mII[i] - mI[i] * mI[i]; a[i] = v / (v + eps); b[i] = mI[i] - a[i] * mI[i]; }
  const ma = blurF(a, w, h, sigma), mb = blurF(b, w, h, sigma);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

const HUE_CENTERS = [0, 30, 60, 120, 180, 240, 280, 320];

function hueWeights(h: number, out: Float32Array) {
  out.fill(0);
  for (let i = 0; i < 8; i++) {
    const c = HUE_CENTERS[i], prev = HUE_CENTERS[(i + 7) % 8], next = HUE_CENTERS[(i + 1) % 8];
    let d = h - c;
    if (d > 180) d -= 360; if (d < -180) d += 360;
    const span = d >= 0 ? ((next - c + 360) % 360) : ((c - prev + 360) % 360);
    const t = 1 - Math.abs(d) / span;
    if (t > 0) out[i] = t;
  }
}

function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}

/** Hash determinista (grano estable por coordenadas del documento). */
function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x: number, y: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0), b = hash(x0 + 1, y0), c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/**
 * Procesa una banda: `src` = w × rows (RGBA, con `top` filas de margen arriba), devuelve w × outRows.
 * `ox, oy` = coordenadas de documento del píxel (0,0) de src.
 */
export function cameraRawBand(src: Uint8ClampedArray, w: number, rows: number, top: number, outRows: number, ox: number, oy: number, cr: CameraRaw): Uint8ClampedArray {
  const n = w * rows, S = cr.scale ?? 1;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), A = new Float32Array(n);
  // 1) Balance de blancos y exposición en luz lineal.
  const t = cr.temp / 100, ti = cr.tint / 100, ev = 2 ** cr.exposure;
  const kr = (1 + 0.32 * t) * (1 + 0.08 * ti) * ev, kg = (1 - 0.18 * ti) * ev, kb = (1 - 0.32 * t) * (1 + 0.08 * ti) * ev;
  const nr = (kr + kg + kb) / 3 / ev; // conserva el brillo medio al cambiar la temperatura
  if (!cr.temp && !cr.tint && !cr.exposure) {
    // Sin balance ni exposición: lectura directa (mucho más rápida).
    for (let i = 0; i < n; i++) { const j = i * 4; R[i] = src[j] / 255; G[i] = src[j + 1] / 255; B[i] = src[j + 2] / 255; A[i] = src[j + 3]; }
  } else {
    // Tablas por canal: 256 entradas en vez de una potencia por píxel.
    const lut = (k: number) => Float32Array.from(LIN, (v) => clamp01(toSrgb(Math.min(1, (v * k) / nr))));
    const tr = lut(kr), tg = lut(kg), tb = lut(kb);
    for (let i = 0; i < n; i++) { const j = i * 4; R[i] = tr[src[j]]; G[i] = tg[src[j + 1]]; B[i] = tb[src[j + 2]]; A[i] = src[j + 3]; }
  }
  // 2) Reducción de ruido (luminancia con filtro guiado, color desenfocando la crominancia).
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
  if (cr.noise > 0 || cr.colorNoise > 0) {
    const Cb = new Float32Array(n), Cr = new Float32Array(n);
    for (let i = 0; i < n; i++) { Cb[i] = B[i] - Y[i]; Cr[i] = R[i] - Y[i]; }
    const Yn = cr.noise > 0 ? selfGuided(Y, w, rows, Math.max(0.6, (1 + 2.5 * cr.noise / 100) * S), (0.008 + (cr.noise / 100) * 0.1) ** 2) : Y;
    const cs = (cr.colorNoise / 100) * 4 * S;
    const Cbn = cs > 0.3 ? blurF(Cb, w, rows, cs) : Cb, Crn = cs > 0.3 ? blurF(Cr, w, rows, cs) : Cr;
    const k = cr.noise / 100;
    for (let i = 0; i < n; i++) {
      const y = Y[i] * (1 - k) + Yn[i] * k;
      const cb = Cbn[i], crr = Crn[i];
      const r = crr + y, b = cb + y, g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
      R[i] = clamp01(r); G[i] = clamp01(g); B[i] = clamp01(b); Y[i] = y;
    }
  }
  // 3) Bases locales.
  const lr = localRadius(cr) * S;
  const needLocal = cr.highlights || cr.shadows || cr.clarity || cr.dehaze;
  // Desenfoques normalizados por la opacidad: fuera de la capa (transparente) no oscurece el borde.
  let anyT = false;
  for (let i = 0; i < n; i++) if (A[i] < 255) { anyT = true; break; }
  const Aw = anyT ? Float32Array.from(A, (v) => v / 255) : null;
  const nblur = (v: Float32Array, sg: number) => {
    if (!Aw) return blurF(v, w, rows, sg);
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) p[i] = v[i] * Aw[i];
    const num = blurF(p, w, rows, sg), den = blurF(Aw, w, rows, sg);
    for (let i = 0; i < n; i++) num[i] = den[i] > 1e-4 ? num[i] / den[i] : v[i];
    return num;
  };
  const Lb = needLocal ? nblur(Y, lr) : Y;
  const Lt = cr.texture ? nblur(Y, Math.max(0.8, 2.5 * S)) : Y;
  const Ls = cr.sharpen ? nblur(Y, Math.max(0.4, cr.sharpenRadius * S)) : Y;
  let Dk: Float32Array | null = null;
  if (cr.dehaze) {
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = Math.min(R[i], G[i], B[i]);
    Dk = nblur(m, lr);
  }
  const out = new Uint8ClampedArray(w * outRows * 4);
  const hw = new Float32Array(8);
  const hs = cr.hsl, anyHsl = hs.some((v) => v !== 0);
  const curveOn = cr.curve.some((v) => v !== 0);
  const g = cr.grade, gradeOn = g.sh[1] || g.mid[1] || g.hi[1];
  const tintOf = (hue: number, sat: number): [number, number, number] => { const [r, gg, b] = hsv2rgb(hue, 1, 1); const m = (r + gg + b) / 3; return [(r - m) * sat / 100, (gg - m) * sat / 100, (b - m) * sat / 100]; };
  const tSh = tintOf(g.sh[0], g.sh[1]), tMid = tintOf(g.mid[0], g.mid[1]), tHi = tintOf(g.hi[0], g.hi[1]);
  const fr = cr.frame ?? { x: ox, y: oy, w, h: rows };
  const vcx = fr.x + fr.w / 2, vcy = fr.y + fr.h / 2;
  const round = cr.vigRoundness / 100;
  // Redondez: 0 = elipse del marco, 1 = círculo, -1 = más rectangular.
  const vrx = (fr.w / 2) * (1 - Math.max(0, round)) + (Math.min(fr.w, fr.h) / 2) * Math.max(0, round);
  const vry = (fr.h / 2) * (1 - Math.max(0, round)) + (Math.min(fr.w, fr.h) / 2) * Math.max(0, round);
  const vpow = 2 + Math.max(0, -round) * 6;
  const mid0 = 0.25 + (cr.vigMidpoint / 100) * 0.9, feather = 0.05 + (cr.vigFeather / 100) * 0.9;

  for (let yy = 0; yy < outRows; yy++) {
    const y = top + yy;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let r = R[i], gg = G[i], b = B[i];
      let L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      // Neblina (prior de canal oscuro, atmósfera blanca).
      if (Dk) {
        const k = cr.dehaze / 100;
        if (k > 0) {
          const tt = Math.max(0.15, 1 - 0.9 * k * Dk[i]);
          r = 1 - (1 - r) / tt; gg = 1 - (1 - gg) / tt; b = 1 - (1 - b) / tt;
          // Recupera el negro perdido y algo de color, como Photoshop.
          const lift = 0.9 * k * Dk[i];
          r = (r - lift) / (1 - lift); gg = (gg - lift) / (1 - lift); b = (b - lift) / (1 - lift);
        } else {
          const kk = -k * 0.6;
          r = r * (1 - kk) + 0.85 * kk; gg = gg * (1 - kk) + 0.87 * kk; b = b * (1 - kk) + 0.9 * kk;
        }
        L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      }
      // Tono sobre la luminancia (se escala el color para no desaturar).
      let L2 = L;
      if (cr.contrast) { const s = cr.contrast / 100; L2 += s * (L2 - 0.5) * (1 - Math.abs(2 * L2 - 1)) * 1.1; }
      if (cr.highlights || cr.shadows) {
        const base = Lb[i];
        if (cr.highlights) L2 += (cr.highlights / 100) * 0.35 * smooth(0.45, 1, base) * (cr.highlights < 0 ? L2 : 1 - L2) * (cr.highlights < 0 ? 1 : 0.8);
        if (cr.shadows) L2 += (cr.shadows / 100) * 0.4 * (1 - smooth(0, 0.55, base)) * (cr.shadows > 0 ? 1 - L2 : L2);
      }
      if (cr.whites) L2 += (cr.whites / 100) * 0.25 * L2 ** 3 * (cr.whites > 0 ? 1 : 1);
      if (cr.blacks) L2 += (cr.blacks / 100) * 0.2 * (1 - L2) ** 3;
      if (cr.texture) L2 += (cr.texture / 100) * 1.2 * (Y[i] - Lt[i]);
      if (cr.clarity) L2 += (cr.clarity / 100) * 0.7 * (Y[i] - Lb[i]) * (0.25 + 3 * L2 * (1 - L2));
      if (curveOn) {
        const c = cr.curve, xx = clamp01(L2);
        const bump = (cx: number) => Math.max(0, 1 - Math.abs(xx - cx) / 0.25);
        L2 += 0.12 * (c[0] / 100 * bump(0.125) + c[1] / 100 * bump(0.375) + c[2] / 100 * bump(0.625) + c[3] / 100 * bump(0.875));
      }
      if (cr.sharpen) {
        let m = 1;
        if (cr.sharpenMasking) { const e = Math.abs(Y[i] - Lb[i]); m = smooth((cr.sharpenMasking / 100) * 0.04, (cr.sharpenMasking / 100) * 0.04 + 0.03, e); }
        L2 += (cr.sharpen / 100) * 1.6 * (Y[i] - Ls[i]) * m;
      }
      L2 = clamp01(L2);
      if (L > 1e-4) { const k = L2 / L; r *= k; gg *= k; b *= k; }
      else { r += L2 - L; gg += L2 - L; b += L2 - L; }
      // Si una componente se sale, se comprime hacia la luminancia (sin cambiar el tono).
      const mx = Math.max(r, gg, b);
      if (mx > 1) { const k = (1 - L2) / Math.max(1e-6, mx - L2); r = L2 + (r - L2) * k; gg = L2 + (gg - L2) * k; b = L2 + (b - L2) * k; }
      // Intensidad y saturación.
      if (cr.vibrance || cr.saturation) {
        const Lc = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        const mxc = Math.max(r, gg, b), mnc = Math.min(r, gg, b), sat = mxc - mnc;
        // Intensidad protege los colores ya saturados y los tonos de piel.
        const skin = r > gg && gg > b ? 0.5 : 1;
        const f = 1 + cr.saturation / 100 + (cr.vibrance / 100) * (1 - sat) * skin;
        r = Lc + (r - Lc) * f; gg = Lc + (gg - Lc) * f; b = Lc + (b - Lc) * f;
      }
      // Mezclador HSL.
      if (anyHsl) {
        const mxc = Math.max(r, gg, b), mnc = Math.min(r, gg, b), d = mxc - mnc;
        if (d > 1e-4) {
          let h = mxc === r ? ((gg - b) / d) % 6 : mxc === gg ? (b - r) / d + 2 : (r - gg) / d + 4;
          h *= 60; if (h < 0) h += 360;
          hueWeights(h, hw);
          let dh = 0, ds = 0, dl = 0;
          for (let k = 0; k < 8; k++) if (hw[k]) { dh += hw[k] * hs[k * 3]; ds += hw[k] * hs[k * 3 + 1]; dl += hw[k] * hs[k * 3 + 2]; }
          const v = mxc, s = d / mxc;
          const nh = (h + dh * 0.3 + 360) % 360, ns = clamp01(s * (1 + ds / 100));
          let [nr2, ng2, nb2] = hsv2rgb(nh, ns, v);
          const lk = (dl / 100) * 0.35 * s;
          if (lk > 0) { nr2 += (1 - nr2) * lk; ng2 += (1 - ng2) * lk; nb2 += (1 - nb2) * lk; }
          else if (lk < 0) { nr2 *= 1 + lk; ng2 *= 1 + lk; nb2 *= 1 + lk; }
          r = nr2; gg = ng2; b = nb2;
        }
      }
      // Gradación de color.
      if (gradeOn) {
        const Lc = clamp01(0.2126 * r + 0.7152 * gg + 0.0722 * b);
        const bal = g.balance / 100, bl = 0.5 + (g.blending / 100) * 0.5;
        const ws = (1 - smooth(0, bl + bal * 0.3, Lc)) * 0.6, wh = smooth(1 - bl + bal * 0.3, 1, Lc) * 0.6, wm = Math.max(0, 1 - ws - wh) * 4 * Lc * (1 - Lc) * 0.6;
        r += tSh[0] * ws + tMid[0] * wm + tHi[0] * wh;
        gg += tSh[1] * ws + tMid[1] * wm + tHi[1] * wh;
        b += tSh[2] * ws + tMid[2] * wm + tHi[2] * wh;
      }
      // Viñeta y grano (coordenadas de documento).
      const X = ox + x + 0.5, Yd = oy + y + 0.5;
      if (cr.vignette) {
        const dx = Math.abs(X - vcx) / Math.max(1, vrx), dy = Math.abs(Yd - vcy) / Math.max(1, vry);
        const dd = (dx ** vpow + dy ** vpow) ** (1 / vpow);
        const wv = smooth(mid0 - feather / 2, mid0 + feather / 2, dd), k = (cr.vignette / 100) * wv;
        if (k < 0) { r *= 1 + k; gg *= 1 + k; b *= 1 + k; } else { r += (1 - r) * k; gg += (1 - gg) * k; b += (1 - b) * k; }
      }
      if (cr.grain) {
        const sz = Math.max(0.5, (cr.grainSize / 25) * 1.5 * S);
        const nz = (valueNoise(X / sz, Yd / sz) + valueNoise(X / sz + 71.3, Yd / sz + 19.7) * 0.5) / 1.5 - 0.5;
        const k = (cr.grain / 100) * 0.22 * nz;
        r += k; gg += k; b += k;
      }
      const o = (yy * w + x) * 4;
      out[o] = clamp01(r) * 255 + 0.5; out[o + 1] = clamp01(gg) * 255 + 0.5; out[o + 2] = clamp01(b) * 255 + 0.5; out[o + 3] = A[i];
    }
  }
  return out;
}
