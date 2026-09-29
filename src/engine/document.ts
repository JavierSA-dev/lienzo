import type { VectorPath } from './path';
import {
  TILE, type BlendMode, type LayerInfo, type Rect, type RGBA, type LayerKind, type AdjustmentParams,
  type TextParams, type ShapeParams, type LayerEffects,
} from './types';
import type { Selection } from './selection';

/** Clave numérica de un tile; admite índices negativos (capas desplazadas). */
export const tileKey = (tx: number, ty: number) => (ty + 32768) * 65536 + (tx + 32768);
export const keyTx = (k: number) => (k % 65536) - 32768;
export const keyTy = (k: number) => Math.floor(k / 65536) - 32768;

export const TILE_BYTES = TILE * TILE * 4;

export function newTile(): Uint8ClampedArray {
  return new Uint8ClampedArray(TILE_BYTES);
}

export function isTileEmpty(t: Uint8ClampedArray): boolean {
  // Recorre sólo el canal alfa; vista de 32 bits para ir 4x más rápido.
  const u = new Uint32Array(t.buffer, t.byteOffset, t.length >> 2);
  for (let i = 0; i < u.length; i++) if (u[i] & 0xff000000) return false;
  return true;
}

let nextLayerId = 1;

/**
 * Tiles que alguna vez se han compartido entre capas (al duplicar). Nunca se
 * escriben en su sitio: quien vaya a modificarlos hace antes una copia.
 * Es seguro aunque el historial vuelva a colocar el mismo tile en otra capa.
 */
const SHARED = new WeakSet<Uint8ClampedArray>();

/**
 * Máscara de capa: un canal de 8 bits por tiles en coordenadas locales de la capa
 * (se mueve con ella). Donde no hay tile vale `fill` (255 = mostrar, 0 = ocultar).
 */
export class MaskChannel {
  tiles = new Map<number, Uint8Array>();
  fill: number;
  gpuDirty = new Set<number>();
  gpuRemoved = new Set<number>();
  constructor(fill = 255) { this.fill = fill; }

  getTile(k: number) { return this.tiles.get(k); }

  ensureTile(k: number): Uint8Array {
    let t = this.tiles.get(k);
    if (!t) { t = new Uint8Array(TILE * TILE).fill(this.fill); this.tiles.set(k, t); this.gpuRemoved.delete(k); }
    return t;
  }

  setTile(k: number, t: Uint8Array | null) {
    if (t) { this.tiles.set(k, t); this.gpuRemoved.delete(k); this.gpuDirty.add(k); }
    else if (this.tiles.has(k)) { this.tiles.delete(k); this.gpuDirty.delete(k); this.gpuRemoved.add(k); }
  }

  touch(k: number) { this.gpuDirty.add(k); }

  get(lx: number, ly: number): number {
    const tx = Math.floor(lx / TILE), ty = Math.floor(ly / TILE);
    const t = this.tiles.get(tileKey(tx, ty));
    return t ? t[(ly - ty * TILE) * TILE + (lx - tx * TILE)] : this.fill;
  }

  clone(): MaskChannel {
    const m = new MaskChannel(this.fill);
    for (const [k, t] of this.tiles) m.setTile(k, t.slice());
    return m;
  }

  byteSize() { return this.tiles.size * TILE * TILE; }
}

/**
 * Capa de píxeles dispersa: sólo existen los tiles con contenido.
 * Los tiles están en coordenadas locales; (x, y) es el desplazamiento en el documento.
 * Píxeles RGBA de 8 bits con alfa directo (no premultiplicado).
 */
export class PixelLayer {
  id = nextLayerId++;
  name: string;
  visible = true;
  opacity = 1;
  blend: BlendMode = 'normal';
  x = 0;
  y = 0;
  tiles = new Map<number, Uint8ClampedArray>();
  /** Tiles cuyo contenido cambió y el compositor aún no ha subido a la GPU. */
  gpuDirty = new Set<number>();
  /** Tiles eliminados que el compositor debe liberar. */
  gpuRemoved = new Set<number>();
  kind: LayerKind = 'pixel';
  mask: MaskChannel | null = null;
  maskEnabled = true;
  /** Bloquear píxeles transparentes: pintar sólo donde ya hay contenido. */
  lockAlpha = false;
  adjustment?: AdjustmentParams;
  text?: TextParams;
  shape?: ShapeParams;
  effects?: LayerEffects;
  /** Capas auxiliares con los estilos (sombra/resplandor debajo, trazo/superposición encima). */
  fxUnder: PixelLayer | null = null;
  fxOver: PixelLayer | null = null;
  /** Versión de contenido: cambia al editar (para invalidar cachés como los estilos). */
  version = 0;
  /** Grupo que la contiene (null = raíz del documento). */
  parent: number | null = null;
  /** Máscara de recorte: se recorta a la capa base (la primera no recortada de debajo). */
  clipped = false;
  /** Grupo plegado en el panel de capas. */
  collapsed = false;

