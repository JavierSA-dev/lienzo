import { TILE, DEFAULT_DYN, type BrushSettings, type BrushDynamics, type DynControl, type Rect, type RGBA, type Symmetry } from './types';
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
  /** Pincel de historia: pinta los píxeles de esta capa (estado de una instantánea). */
  sourceLayer?: PixelLayer;
  /** Lápiz: bordes sin suavizar. */
  aliased?: boolean;
  label?: string;
  /** Pinceles correctores: sólo cambia el nombre del paso del historial. */
  healTool?: 'spotHeal' | 'heal' | 'remove';
  /** Puntas muestreadas registradas (alfa 0..1). */
  tips?: Map<string, BrushTip>;
  /** Pintura simétrica. */
  symmetry?: Symmetry | null;
  /** Color de fondo (dinámica frontal/fondo). */
  bgColor?: RGBA;
  /** Depósito del pincel mezclador (persiste entre trazos). */
  mixerState?: { color: RGBA | null };
}

export interface BrushTip { w: number; h: number; a: Float32Array }

interface Dab { x: number; y: number; r: number; angle: number; round: number; flipX: boolean; flipY: boolean; op: number; flow: number; color: RGBA }

/** Aleatorio determinista por trazo (el mismo trazo se repite igual al rehacer). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

function rgb2hsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx / 255];
}
function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h / 60) % 6; return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255; };
  return [f(5), f(3), f(1)];
}

/** Transformaciones de la simetría: centro, matriz 2×2 y si es reflejo. */
function symmetryOps(sym: Symmetry | null | undefined): { m: [number, number, number, number]; mirror: boolean; rot: number; axis: number }[] {
  const id = { m: [1, 0, 0, 1] as [number, number, number, number], mirror: false, rot: 0, axis: 0 };
  if (!sym) return [id];
  const rotOp = (a: number) => ({ m: [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)] as [number, number, number, number], mirror: false, rot: a, axis: 0 });
  // Reflejo respecto al eje que pasa por el centro con ángulo φ.
  const mirOp = (phi: number) => ({ m: [Math.cos(2 * phi), Math.sin(2 * phi), Math.sin(2 * phi), -Math.cos(2 * phi)] as [number, number, number, number], mirror: true, rot: 0, axis: phi });
  const base = (sym.angle * Math.PI) / 180;
  switch (sym.type) {
    case 'vertical': return [id, mirOp(base + Math.PI / 2)];
    case 'horizontal': return [id, mirOp(base)];
    case 'dual': return [id, mirOp(base + Math.PI / 2), mirOp(base), rotOp(Math.PI)];
    case 'diagonal': return [id, mirOp(base + Math.PI / 4)];
    case 'radial': { const n = Math.max(2, sym.segments | 0); return Array.from({ length: n }, (_, k) => (k ? rotOp((2 * Math.PI * k) / n) : id)); }
    case 'mandala': {
      const n = Math.max(2, sym.segments | 0), out = [];
      for (let k = 0; k < n; k++) { out.push(k ? rotOp((2 * Math.PI * k) / n) : id); out.push(mirOp(base + (Math.PI * k) / n)); }
      return out;
    }
  }
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
  private smoothPt: { x: number; y: number } | null = null;
  private dir = 0;
  private dir0: number | null = null;
  private nStamp = 0;
  private rand = rng((Math.random() * 2 ** 31) | 0);
  private strokeColor: RGBA | null = null;
  private paint = 1;
  private syms = symmetryOps(null);
  dirty: Rect | null = null;
  /** Zona total tocada por el trazo (coordenadas de documento). */
  total: Rect | null = null;

  get layerId() { return this.o.layer.id; }

  constructor(o: StrokeOptions) {
    this.o = o;
    const names: Record<BrushMode, string> = { paint: 'Pincel', erase: 'Borrador', clone: 'Tampón de clonar', dodge: 'Sobreexponer', burn: 'Subexponer', blur: 'Desenfocar', sharpen: 'Enfocar', smudge: 'Dedo' };
    if (!o.label && o.healTool) o.label = o.healTool === 'spotHeal' ? 'Pincel corrector puntual' : o.healTool === 'remove' ? 'Quitar' : 'Pincel corrector';
    this.patch = new TilePatch(o.label ?? (o.target === 'mask' ? `${names[o.mode]} (máscara)` : o.settings.mixer && o.mode === 'paint' ? 'Pincel mezclador' : names[o.mode]), o.layer, o.target);
    this.syms = symmetryOps(o.symmetry);
    const mx = o.settings.mixer;
    if (mx && o.mixerState) {
      if (mx.cleanEach) o.mixerState.color = null;
      if (mx.loadEach || !o.mixerState.color) o.mixerState.color = mx.loadEach || !mx.cleanEach ? [...o.color] as RGBA : o.mixerState.color;
    }
  }

  /** Añade un punto (coordenadas de documento) e interpola dabs según el espaciado. */
  addPoint(x: number, y: number, pressure: number) {
    // Suavizado: el pincel sigue al puntero con una «correa» (menos temblor).
    const sm = this.o.settings.smoothing ?? 0;
    if (sm > 0) {
      if (!this.smoothPt) this.smoothPt = { x, y };
      else { const k = 1 - sm * 0.92; this.smoothPt = { x: this.smoothPt.x + (x - this.smoothPt.x) * k, y: this.smoothPt.y + (y - this.smoothPt.y) * k }; }
      ({ x, y } = this.smoothPt);
    }
    const p = pressure > 0 ? pressure : 1;
    if (!this.last) {
      this.stamp(x, y, p);
      this.last = { x, y, p };
      this.untilNext = this.stepAt(p);
      return;
    }
    if (Math.hypot(x - this.last.x, y - this.last.y) > 0.5) {
      this.dir = Math.atan2(y - this.last.y, x - this.last.x);
      if (this.dir0 === null) this.dir0 = this.dir;
    }
    const { x: lx, y: ly, p: lp } = this.last;
    const dist = Math.hypot(x - lx, y - ly);
    let pos = this.untilNext;
    while (pos <= dist) {
      const t = pos / dist;
      const pp = lp + (p - lp) * t;
      this.stamp(lx + (x - lx) * t, ly + (y - ly) * t, pp);
      pos += this.stepAt(pp);
    }
    this.untilNext = pos - dist;
    this.last = { x, y, p };
  }

  private stepAt(pressure: number) {
    const s = this.o.settings;
    return Math.max(1, s.size * (s.pressureSize ? pressure : 1) * s.spacing * (s.tip ? 1 : Math.max(0.2, s.roundness ?? 1)));
  }

  private ctrl(c: DynControl, p: number, d: BrushDynamics): number {
    switch (c) {
      case 'pressure': return p;
      case 'fade': return Math.max(0, 1 - this.nStamp / Math.max(1, d.fadeSteps));
      default: return 1;
    }
  }

  /** Un «estampado» en el trazo: aplica dinámicas, dispersión, color y simetría y pinta los dabs. */
  private stamp(cx: number, cy: number, pressure: number) {
    const s = this.o.settings, d = { ...DEFAULT_DYN, ...s.dyn }, R = this.rand;
    this.nStamp++;
    const count = Math.max(1, Math.round(d.count * (1 - d.countJitter * R())));
    for (let k = 0; k < count; k++) {
      let size = s.size * (s.pressureSize ? pressure : 1);
      if (d.sizeControl !== 'off') size *= Math.max(d.minDiameter, this.ctrl(d.sizeControl, pressure, d));
      if (d.sizeJitter) size *= Math.max(d.minDiameter, 1 - d.sizeJitter * R());
      let angle = s.angle ?? 0;
      if (d.angleControl === 'direction') angle += (this.dir * 180) / Math.PI;
      else if (d.angleControl === 'initialDirection') angle += ((this.dir0 ?? 0) * 180) / Math.PI;
      if (d.angleJitter) angle += (R() - 0.5) * 360 * d.angleJitter;
      let round = s.roundness ?? 1;
      if (d.roundJitter) round = Math.max(d.minRoundness, round * (1 - d.roundJitter * R()));
      let x = cx, y = cy;
      if (d.scatter) {
        const amt = d.scatter * size;
        if (d.scatterBoth) { x += (R() - 0.5) * 2 * amt; y += (R() - 0.5) * 2 * amt; }
        else { const o = (R() - 0.5) * 2 * amt; x += -Math.sin(this.dir) * o; y += Math.cos(this.dir) * o; }
      }
      let op = (s.pressureOpacity ? pressure : 1) * this.ctrl(d.opacityControl, pressure, d);
      if (d.opacityJitter) op *= 1 - d.opacityJitter * R();
      let flow = this.ctrl(d.flowControl, pressure, d);
      if (d.flowJitter) flow *= 1 - d.flowJitter * R();
      const color = this.dabColor(d, pressure, x, y, size);
      if (color === null) continue;
      for (const t of this.syms) {
        let X = x, Y = y, A = angle, fx = !!s.flipX, fy = !!s.flipY;
        if (t.m[0] !== 1 || t.m[1] !== 0 || t.m[3] !== 1) {
          const sym = this.o.symmetry!, dx = x - sym.cx, dy = y - sym.cy;
          X = sym.cx + t.m[0] * dx + t.m[1] * dy; Y = sym.cy + t.m[2] * dx + t.m[3] * dy;
          if (t.mirror) { A = (2 * t.axis * 180) / Math.PI - angle; fy = !fy; } else A = angle + (t.rot * 180) / Math.PI;
        }
        this.dab({ x: X, y: Y, r: Math.max(0.5, size / 2), angle: A, round, flipX: fx, flipY: fy, op, flow, color });
      }
    }
  }

  /** Color del dab: dinámica de color y pincel mezclador. null = no pintar (sin pintura). */
  private dabColor(d: BrushDynamics, pressure: number, x: number, y: number, size: number): RGBA | null {
    const s = this.o.settings;
    let c: RGBA = this.o.color;
    if (s.mixer && this.o.mode === 'paint' && this.o.target === 'pixels' && this.o.mixerState) {
      const st = this.o.mixerState, mx = s.mixer;
      // Pintura del lienzo bajo el pincel (media de 5 puntos).
      let r = 0, g = 0, b = 0, a = 0;
      for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = this.o.layer.pixel(Math.floor(x + (ox * size) / 4), Math.floor(y + (oy * size) / 4));
        const qa = q[3] / 255; r += q[0] * qa; g += q[1] * qa; b += q[2] * qa; a += qa;
      }
      const canvas: RGBA | null = a > 0.05 ? [r / a, g / a, b / a, 255] : null;
      const res = st.color;
      if (!res && !canvas) return null;
      let out: RGBA;
      if (!res) out = canvas!;
      else if (!canvas) out = res;
      else { const w = mx.wet; out = [res[0] + (canvas[0] - res[0]) * w, res[1] + (canvas[1] - res[1]) * w, res[2] + (canvas[2] - res[2]) * w, 255]; }
      // El depósito se contamina con lo que recoge y se va gastando.
      if (res && canvas) { const k = mx.mix * 0.25; st.color = [res[0] + (canvas[0] - res[0]) * k, res[1] + (canvas[1] - res[1]) * k, res[2] + (canvas[2] - res[2]) * k, 255]; }
      this.paint = Math.max(res ? 0.15 : 1, this.paint * (1 - (1 - mx.load) * 0.03));
      return out;
    }
    const colorDyn = d.fgBgJitter || d.fgBgControl !== 'off' || d.hueJitter || d.satJitter || d.briJitter;
    if (!colorDyn) return c;
    if (!d.perTip && this.strokeColor) return this.strokeColor;
    const R = this.rand;
    let t = d.fgBgJitter * R();
    if (d.fgBgControl !== 'off') t = Math.max(t, 1 - this.ctrl(d.fgBgControl, pressure, d));
    const bg = this.o.bgColor ?? [255, 255, 255, 255];
    c = [c[0] + (bg[0] - c[0]) * t, c[1] + (bg[1] - c[1]) * t, c[2] + (bg[2] - c[2]) * t, 255];
    if (d.hueJitter || d.satJitter || d.briJitter) {
      let [h, sa, v] = rgb2hsv(c[0], c[1], c[2]);
      h = (h + (R() - 0.5) * 360 * d.hueJitter + 360) % 360;
      sa = Math.max(0, Math.min(1, sa * (1 - d.satJitter * R())));
      v = Math.max(0, Math.min(1, v * (1 - d.briJitter * R())));
      const [r, g, b] = hsv2rgb(h, sa, v);
      c = [r, g, b, 255];
    }
    this.strokeColor = c;
    return c;
  }

  private dab(D: Dab) {
    const { settings: s, layer: L, clip, selection: sel, mode, target, aliased } = this.o;
    const cx = D.x, cy = D.y, r = D.r;
    const mixAmt = s.mixer && mode === 'paint' ? this.paint : 1;
    const cap = s.opacity * D.op * mixAmt;
    const flow = s.flow * D.flow;
    const hard = aliased ? 0.999 : Math.min(0.999, Math.max(0, s.hardness));
    const invSoft = 1 / (1 - hard);
    // Forma: punta redonda (con ángulo y redondez) o muestreada.
    const tip = s.tip ? this.o.tips?.get(s.tip) ?? null : null;
    const ang = (D.angle * Math.PI) / 180, ca = Math.cos(ang), sn = Math.sin(ang);
    const tmax = tip ? Math.max(tip.w, tip.h) : 1;
    const rx = tip ? (r * tip.w) / tmax : r, ry = (tip ? (r * tip.h) / tmax : r) * Math.max(0.01, D.round);
    const round = !tip && Math.abs(D.round - 1) < 1e-3;
    const ext = round ? r : Math.hypot(rx, ry);
    const noise = !!s.noise, wet = !!s.wetEdges;

    const x0 = Math.max(Math.floor(cx - ext - 1), clip.x);
    const y0 = Math.max(Math.floor(cy - ext - 1), clip.y);
    const x1 = Math.min(Math.ceil(cx + ext + 1), clip.x + clip.w);
    const y1 = Math.min(Math.ceil(cy + ext + 1), clip.y + clip.h);
    if (x1 <= x0 || y1 <= y0) return;
    this.grow({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });

    const [cr, cg, cb] = D.color;
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
    if (mode === 'smudge' && !mask) { this.smudgeDab(cx, cy, r, x0, y0, x1, y1, cap, hard, invSoft, selAt); return; }

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
            let a: number;
            if (round) {
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (aliased) a = dist <= r ? 1 : 0;
              else {
                a = r + 0.5 - dist;
                if (a <= 0) continue;
                if (a > 1) a = 1;
                const nd = dist / r;
                if (nd > hard) { const f = 1 - (nd - hard) * invSoft; a *= f <= 0 ? 0 : f * f * (3 - 2 * f); }
              }
            } else {
              let u = dx * ca + dy * sn, v = -dx * sn + dy * ca;
              if (D.flipX) u = -u;
              if (D.flipY) v = -v;
              if (tip) {
                const tu = (u / rx) * 0.5 * tip.w + tip.w / 2 - 0.5, tv = (v / ry) * 0.5 * tip.h + tip.h / 2 - 0.5;
                if (tu < -1 || tv < -1 || tu > tip.w || tv > tip.h) continue;
                const ix = Math.floor(tu), iy = Math.floor(tv), fx = tu - ix, fy = tv - iy;
                const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= tip.w || yy >= tip.h ? 0 : tip.a[yy * tip.w + xx]);
                a = (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
              } else {
                const nd = Math.sqrt((u / rx) ** 2 + (v / ry) ** 2);
                a = (1 - nd) * Math.min(rx, ry) + 0.5;
                if (a <= 0) continue;
                if (a > 1) a = 1;
                if (aliased) a = nd <= 1 ? 1 : 0;
                else if (nd > hard) { const f = 1 - (nd - hard) * invSoft; a *= f <= 0 ? 0 : f * f * (3 - 2 * f); }
              }
            }
            if (a <= 0) continue;
            if (noise && a < 0.999) { const hh = Math.imul((ox + px + L.x) * 73856093 ^ (oy + py + L.y) * 19349663, 2654435761) >>> 0; a *= 0.35 + 0.65 * ((hh & 1023) / 1023); }
            if (wet) a *= 0.5 + 0.8 * a * (1 - a) * 2;
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
            if (this.o.sourceLayer) {
              const src = this.o.sourceLayer.pixel(docX, docY);
              sr = src[0]; sg = src[1]; sb = src[2]; sa = src[3] / 255;
              // Donde el estado de origen es transparente, el pincel de historia borra.
              if (sa <= 0) {
                const O2 = orig as Uint8ClampedArray | null, T2 = t as Uint8ClampedArray, j2 = i * 4;
                if (O2) { T2[j2] = O2[j2]; T2[j2 + 1] = O2[j2 + 1]; T2[j2 + 2] = O2[j2 + 2]; T2[j2 + 3] = O2[j2 + 3] * (1 - nm); }
                continue;
              }
            } else if (clone) {
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

  private lastSmudge: { x: number; y: number } | null = null;

  /**
   * Dedo: cada toque desplaza el contenido de debajo en la dirección del trazo
   * (muestreo bilineal del contenido actual), así que el color se arrastra y se va diluyendo.
   */
  private smudgeDab(cx: number, cy: number, r: number, x0: number, y0: number, x1: number, y1: number, cap: number,
    hard: number, invSoft: number, selAt: (x: number, y: number) => number) {
    const L = this.o.layer;
    const last = this.lastSmudge;
    this.lastSmudge = { x: cx, y: cy };
    if (!last) return;
    const ddx = cx - last.x, ddy = cy - last.y;
    const w = x1 - x0, h = y1 - y0;
    const out = new Float32Array(w * h * 4), k = new Float32Array(w * h);
    const px = (x: number, y: number, c: number) => {
      const lx = x - L.x, ly = y - L.y;
      const tx = Math.floor(lx / TILE), ty = Math.floor(ly / TILE);
      const t = L.getTile(tileKey(tx, ty));
      return t ? t[((ly - ty * TILE) * TILE + (lx - tx * TILE)) * 4 + c] : 0;
    };
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dist = Math.sqrt(dx * dx + dy * dy);
        let a = r + 0.5 - dist;
        if (a <= 0) continue;
        if (a > 1) a = 1;
        const nd = dist / r;
        if (nd > hard) { const f = 1 - (nd - hard) * invSoft; a *= f <= 0 ? 0 : f * f * (3 - 2 * f); }
        const sv = selAt(x, y);
        if (a <= 0 || !sv) continue;
        const i = (y - y0) * w + (x - x0);
        k[i] = a * cap * (sv / 255);
        // Origen: el punto de donde viene el dedo (bilineal, premultiplicado).
        const sx = x - ddx, sy = y - ddy;
        const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
        let ar = 0, ag = 0, ab = 0, aa = 0;
        for (const [ox, oy, wgt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]] as const) {
          if (!wgt) continue;
          const al = px(ix + ox, iy + oy, 3) / 255;
          ar += px(ix + ox, iy + oy, 0) * al * wgt; ag += px(ix + ox, iy + oy, 1) * al * wgt; ab += px(ix + ox, iy + oy, 2) * al * wgt; aa += al * wgt;
        }
        out[i * 4] = ar; out[i * 4 + 1] = ag; out[i * 4 + 2] = ab; out[i * 4 + 3] = aa;
      }
    }
    // Escritura (después de leer todo, para no arrastrar lo recién escrito).
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y - y0) * w + (x - x0), kk = k[i];
        if (!kk) continue;
        const lx = x - L.x, ly = y - L.y;
        const tx = Math.floor(lx / TILE), ty = Math.floor(ly / TILE), key = tileKey(tx, ty);
        this.patch.capture(L, key);
        const T = L.ensureTile(key), j = ((ly - ty * TILE) * TILE + (lx - tx * TILE)) * 4;
        const ta = T[j + 3] / 255;
        const na = ta + (out[i * 4 + 3] - ta) * kk;
        for (let c = 0; c < 3; c++) {
          const pre = T[j + c] * ta + (out[i * 4 + c] - T[j + c] * ta) * kk;
          T[j + c] = na > 0 ? pre / na : 0;
        }
        T[j + 3] = na * 255;
        L.touch(key);
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
