import { TILE, type BrushSettings, type Rect, type RGBA } from './types';
import { tileKey, isTileEmpty, type PixelLayer } from './document';
import { TilePatch } from './history';
import type { Selection } from './selection';

export type BrushMode = 'paint' | 'erase' | 'clone' | 'dodge' | 'burn';

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

  constructor(o: StrokeOptions) {
    this.o = o;
    const names: Record<BrushMode, string> = { paint: 'Pincel', erase: 'Borrador', clone: 'Tampón de clonar', dodge: 'Sobreexponer', burn: 'Subexponer' };
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
