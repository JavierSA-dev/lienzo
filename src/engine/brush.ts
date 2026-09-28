import { TILE, type BrushSettings, type Rect, type RGBA } from './types';
import { tileKey, isTileEmpty, type PixelLayer } from './document';
import { TilePatch } from './history';
import type { Selection } from './selection';

export type BrushMode = 'paint' | 'erase' | 'clone' | 'dodge' | 'burn' | 'blur' | 'sharpen' | 'smudge';

export interface StrokeOptions {
  layer: PixelLayer;
  settings: BrushSettings;
  color: RGBA;
  mode: BrushMode;
  /** Zona donde se puede pintar (documento ∩ límites de la selección). */
  clip: Rect;
  selection: Selection | null;
  /** 'mask' = pinta en la máscara de la capa en escala de grises. */
  target: 'pixels' | 'mask';
  /** Valor 0..255 que se pinta en la máscara (luminancia del color). */
  maskValue?: number;
  /** Tampón de clonar: desplazamiento origen - destino en píxeles. */
  cloneOffset?: { dx: number; dy: number };
  /** Lápiz: bordes sin suavizar. */
  aliased?: boolean;
  label?: string;
  /** Pinceles correctores: sólo cambia el nombre del paso del historial. */
  healTool?: 'spotHeal' | 'heal';
}

/**
 * Motor de pincel por "estampados" (dabs) con búfer de trazo, como Photoshop:
 * - el flujo se acumula dab a dab, pero nunca supera la opacidad del trazo;
 * - el trazo se compone sobre el contenido original del tile, así que repasar
 *   la misma zona dentro de un trazo no oscurece más allá de la opacidad.
 */
export class BrushStroke {
  private o: StrokeOptions;
  readonly patch: TilePatch;
  /** Cobertura acumulada del trazo por tile (0..1). */
  private acc = new Map<number, Float32Array>();
  private last: { x: number; y: number; p: number } | null = null;
  private untilNext = 0;
  dirty: Rect | null = null;
  /** Zona total tocada por el trazo (coordenadas de documento). */
  total: Rect | null = null;

  get layerId() { return this.o.layer.id; }

  constructor(o: StrokeOptions) {
    this.o = o;
    const names: Record<BrushMode, string> = { paint: 'Pincel', erase: 'Borrador', clone: 'Tampón de clonar', dodge: 'Sobreexponer', burn: 'Subexponer', blur: 'Desenfocar', sharpen: 'Enfocar', smudge: 'Dedo' };
    if (!o.label && o.healTool) o.label = o.healTool === 'spotHeal' ? 'Pincel corrector puntual' : 'Pincel corrector';
    this.patch = new TilePatch(o.label ?? (o.target === 'mask' ? `${names[o.mode]} (máscara)` : names[o.mode]), o.layer, o.target);
  }

  /** Añade un punto (coordenadas de documento) e interpola dabs según el espaciado. */
  addPoint(x: number, y: number, pressure: number) {
    const p = pressure > 0 ? pressure : 1;
    if (!this.last) {
      this.dab(x, y, p);
      this.last = { x, y, p };
      this.untilNext = this.stepAt(p);
      return;
    }
    const { x: lx, y: ly, p: lp } = this.last;
    const dist = Math.hypot(x - lx, y - ly);
    let pos = this.untilNext;
    while (pos <= dist) {
      const t = pos / dist;
      const pp = lp + (p - lp) * t;
      this.dab(lx + (x - lx) * t, ly + (y - ly) * t, pp);
      pos += this.stepAt(pp);
    }
    this.untilNext = pos - dist;
    this.last = { x, y, p };
  }

  private stepAt(pressure: number) {
    const s = this.o.settings;
    return Math.max(1, s.size * (s.pressureSize ? pressure : 1) * s.spacing);
  }

