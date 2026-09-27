import { TILE, type BrushSettings, type Rect, type RGBA } from './types';
import { tileKey, isTileEmpty, type PixelLayer } from './document';
import { TilePatch } from './history';

/**
 * Motor de pincel por "estampados" (dabs) con búfer de trazo, como Photoshop:
 * - el flujo se acumula dab a dab, pero nunca supera la opacidad del trazo;
 * - el trazo se compone sobre el contenido original del tile, así que repasar
 *   la misma zona dentro de un trazo no oscurece más allá de la opacidad.
 */
export class BrushStroke {
  private layer: PixelLayer;
  private settings: BrushSettings;
  private color: RGBA;
  private erase: boolean;
  private clip: Rect;
  readonly patch: TilePatch;
  /** Cobertura acumulada del trazo por tile (0..1). */
  private mask = new Map<number, Float32Array>();
  private last: { x: number; y: number; p: number } | null = null;
  private untilNext = 0;
  /** Rectángulo sucio en coordenadas de documento desde la última consulta. */
  dirty: Rect | null = null;

  constructor(layer: PixelLayer, settings: BrushSettings, color: RGBA, erase: boolean, clip: Rect) {
    this.layer = layer;
    this.settings = settings;
    this.color = color;
    this.erase = erase;
    this.clip = clip;
    this.patch = new TilePatch(erase ? 'Borrador' : 'Pincel', layer);
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
    const s = this.settings;
    const d = s.size * (s.pressureSize ? pressure : 1);
    return Math.max(1, d * s.spacing);
  }

  private dab(cx: number, cy: number, pressure: number) {
    const s = this.settings;
    const r = Math.max(0.5, (s.size / 2) * (s.pressureSize ? pressure : 1));
    const cap = s.opacity * (s.pressureOpacity ? pressure : 1);
    const flow = s.flow;
    const hard = Math.min(0.999, Math.max(0, s.hardness));
    const L = this.layer;

    // Rectángulo del dab recortado a la selección/lienzo (coords de documento).
    const x0 = Math.max(Math.floor(cx - r - 1), this.clip.x);
    const y0 = Math.max(Math.floor(cy - r - 1), this.clip.y);
    const x1 = Math.min(Math.ceil(cx + r + 1), this.clip.x + this.clip.w);
    const y1 = Math.min(Math.ceil(cy + r + 1), this.clip.y + this.clip.h);
    if (x1 <= x0 || y1 <= y0) return;
    this.grow({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });

    const [cr, cg, cb] = this.color;
    const lx0 = x0 - L.x, ly0 = y0 - L.y, lx1 = x1 - L.x, ly1 = y1 - L.y;
    const tx0 = Math.floor(lx0 / TILE), ty0 = Math.floor(ly0 / TILE);
    const tx1 = Math.floor((lx1 - 1) / TILE), ty1 = Math.floor((ly1 - 1) / TILE);
    const invSoft = 1 / (1 - hard);

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const k = tileKey(tx, ty);
        if (this.erase && !L.getTile(k) && !this.patch.has(k)) continue; // nada que borrar
        this.patch.capture(L, k);
        const orig = this.patch.saved.get(k) ?? null; // contenido previo al trazo
        let m = this.mask.get(k);
        if (!m) { m = new Float32Array(TILE * TILE); this.mask.set(k, m); }
        const t = L.ensureTile(k);
        const ox = tx * TILE, oy = ty * TILE;
        const px0 = Math.max(lx0, ox) - ox, px1 = Math.min(lx1, ox + TILE) - ox;
        const py0 = Math.max(ly0, oy) - oy, py1 = Math.min(ly1, oy + TILE) - oy;
        const ccx = cx - L.x - ox, ccy = cy - L.y - oy;

        for (let py = py0; py < py1; py++) {
          const dy = py + 0.5 - ccy;
          for (let px = px0; px < px1; px++) {
            const dx = px + 0.5 - ccx;
            const dist = Math.sqrt(dx * dx + dy * dy);
            // Borde suavizado de 1 px + caída según la dureza.
            let a = r + 0.5 - dist;
            if (a <= 0) continue;
            if (a > 1) a = 1;
            const nd = dist / r;
            if (nd > hard) {
              const f = 1 - (nd - hard) * invSoft;
              a *= f <= 0 ? 0 : f * f * (3 - 2 * f);
            }
            if (a <= 0) continue;
            const i = py * TILE + px;
            const prev = m[i];
            if (prev >= cap) continue;
            const nm = prev + (cap - prev) * a * flow;
            m[i] = nm;
            const j = i * 4;
            const oa = orig ? orig[j + 3] / 255 : 0;
            if (this.erase) {
              t[j + 3] = Math.round(oa * (1 - nm) * 255);
              if (orig) { t[j] = orig[j]; t[j + 1] = orig[j + 1]; t[j + 2] = orig[j + 2]; }
            } else {
              const na = nm + oa * (1 - nm);
              if (na <= 0) continue;
              const wo = (oa * (1 - nm)) / na, wc = nm / na;
              t[j] = orig ? cr * wc + orig[j] * wo : cr;
              t[j + 1] = orig ? cg * wc + orig[j + 1] * wo : cg;
              t[j + 2] = orig ? cb * wc + orig[j + 2] * wo : cb;
              t[j + 3] = na * 255;
            }
          }
        }
        L.touch(k);
      }
    }
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
    for (const k of this.patch.saved.keys()) {
      const t = this.layer.getTile(k);
      if (t && isTileEmpty(t)) this.layer.setTile(k, null);
    }
    this.mask.clear();
    return this.patch.saved.size ? this.patch : null;
  }
}