  constructor(name: string) {
    this.name = name;
  }

  info(): LayerInfo {
    return {
      id: this.id, name: this.name, kind: this.kind, visible: this.visible, opacity: this.opacity, blend: this.blend,
      x: this.x, y: this.y, hasMask: !!this.mask, maskEnabled: this.maskEnabled, lockAlpha: this.lockAlpha,
      adjustment: this.adjustment, text: this.text, shape: this.shape, effects: this.effects,
      parent: this.parent, clipped: this.clipped, collapsed: this.kind === 'group' ? this.collapsed : undefined,
    };
  }

  getTile(k: number): Uint8ClampedArray | undefined {
    return this.tiles.get(k);
  }

  /**
   * Devuelve el tile listo para escribir: lo crea vacío si no existe y lo copia
   * si está compartido con otra capa (copia en escritura).
   */
  ensureTile(k: number): Uint8ClampedArray {
    let t = this.tiles.get(k);
    if (!t) {
      t = newTile();
      this.tiles.set(k, t);
      this.gpuRemoved.delete(k);
    } else if (SHARED.has(t)) {
      t = t.slice();
      this.tiles.set(k, t);
    }
    return t;
  }

  setTile(k: number, t: Uint8ClampedArray | null) {
    this.version++;
    if (t) {
      this.tiles.set(k, t);
      this.gpuRemoved.delete(k);
      this.gpuDirty.add(k);
    } else if (this.tiles.has(k)) {
      this.tiles.delete(k);
      this.gpuDirty.delete(k);
      this.gpuRemoved.add(k);
    }
  }

  touch(k: number) {
    this.gpuDirty.add(k);
    this.version++;
  }

  /** Borra todo el contenido de píxeles (p. ej. antes de re-rasterizar texto). */
  clearTiles() {
    for (const k of [...this.tiles.keys()]) this.setTile(k, null);
  }