  private dab(cx: number, cy: number, pressure: number) {
    const { settings: s, layer: L, clip, selection: sel, mode, target, aliased } = this.o;
    const r = Math.max(0.5, (s.size / 2) * (s.pressureSize ? pressure : 1));
    const cap = s.opacity * (s.pressureOpacity ? pressure : 1);
    const flow = s.flow;
    const hard = aliased ? 0.999 : Math.min(0.999, Math.max(0, s.hardness));
    const invSoft = 1 / (1 - hard);

    const x0 = Math.max(Math.floor(cx - r - 1), clip.x);
    const y0 = Math.max(Math.floor(cy - r - 1), clip.y);
    const x1 = Math.min(Math.ceil(cx + r + 1), clip.x + clip.w);
    const y1 = Math.min(Math.ceil(cy + r + 1), clip.y + clip.h);
    if (x1 <= x0 || y1 <= y0) return;
    this.grow({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });

    const [cr, cg, cb] = this.o.color;
    const lx0 = x0 - L.x, ly0 = y0 - L.y, lx1 = x1 - L.x, ly1 = y1 - L.y;
    const tx0 = Math.floor(lx0 / TILE), ty0 = Math.floor(ly0 / TILE);
    const tx1 = Math.floor((lx1 - 1) / TILE), ty1 = Math.floor((ly1 - 1) / TILE);
    const mask = target === 'mask' ? L.mask! : null;
    const maskValue = this.o.maskValue ?? 0;
    const clone = this.o.cloneOffset;

    // Caché del tile de selección para no buscar en el mapa en cada píxel.
    let selKey = -1, selTile: Uint8Array | undefined;
    const selAt = (dx: number, dy: number) => {
      if (!sel || sel.rect) return 255;
      const tx = Math.floor(dx / TILE), ty = Math.floor(dy / TILE);
      const k = tileKey(tx, ty);
      if (k !== selKey) { selKey = k; selTile = sel.tiles.get(k); }
      return selTile ? selTile[(dy - ty * TILE) * TILE + (dx - tx * TILE)] : 0;
    };

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const k = tileKey(tx, ty);
        if (!mask && (mode === 'erase' || mode === 'dodge' || mode === 'burn' || L.lockAlpha) && !L.getTile(k) && !this.patch.has(k)) continue;
        this.patch.capture(L, k);
        const orig = this.patch.saved.get(k) ?? null;
        let m = this.acc.get(k);
        if (!m) { m = new Float32Array(TILE * TILE); this.acc.set(k, m); }
        const t = mask ? mask.ensureTile(k) : L.ensureTile(k);
        const ox = tx * TILE, oy = ty * TILE;
        const px0 = Math.max(lx0, ox) - ox, px1 = Math.min(lx1, ox + TILE) - ox;
        const py0 = Math.max(ly0, oy) - oy, py1 = Math.min(ly1, oy + TILE) - oy;
        const ccx = cx - L.x - ox, ccy = cy - L.y - oy;

        for (let py = py0; py < py1; py++) {
          const dy = py + 0.5 - ccy;
          for (let px = px0; px < px1; px++) {
            const dx = px + 0.5 - ccx;
            const dist = Math.sqrt(dx * dx + dy * dy);
            let a: number;
            if (aliased) {
              a = dist <= r ? 1 : 0;
            } else {
              a = r + 0.5 - dist;
              if (a <= 0) continue;
              if (a > 1) a = 1;
              const nd = dist / r;
              if (nd > hard) {
                const f = 1 - (nd - hard) * invSoft;
                a *= f <= 0 ? 0 : f * f * (3 - 2 * f);
              }
            }
            if (a <= 0) continue;
            const docX = ox + px + L.x, docY = oy + py + L.y;
            const sv = selAt(docX, docY);
            if (!sv) continue;
            const i = py * TILE + px;
            if (mode === 'smudge' && !mask) {
              // Dedo: arrastra el color que "lleva el dedo" (búfer) sobre el píxel actual.
              const T = t as Uint8ClampedArray, j = i * 4;
              const bi = this.smudgeIndex(docX - cx, docY - cy);
              if (bi < 0) continue;
              const B = this.smudgeBuf!;
              const k = a * cap * (sv / 255);
              if (!this.smudgeInit[bi >> 2]) { this.smudgeInit[bi >> 2] = 1; B[bi] = T[j]; B[bi + 1] = T[j + 1]; B[bi + 2] = T[j + 2]; B[bi + 3] = T[j + 3]; }
              const o0 = T[j], o1 = T[j + 1], o2 = T[j + 2], o3 = T[j + 3];
              const ta = T[j + 3] / 255, ba = B[bi + 3] / 255;
              const na = ta + (ba - ta) * k;
              for (let c = 0; c < 3; c++) {
                const v = na > 0 ? (T[j + c] * ta + (B[bi + c] * ba - T[j + c] * ta) * k) / na : B[bi + c];
                T[j + c] = v;
              }
              T[j + 3] = na * 255;
              // El dedo recoge parte del color nuevo (se va diluyendo, como en Photoshop).
              const pick = (1 - cap) * a;
              B[bi] += (o0 - B[bi]) * pick; B[bi + 1] += (o1 - B[bi + 1]) * pick; B[bi + 2] += (o2 - B[bi + 2]) * pick; B[bi + 3] += (o3 - B[bi + 3]) * pick;
              continue;
            }
            const limit = cap * (sv / 255);
            const prev = m[i];
            if (prev >= limit) continue;
            const nm = prev + (limit - prev) * a * flow;
            m[i] = nm;

            if (mask) {
              const o0 = orig ? (orig as Uint8Array)[i] : mask.fill;
              (t as Uint8Array)[i] = o0 + (maskValue - o0) * nm;
              continue;
            }
            const T = t as Uint8ClampedArray;
            const O = orig as Uint8ClampedArray | null;
            const j = i * 4;
            const oa = O ? O[j + 3] / 255 : 0;
            if (mode === 'erase') {
              T[j + 3] = oa * (1 - nm) * 255;
              if (O) { T[j] = O[j]; T[j + 1] = O[j + 1]; T[j + 2] = O[j + 2]; }
              continue;
            }
            if (mode === 'blur' || mode === 'sharpen') {
              if (!O || !O[j + 3]) continue;
              // Media 5×5 del contenido previo al trazo (no se acumula dentro del mismo trazo).
              let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
              for (let yy = -2; yy <= 2; yy++) for (let xx = -2; xx <= 2; xx++) {
                const q = this.sample(docX + xx, docY + yy);
                const w = (3 - Math.abs(xx)) * (3 - Math.abs(yy));
                sr += q[0] * q[3] * w; sg += q[1] * q[3] * w; sb += q[2] * q[3] * w; sa += q[3] * w; n += w;
              }
              if (sa <= 0) continue;
              const ar = sr / sa, ag = sg / sa, ab = sb / sa;
              if (mode === 'blur') {
                T[j] = O[j] + (ar - O[j]) * nm; T[j + 1] = O[j + 1] + (ag - O[j + 1]) * nm; T[j + 2] = O[j + 2] + (ab - O[j + 2]) * nm;
                T[j + 3] = O[j + 3] + (sa / n - O[j + 3]) * nm;
              } else {
                const k2 = nm * 1.5;
                T[j] = O[j] + (O[j] - ar) * k2; T[j + 1] = O[j + 1] + (O[j + 1] - ag) * k2; T[j + 2] = O[j + 2] + (O[j + 2] - ab) * k2;
                T[j + 3] = O[j + 3];
              }
              continue;
            }
            if (mode === 'dodge' || mode === 'burn') {
              if (!O) continue;
              for (let c = 0; c < 3; c++) T[j + c] = mode === 'dodge' ? O[j + c] + (255 - O[j + c]) * nm * 0.6 : O[j + c] * (1 - nm * 0.6);
              T[j + 3] = O[j + 3];
              continue;
            }
            let sr = cr, sg = cg, sb = cb, sa = 1;
            if (clone) {
              const src = this.sample(docX + clone.dx, docY + clone.dy);
              sr = src[0]; sg = src[1]; sb = src[2]; sa = src[3] / 255;
              if (sa <= 0) continue;
            }
            const cov = nm * sa;
            if (L.lockAlpha) {
              // Sólo tiñe el color; el alfa original no cambia.
              if (!O || !oa) continue;
              T[j] = O[j] + (sr - O[j]) * cov; T[j + 1] = O[j + 1] + (sg - O[j + 1]) * cov; T[j + 2] = O[j + 2] + (sb - O[j + 2]) * cov;
              T[j + 3] = O[j + 3];
              continue;
            }
            const na = cov + oa * (1 - cov);
            if (na <= 0) continue;
            const wo = (oa * (1 - cov)) / na, wc = cov / na;
            T[j] = O ? sr * wc + O[j] * wo : sr;
            T[j + 1] = O ? sg * wc + O[j + 1] * wo : sg;
            T[j + 2] = O ? sb * wc + O[j + 2] * wo : sb;
            T[j + 3] = na * 255;
          }
        }
        if (mask) mask.touch(k); else L.touch(k);
      }
    }
  }

  private smudgeBuf: Float32Array | null = null;
  private smudgeInit = new Uint8Array(0);
  private smudgeR = 0;

  /** Índice en el búfer del dedo para un desplazamiento respecto al centro del toque. */
  private smudgeIndex(dx: number, dy: number): number {
    if (!this.smudgeBuf) {
      this.smudgeR = Math.ceil(this.o.settings.size / 2) + 2;
      const side = this.smudgeR * 2 + 1;
      this.smudgeBuf = new Float32Array(side * side * 4);
      this.smudgeInit = new Uint8Array(side * side);
    }
    const R = this.smudgeR, x = Math.round(dx) + R, y = Math.round(dy) + R, side = R * 2 + 1;
    if (x < 0 || y < 0 || x >= side || y >= side) return -1;
    return (y * side + x) * 4;
  }

  /** Lee el píxel de origen para el tampón: siempre del contenido previo al trazo. */
  private sample(dx: number, dy: number): RGBA {
    const L = this.o.layer;
    const lx = dx - L.x, ly = dy - L.y;
    const tx = Math.floor(lx / TILE), ty = Math.floor(ly / TILE);
    const k = tileKey(tx, ty);
    const t = (this.patch.has(k) ? this.patch.saved.get(k) : L.getTile(k)) as Uint8ClampedArray | null | undefined;
    if (!t) return [0, 0, 0, 0];
    const i = ((ly - ty * TILE) * TILE + (lx - tx * TILE)) * 4;
    return [t[i], t[i + 1], t[i + 2], t[i + 3]];
  }

  private grow(r: Rect) {
    const t = this.total;
    this.total = !t ? { ...r } : (() => {
      const x0 = Math.min(t.x, r.x), y0 = Math.min(t.y, r.y);
      return { x: x0, y: y0, w: Math.max(t.x + t.w, r.x + r.w) - x0, h: Math.max(t.y + t.h, r.y + r.h) - y0 };
    })();
    if (!this.dirty) { this.dirty = { ...r }; return; }
    const d = this.dirty;
    const x0 = Math.min(d.x, r.x), y0 = Math.min(d.y, r.y);
    const x1 = Math.max(d.x + d.w, r.x + r.w), y1 = Math.max(d.y + d.h, r.y + r.h);
    this.dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  takeDirty(): Rect | null {
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  /** Cobertura acumulada del trazo (0..1) en una región del documento. Antes de finish(). */
  coverage(r: Rect): Float32Array {
    const L = this.o.layer;
    const out = new Float32Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const lx = r.x + x - L.x, ly = r.y + y - L.y;
        const tx = Math.floor(lx / TILE), ty = Math.floor(ly / TILE);
        const m = this.acc.get(tileKey(tx, ty));
        if (m) out[y * r.w + x] = m[(ly - ty * TILE) * TILE + (lx - tx * TILE)] / Math.max(1e-6, this.o.settings.opacity);
      }
    }
    return out;
  }

  /** Píxeles de la capa tal como estaban antes del trazo. */
  original(r: Rect): Uint8ClampedArray {
    const out = new Uint8ClampedArray(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const p = this.sample(r.x + x, r.y + y);
      out.set(p, (y * r.w + x) * 4);
    }
    return out;
  }

  /** Cierra el trazo: libera tiles que quedaron vacíos (p. ej. tras borrar). */
  finish(): TilePatch | null {
    if (this.o.target === 'pixels') {
      for (const k of this.patch.saved.keys()) {
        const t = this.o.layer.getTile(k);
        if (t && isTileEmpty(t)) this.o.layer.setTile(k, null);
      }
    }
    this.acc.clear();
    return this.patch.saved.size ? this.patch : null;
  }
}
