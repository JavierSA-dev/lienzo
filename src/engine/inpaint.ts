// Relleno según contenido y pinceles correctores (se ejecuta en el pool de workers).
//
// - inpaint(): síntesis de textura multiescala con PatchMatch (Barnes et al. 2009) y
//   votación por parches (Wexler et al. 2007): rellena el hueco copiando parches
//   parecidos del resto de la imagen.
// - heal(): corrector tipo Photoshop: conserva la textura del origen y ajusta color y
//   luminosidad a los bordes del destino (membrana armónica, equivalente a la mezcla
//   de Poisson), resuelta con pull-push + iteraciones de Jacobi.

const C = 4; // RGBA
const R = 4; // radio del parche (9×9)
/** Peso gaussiano dentro del parche: el centro cuenta más al votar (menos desenfoque). */
const GAUSS = (() => {
  const g = new Float32Array((2 * R + 1) ** 2);
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) g[(y + R) * (2 * R + 1) + x + R] = Math.exp(-(x * x + y * y) / (2 * 2.2 * 2.2));
  return g;
})();

/** Rellena los píxeles con peso < 1 interpolando suavemente desde los conocidos (pull-push). */
export function pullPush(img: Float32Array, wgt: Float32Array, w: number, h: number, ch = C) {
  if (w <= 1 && h <= 1) return;
  const w2 = Math.ceil(w / 2), h2 = Math.ceil(h / 2);
  const img2 = new Float32Array(w2 * h2 * ch), wgt2 = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let ws = 0;
      const acc = [0, 0, 0, 0];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const fx = x * 2 + dx, fy = y * 2 + dy;
        if (fx >= w || fy >= h) continue;
        const i = fy * w + fx, a = wgt[i];
        if (a <= 0) continue;
        ws += a;
        for (let c = 0; c < ch; c++) acc[c] += img[i * ch + c] * a;
      }
      const j = y * w2 + x;
      if (ws > 0) for (let c = 0; c < ch; c++) img2[j * ch + c] = acc[c] / ws;
      wgt2[j] = Math.min(1, ws);
    }
  }
  pullPush(img2, wgt2, w2, h2, ch);
  // push: bilineal desde el nivel grueso donde falta información
  for (let y = 0; y < h; y++) {
    const gy = Math.min(h2 - 1, Math.max(0, (y - 0.5) / 2)), y0 = Math.floor(gy), y1 = Math.min(h2 - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, a = wgt[i];
      if (a >= 1) continue;
      const gx = Math.min(w2 - 1, Math.max(0, (x - 0.5) / 2)), x0 = Math.floor(gx), x1 = Math.min(w2 - 1, x0 + 1), fx = gx - x0;
      for (let c = 0; c < ch; c++) {
        const v = (img2[(y0 * w2 + x0) * ch + c] * (1 - fx) + img2[(y0 * w2 + x1) * ch + c] * fx) * (1 - fy)
          + (img2[(y1 * w2 + x0) * ch + c] * (1 - fx) + img2[(y1 * w2 + x1) * ch + c] * fx) * fy;
        img[i * ch + c] = img[i * ch + c] * a + v * (1 - a);
      }
      wgt[i] = 1;
    }
  }
}

/** Membrana armónica: rellena `unknown` para que sea suave y coincida con los valores conocidos. */
function membrane(val: Float32Array, unknown: Uint8Array, w: number, h: number, iters: number) {
  const wgt = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) wgt[i] = unknown[i] ? 0 : 1;
  pullPush(val, wgt, w, h);
  // Jacobi (Gauss-Seidel en el sitio) sobre los píxeles desconocidos para acercarse a la solución de Laplace.
  const list: number[] = [];
  for (let i = 0; i < w * h; i++) if (unknown[i]) list.push(i);
  for (let it = 0; it < iters; it++) {
    for (const i of list) {
      const x = i % w, y = (i - x) / w;
      let n = 0;
      const s = [0, 0, 0, 0];
      if (x > 0) { n++; for (let c = 0; c < C; c++) s[c] += val[(i - 1) * C + c]; }
      if (x < w - 1) { n++; for (let c = 0; c < C; c++) s[c] += val[(i + 1) * C + c]; }
      if (y > 0) { n++; for (let c = 0; c < C; c++) s[c] += val[(i - w) * C + c]; }
      if (y < h - 1) { n++; for (let c = 0; c < C; c++) s[c] += val[(i + w) * C + c]; }
      for (let c = 0; c < C; c++) val[i * C + c] = s[c] / n;
    }
  }
}