  /** Límites del contenido en coordenadas del documento, a nivel de tile. */
  bounds(): Rect | null {
    if (this.tiles.size === 0) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of this.tiles.keys()) {
      const tx = keyTx(k), ty = keyTy(k);
      x0 = Math.min(x0, tx); y0 = Math.min(y0, ty);
      x1 = Math.max(x1, tx + 1); y1 = Math.max(y1, ty + 1);
    }
    return { x: x0 * TILE + this.x, y: y0 * TILE + this.y, w: (x1 - x0) * TILE, h: (y1 - y0) * TILE };
  }

  clone(name: string): PixelLayer {
    const l = new PixelLayer(name);
    l.visible = this.visible;
    l.opacity = this.opacity;
    l.blend = this.blend;
    l.x = this.x;
    l.y = this.y;
    l.kind = this.kind;
    l.parent = this.parent;
    l.clipped = this.clipped;
    l.collapsed = this.collapsed;
    l.lockAlpha = this.lockAlpha;
    l.maskEnabled = this.maskEnabled;
    l.mask = this.mask?.clone() ?? null;
    l.adjustment = this.adjustment && structuredClone(this.adjustment);
    l.text = this.text && structuredClone(this.text);
    l.shape = this.shape && structuredClone(this.shape);
    l.effects = this.effects && structuredClone(this.effects);
    // Duplicar es instantáneo: se comparten los tiles hasta que alguna capa los modifica.
    for (const [k, t] of this.tiles) {
      l.tiles.set(k, t);
      l.gpuDirty.add(k);
      SHARED.add(t);
    }
    return l;
  }

  byteSize(): number {
    return this.tiles.size * TILE_BYTES + (this.mask?.byteSize() ?? 0);
  }

  /** Valor efectivo de la máscara (0..255) en coordenadas de documento. */
  maskAt(dx: number, dy: number): number {
    if (!this.mask || !this.maskEnabled) return 255;
    return this.mask.get(dx - this.x, dy - this.y);
  }

  /** Lee un píxel en coordenadas del documento. */
  pixel(dx: number, dy: number): RGBA {
    const lx = dx - this.x, ly = dy - this.y;
    const tx = Math.floor(lx / TILE), ty = Math.floor(ly / TILE);
    const t = this.tiles.get(tileKey(tx, ty));
    if (!t) return [0, 0, 0, 0];
    const i = ((ly - ty * TILE) * TILE + (lx - tx * TILE)) * 4;
    return [t[i], t[i + 1], t[i + 2], t[i + 3]];
  }

  /** Copia una región RGBA (w*h*4, alfa directo) a los tiles, en coordenadas locales. */
  writeRegion(data: Uint8ClampedArray, w: number, h: number, lx: number, ly: number) {
    const tx0 = Math.floor(lx / TILE), ty0 = Math.floor(ly / TILE);
    const tx1 = Math.floor((lx + w - 1) / TILE), ty1 = Math.floor((ly + h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const k = tileKey(tx, ty);
        const existing = this.tiles.has(k);
        const t = existing ? this.ensureTile(k) : newTile();
        const ox = tx * TILE, oy = ty * TILE;
        const x0 = Math.max(lx, ox), x1 = Math.min(lx + w, ox + TILE);
        const y0 = Math.max(ly, oy), y1 = Math.min(ly + h, oy + TILE);
        const rowLen = (x1 - x0) * 4;
        for (let y = y0; y < y1; y++) {
          const src = ((y - ly) * w + (x0 - lx)) * 4;
          const dst = ((y - oy) * TILE + (x0 - ox)) * 4;
          t.set(data.subarray(src, src + rowLen), dst);
        }
        if (existing || !isTileEmpty(t)) this.setTile(k, t);
      }
    }
  }

  /** Lee una región en coordenadas locales como RGBA (alfa directo). */
  readRegion(lx: number, ly: number, w: number, h: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(w * h * 4);
    const tx0 = Math.floor(lx / TILE), ty0 = Math.floor(ly / TILE);
    const tx1 = Math.floor((lx + w - 1) / TILE), ty1 = Math.floor((ly + h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.tiles.get(tileKey(tx, ty));
        if (!t) continue;
        const ox = tx * TILE, oy = ty * TILE;
        const x0 = Math.max(lx, ox), x1 = Math.min(lx + w, ox + TILE);
        const y0 = Math.max(ly, oy), y1 = Math.min(ly + h, oy + TILE);
        for (let y = y0; y < y1; y++) {
          const src = ((y - oy) * TILE + (x0 - ox)) * 4;
          out.set(t.subarray(src, src + (x1 - x0) * 4), ((y - ly) * w + (x0 - lx)) * 4);
        }
      }
    }
    return out;
  }
}

export interface Snapshot {
  id: number;
  name: string;
  width: number;
  height: number;
  layers: PixelLayer[];
  /** id de la capa del documento -> su copia en la instantánea (para el pincel de historia). */
  map: Map<number, PixelLayer>;
  activeIndex: number;
}

/** Copia capas conservando la jerarquía de grupos (los tiles se comparten, copia en escritura). */
export function cloneLayers(list: PixelLayer[]): { copies: PixelLayer[]; map: Map<number, PixelLayer> } {
  const map = new Map<number, PixelLayer>();
  const copies = list.map((l) => { const c = l.clone(l.name); map.set(l.id, c); return c; });
  for (const c of copies) if (c.parent != null) c.parent = map.get(c.parent)?.id ?? null;
  return { copies, map };
}

export class EditorDocument {
  name: string;
  width: number;
  height: number;
  layers: PixelLayer[] = []; // de abajo a arriba
  activeLayerId = 0;
  selection: Selection | null = null;
  /** true = las herramientas de pintura actúan sobre la máscara de la capa activa. */
  editMask = false;
  /** Capas seleccionadas a la vez (Ctrl/Mayús+clic en el panel). Siempre incluye la activa. */
  selectedIds = new Set<number>();
  /** Trazados (pluma). `work` = trazado de trabajo, se reemplaza al dibujar uno nuevo. */
  paths: { id: number; name: string; work: boolean; path: VectorPath }[] = [];
  /** Guías (Vista > Nueva guía o arrastrando desde las reglas). pos en px de documento. */
  guides: { id: number; dir: 'h' | 'v'; pos: number }[] = [];
  activePathId: number | null = null;

  /** Capas seleccionadas que siguen existiendo, en el orden del documento. */
  selected(): PixelLayer[] {
    const a = this.active();
    // La selección múltiple sólo vale si incluye la capa activa (si no, se ha cambiado de capa).
    if (!a || !this.selectedIds.has(a.id)) return a ? [a] : [];
    return this.layers.filter((l) => this.selectedIds.has(l.id));
  }
  dirty = false;

  constructor(name: string, width: number, height: number) {
    this.name = name;
    this.width = width;
    this.height = height;
  }

