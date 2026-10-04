/**
 * Filtro > Galería de desenfoques: Desenfoque de campo (chinchetas con su desenfoque), Desenfoque de
 * iris (elipse enfocada que se difumina hacia fuera) y Cambio de inclinación (banda enfocada), con
 * bokeh de luz. Radio variable por píxel: pila de desenfoques e interpolación entre niveles.
 */

export interface BlurGallery {
  kind: 'field' | 'iris' | 'tilt';
  /** Desenfoque máximo (px a tamaño real). */
  blur: number;
  /** Desenfoque de campo: chinchetas (doc) con su desenfoque (px). */
  pins: { x: number; y: number; blur: number }[];
  /** Iris: centro, radios, giro (rad) y fracción enfocada (0..1). */
  iris: { cx: number; cy: number; rx: number; ry: number; angle: number; focus: number };
  /** Cambio de inclinación: centro, ángulo (rad), media anchura enfocada y transición (px). */
  tilt: { cx: number; cy: number; angle: number; focus: number; transition: number };
  /** Bokeh de luz (0..100) y umbral de luces (0..255). */
  bokeh: number; bokehThreshold: number;
  scale?: number;
}

export function blurGalleryApron(g: BlurGallery): number {
  return Math.ceil(Math.max(1, g.blur, ...g.pins.map((p) => p.blur)) * (g.scale ?? 1) * 1.2) + 4;
}

/** Desenfoque (px a tamaño real) que corresponde a un punto del documento. */
export function blurAt(g: BlurGallery, X: number, Y: number): number {
  if (g.kind === 'iris') {
    const { cx, cy, rx, ry, angle, focus } = g.iris;
    const c = Math.cos(-angle), s = Math.sin(-angle);
    const dx = X - cx, dy = Y - cy;
    const u = (dx * c - dy * s) / Math.max(1, rx), v = (dx * s + dy * c) / Math.max(1, ry);
    const r = Math.hypot(u, v);
    const t = Math.max(0, Math.min(1, (r - focus) / Math.max(0.01, 1 - focus)));
    return g.blur * t * t * (3 - 2 * t);
  }
  if (g.kind === 'tilt') {
    const { cx, cy, angle, focus, transition } = g.tilt;
    // Distancia a la línea central (perpendicular a la dirección de la banda).
    const d = Math.abs(-(X - cx) * Math.sin(angle) + (Y - cy) * Math.cos(angle));
    const t = Math.max(0, Math.min(1, (d - focus) / Math.max(1, transition)));
    return g.blur * t * t * (3 - 2 * t);
  }
  // Campo: interpolación por distancia inversa entre chinchetas.
  if (!g.pins.length) return g.blur;
  let ws = 0, acc = 0;
  for (const p of g.pins) {
    const d2 = (X - p.x) ** 2 + (Y - p.y) ** 2;
    if (d2 < 1) return p.blur;
    const w = 1 / (d2 * d2);
    ws += w; acc += w * p.blur;
  }
  return acc / ws;
}

function boxBlurRGBA(f: Float32Array, w: number, h: number, r: number, tmp: Float32Array) {
  // Tres pasadas de caja horizontales y verticales (≈ gaussiana) sobre RGBA premultiplicado.
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let x = -r; x <= r; x++) acc += f[(y * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
        for (let x = 0; x < w; x++) {
          tmp[(y * w + x) * 4 + c] = acc / (2 * r + 1);
          acc += f[(y * w + Math.min(w - 1, x + r + 1)) * 4 + c] - f[(y * w + Math.max(0, x - r)) * 4 + c];
        }
      }
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * 4 + c];
        for (let y = 0; y < h; y++) {
          f[(y * w + x) * 4 + c] = acc / (2 * r + 1);
          acc += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 4 + c] - tmp[(Math.max(0, y - r) * w + x) * 4 + c];
        }
      }
    }
  }
}

/** Una banda: src w × rows con `top` filas de margen; ox/oy = doc del píxel (0,0) de src. */
export function blurGalleryBand(src: Uint8ClampedArray, w: number, rows: number, top: number, outRows: number, ox: number, oy: number, g: BlurGallery): Uint8ClampedArray {
  const S = g.scale ?? 1, n = w * rows;
  // Premultiplicado y con bokeh: las luces se amplifican antes de desenfocar (se ven como discos brillantes).
  const base = new Float32Array(n * 4);
  const bk = (g.bokeh / 100) * 6, thr = g.bokehThreshold / 255;
  for (let i = 0; i < n; i++) {
    const a = src[i * 4 + 3] / 255;
    let r = src[i * 4] / 255, gg = src[i * 4 + 1] / 255, b = src[i * 4 + 2] / 255;
    if (bk) {
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      if (l > thr) { const k = 1 + bk * ((l - thr) / Math.max(0.01, 1 - thr)) ** 2; r *= k; gg *= k; b *= k; }
    }
    base[i * 4] = r * a; base[i * 4 + 1] = gg * a; base[i * 4 + 2] = b * a; base[i * 4 + 3] = a;
  }
  // Radio por píxel (en px de esta imagen).
  const rad = new Float32Array(w * outRows);
  let maxR = 0;
  for (let y = 0; y < outRows; y++) for (let x = 0; x < w; x++) {
    const v = blurAt(g, ox + x + 0.5, oy + top + y + 0.5) * S;
    rad[y * w + x] = v; if (v > maxR) maxR = v;
  }
  // Niveles: 0, y radios que crecen ×1,6 hasta el máximo.
  const levels: number[] = [0];
  for (let r = 1; r < maxR * 1.6; r *= 1.6) levels.push(Math.min(maxR, r));
  if (levels[levels.length - 1] < maxR) levels.push(maxR);
  const out = new Uint8ClampedArray(w * outRows * 4);
  const write = (A: Float32Array, B: Float32Array, lo: number, hi: number, last: boolean) => {
    for (let y = 0; y < outRows; y++) for (let x = 0; x < w; x++) {
      const r = rad[y * w + x];
      if (r < lo || (r >= hi && !last) || r > hi) continue;
      const t = hi > lo ? Math.max(0, Math.min(1, (r - lo) / (hi - lo))) : 0;
      const i = ((top + y) * w + x) * 4, o = (y * w + x) * 4;
      const a = A[i + 3] * (1 - t) + B[i + 3] * t;
      if (a <= 1e-4) continue;
      for (let c = 0; c < 3; c++) {
        let v = (A[i + c] * (1 - t) + B[i + c] * t) / a;
        if (bk) v = v / (1 + Math.max(0, v - 1)); // las luces amplificadas vuelven a rango con suavidad
        out[o + c] = Math.max(0, Math.min(1, v)) * 255 + 0.5;
      }
      // Se conserva la opacidad original: el borde de la foto no se vuelve transparente.
      out[o + 3] = src[i + 3];
    }
  };
  if (levels.length === 1) { write(base, base, 0, 0, true); return out; }
  // Sólo dos niveles en memoria a la vez (el anterior y el actual).
  const tmp = new Float32Array(n * 4);
  let prev = base;
  for (let l = 1; l < levels.length; l++) {
    const cur = base.slice();
    boxBlurRGBA(cur, w, rows, Math.max(1, Math.round(levels[l] / 2)), tmp);
    write(prev, cur, levels[l - 1], levels[l], l === levels.length - 1);
    prev = cur;
  }
  return out;
}