/**
 * Pincel corrector: `src` aporta la textura, `dst` los colores del entorno.
 * `mask` (0..1): zona corregida. Devuelve el resultado ya mezclado con `dst` según la máscara.
 */
export function heal(src: Uint8ClampedArray, dst: Uint8ClampedArray, mask: Float32Array, w: number, h: number): Uint8ClampedArray {
  const n = w * h;
  const diff = new Float32Array(n * C);
  const unknown = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (mask[i] > 0.02) { unknown[i] = 1; continue; }
    for (let c = 0; c < C; c++) diff[i * C + c] = dst[i * C + c] - src[i * C + c];
  }
  membrane(diff, unknown, w, h, Math.min(200, Math.max(20, Math.round(Math.sqrt(n) / 2))));
  const out = new Uint8ClampedArray(n * C);
  for (let i = 0; i < n; i++) {
    const k = mask[i];
    for (let c = 0; c < C; c++) {
      const healed = src[i * C + c] + diff[i * C + c];
      out[i * C + c] = dst[i * C + c] + (healed - dst[i * C + c]) * k;
    }
  }
  return out;
}

// ------------------------------------------------------------------ síntesis por parches

interface Level { img: Float32Array; hole: Uint8Array; w: number; h: number }

function downsample(L: Level): Level {
  const w = Math.max(1, Math.floor(L.w / 2)), h = Math.max(1, Math.floor(L.h / 2));
  const img = new Float32Array(w * h * C), hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0, anyHole = 0;
      const acc = [0, 0, 0, 0];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = (y * 2 + dy) * L.w + x * 2 + dx;
        if (L.hole[i]) { anyHole = 1; continue; }
        n++;
        for (let c = 0; c < C; c++) acc[c] += L.img[i * C + c];
      }
      const j = y * w + x;
      hole[j] = anyHole;
      if (n) for (let c = 0; c < C; c++) img[j * C + c] = acc[c] / n;
    }
  }
  return { img, hole, w, h };
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Rellena `hole` (1 = rellenar) copiando parches del resto de la imagen. */
export function inpaint(src: Uint8ClampedArray, w: number, h: number, holeIn: Uint8Array, seed = 7): Uint8ClampedArray {
  const n = w * h;
  let holeCount = 0;
  for (let i = 0; i < n; i++) holeCount += holeIn[i] ? 1 : 0;
  if (!holeCount) return src.slice();
  const levels: Level[] = [{ img: Float32Array.from(src), hole: holeIn.slice(), w, h }];
  // Pirámide hasta que el hueco sea pequeño (unos pocos parches) o la imagen mínima.
  for (;;) {
    const top = levels[levels.length - 1];
    let hx0 = top.w, hx1 = -1, hy0 = top.h, hy1 = -1;
    for (let y = 0; y < top.h; y++) for (let x = 0; x < top.w; x++) if (top.hole[y * top.w + x]) {
      if (x < hx0) hx0 = x; if (x > hx1) hx1 = x; if (y < hy0) hy0 = y; if (y > hy1) hy1 = y;
    }
    const holeSize = Math.max(hx1 - hx0 + 1, hy1 - hy0 + 1);
    if (holeSize <= 2 * R + 2 || Math.min(top.w, top.h) < 4 * (2 * R + 1)) break;
    levels.push(downsample(top));
  }
  const rand = rng(seed);

  // Nivel más grueso: relleno suave como punto de partida.
  {
    const top = levels[levels.length - 1];
    const wgt = new Float32Array(top.w * top.h);
    for (let i = 0; i < wgt.length; i++) wgt[i] = top.hole[i] ? 0 : 1;
    pullPush(top.img, wgt, top.w, top.h);
  }

  let prevNx: Int32Array | null = null, prevNy: Int32Array | null = null, prevW = 0;
  for (let li = levels.length - 1; li >= 0; li--) {
    const Lv = levels[li];
    const { img, hole, w: lw, h: lh } = Lv;
    // Inicializa el hueco desde el nivel anterior (ya relleno).
    if (li < levels.length - 1) {
      const up = levels[li + 1];
      for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
        const i = y * lw + x;
        if (!hole[i]) continue;
        const ux = Math.min(up.w - 1, x >> 1), uy = Math.min(up.h - 1, y >> 1);
        for (let c = 0; c < C; c++) img[i * C + c] = up.img[(uy * up.w + ux) * C + c];
      }
    }
    // Centros de parche válidos como origen: el parche entero dentro y sin hueco.
    const integ = new Int32Array((lw + 1) * (lh + 1));
    for (let y = 0; y < lh; y++) {
      let row = 0;
      for (let x = 0; x < lw; x++) { row += hole[y * lw + x]; integ[(y + 1) * (lw + 1) + x + 1] = integ[y * (lw + 1) + x + 1] + row; }
    }
    const holesIn = (x0: number, y0: number, x1: number, y1: number) =>
      integ[y1 * (lw + 1) + x1] - integ[y0 * (lw + 1) + x1] - integ[y1 * (lw + 1) + x0] + integ[y0 * (lw + 1) + x0];
    const valid = new Uint8Array(lw * lh);
    const validList: number[] = [];
    for (let y = R; y < lh - R; y++) for (let x = R; x < lw - R; x++) {
      if (holesIn(x - R, y - R, x + R + 1, y + R + 1) === 0) { valid[y * lw + x] = 1; validList.push(y * lw + x); }
    }
    if (!validList.length) continue; // sin fuentes: se queda el relleno suave
    // Objetivos: píxeles cuyo parche toca el hueco.
    const targets: number[] = [];
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R), x1 = Math.min(lw, x + R + 1), y1 = Math.min(lh, y + R + 1);
      if (holesIn(x0, y0, x1, y1) > 0) targets.push(y * lw + x);
    }
    const nx = new Int32Array(lw * lh), ny = new Int32Array(lw * lh), nd = new Float64Array(lw * lh);
    const isT = new Uint8Array(lw * lh);
    for (const p of targets) isT[p] = 1;

    const dist = (px: number, py: number, qx: number, qy: number, best: number) => {
      let d = 0, cnt = 0;
      for (let dy = -R; dy <= R; dy++) {
        const ty = py + dy;
        if (ty < 0 || ty >= lh) continue;
        const sRow = (qy + dy) * lw, tRow = ty * lw;
        for (let dx = -R; dx <= R; dx++) {
          const tx = px + dx;
          if (tx < 0 || tx >= lw) continue;
          const a = (tRow + tx) * C, b = (sRow + qx + dx) * C;
          const e0 = img[a] - img[b], e1 = img[a + 1] - img[b + 1], e2 = img[a + 2] - img[b + 2], e3 = img[a + 3] - img[b + 3];
          d += e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3;
          cnt++;
        }
        if (d > best * (2 * R + 1) * (2 * R + 1)) return Infinity; // poda
      }
      return cnt ? d / cnt : Infinity;
    };
    const tryCand = (p: number, qx: number, qy: number) => {
      if (qx < R || qy < R || qx >= lw - R || qy >= lh - R || !valid[qy * lw + qx]) return;
      const px = p % lw, py = (p - px) / lw;
      const d = dist(px, py, qx, qy, nd[p]);
      if (d < nd[p]) { nd[p] = d; nx[p] = qx; ny[p] = qy; }
    };

    // Inicialización del campo de correspondencias: del nivel anterior o al azar.
    for (const p of targets) {
      const px = p % lw, py = (p - px) / lw;
      nd[p] = Infinity;
      if (prevNx && prevNy) {
        const pi = Math.min(levels[li + 1].h - 1, py >> 1) * prevW + Math.min(prevW - 1, px >> 1);
        tryCand(p, prevNx[pi] * 2 + (px & 1), prevNy[pi] * 2 + (py & 1));
      }
      if (nd[p] === Infinity) {
        const q = validList[Math.floor(rand() * validList.length)];
        const qx = q % lw;
        nx[p] = qx; ny[p] = (q - qx) / lw;
        nd[p] = dist(px, py, nx[p], ny[p], Infinity);
      }
    }

    const iters = li <= 1 ? 6 : 7;
    const acc = new Float32Array(lw * lh * C), wsum = new Float32Array(lw * lh);
    for (let it = 0; it < iters; it++) {
      // Distancias con la estimación actual del hueco.
      for (const p of targets) { const px = p % lw; nd[p] = dist(px, (p - px) / lw, nx[p], ny[p], Infinity); }
      // PatchMatch: propagación alternando el sentido + búsqueda aleatoria.
      for (let pass = 0; pass < 2; pass++) {
        const rev = (it + pass) % 2 === 1;
        const s = rev ? -1 : 1;
        for (let t = 0; t < targets.length; t++) {
          const p = targets[rev ? targets.length - 1 - t : t];
          const px = p % lw, py = (p - px) / lw;
          const a = px - s, b = py - s;
          if (a >= 0 && a < lw && isT[py * lw + a]) { const q = py * lw + a; tryCand(p, nx[q] + s, ny[q]); }
          if (b >= 0 && b < lh && isT[b * lw + px]) { const q = b * lw + px; tryCand(p, nx[q], ny[q] + s); }
          for (let rad = Math.max(lw, lh); rad >= 1; rad = Math.floor(rad / 2)) {
            tryCand(p, Math.round(nx[p] + (rand() * 2 - 1) * rad), Math.round(ny[p] + (rand() * 2 - 1) * rad));
          }
        }
      }
      // Votación: cada píxel del hueco = media ponderada de los parches que lo cubren.
      const ds = targets.map((p) => nd[p]).filter((d) => d < Infinity).sort((x, y) => x - y);
      const s2 = Math.max(1, ds[Math.floor(ds.length * (li === 0 ? 0.15 : 0.35))] ?? 1);
      acc.fill(0); wsum.fill(0);
      for (const p of targets) {
        if (nd[p] === Infinity) continue;
        const px = p % lw, py = (p - px) / lw;
        const wgt = Math.exp(-nd[p] / (2 * s2));
        const last = li === 0 && it === iters - 1;
        for (let dy = -R; dy <= R; dy++) {
          const ty = py + dy;
          if (ty < 0 || ty >= lh) continue;
          for (let dx = -R; dx <= R; dx++) {
            const tx = px + dx;
            if (tx < 0 || tx >= lw) continue;
            const ti = ty * lw + tx;
            // En la última pasada también se reconstruye la banda alrededor del hueco (para fundir el color).
            if (!hole[ti] && !last) continue;
            const g = wgt * GAUSS[(dy + R) * (2 * R + 1) + dx + R];
            const si = ((ny[p] + dy) * lw + nx[p] + dx) * C;
            for (let c = 0; c < C; c++) acc[ti * C + c] += img[si + c] * g;
            wsum[ti] += g;
          }
        }
      }
      if (li === 0 && it === iters - 1) {
        // Fusión final (Poisson): la textura sintetizada se ajusta al color del borde real.
        const diff = new Float32Array(lw * lh * C);
        for (let i = 0; i < lw * lh; i++) {
          if (hole[i] || wsum[i] <= 0) continue;
          for (let c = 0; c < C; c++) diff[i * C + c] = img[i * C + c] - acc[i * C + c] / wsum[i];
        }
        membrane(diff, hole, lw, lh, 60);
        for (let i = 0; i < lw * lh; i++) {
          if (!hole[i] || wsum[i] <= 0) continue;
          for (let c = 0; c < C; c++) img[i * C + c] = acc[i * C + c] / wsum[i] + diff[i * C + c];
        }
        continue;
      }
      for (let i = 0; i < lw * lh; i++) {
        if (!hole[i] || wsum[i] <= 0) continue;
        for (let c = 0; c < C; c++) img[i * C + c] = acc[i * C + c] / wsum[i];
      }
    }
    prevNx = nx; prevNy = ny; prevW = lw;
  }

  const out = new Uint8ClampedArray(n * C);
  const top = levels[0].img;
  for (let i = 0; i < n; i++) {
    if (holeIn[i]) for (let c = 0; c < C; c++) out[i * C + c] = top[i * C + c];
    else for (let c = 0; c < C; c++) out[i * C + c] = src[i * C + c];
  }
  return out;
}