  get tilesX() { return Math.ceil(this.width / TILE); }
  get tilesY() { return Math.ceil(this.height / TILE); }

  active(): PixelLayer | undefined {
    return this.layers.find((l) => l.id === this.activeLayerId) ?? this.layers[this.layers.length - 1];
  }

  layer(id: number): PixelLayer | undefined {
    return this.layers.find((l) => l.id === id) ?? this.extras.find((l) => l.id === id);
  }

  /** Capas internas que no se ven en el panel (p. ej. la máscara rápida), para el historial. */
  extras: PixelLayer[] = [];
  /** Canales alfa (selecciones guardadas). Sus tiles no se modifican nunca: se comparten sin copiar. */
  alphas: { id: number; name: string; tiles: Map<number, Uint8Array> }[] = [];
  /** Instantáneas (panel Historial): copias ligeras del documento (los tiles se comparten). */
  snapshots: Snapshot[] = [];
  /** Instantánea de origen del pincel de historia. */
  historySource: number | null = null;

  indexOf(id: number): number {
    return this.layers.findIndex((l) => l.id === id);
  }

  // ------------------------------------------------------------ árbol de grupos
  // doc.layers es el árbol aplanado en profundidad: los hijos de un grupo (de abajo a
  // arriba) van justo debajo de él. normalize() restablece ese orden tras editarlo.

  /** Hijos directos de un grupo (null = raíz), de abajo a arriba. */
  children(parent: number | null): PixelLayer[] {
    return this.layers.filter((l) => l.parent === parent);
  }

  /** Todos los descendientes de un grupo, en el orden del documento. */
  descendants(id: number): PixelLayer[] {
    const out: PixelLayer[] = [];
    const walk = (pid: number) => { for (const c of this.children(pid)) { if (c.kind === 'group') walk(c.id); out.push(c); } };
    walk(id);
    return this.layers.filter((l) => out.includes(l));
  }

  /** ¿`a` es `b` o está dentro de `b`? */
  isInside(a: PixelLayer, b: PixelLayer): boolean {
    for (let l: PixelLayer | undefined = a; l; l = l.parent != null ? this.layer(l.parent) : undefined) if (l === b) return true;
    return false;
  }

  /** Visible y con todos sus grupos visibles. */
  effectivelyVisible(L: PixelLayer): boolean {
    for (let l: PixelLayer | undefined = L; l; l = l.parent != null ? this.layer(l.parent) : undefined) if (!l.visible) return false;
    return true;
  }

  depth(L: PixelLayer): number {
    let n = 0;
    for (let l = L; l.parent != null; n++) { const p = this.layer(l.parent); if (!p) break; l = p; }
    return n;
  }

  /** Reordena doc.layers en profundidad según parent y el orden relativo actual. */
  normalize() {
    const ids = new Set(this.layers.map((l) => l.id));
    for (const l of this.layers) if (l.parent != null && !ids.has(l.parent)) l.parent = null;
    const out: PixelLayer[] = [];
    const walk = (pid: number | null) => {
      for (const c of this.children(pid)) { if (c.kind === 'group') walk(c.id); out.push(c); }
    };
    walk(null);
    this.layers = out;
  }

  /** Rellena una capa entera (o un rectángulo) con un color. */
  static fillLayer(layer: PixelLayer, rect: Rect, color: RGBA) {
    const [r, g, b, a] = color;
    const lx0 = rect.x - layer.x, ly0 = rect.y - layer.y;
    const tx0 = Math.floor(lx0 / TILE), ty0 = Math.floor(ly0 / TILE);
    const tx1 = Math.floor((lx0 + rect.w - 1) / TILE), ty1 = Math.floor((ly0 + rect.h - 1) / TILE);
    const px = (a << 24) | (b << 16) | (g << 8) | r; // little-endian RGBA
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const k = tileKey(tx, ty);
        const t = layer.ensureTile(k);
        const u = new Uint32Array(t.buffer, t.byteOffset, TILE * TILE);
        const ox = tx * TILE, oy = ty * TILE;
        const x0 = Math.max(lx0, ox) - ox, x1 = Math.min(lx0 + rect.w, ox + TILE) - ox;
        const y0 = Math.max(ly0, oy) - oy, y1 = Math.min(ly0 + rect.h, oy + TILE) - oy;
        for (let y = y0; y < y1; y++) u.fill(px >>> 0, y * TILE + x0, y * TILE + x1);
        layer.setTile(k, a === 0 && isTileEmpty(t) ? null : t);
      }
    }
  }
}
