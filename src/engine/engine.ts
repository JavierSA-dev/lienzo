import {
  TILE, IDENTITY, type BrushSettings, type DocState, type FromWorker, type PointerMsg, type Rect, type RGBA,
  type SmartFilter, type Artboard, type ToolId, type ViewState, type BlendMode, type AdjustmentParams, type AdjustmentType, type TextParams,
  type ShapeParams, type LayerEffects, type Matrix,
} from './types';
import { EditorDocument, type AnimFrame, PixelLayer, MaskChannel, tileKey, keyTx, keyTy, cloneLayers, type SmartObject } from './document';
import { History, TilePatch, FnEntry, GroupEntry, type HistoryEntry } from './history';
import { BrushStroke, type BrushMode } from './brush';
import { Renderer } from './renderer';
import { Pool, shareable } from './pool';
import { importRaster, encodeRaster } from './io';
import { proofPixels, toCmyk } from './color';
import { encodeTiff, encodePdf, encodeGif, type ColorOut } from './encoders';
import { buildSvg } from './svgexport';
import {
  resampleLayer, applyLut, invertLut, brightnessContrastLut, desaturate, layerThumb, layerFromPixels, pruneEmpty,
  applyRegion, gradientPixels, type GradientType,
} from './ops';
import { Selection, floodMask, clampRect, forTiles, type CombineMode } from './selection';
import { filterApron, WHOLE_FILTERS, type FilterName, type FilterParams } from './filters';
import { defaultAdjustment, ADJUSTMENT_LABELS } from './adjust';
import { fixRedEye, strokeCoverage, type StrokeLocation } from './retouch';
import { rasterizeText, rasterizeShape, rasterLimit, mul, invert as invertM, textBox, transformRect } from './vector';
import { buildEffects, hasEffects, USER_PATTERNS, userPatternAt, pattern } from './effects';
import { downscale, quickRegion, upscaleMask, snapEdges, component, colorRange, refineMask, decontaminate, type ColorRangeParams, type RefineParams } from './smartsel';
import { fontReady, loadGoogleFont } from './fonts';
import { resetTextCache } from './text';
import { newVectorMask, nextRev, rasterVectorMask, combineMasks, type VectorMask } from './vmask';
import type { Symmetry, Stops, PatternId } from './types';
import { cameraRawBand, cameraRawApron, CAMERA_RAW_DEFAULTS, localRadius, type CameraRaw } from './camraw';
import type { ResampleMethod } from './resample';
import { blurGalleryBand, type BlurGallery } from './blurgal';
import { grayDown, detect, match, ransac, scaleH, mulH, mtbAlign, exposureFusion, type Pt as Pt2 } from './stitch';
import { blurF } from './camraw';
import { resample } from './resample';
import { applyH as applyHm, invertH } from './meshwarp';
import { specToMesh, specBounds, specMinScale, backMap, specForward, homography as homographyOf, toPts as toQuad, type WarpSpec } from './meshwarp';

/** Clave de caché de los estilos: contenido, máscara, posición y parámetros. */
function fxKey(L: PixelLayer): string {
  if (!hasEffects(L.effects)) return '';
  return `${L.version}|${L.mask ? `${L.mask.version}:${L.maskEnabled}` : '-'}|${L.vmask ? `${L.vmask.rev}:${L.vmask.enabled}` : '-'}|${L.x},${L.y}|${JSON.stringify(L.effects)}`;
}
function fxBounds(L: PixelLayer): Rect | null {
  let r: Rect | null = null;
  for (const f of L.fxLayers()) r = union(r, f.bounds());
  return r;
}
import { flatten as flattenPath, pathBounds, toSvg, isEmpty as isEmptyPath, clonePath, traceMask, type VectorPath } from './path';

/** Color neutro de cada modo de fusión (el que no cambia nada): gris 50 %, blanco o negro. */
export const NEUTRAL: Partial<Record<BlendMode, number>> = {
  overlay: 128, 'soft-light': 128, 'hard-light': 128, 'vivid-light': 128, 'linear-light': 128, 'pin-light': 128,
  multiply: 255, 'color-burn': 255, 'linear-burn': 255, darken: 255,
  divide: 255, 'darker-color': 255, 'lighter-color': 0,
  screen: 0, 'color-dodge': 0, 'linear-dodge': 0, lighten: 0, difference: 0, exclusion: 0, subtract: 0,
};

type Post = (m: FromWorker, transfer?: Transferable[]) => void;

const ZOOM_STEPS = [0.01, 0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 32];

const intersect = (a: Rect, b: Rect): Rect | null => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
};
const union = (a: Rect | null, b: Rect | null): Rect | null => {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
};
const lumOf = (c: RGBA) => Math.round(c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114);

const TOOL_LABEL = { spotHeal: 'Pincel corrector puntual', heal: 'Pincel corrector', remove: 'Quitar' };

const BRUSH_TOOLS: Partial<Record<ToolId, BrushMode>> = {
  brush: 'paint', pencil: 'paint', eraser: 'erase', clone: 'clone', dodge: 'dodge', burn: 'burn',
  spotHeal: 'paint', remove: 'paint', mixer: 'paint', heal: 'clone', blur: 'blur', sharpen: 'sharpen', smudge: 'smudge', historyBrush: 'paint',
};

/** Una pestaña: su documento con su historial, vista y estado propio. */
interface DocSlot {
  id: number;
  doc: EditorDocument;
  history: History;
  baseLabel: string;
  view: { zoom: number; panX: number; panY: number; rot: number };
  fxVersions: Map<number, string>;
  counters: [number, number, number];
  lastSelection: Selection | null;
  cloneSource: { x: number; y: number } | null;
  cloneOffset: { dx: number; dy: number } | null;
  /** Pestaña con el contenido de un objeto inteligente: capa de origen. */
  smartLink?: { slotId: number; layerId: number; name: string };
}

/** Motor del editor: vive entero en el worker; la interfaz sólo envía comandos. */
export class Engine {
  private post: Post;
  private r: Renderer;
  doc: EditorDocument | null = null;
  private history = new History();
  private slots: DocSlot[] = [];
  private slotId = 0;
  private nextSlot = 1;
  private baseLabel = 'Nuevo';
  private view: ViewState = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
  private cw = 800;
  private ch = 600;
  private tool: ToolId = 'brush';
  private brush: BrushSettings = { size: 30, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.1, pressureSize: true, pressureOpacity: false };
  private fg: RGBA = [0, 0, 0, 255];
  private bg: RGBA = [255, 255, 255, 255];
  private frameQueued = false;
  private statePending = false;
  private thumbTimer: ReturnType<typeof setTimeout> | null = null;
  private fxTimer: ReturnType<typeof setTimeout> | null = null;
  private fxVersions = new Map<number, string>();
  /** Google Fonts que se están descargando. */
  private fontWait = new Set<string>();
  private layerCounter = 1;
  private groupCounter = 1;
  private healing = false;
  /** Máscara rápida: capa interna cuya máscara es la selección que se pinta. */
  private qm: PixelLayer | null = null;
  private viewChannel = 0;
  private snap = true;
  private batch: HistoryEntry[] | null = null;
  private pathCounter = 1;
  private alphaCounter = 1;
  private snapCounter = 1;
  private pointerQueue: PointerMsg[] = [];
  private strokeTool: ToolId = 'brush';
  private pool = new Pool();
  private base: string;

  private stroke: BrushStroke | null = null;
  private drag: { kind: 'pan' | 'move'; x0: number; y0: number; panX: number; panY: number; lx: number; ly: number; layer?: PixelLayer; moved?: boolean; set?: { L: PixelLayer; x: number; y: number; text?: TextParams; shape?: ShapeParams; smart?: SmartObject; artboard?: Artboard }[]; box?: Rect | null } | null = null;
  private pendingProps = new Map<number, unknown>();
  private cloneSource: { x: number; y: number } | null = null;
  private cloneOffset: { dx: number; dy: number } | null = null;
  private lastSelection: Selection | null = null;
  private lastFilter: { name: FilterName; params: FilterParams } | null = null;
  private transform: { layers: PixelLayer[]; src: Rect; matrix: Matrix; spec?: WarpSpec | null } | null = null;
  private autoSelect = false;
  private busy = false;
  private clipboard: { data: Uint8ClampedArray; rect: Rect } | null = null;
  /** Vista previa de un ajuste/filtro destructivo: aplicado pero aún fuera del historial. */
  private preview: HistoryEntry | null = null;
  private previewSeq = 0;

  constructor(canvas: OffscreenCanvas, width: number, height: number, dpr: number, post: Post, base = '/') {
    this.post = post;
    this.base = base;
    this.r = new Renderer(canvas);
    this.resize(width, height, dpr);
    post({ type: 'ready', renderer: this.r.info, maxTexture: this.r.maxTexture });
    // El primer texto que se pinta en el worker carga el sistema de fuentes (puede tardar ~1 s):
    // se hace ya, en segundo plano, para que la herramienta Texto responda al instante.
    setTimeout(() => { try { const c = new OffscreenCanvas(8, 8).getContext('2d')!; c.font = '16px Arial, sans-serif'; c.fillText('Aa', 0, 8); c.measureText('Hg'); } catch { /* sin texto */ } }, 50);
  }

  // ================================================================ vista

  resize(w: number, h: number, dpr: number) {
    this.cw = w; this.ch = h;
    const first = this.view.dpr !== dpr;
    this.view.dpr = dpr;
    this.r.resize(w * dpr, h * dpr);
    if (first && this.doc) this.fit(false);
    this.requestFrame(true);
  }

  private setView(zoom: number, panX: number, panY: number, rot = this.view.rot ?? 0) {
    this.view.zoom = Math.min(64, Math.max(0.005, zoom));
    this.view.panX = panX;
    this.view.panY = panY;
    this.view.rot = rot;
    this.post({ type: 'view', view: { ...this.view } });
    this.requestFrame();
  }

  private zoomAt(z: number, x: number, y: number) {
    const v = this.view;
    const nz = Math.min(64, Math.max(0.005, z));
    this.setView(nz, x - ((x - v.panX) * nz) / v.zoom, y - ((y - v.panY) * nz) / v.zoom);
  }

  private stepZoom(dir: 1 | -1, x = this.cw / 2, y = this.ch / 2) {
    const z = this.view.zoom;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z * 1.001) : [...ZOOM_STEPS].reverse().find((s) => s < z * 0.999);
    if (next) this.zoomAt(next, x, y);
  }

  zoomIn() { this.stepZoom(1); }
  zoomOut() { this.stepZoom(-1); }
  zoomTo(z: number) { this.zoomAt(z, this.cw / 2, this.ch / 2); }
  zoomAtPoint(dir: 1 | -1, x: number, y: number) { this.stepZoom(dir, x, y); }
  /** Vista absoluta (gestos táctiles: pellizcar y arrastrar con dos dedos). */
  viewTo(zoom: number, panX: number, panY: number) { if (this.doc) this.setView(zoom, panX, panY); }
  /** Color compuesto en un punto del documento (cuentagotas al mantener pulsado). */
  pickColor(x: number, y: number): RGBA | null {
    const d = this.doc;
    if (!d || x < 0 || y < 0 || x >= d.width || y >= d.height) return null;
    this.r.compose(d);
    const c = this.r.readCompositePixel(Math.floor(x), Math.floor(y));
    return c[3] > 0 ? [c[0], c[1], c[2], 255] : null;
  }

  fit(capAt100: boolean) {
    const d = this.doc;
    if (!d) return;
    const m = 24;
    let z = Math.min((this.cw - m * 2) / d.width, (this.ch - m * 2 - 26) / d.height);
    if (capAt100) z = Math.min(1, z);
    z = Math.max(0.005, z);
    this.setView(z, Math.round((this.cw - d.width * z) / 2), Math.round((this.ch + 26 - d.height * z) / 2));
  }

  actualPixels() {
    const d = this.doc;
    if (!d) return;
    this.setView(1, Math.round((this.cw - d.width) / 2), Math.round((this.ch - d.height) / 2));
  }

  private toDoc(x: number, y: number) {
    return { x: (x - this.view.panX) / this.view.zoom, y: (y - this.view.panY) / this.view.zoom };
  }

  wheel(x: number, y: number, dx: number, dy: number, zoom: boolean) {
    if (!this.doc) return;
    const [ux, uy] = this.unrot(x, y);
    if (zoom) { this.zoomAt(this.view.zoom * Math.exp(-dy * 0.0025), ux, uy); return; }
    const r = -(this.view.rot ?? 0), c = Math.cos(r), sn = Math.sin(r);
    this.setView(this.view.zoom, this.view.panX - (dx * c - dy * sn), this.view.panY - (dx * sn + dy * c));
  }

  /** Rotar vista (R): gira el lienzo en pantalla alrededor del centro, sin tocar los píxeles. */
  setRotation(rad: number) {
    let r = rad % (Math.PI * 2);
    if (r > Math.PI) r -= Math.PI * 2;
    if (r < -Math.PI) r += Math.PI * 2;
    this.setView(this.view.zoom, this.view.panX, this.view.panY, Math.abs(r) < 1e-4 ? 0 : r);
  }

  /** Punto de pantalla -> pantalla sin rotar (la vista gira alrededor del centro del área). */
  private unrot(x: number, y: number): [number, number] {
    const r = this.view.rot ?? 0;
    if (!r) return [x, y];
    const cx = this.cw / 2, cy = this.ch / 2, c = Math.cos(-r), sn = Math.sin(-r);
    return [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c];
  }

  // ================================================================ render

  private requestFrame(force = false) {
    if (this.frameQueued && !force) return;
    this.frameQueued = true;
    const raf = (self as unknown as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    const run = () => this.frame();
    if (raf) raf.call(self, run); else setTimeout(run, 8);
  }

  private frame() {
    this.frameQueued = false;
    if (this.doc) this.r.compose(this.doc);
    this.r.draw(this.doc, this.view);
  }

  private invalidate(r: Rect | null) {
    this.r.invalidate(r);
    this.requestFrame();
  }

  // ================================================================ estado

  private snapshot(): DocState {
    const d = this.doc;
    if (!d) {
      return { open: false, name: '', width: 0, height: 0, layers: [], activeLayerId: 0, history: [], historyIndex: 0, selection: null, editMask: false, dirty: false, selectedLayerIds: [], paths: [], activePathId: null, docs: [], activeDocId: 0, guides: [], quickMask: false, alphas: [], viewChannel: 0, snapshots: [], historySource: null };
    }
    return {
      open: true,
      name: d.name,
      width: d.width,
      height: d.height,
      layers: d.layers.map((l) => l.info()),
      activeLayerId: d.active()?.id ?? 0,
      history: [{ label: this.baseLabel }, ...this.history.entries.map((e) => ({ label: e.label }))],
      historyIndex: this.history.index,
      selection: d.selection?.bounds() ?? null,
      editMask: d.editMask && !!d.active()?.mask,
      dirty: d.dirty,
      selectedLayerIds: d.selected().map((l) => l.id),
      paths: d.paths.map((p) => ({ ...p })),
      activePathId: d.activePathId,
      guides: d.guides.map((g) => ({ ...g })),
      quickMask: !!this.qm,
      alphas: d.alphas.map((a) => ({ id: a.id, name: a.name })),
      viewChannel: this.viewChannel,
      mode: d.mode,
      dpi: d.dpi,
      frames: d.frames.map((f) => ({ delay: f.delay })),
      activeFrame: d.activeFrame,
      loop: d.loop,
      proof: this.r.proof,
      gamutWarning: this.r.gamutWarning,
      snapshots: d.snapshots.map((x) => ({ id: x.id, name: x.name })),
      historySource: d.historySource,
      docs: this.slots.map((x) => ({ id: x.id, name: x.id === this.slotId ? d.name : x.doc.name, dirty: x.id === this.slotId ? d.dirty : x.doc.dirty })),
      activeDocId: this.slotId,
      smartParent: this.slots.find((x) => x.id === this.slotId)?.smartLink?.name ?? null,
    };
  }

  private pushState(thumbs = true) {
    if (!this.statePending) {
      this.statePending = true;
      queueMicrotask(() => {
        this.statePending = false;
        this.post({ type: 'state', state: this.snapshot() });
      });
    }
    if (thumbs) { this.scheduleThumbs(); this.scheduleEffects(); }
  }

  private selectionChanged() {
    const d = this.doc;
    const sel = d?.selection ?? null;
    this.post({ type: 'selection', path: sel && d ? sel.outline(d.width, d.height) : '', bounds: sel?.bounds() ?? null });
  }

  private scheduleThumbs() {
    if (this.thumbTimer) clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(() => {
      this.thumbTimer = null;
      const d = this.doc;
      if (!d) return;
      const thumbs: { id: number; w: number; h: number; data: Uint8ClampedArray }[] = [];
      for (const l of d.layers) {
        if (l.kind !== 'adjustment') thumbs.push({ id: l.id, ...layerThumb(l, d.width, d.height) });
        if (l.mask) thumbs.push({ id: -l.id, ...maskThumb(l, d.width, d.height) });
      }
      this.post({ type: 'thumbs', thumbs }, thumbs.map((t) => t.data.buffer));
    }, 150);
  }

  /** Recalcula los estilos de capa que hayan cambiado (con retardo, tras editar). */
  private scheduleEffects() {
    if (this.fxTimer) clearTimeout(this.fxTimer);
    this.fxTimer = setTimeout(() => {
      this.fxTimer = null;
      const d = this.doc;
      if (!d) return;
      for (const L of d.layers) {
        const key = fxKey(L);
        if ((this.fxVersions.get(L.id) ?? '') === key) continue;
        this.fxVersions.set(L.id, key);
        const before = fxBounds(L);
        const { under, styled } = key ? buildEffects(L) : { under: [], styled: null };
        L.fxUnder = under;
        L.fxStyled = styled;
        this.invalidate(union(before, union(fxBounds(L), L.bounds())));
      }
    }, 120);
  }

  private commit(e: HistoryEntry) {
    if (this.batch) { this.batch.push(e); return; }
    this.history.push(e);
    if (this.doc) this.doc.dirty = true;
    this.pushState();
  }

  /** Agrupa en un solo paso del historial todo lo que se registre dentro de `fn`. */
  private batched(label: string, fn: () => void) {
    const outer = this.batch;
    this.batch = [];
    try { fn(); } finally {
      const es = this.batch;
      this.batch = outer;
      if (es.length) this.commit(new GroupEntry(label, es));
    }
  }

  /** Capas seleccionadas sin las que ya están dentro de otro grupo seleccionado. */
  private topSelected(): PixelLayer[] {
    const d = this.doc!;
    const sel = d.selected();
    return sel.filter((l) => !sel.some((g) => g !== l && g.kind === 'group' && d.isInside(l, g)));
  }

  private perf<T>(label: string, fn: () => T): T {
    const t0 = performance.now();
    const v = fn();
    this.post({ type: 'perf', label, ms: performance.now() - t0 });
    return v;
  }

  private docRect(): Rect {
    return { x: 0, y: 0, w: this.doc!.width, h: this.doc!.height };
  }

  private toast(text: string, kind: 'info' | 'warn' | 'error' = 'info') {
    this.post({ type: 'toast', text, kind });
  }

  // ================================================================ documentos

  // ------------------------------------------------------------ varios documentos (pestañas)

  /** Guarda el estado del documento activo en su pestaña. */
  private saveSlot() {
    const s = this.slots.find((x) => x.id === this.slotId);
    if (!s || !this.doc) return;
    s.doc = this.doc; s.history = this.history; s.baseLabel = this.baseLabel;
    s.view = { zoom: this.view.zoom, panX: this.view.panX, panY: this.view.panY, rot: this.view.rot ?? 0 };
    s.fxVersions = this.fxVersions; s.counters = [this.layerCounter, this.groupCounter, this.pathCounter];
    s.lastSelection = this.lastSelection; s.cloneSource = this.cloneSource; s.cloneOffset = this.cloneOffset;
  }

  private loadSlot(s: DocSlot, fit = false) {
    this.r.reset();
    this.r.setMaskOverlay(null);
    this.qm = null;
    s.doc.extras = [];
    this.slotId = s.id;
    this.doc = s.doc; this.history = s.history; this.baseLabel = s.baseLabel;
    this.fxVersions = s.fxVersions; [this.layerCounter, this.groupCounter, this.pathCounter] = s.counters;
    this.lastSelection = s.lastSelection; this.cloneSource = s.cloneSource; this.cloneOffset = s.cloneOffset;
    this.transform = null; this.preview = null; this.stroke = null; this.drag = null;
    this.pointerQueue = [];
    this.pendingProps.clear();
    if (fit) this.fit(true);
    else this.setView(s.view.zoom, s.view.panX, s.view.panY, s.view.rot);
    this.invalidate(null);
    this.pushState();
    this.selectionChanged();
    this.requestFrame();
  }

  private setDoc(doc: EditorDocument, label: string) {
    if (this.qm) this.toggleQuickMask();
    this.restorePreview();
    this.cancelTransformSilently();
    this.saveSlot();
    const s: DocSlot = {
      id: this.nextSlot++, doc, history: new History(), baseLabel: label, view: { zoom: 1, panX: 0, panY: 0, rot: 0 },
      fxVersions: new Map(), lastSelection: null, cloneSource: null, cloneOffset: null,
      counters: [doc.layers.length + 1, doc.layers.filter((l) => l.kind === 'group').length + 1, Math.max(0, ...doc.paths.map((p) => p.id)) + 1],
    };
    this.slots.push(s);
    // Instantánea inicial automática (origen por defecto del pincel de historia).
    if (!doc.snapshots.length) { this.takeSnapshot(doc, doc.name.replace(/\.[^.]+$/, '')); doc.historySource = doc.snapshots[0].id; }
    this.loadSlot(s, true);
  }

  /** Cambiar de pestaña (Ctrl+Tab en Photoshop; Ctrl+F6 en el navegador). */
  switchDoc(id: number) {
    const s = this.slots.find((x) => x.id === id);
    if (!s || id === this.slotId) return;
    if (this.qm) this.toggleQuickMask();
    this.restorePreview();
    this.cancelTransformSilently();
    this.saveSlot();
    this.loadSlot(s);
  }

  /** Siguiente / anterior pestaña. */
  cycleDoc(dir: 1 | -1) {
    if (this.slots.length < 2) return;
    const i = this.slots.findIndex((x) => x.id === this.slotId);
    this.switchDoc(this.slots[(i + dir + this.slots.length) % this.slots.length].id);
  }

  private cancelTransformSilently() {
    if (!this.transform) return;
    this.transform = null;
    this.r.clearPreview();
  }

  newDoc(width: number, height: number, background: 'white' | 'black' | 'transparent' | 'bg', name = 'Sin título-1', artboard = false) {
    const w = Math.max(1, Math.min(30000, Math.round(width)));
    const h = Math.max(1, Math.min(30000, Math.round(height)));
    const doc = new EditorDocument(name, w, h);
    const color: RGBA | null = background === 'white' ? [255, 255, 255, 255] : background === 'black' ? [0, 0, 0, 255] : background === 'bg' ? this.bg : null;
    if (artboard) {
      // Documento con mesa de trabajo (como Photoshop para web y redes): el fondo es el de la mesa.
      const G = new PixelLayer('Mesa de trabajo 1');
      G.kind = 'group'; G.blend = 'normal';
      G.artboard = { x: 0, y: 0, w, h, bg: color };
      const L = new PixelLayer('Capa 1');
      L.parent = G.id;
      doc.layers.push(L, G);
      doc.activeLayerId = L.id;
    } else {
      const L = new PixelLayer(background === 'transparent' ? 'Capa 1' : 'Fondo');
      if (color) EditorDocument.fillLayer(L, { x: 0, y: 0, w, h }, color);
      doc.layers.push(L);
      doc.activeLayerId = L.id;
    }
    this.setDoc(doc, 'Nuevo');
    return { width: w, height: h };
  }

  async open(name: string, buffer: ArrayBuffer, mime: string) {
    this.post({ type: 'busy', label: `Abriendo ${name}…` });
    try {
      const t0 = performance.now();
      const isPsd = /\.(psd|psb)$/i.test(name) || mime === 'image/vnd.adobe.photoshop';
      const res = isPsd ? (await import('./psd')).importPsd(name, buffer) : await importRaster(name, buffer, mime);
      this.setDoc(res.doc, 'Abrir');
      const ms = performance.now() - t0;
      this.post({ type: 'perf', label: 'Abrir', ms });
      if (res.warnings.length) this.toast(`Abierto. Aún no se editan: ${res.warnings.join(', ')}.`, 'warn');
      return { layers: res.doc.layers.length, ms, warnings: res.warnings };
    } finally {
      this.post({ type: 'busy', label: null });
    }
  }

  // ================================================================ fotografía: Photomerge, HDR, alinear y fusionar

  /** Decodifica un archivo y lo devuelve acoplado (RGBA). */
  private async decodeFlat(f: { name: string; buffer: ArrayBuffer; mime: string }): Promise<{ name: string; px: Uint8ClampedArray; w: number; h: number }> {
    const isPsd = /\.(psd|psb)$/i.test(f.name) || f.mime === 'image/vnd.adobe.photoshop';
    const res = isPsd ? (await import('./psd')).importPsd(f.name, f.buffer) : await importRaster(f.name, f.buffer, f.mime);
    const D = res.doc, rect = { x: 0, y: 0, w: D.width, h: D.height };
    const one = D.layers.length === 1 && D.layers[0].kind === 'pixel' && !D.layers[0].x && !D.layers[0].y;
    const px = one ? D.layers[0].readRegion(0, 0, D.width, D.height) : this.r.flatten(D, D.layers, rect);
    return { name: f.name.replace(/\.[^.]+$/, ''), px, w: D.width, h: D.height };
  }

  /** Homografías de cada imagen a la de referencia (la mejor conectada); null si alguna no encaja. */
  private registerImages(imgs: { px: Uint8ClampedArray; w: number; h: number }[]): { H: (number[] | null)[]; ref: number } {
    const n = imgs.length;
    const feats = imgs.map((im) => { const g = grayDown(im.px, im.w, im.h, 1000); return { f: detect(g.g, g.w, g.h, 1000), s: g.s }; });
    const edges: { i: number; j: number; H: number[]; inl: number }[] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const m = match(feats[i].f, feats[j].f);
      const r = ransac(m, 2.5);
      if (!r || r.inliers < 12) continue;
      const Hij = scaleH(r.H, feats[i].s, feats[j].s);
      edges.push({ i, j, H: Hij, inl: r.inliers });
    }
    const score = new Array(n).fill(0);
    for (const e of edges) { score[e.i] += e.inl; score[e.j] += e.inl; }
    const ref = score.indexOf(Math.max(...score));
    const H: (number[] | null)[] = new Array(n).fill(null);
    H[ref] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    // Árbol de máxima confianza desde la referencia (Prim por número de parejas buenas).
    const done = new Set([ref]);
    while (done.size < n) {
      let best: { from: number; to: number; Hm: number[]; inl: number } | null = null;
      for (const e of edges) {
        const a = done.has(e.i), b = done.has(e.j);
        if (a === b) continue;
        if (best && e.inl <= best.inl) continue;
        // H_to→ref = H_from→ref · H_to→from
        best = a ? { from: e.i, to: e.j, Hm: invertH(e.H), inl: e.inl } : { from: e.j, to: e.i, Hm: e.H, inl: e.inl };
      }
      if (!best) break;
      H[best.to] = mulH(H[best.from]!, best.Hm);
      done.add(best.to);
    }
    return { H, ref };
  }

  /** Archivo > Automatizar > Panorámica: une fotos en una panorámica (capas con máscaras, como Photoshop). */
  async photomerge(files: { name: string; buffer: ArrayBuffer; mime: string }[], blend = true, vignetteFix = true) {
    if (files.length < 2) { this.toast('Elige al menos dos fotos.', 'warn'); return null; }
    this.post({ type: 'busy', label: 'Panorámica: leyendo…' });
    const t0 = performance.now();
    try {
      const imgs: { name: string; px: Uint8ClampedArray; w: number; h: number }[] = [];
      for (const f of files) imgs.push(await this.decodeFlat(f));
      this.post({ type: 'busy', label: 'Panorámica: buscando coincidencias…' });
      const { H, ref } = this.registerImages(imgs);
      const ok = imgs.map((_, i) => i).filter((i) => H[i]);
      if (ok.length < 2) { this.toast('No se encontraron zonas comunes entre las fotos (deben solaparse un 20-30 %).', 'warn'); return null; }
      const lost = imgs.length - ok.length;
      // Lienzo: unión de las fotos transformadas.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const i of ok) for (const [x, y] of [[0, 0], [imgs[i].w, 0], [imgs[i].w, imgs[i].h], [0, imgs[i].h]]) {
        const [u, v] = applyHm(H[i]!, x, y); x0 = Math.min(x0, u); y0 = Math.min(y0, v); x1 = Math.max(x1, u); y1 = Math.max(y1, v);
      }
      const W = Math.min(30000, Math.ceil(x1 - x0)), Hh = Math.min(30000, Math.ceil(y1 - y0));
      const T = [1, 0, -Math.floor(x0), 0, 1, -Math.floor(y0), 0, 0, 1];
      const doc = new EditorDocument('Panorámica.psd', W, Hh);
      const prev = this.doc;
      this.setDoc(doc, 'Panorámica');
      const order = [ref, ...ok.filter((i) => i !== ref)];
      const layers: PixelLayer[] = [];
      const placed = new Uint8Array(W * Hh); // cobertura acumulada (para compensar la exposición)
      const acc = new Float32Array(W * Hh);   // luminancia acumulada
      this.post({ type: 'busy', label: 'Panorámica: fundiendo…' });
      for (const i of order) {
        const L = new PixelLayer(imgs[i].name || `Foto ${i + 1}`);
        const Hi = mulH(T, H[i]!);
        await this.warpPixels(imgs[i].px, { x: 0, y: 0, w: imgs[i].w, h: imgs[i].h }, { kind: 'proj', h: Hi, dst: { x: 0, y: 0, w: W, h: Hh } }, L);
        // Compensación de exposición con lo ya colocado.
        const px = L.readRegion(0, 0, W, Hh);
        if (layers.length && vignetteFix) {
          let sa = 0, sb = 0;
          for (let k = 0; k < W * Hh; k += 7) if (placed[k] && px[k * 4 + 3] > 250) { sa += acc[k]; sb += px[k * 4] * 0.299 + px[k * 4 + 1] * 0.587 + px[k * 4 + 2] * 0.114; }
          const gain = sb > 0 ? Math.max(0.7, Math.min(1.4, sa / sb)) : 1;
          if (Math.abs(gain - 1) > 0.01) {
            for (let k = 0; k < px.length; k += 4) { px[k] = Math.min(255, px[k] * gain); px[k + 1] = Math.min(255, px[k + 1] * gain); px[k + 2] = Math.min(255, px[k + 2] * gain); }
            L.clearTiles(); L.writeRegion(px, W, Hh, 0, 0);
          }
        }
        for (let k = 0; k < W * Hh; k++) if (px[k * 4 + 3] > 250 && !placed[k]) { placed[k] = 1; acc[k] = px[k * 4] * 0.299 + px[k * 4 + 1] * 0.587 + px[k * 4 + 2] * 0.114; }
        pruneEmpty(L);
        layers.push(L);
      }
      // La primera abajo; el resto encima, con máscaras de costura.
      doc.layers = layers;
      doc.activeLayerId = layers[layers.length - 1].id;
      if (blend) this.seamMasks(layers, order.map((i) => mulH(T, H[i]!)), order.map((i) => imgs[i]), W, Hh);
      void prev;
      // Instantánea inicial con el resultado (origen del pincel de historia).
      doc.snapshots = []; this.takeSnapshot(doc, 'Panorámica'); doc.historySource = doc.snapshots[0].id;
      this.invalidate(null);
      this.pushState(true);
      this.fit(true);
      this.post({ type: 'perf', label: 'Panorámica', ms: performance.now() - t0 });
      if (lost) this.toast(`${lost} foto(s) no encajaban con las demás y se han dejado fuera.`, 'warn');
      return { w: W, h: Hh, layers: layers.length };
    } finally {
      this.post({ type: 'busy', label: null });
    }
  }

  /**
   * Máscaras de costura: cada píxel es de la foto en la que queda más lejos de su borde (el centro
   * de la foto se ve mejor); las máscaras se suavizan para que la transición no se note.
   */
  private seamMasks(layers: PixelLayer[], Hs: number[][], imgs: { w: number; h: number }[], W: number, Hh: number) {
    const n = layers.length, inv = Hs.map((h) => invertH(h));
    const best = new Int16Array(W * Hh).fill(-1);
    const bestW = new Float32Array(W * Hh);
    // Capa más baja que cubre cada píxel: donde una capa es la única, su máscara queda llena.
    const lowest = new Int16Array(W * Hh).fill(-1);
    for (let k = 0; k < n; k++) {
      const im = imgs[k], hi = inv[k];
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
        const [u, v] = applyHm(hi, x + 0.5, y + 0.5);
        if (u < 0 || v < 0 || u > im.w || v > im.h) continue;
        if (lowest[y * W + x] < 0) lowest[y * W + x] = k;
        const wgt = Math.min(u, im.w - u) / im.w * (Math.min(v, im.h - v) / im.h);
        const i = y * W + x;
        if (wgt > bestW[i]) { bestW[i] = wgt; best[i] = k; }
      }
    }
    const r = Math.max(6, Math.round(Math.min(W, Hh) * 0.012));
    for (let k = 1; k < n; k++) {
      const m = new Float32Array(W * Hh);
      for (let i = 0; i < m.length; i++) m[i] = best[i] === k ? 1 : 0;
      const f = blurF(m, W, Hh, r);
      const mask = new MaskChannel(0);
      forTiles({ x: 0, y: 0, w: W, h: Hh }, (tx, ty, xa, ya, xb, yb) => {
        let any = false;
        const t = new Uint8Array(TILE * TILE);
        for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
          const i = (ty * TILE + y) * W + tx * TILE + x;
          const v = lowest[i] === k ? 255 : Math.round(f[i] * 255);
          if (v) { t[y * TILE + x] = v; any = true; }
        }
        if (any) mask.setTile(tileKey(tx, ty), t);
      });
      layers[k].mask = mask; layers[k].maskEnabled = true;
    }
  }

  /** Archivo > Automatizar > Combinar para HDR: alinea las exposiciones y las funde (Mertens). */
  async mergeHdr(files: { name: string; buffer: ArrayBuffer; mime: string }[], align = true, strength = 1) {
    if (files.length < 2) { this.toast('Elige al menos dos exposiciones.', 'warn'); return null; }
    this.post({ type: 'busy', label: 'HDR: leyendo…' });
    const t0 = performance.now();
    try {
      const imgs: { name: string; px: Uint8ClampedArray; w: number; h: number }[] = [];
      for (const f of files) imgs.push(await this.decodeFlat(f));
      const w = imgs[0].w, h = imgs[0].h;
      const same = imgs.map((im) => (im.w === w && im.h === h ? im.px : resample(im.px, im.w, im.h, w, h)));
      // Alineación por traslación respecto a la exposición media.
      const mid = Math.floor(imgs.length / 2);
      let shifts: Pt2[] = same.map(() => [0, 0]);
      if (align) {
        this.post({ type: 'busy', label: 'HDR: alineando…' });
        const gs = same.map((px) => grayDown(px, w, h, 1600));
        shifts = gs.map((g, k) => { if (k === mid) return [0, 0]; const [dx, dy] = mtbAlign(gs[mid].g, g.g, g.w, g.h); return [Math.round(dx / g.s), Math.round(dy / g.s)]; });
      }
      this.post({ type: 'busy', label: 'HDR: fundiendo exposiciones…' });
      const out = exposureFusion(same, w, h, shifts, strength);
      const L = layerFromPixels('Fondo', out, w, h);
      const doc = new EditorDocument('HDR.psd', w, h);
      doc.layers = [L]; doc.activeLayerId = L.id;
      this.setDoc(doc, 'Combinar para HDR');
      this.post({ type: 'perf', label: 'Combinar para HDR', ms: performance.now() - t0 });
      return { w, h, shifts };
    } finally {
      this.post({ type: 'busy', label: null });
    }
  }

  /** Edición > Alinear capas automáticamente (las seleccionadas; la de abajo es la referencia). */
  async autoAlignLayers() {
    const d = this.doc;
    if (!d) return;
    let set = this.topSelected().filter((l) => l.kind === 'pixel' || l.kind === 'smart');
    if (set.length < 2) set = d.layers.filter((l) => (l.kind === 'pixel' || l.kind === 'smart') && l.visible);
    if (set.length < 2) { this.toast('Selecciona al menos dos capas con fotos.', 'warn'); return; }
    set.sort((a, b) => d.indexOf(a.id) - d.indexOf(b.id));
    this.post({ type: 'busy', label: 'Alineando capas…' });
    try {
      const rect = this.docRect();
      const imgs = set.map((L) => ({ px: L.readRegion(-L.x, -L.y, d.width, d.height), w: d.width, h: d.height }));
      // La referencia es la de abajo: se calculan las demás contra ella (o encadenadas).
      const { H } = this.registerImages(imgs);
      const H0 = H[0];
      if (!H0) { this.toast('No se encontraron coincidencias entre las capas.', 'warn'); return; }
      const toRef = invertH(H0);
      const entries: HistoryEntry[] = [];
      let moved = 0;
      for (let k = 1; k < set.length; k++) {
        if (!H[k]) continue;
        const h = mulH(toRef, H[k]!);
        const e = await this.warpOne(set[k], { kind: 'proj', h, dst: rect }, 'Alinear capas automáticamente');
        if (e) { entries.push(e); moved++; }
      }
      if (entries.length) this.commit(new GroupEntry('Alinear capas automáticamente', entries));
      this.invalidate(null);
      if (moved < set.length - 1) this.toast(`${set.length - 1 - moved} capa(s) no se pudieron alinear.`, 'warn');
    } finally {
      this.post({ type: 'busy', label: null });
    }
  }

  /** Edición > Fusionar capas automáticamente: panorámica (costuras) o apilar (enfoque por píxel). */
  autoBlendLayers(mode: 'panorama' | 'stack' = 'panorama') {
    const d = this.doc;
    if (!d) return;
    let set = this.topSelected().filter((l) => l.kind === 'pixel' || l.kind === 'smart');
    if (set.length < 2) set = d.layers.filter((l) => (l.kind === 'pixel' || l.kind === 'smart') && l.visible);
    if (set.length < 2) { this.toast('Selecciona al menos dos capas.', 'warn'); return; }
    set.sort((a, b) => d.indexOf(a.id) - d.indexOf(b.id));
    const W = d.width, Hh = d.height, n = set.length;
    const px = set.map((L) => L.readRegion(-L.x, -L.y, W, Hh));
    const best = new Int16Array(W * Hh).fill(-1), bestW = new Float32Array(W * Hh);
    for (let k = 0; k < n; k++) {
      let wmap: Float32Array;
      if (mode === 'stack') {
        // Nitidez local: energía del laplaciano, suavizada.
        const g = new Float32Array(W * Hh);
        for (let i = 0; i < g.length; i++) g[i] = (px[k][i * 4] + px[k][i * 4 + 1] + px[k][i * 4 + 2]) / 765;
        const lap = new Float32Array(W * Hh);
        for (let y = 1; y < Hh - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; const v = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W]; lap[i] = v * v; }
        wmap = blurF(lap, W, Hh, Math.max(2, Math.min(W, Hh) * 0.004));
      } else {
        // Distancia al borde del contenido de la capa (las zonas centrales ganan).
        wmap = new Float32Array(W * Hh);
        const a = new Float32Array(W * Hh);
        for (let i = 0; i < a.length; i++) a[i] = px[k][i * 4 + 3] > 250 ? 1 : 0;
        const bl = blurF(a, W, Hh, Math.max(8, Math.min(W, Hh) * 0.05));
        for (let i = 0; i < a.length; i++) wmap[i] = a[i] ? bl[i] + 1e-3 : 0;
      }
      for (let i = 0; i < W * Hh; i++) if (px[k][i * 4 + 3] > 250 && wmap[i] > bestW[i]) { bestW[i] = wmap[i]; best[i] = k; }
    }
    const lowest = new Int16Array(W * Hh).fill(-1);
    for (let k = n - 1; k >= 0; k--) for (let i = 0; i < W * Hh; i++) if (px[k][i * 4 + 3] > 250) lowest[i] = k;
    const before = set.map((L) => ({ L, mask: L.mask, en: L.maskEnabled }));
    const r = mode === 'stack' ? 3 : Math.max(6, Math.round(Math.min(W, Hh) * 0.012));
    for (let k = 1; k < n; k++) {
      const m = new Float32Array(W * Hh);
      for (let i = 0; i < m.length; i++) m[i] = best[i] === k ? 1 : 0;
      const f = blurF(m, W, Hh, r);
      const L = set[k], mask = new MaskChannel(0);
      forTiles({ x: -L.x, y: -L.y, w: W, h: Hh }, (tx, ty, xa, ya, xb, yb) => {
        const t = new Uint8Array(TILE * TILE);
        let any = false;
        for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
          const X = tx * TILE + x + L.x, Y = ty * TILE + y + L.y;
          const v = X >= 0 && Y >= 0 && X < W && Y < Hh ? (lowest[Y * W + X] === k ? 255 : Math.round(f[Y * W + X] * 255)) : 0;
          if (v) { t[y * TILE + x] = v; any = true; }
        }
        if (any) mask.setTile(tileKey(tx, ty), t);
      });
      L.mask = mask; L.maskEnabled = true;
    }
    const after = set.map((L) => ({ L, mask: L.mask, en: L.maskEnabled }));
    const apply = (v: typeof before) => (doc: EditorDocument) => { for (const e of v) { const l = doc.layer(e.L.id); if (l) { l.mask = e.mask; l.maskEnabled = e.en; } } };
    this.commit(new FnEntry(mode === 'stack' ? 'Apilar imágenes' : 'Fusionar capas automáticamente', apply(before), apply(after)));
    this.invalidate(null);
  }

  /** Abre píxeles ya decodificados (RAW revelado en la interfaz) como documento nuevo. */
  openPixels(name: string, w: number, h: number, rgba: Uint8ClampedArray) {
    const doc = new EditorDocument(name, w, h);
    const L = layerFromPixels('Fondo', rgba, w, h);
    doc.layers = [L]; doc.activeLayerId = L.id;
    this.setDoc(doc, 'Abrir');
    return { layers: 1 };
  }

  /** Coloca una imagen como capa nueva (Archivo > Colocar, arrastrar, pegar). */
  async placeImage(name: string, buffer: ArrayBuffer, mime: string, at?: { x: number; y: number } | null) {
    const d = this.doc;
    if (!d) return this.open(name, buffer, mime);
    const res = await importRaster(name, buffer, mime);
    const L = res.doc.layers[0];
    L.name = name.replace(/\.[^.]+$/, '') || 'Imagen';
    const w = res.doc.width, h = res.doc.height;
    L.x = at ? Math.round(at.x) : Math.round((d.width - w) / 2);
    L.y = at ? Math.round(at.y) : Math.round((d.height - h) / 2);
    this.insertLayer(L, this.above(L), 'Colocar');
    return { layers: d.layers.length };
  }

  /** Cierra una pestaña (la activa por defecto) y pasa a la vecina. */
  closeDoc(id?: number) {
    const target = id ?? this.slotId;
    const i = this.slots.findIndex((x) => x.id === target);
    if (i < 0) return;
    if (target !== this.slotId) { this.slots.splice(i, 1); this.pushState(false); return; }
    this.slots.splice(i, 1);
    const next = this.slots[Math.min(i, this.slots.length - 1)];
    if (next) { this.loadSlot(next); return; }
    this.r.reset();
    this.r.setMaskOverlay(null);
    this.qm = null;
    this.slotId = 0;
    this.doc = null;
    this.history = new History();
    this.transform = null;
    this.pushState(false);
    this.selectionChanged();
    this.requestFrame();
  }

  /** Arrastrar una capa a otra pestaña: se copia allí (centrada si los tamaños difieren). */
  copyLayerToDoc(targetId: number, layerId?: number) {
    const d = this.doc;
    const t = this.slots.find((x) => x.id === targetId);
    const L = layerId ? d?.layer(layerId) : d?.active();
    if (!d || !t || !L || targetId === this.slotId) return;
    const subtree = L.kind === 'group' ? [...d.descendants(L.id), L] : [L];
    const ids = new Map<number, number>();
    const copies = subtree.map((l) => { const c = l.clone(l.name); ids.set(l.id, c.id); return c; });
    copies.forEach((c, k) => { c.parent = subtree[k] === L ? null : ids.get(subtree[k].parent!) ?? null; });
    const dx = Math.round((t.doc.width - d.width) / 2), dy = Math.round((t.doc.height - d.height) / 2);
    for (const c of copies) { c.x += dx; c.y += dy; if (c.text) c.text = { ...c.text, matrix: mul([1, 0, 0, 1, dx, dy], c.text.matrix) }; if (c.shape) c.shape = { ...c.shape, matrix: mul([1, 0, 0, 1, dx, dy], c.shape.matrix) }; }
    this.saveSlot();
    this.loadSlot(t);
    const before = this.structSnap();
    const doc = this.doc!;
    doc.layers.push(...copies);
    doc.activeLayerId = copies[copies.length - 1].id;
    doc.selectedIds = new Set([doc.activeLayerId]);
    this.commitStruct('Duplicar capa', before);
  }

  // ================================================================ historial

  undo() { this.restorePreview(); if (this.doc && !this.transform && this.history.undo(this.doc)) this.afterHistory(); }
  redo() { if (this.doc && !this.transform && this.history.redo(this.doc)) this.afterHistory(); }
  jumpHistory(i: number) { if (this.doc) { this.history.jump(this.doc, i); this.afterHistory(); } }
  /** Ctrl+Alt+Z: alterna el último estado. */
  toggleLastState() {
    if (!this.doc) return;
    if (this.history.canRedo() && this.history.index === this.history.entries.length - 1) this.redo(); else this.undo();
  }

  private afterHistory() {
    const d = this.doc!;
    for (const L of d.layers) this.rerasterize(L, true);
    this.invalidate(null);
    this.pushState();
    this.selectionChanged();
  }

  // ================================================================ capas

  private insertLayer(L: PixelLayer, index: number, label: string) {
    const d = this.doc!;
    const prevActive = d.activeLayerId;
    const prevMask = d.editMask;
    d.layers.splice(index, 0, L);
    d.activeLayerId = L.id;
    d.editMask = false;
    this.commit(new FnEntry(label,
      (doc) => { doc.layers.splice(doc.indexOf(L.id), 1); doc.activeLayerId = prevActive; doc.editMask = prevMask; },
      (doc) => { doc.layers.splice(index, 0, L); doc.activeLayerId = L.id; doc.editMask = false; },
      L.byteSize()));
    this.invalidate(L.kind === 'adjustment' ? null : L.bounds());
  }

  /**
   * Posición para una capa nueva, como Photoshop: encima de la activa y en su mismo grupo;
   * con un grupo desplegado activo, dentro de él (arriba del todo). Si se inserta entre
   * capas recortadas, también queda recortada.
   */
  private above(L?: PixelLayer): number {
    const d = this.doc!;
    const A = d.active();
    if (!A) { if (L) L.parent = null; return d.layers.length; }
    if (A.kind === 'group' && !A.collapsed) { if (L) L.parent = A.id; return d.indexOf(A.id); }
    if (L) {
      L.parent = A.parent;
      const sibs = d.children(A.parent);
      const next = sibs[sibs.indexOf(A) + 1];
      L.clipped = L.kind !== 'group' && !!next?.clipped;
    }
    return d.indexOf(A.id) + 1;
  }

  // ------------------------------------------------------------ estructura (grupos y recortes)

  private structSnap() {
    const d = this.doc!;
    return { layers: [...d.layers], meta: d.layers.map((l) => [l, l.parent, l.clipped] as const), active: d.activeLayerId, editMask: d.editMask };
  }

  private structApply(s: ReturnType<Engine['structSnap']>) {
    return (doc: EditorDocument) => {
      doc.layers = [...s.layers];
      for (const [l, p, c] of s.meta) { l.parent = p; l.clipped = c; }
      doc.activeLayerId = s.active;
      doc.editMask = s.editMask;
    };
  }

  /** Registra en el historial un cambio de estructura hecho desde `before`. */
  private commitStruct(label: string, before: ReturnType<Engine['structSnap']>, bytes = 0) {
    this.doc!.normalize();
    const after = this.structSnap();
    this.commit(new FnEntry(label, this.structApply(before), this.structApply(after), bytes));
    this.invalidate(null);
  }

  /** Capas que se mueven juntas con la herramienta Mover (un grupo mueve su contenido). */
  private moveSet(L: PixelLayer): PixelLayer[] {
    const d = this.doc!;
    // Con varias capas seleccionadas se mueven todas (si la pulsada es una de ellas).
    const units = d.selected().some((l) => l === L) ? this.topSelected() : [L];
    const out = new Set<PixelLayer>();
    for (const U of units) {
      if (U.kind !== 'group') { if (U.kind !== 'adjustment') out.add(U); continue; }
      if (U.artboard) out.add(U); // la mesa de trabajo se mueve con su contenido
      for (const l of d.descendants(U.id)) if (l.kind !== 'group' && l.kind !== 'adjustment') out.add(l);
    }
    return [...out];
  }

  /** Ctrl+Alt+A: selecciona todas las capas. */
  selectAllLayers() {
    const d = this.doc;
    if (!d) return;
    d.selectedIds = new Set(d.layers.map((l) => l.id));
    if (!d.selectedIds.has(d.activeLayerId)) d.activeLayerId = d.layers.at(-1)!.id;
    this.pushState(false);
  }

  /** Cambia opacidad, modo, visibilidad… de todas las capas seleccionadas en un solo paso. */
  setLayers(ids: number[], props: Parameters<Engine['setLayer']>[1], record = true) {
    if (ids.length <= 1) return this.setLayer(ids[0] ?? this.doc?.activeLayerId ?? 0, props, record);
    this.batched(props.opacity !== undefined ? 'Opacidad de capa' : props.blend !== undefined ? 'Modo de fusión' : 'Propiedades de capa', () => {
      for (const id of ids) this.setLayer(id, props, record);
    });
  }

  /**
   * Alinear capas: con varias, respecto a su caja común; con una, respecto a la selección
   * (o al lienzo si no hay selección), como Photoshop.
   */
  alignLayers(mode: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') {
    const d = this.doc;
    if (!d) return;
    const units = this.topSelected().filter((l) => l.kind !== 'adjustment');
    const boxes = units.map((U) => ({ U, b: this.unitBox(U) })).filter((x) => x.b) as { U: PixelLayer; b: Rect }[];
    if (!boxes.length) return;
    let ref: Rect;
    if (boxes.length > 1) { let r: Rect | null = null; for (const x of boxes) r = union(r, x.b); ref = r!; }
    else ref = (d.selection && intersect(d.selection.bounds()!, this.docRect())) || this.docRect();
    this.batched('Alinear', () => {
      for (const { U, b } of boxes) {
        let dx = 0, dy = 0;
        if (mode === 'left') dx = ref.x - b.x;
        if (mode === 'right') dx = ref.x + ref.w - (b.x + b.w);
        if (mode === 'hcenter') dx = Math.round(ref.x + ref.w / 2 - (b.x + b.w / 2));
        if (mode === 'top') dy = ref.y - b.y;
        if (mode === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
        if (mode === 'vcenter') dy = Math.round(ref.y + ref.h / 2 - (b.y + b.h / 2));
        if (dx || dy) this.shiftUnit(U, dx, dy);
      }
    });
  }

  /** Distribuir (3 o más capas): mismos huecos entre centros. */
  distributeLayers(mode: 'hcenter' | 'vcenter' | 'left' | 'right' | 'top' | 'bottom') {
    const d = this.doc;
    if (!d) return;
    const units = this.topSelected().filter((l) => l.kind !== 'adjustment');
    const boxes = units.map((U) => ({ U, b: this.unitBox(U) })).filter((x) => x.b) as { U: PixelLayer; b: Rect }[];
    if (boxes.length < 3) { this.toast('Selecciona al menos tres capas para distribuir.', 'warn'); return; }
    const key = (b: Rect) => mode === 'left' ? b.x : mode === 'right' ? b.x + b.w : mode === 'top' ? b.y : mode === 'bottom' ? b.y + b.h
      : mode === 'hcenter' ? b.x + b.w / 2 : b.y + b.h / 2;
    boxes.sort((a, b) => key(a.b) - key(b.b));
    const k0 = key(boxes[0].b), k1 = key(boxes[boxes.length - 1].b);
    const horiz = mode === 'left' || mode === 'right' || mode === 'hcenter';
    this.batched('Distribuir', () => {
      boxes.forEach(({ U, b }, i) => {
        const delta = Math.round(k0 + ((k1 - k0) * i) / (boxes.length - 1) - key(b));
        if (delta) this.shiftUnit(U, horiz ? delta : 0, horiz ? 0 : delta);
      });
    });
  }

  /** Caja exacta del contenido de una capa o de todo un grupo. */
  private unitBox(U: PixelLayer): Rect | null {
    const d = this.doc!;
    let r: Rect | null = null;
    for (const l of U.kind === 'group' ? d.descendants(U.id) : [U]) if (l.kind !== 'group' && l.kind !== 'adjustment') r = union(r, exactBounds(l));
    return r;
  }

  /** Mueve una capa o un grupo entero y lo registra. */
  private shiftUnit(U: PixelLayer, dx: number, dy: number) {
    const d = this.doc!;
    const set = U.kind === 'group' ? d.descendants(U.id).filter((l) => l.kind !== 'group' && l.kind !== 'adjustment') : [U];
    const pos = (l: PixelLayer) => ({ x: l.x, y: l.y, text: l.text, shape: l.shape, smart: l.smart, artboard: l.artboard });
    const from = set.map(pos);
    let dirty: Rect | null = null;
    for (const L of set) { dirty = union(dirty, this.fullBounds(L)); this.shiftLayer(L, dx, dy); dirty = union(dirty, this.fullBounds(L)); }
    const to = set.map(pos);
    const apply = (v: typeof from) => (doc: EditorDocument) => { set.forEach((L, i) => { const l = doc.layer(L.id); if (l) Object.assign(l, v[i]); }); };
    this.commit(new FnEntry('Mover', apply(from), apply(to)));
    this.invalidate(dirty);
  }

  /** Ctrl+G: mete la capa activa en un grupo nuevo. Sin capa activa, crea un grupo vacío. */
  groupLayers(empty = false) {
    const d = this.doc;
    const A = d?.active();
    if (!d) return;
    const before = this.structSnap();
    const G = new PixelLayer(`Grupo ${this.groupCounter++}`);
    G.kind = 'group';
    G.blend = 'pass-through';
    const sel = empty ? [] : this.topSelected();
    if (sel.length > 1) {
      const top = sel[sel.length - 1];
      G.parent = top.parent;
      d.layers.splice(d.indexOf(top.id) + 1, 0, G);
      for (const l of sel) { l.parent = G.id; l.clipped = false; }
    } else if (empty || !A) {
      d.layers.splice(this.above(G), 0, G);
    } else {
      G.parent = A.parent;
      G.clipped = false;
      A.parent = G.id;
      A.clipped = false;
      d.layers.splice(d.indexOf(A.id) + 1, 0, G);
    }
    d.activeLayerId = G.id;
    d.selectedIds = new Set([G.id]);
    d.editMask = false;
    this.commitStruct(empty ? 'Nuevo grupo' : 'Agrupar capas', before);
    return G.id;
  }

  /** Ctrl+Mayús+G: desagrupa (el grupo activo o el que contiene la capa activa). */
  ungroupLayers() {
    const d = this.doc;
    const A = d?.active();
    if (!d || !A) return;
    const G = A.kind === 'group' ? A : A.parent != null ? d.layer(A.parent) : undefined;
    if (!G) return;
    const before = this.structSnap();
    const kids = d.children(G.id);
    for (const c of kids) c.parent = G.parent;
    d.layers.splice(d.indexOf(G.id), 1);
    d.activeLayerId = (A === G ? kids[kids.length - 1] ?? d.layers[0] : A).id;
    this.commitStruct('Desagrupar capas', before);
  }

  /** Ctrl+Alt+G: crea o quita la máscara de recorte de la capa activa. */
  toggleClip(id?: number) {
    const d = this.doc;
    const A = id ? d?.layer(id) : d?.active();
    if (!d || !A) return;
    const sibs = d.children(A.parent);
    if (!A.clipped && sibs.indexOf(A) <= 0) { this.toast('No hay ninguna capa debajo a la que recortar.', 'warn'); return; }
    const before = this.structSnap();
    A.clipped = !A.clipped;
    this.commitStruct(A.clipped ? 'Crear máscara de recorte' : 'Liberar máscara de recorte', before);
  }

  /** Pliega o despliega un grupo en el panel (no entra en el historial). */
  setCollapsed(id: number, collapsed: boolean) {
    const L = this.doc?.layer(id);
    if (!L || L.kind !== 'group') return;
    L.collapsed = collapsed;
    this.pushState(false);
  }

  /** Arrastrar en el panel: encima o debajo de otra capa, o dentro de un grupo. */
  moveLayerTo(id: number, targetId: number, pos: 'above' | 'below' | 'inside') {
    const d = this.doc;
    const L = d?.layer(id), T = d?.layer(targetId);
    if (!d || !L || !T || L === T || d.isInside(T, L)) return;
    if (pos === 'inside' && T.kind !== 'group') pos = 'above';
    const before = this.structSnap();
    const moving = L.kind === 'group' ? [...d.descendants(L.id), L] : [L];
    d.layers = d.layers.filter((l) => !moving.includes(l));
    let idx: number;
    if (pos === 'inside') { L.parent = T.id; idx = d.indexOf(T.id); }
    else {
      L.parent = T.parent;
      const first = T.kind === 'group' ? d.descendants(T.id)[0] ?? T : T;
      idx = pos === 'above' ? d.indexOf(T.id) + 1 : d.indexOf(first.id);
    }
    d.layers.splice(idx, 0, ...moving);
    this.commitStruct('Ordenar capas', before);
  }

  newLayer(name?: string) {
    const d = this.doc;
    if (!d) return;
    const L = new PixelLayer(name ?? `Capa ${this.layerCounter++}`);
    this.insertLayer(L, this.above(L), 'Nueva capa');
    return L.id;
  }

  /** Ctrl+J: capa vía copiar (la selección) o duplicar si no hay selección. Ctrl+Mayús+J: vía cortar. */
  layerVia(cut = false) {
    const d = this.doc;
    const A = d?.active();
    if (!d || !A) return;
    if (!d.selection || A.kind !== 'pixel') {
      if (!cut) this.duplicateLayer();
      return;
    }
    const b = intersect(d.selection.bounds()!, A.bounds() ?? this.docRect());
    if (!b) return;
    const orig = A.readRegion(b.x - A.x, b.y - A.y, b.w, b.h);
    const m = d.selection.region(b);
    const px = orig.slice();
    for (let i = 0; i < m.length; i++) px[i * 4 + 3] = (px[i * 4 + 3] * m[i]) / 255;
    const L = layerFromPixels(`${A.name} ${cut ? 'cortada' : 'copia'}`, px, b.w, b.h, b.x, b.y);
    const entries: HistoryEntry[] = [];
    if (cut) {
      const patch = new TilePatch('Cortar', A);
      const cleared = orig.slice();
      for (let i = 0; i < m.length; i++) cleared[i * 4 + 3] = (cleared[i * 4 + 3] * (255 - m[i])) / 255;
      applyRegion(A, patch, b, cleared, null);
      entries.push(patch);
    }
    const idx = d.indexOf(A.id) + 1;
    const prev = d.activeLayerId;
    L.parent = A.parent;
    d.layers.splice(idx, 0, L);
    d.activeLayerId = L.id;
    entries.push(new FnEntry('', (doc) => { doc.layers.splice(doc.indexOf(L.id), 1); doc.activeLayerId = prev; }, (doc) => { doc.layers.splice(idx, 0, L); doc.activeLayerId = L.id; }));
    this.commit(new GroupEntry(cut ? 'Capa vía cortar' : 'Capa vía copiar', entries));
    this.invalidate(b);
  }

  duplicateLayer() {
    const d = this.doc;
    const A = d?.active();
    if (!d || !A) return;
    if (d.selected().length > 1) {
      const before = this.structSnap();
      const newIds: number[] = [];
      for (const U of this.topSelected()) {
        const subtree = U.kind === 'group' ? [...d.descendants(U.id), U] : [U];
        const ids = new Map<number, number>();
        const copies = subtree.map((l) => { const c = l.clone(l === U ? `${l.name} copia` : l.name); ids.set(l.id, c.id); return c; });
        copies.forEach((c, i) => { if (subtree[i] !== U && subtree[i].parent != null) c.parent = ids.get(subtree[i].parent!) ?? c.parent; });
        d.layers.splice(d.indexOf(U.id) + 1, 0, ...copies);
        newIds.push(copies[copies.length - 1].id);
      }
      d.selectedIds = new Set(newIds);
      d.activeLayerId = newIds[newIds.length - 1];
      this.commitStruct('Duplicar capas', before);
      return;
    }
    if (A.kind === 'group') {
      const before = this.structSnap();
      const subtree = [...d.descendants(A.id), A];
      const ids = new Map<number, number>();
      const copies = subtree.map((l) => { const c = l.clone(l === A ? `${A.name} copia` : l.name); ids.set(l.id, c.id); return c; });
      copies.forEach((c, i) => { if (subtree[i] !== A && subtree[i].parent != null) c.parent = ids.get(subtree[i].parent!) ?? c.parent; });
      d.layers.splice(d.indexOf(A.id) + 1, 0, ...copies);
      d.activeLayerId = copies[copies.length - 1].id;
      this.commitStruct('Duplicar grupo', before);
      return;
    }
    const L = A.clone(`${A.name} copia`);
    this.insertLayer(L, d.indexOf(A.id) + 1, 'Duplicar capa');
  }

  deleteLayer(id?: number) {
    const d = this.doc;
    if (!d || d.layers.length <= 1) return;
    if (!id && d.selected().length > 1) {
      const gone = new Set<PixelLayer>();
      for (const U of this.topSelected()) { gone.add(U); if (U.kind === 'group') for (const l of d.descendants(U.id)) gone.add(l); }
      if (gone.size >= d.layers.length) { this.toast('El documento necesita al menos una capa.', 'warn'); return; }
      const before = this.structSnap();
      const idx = Math.min(...[...gone].map((l) => d.indexOf(l.id)));
      d.layers = d.layers.filter((l) => !gone.has(l));
      d.activeLayerId = d.layers[Math.max(0, Math.min(d.layers.length - 1, idx - 1))].id;
      d.selectedIds = new Set([d.activeLayerId]);
      d.editMask = false;
      this.commitStruct('Eliminar capas', before);
      return;
    }
    const L = id ? d.layer(id) : d.active();
    if (!L) return;
    if (L.kind === 'group') {
      const gone = [...d.descendants(L.id), L];
      if (gone.length >= d.layers.length) { this.toast('El documento necesita al menos una capa.', 'warn'); return; }
      const before = this.structSnap();
      const idx = d.indexOf(gone[0].id);
      d.layers = d.layers.filter((l) => !gone.includes(l));
      d.activeLayerId = d.layers[Math.max(0, idx - 1)].id;
      d.editMask = false;
      this.commitStruct('Eliminar grupo', before);
      return;
    }
    const idx = d.indexOf(L.id);
    const prevActive = d.activeLayerId;
    const remove = (doc: EditorDocument) => {
      doc.layers.splice(idx, 1);
      doc.activeLayerId = doc.layers[Math.max(0, idx - 1)].id;
    };
    remove(d);
    this.commit(new FnEntry('Eliminar capa', (doc) => { doc.layers.splice(idx, 0, L); doc.activeLayerId = prevActive; }, remove));
    this.invalidate(L.kind === 'adjustment' ? null : union(L.bounds(), fxBounds(L)));
  }

  /** mode: 'replace' (clic), 'toggle' (Ctrl+clic), 'range' (Mayús+clic). */
  selectLayer(id: number, editMask?: boolean, mode: 'replace' | 'toggle' | 'range' = 'replace') {
    const d = this.doc;
    const L = d?.layer(id);
    if (!d || !L) return;
    const cur = new Set(d.selected().map((l) => l.id));
    if (mode === 'toggle') {
      if (cur.has(id) && cur.size > 1) {
        cur.delete(id);
        d.selectedIds = cur;
        if (d.activeLayerId === id) d.activeLayerId = [...cur].at(-1)!;
        d.editMask = false;
        this.pushState(false);
        return;
      }
      cur.add(id);
      d.selectedIds = cur;
    } else if (mode === 'range') {
      const a = d.indexOf(d.activeLayerId), b = d.indexOf(id);
      const [i0, i1] = a < b ? [a, b] : [b, a];
      d.selectedIds = new Set(d.layers.slice(Math.max(0, i0), i1 + 1).map((l) => l.id));
    } else {
      d.selectedIds = new Set([id]);
    }
    d.activeLayerId = id;
    d.editMask = editMask ?? (L.kind === 'adjustment' && !!L.mask);
    this.pushState(false);
  }

  /** Alt+[ / Alt+] / Alt+, / Alt+. : capa inferior, superior, la de más abajo, la de más arriba. */
  selectLayerRelative(which: 'up' | 'down' | 'top' | 'bottom') {
    const d = this.doc;
    if (!d) return;
    const i = d.indexOf(d.active()?.id ?? -1);
    const n = d.layers.length;
    const j = which === 'up' ? Math.min(n - 1, i + 1) : which === 'down' ? Math.max(0, i - 1) : which === 'top' ? n - 1 : 0;
    this.selectLayer(d.layers[j].id);
  }

  setLayer(id: number, props: Partial<{ name: string; visible: boolean; opacity: number; blend: BlendMode; lockAlpha: boolean; maskEnabled: boolean }>, record = true) {
    const L = this.doc?.layer(id);
    if (!L) return;
    const snap = () => ({ opacity: L.opacity, blend: L.blend, name: L.name, visible: L.visible, lockAlpha: L.lockAlpha, maskEnabled: L.maskEnabled });
    const before = (this.pendingProps.get(id) as ReturnType<typeof snap> | undefined) ?? snap();
    if (props.name !== undefined) L.name = props.name;
    if (props.visible !== undefined) L.visible = props.visible;
    if (props.opacity !== undefined) L.opacity = Math.min(1, Math.max(0, props.opacity));
    if (props.blend !== undefined) L.blend = props.blend;
    if (props.lockAlpha !== undefined) L.lockAlpha = props.lockAlpha;
    if (props.maskEnabled !== undefined) L.maskEnabled = props.maskEnabled;
    this.invalidate(L.kind === 'adjustment' ? null : union(L.bounds(), fxBounds(L)));
    if (!record) {
      this.pendingProps.set(id, before);
      this.pushState(false);
      return;
    }
    this.pendingProps.delete(id);
    const after = snap();
    if (JSON.stringify(before) === JSON.stringify(after)) { this.pushState(false); return; }
    const label = before.name !== after.name ? 'Cambiar nombre de capa'
      : before.blend !== after.blend ? 'Modo de fusión'
      : before.opacity !== after.opacity ? 'Opacidad de capa'
      : before.maskEnabled !== after.maskEnabled ? (after.maskEnabled ? 'Activar máscara' : 'Desactivar máscara')
      : before.lockAlpha !== after.lockAlpha ? 'Bloquear transparencia'
      : 'Visibilidad de capa';
    const apply = (v: typeof before) => (doc: EditorDocument) => { const l = doc.layer(id); if (l) Object.assign(l, v); };
    this.commit(new FnEntry(label, apply(before), apply(after)));
  }

  /** Alt+clic en el ojo: muestra sólo esta capa (o vuelve a mostrar todas). */
  soloLayer(id: number) {
    const d = this.doc;
    if (!d) return;
    const T = d.layer(id);
    if (!T) return;
    // Se mantienen la capa, sus grupos y su contenido (si es un grupo).
    const keep = (l: PixelLayer) => d.isInside(T, l) || d.isInside(l, T);
    const others = d.layers.filter((l) => !keep(l));
    const soloNow = others.some((l) => l.visible);
    const before = new Map(d.layers.map((l) => [l.id, l.visible]));
    for (const l of d.layers) l.visible = keep(l) ? true : !soloNow;
    const after = new Map(d.layers.map((l) => [l.id, l.visible]));
    const set = (m: Map<number, boolean>) => (doc: EditorDocument) => { for (const l of doc.layers) if (m.has(l.id)) l.visible = m.get(l.id)!; };
    this.commit(new FnEntry('Visibilidad de capa', set(before), set(after)));
    this.invalidate(null);
  }

  moveLayer(id: number, toIndex: number) {
    const d = this.doc;
    if (!d) return;
    const from = d.indexOf(id);
    const to = Math.max(0, Math.min(d.layers.length - 1, toIndex));
    if (from < 0 || from === to) return;
    const mv = (a: number, b: number) => (doc: EditorDocument) => { const [l] = doc.layers.splice(a, 1); doc.layers.splice(b, 0, l); };
    mv(from, to)(d);
    this.commit(new FnEntry('Ordenar capas', mv(to, from), mv(from, to)));
    this.invalidate(null);
  }

  /** Ctrl+] / Ctrl+[ / Ctrl+Mayús+] / Ctrl+Mayús+[ */
  arrange(which: 'up' | 'down' | 'top' | 'bottom') {
    const d = this.doc;
    const A = d?.active();
    if (!d || !A) return;
    const sibs = d.children(A.parent);
    const i = sibs.indexOf(A), last = sibs.length - 1;
    const G = A.parent != null ? d.layer(A.parent) : undefined;
    // Como Photoshop: al llegar al borde de un grupo, la capa sale de él.
    if (which === 'up') { if (i < last) this.moveLayerTo(A.id, sibs[i + 1].id, 'above'); else if (G) this.moveLayerTo(A.id, G.id, 'above'); }
    else if (which === 'down') { if (i > 0) this.moveLayerTo(A.id, sibs[i - 1].id, 'below'); else if (G) this.moveLayerTo(A.id, G.id, 'below'); }
    else if (which === 'top') { if (i < last) this.moveLayerTo(A.id, sibs[last].id, 'above'); }
    else if (i > 0) this.moveLayerTo(A.id, sibs[0].id, 'below');
  }

  private replaceLayers(label: string, oldLayers: PixelLayer[], newLayers: PixelLayer[], index: number) {
    const d = this.doc!;
    const prevActive = d.activeLayerId;
    const doIt = (doc: EditorDocument) => {
      doc.layers.splice(index, oldLayers.length, ...newLayers);
      doc.activeLayerId = newLayers[newLayers.length - 1].id;
    };
    const undoIt = (doc: EditorDocument) => {
      doc.layers.splice(index, newLayers.length, ...oldLayers);
      doc.activeLayerId = prevActive;
    };
    doIt(d);
    this.commit(new FnEntry(label, undoIt, doIt, oldLayers.reduce((a, l) => a + l.byteSize(), 0)));
    this.invalidate(null);
  }

  private contentRect(layers: PixelLayer[]): Rect | null {
    let r: Rect | null = null;
    for (const L of layers) {
      if (L.kind === 'adjustment') return this.docRect();
      r = union(r, union(L.bounds(), fxBounds(L)));
    }
    return r;
  }

  mergeDown() {
    const d = this.doc;
    const A = d?.active();
    if (!d || !A) return;
    if (d.selected().length > 1) return this.mergeLayers();
    if (A.kind === 'group') return this.mergeGroup(A);
    const sibs = d.children(A.parent);
    const j = sibs.indexOf(A);
    if (j <= 0) return;
    const B = sibs[j - 1];
    if (B.kind === 'group') { this.toast('No se puede combinar con un grupo. Combina el grupo primero (Ctrl+E con el grupo activo).', 'warn'); return; }
    const i = d.indexOf(A.id);
    const region = this.contentRect([A, B]);
    const merged = new PixelLayer(B.name);
    merged.parent = B.parent;
    merged.clipped = B.clipped;
    if (region) {
      const vis = [B, A].filter((l) => l.visible);
      const px = this.perf('Combinar', () => this.r.flatten(d, vis, region));
      merged.writeRegion(px, region.w, region.h, region.x, region.y);
    }
    this.replaceLayers('Combinar hacia abajo', [B, A], [merged], i - 1);
  }

  /** Ctrl+E con varias capas seleccionadas: se combinan en una (arriba del todo de ellas). */
  private mergeLayers() {
    const d = this.doc!;
    const units = this.topSelected();
    const all = new Set<PixelLayer>();
    for (const U of units) { all.add(U); if (U.kind === 'group') for (const l of d.descendants(U.id)) all.add(l); }
    const list = d.layers.filter((l) => all.has(l));
    const region = this.contentRect(list.filter((l) => l.kind !== 'group'));
    const top = units[units.length - 1];
    const merged = new PixelLayer(top.name);
    if (region) {
      const px = this.perf('Combinar capas', () => this.r.flatten(d, list, region));
      merged.writeRegion(px, region.w, region.h, region.x, region.y);
    }
    merged.parent = top.parent;
    const before = this.structSnap();
    const idx = d.indexOf(top.id);
    d.layers.splice(idx + 1, 0, merged);
    d.layers = d.layers.filter((l) => !all.has(l));
    d.activeLayerId = merged.id;
    d.selectedIds = new Set([merged.id]);
    d.editMask = false;
    this.commitStruct('Combinar capas', before, list.reduce((a, l) => a + l.byteSize(), 0));
  }

  /** Ctrl+E con un grupo activo: el grupo pasa a ser una sola capa. */
  mergeGroup(G: PixelLayer) {
    const d = this.doc!;
    const desc = d.descendants(G.id);
    const content = desc.filter((l) => l.kind !== 'group');
    const region = this.contentRect(content);
    const merged = new PixelLayer(G.name);
    if (region) {
      const px = this.perf('Combinar grupo', () => this.r.flatten(d, desc, region));
      merged.writeRegion(px, region.w, region.h, region.x, region.y);
    }
    merged.parent = G.parent;
    merged.opacity = G.opacity;
    merged.blend = G.blend === 'pass-through' ? 'normal' : G.blend;
    merged.visible = G.visible;
    merged.mask = G.mask?.clone() ?? null;
    merged.maskEnabled = G.maskEnabled;
    const before = this.structSnap();
    const idx = d.indexOf((desc[0] ?? G).id);
    d.layers = d.layers.filter((l) => l !== G && !desc.includes(l));
    d.layers.splice(idx, 0, merged);
    d.activeLayerId = merged.id;
    d.editMask = false;
    this.commitStruct('Combinar grupo', before, desc.reduce((a, l) => a + l.byteSize(), 0));
  }

  mergeVisible() {
    const d = this.doc;
    if (!d) return;
    const vis = d.layers.filter((l) => d.effectivelyVisible(l));
    if (vis.filter((l) => l.kind !== 'group').length < 2) return;
    const region = this.contentRect(vis.filter((l) => l.kind !== 'group')) ?? this.docRect();
    const px = this.perf('Combinar visibles', () => this.r.flatten(d, vis, region));
    const L = layerFromPixels(vis.filter((l) => l.kind !== 'group').at(-1)!.name, px, region.w, region.h, region.x, region.y);
    const before = this.structSnap();
    const keep = d.layers.filter((l) => !vis.includes(l));
    d.layers = [...keep, L];
    d.activeLayerId = L.id;
    d.editMask = false;
    this.commitStruct('Combinar visibles', before, vis.reduce((a, l) => a + l.byteSize(), 0));
  }

  /** Ctrl+Alt+Mayús+E: estampar lo visible en una capa nueva encima. */
  stampVisible() {
    const d = this.doc;
    if (!d) return;
    const px = this.perf('Estampar visibles', () => this.r.flatten(d, d.layers, this.docRect()));
    const L = layerFromPixels(`Capa ${this.layerCounter++}`, px, d.width, d.height);
    this.insertLayer(L, d.layers.length, 'Estampar visibles');
  }

  flattenImage() {
    const d = this.doc;
    if (!d) return;
    const px = this.perf('Acoplar', () => this.r.flatten(d, d.layers, this.docRect(), [255, 255, 255, 255]));
    const L = layerFromPixels('Fondo', px, d.width, d.height);
    this.replaceLayers('Acoplar imagen', [...d.layers], [L], 0);
  }

  /** Convierte texto/forma en píxeles normales. */
  rasterizeLayer(id?: number) {
    const d = this.doc;
    const L = id ? d?.layer(id) : d?.active();
    if (!d || !L || L.kind === 'pixel' || L.kind === 'adjustment' || L.kind === 'group') return;
    const before = { kind: L.kind, text: L.text, shape: L.shape, smart: L.smart };
    L.kind = 'pixel'; L.text = undefined; L.shape = undefined; L.smart = undefined;
    this.commit(new FnEntry('Rasterizar capa',
      (doc) => { const l = doc.layer(L.id); if (l) Object.assign(l, before); },
      (doc) => { const l = doc.layer(L.id); if (l) { l.kind = 'pixel'; l.text = undefined; l.shape = undefined; l.smart = undefined; } }));
  }

  /** Antes de pintar/filtrar una capa vectorial se rasteriza (Photoshop pregunta; aquí avisa). */
  private ensurePixel(L: PixelLayer): boolean {
    if (L.kind === 'group') { this.toast('Selecciona una capa de píxeles (esta es un grupo).', 'warn'); return false; }
    if (L.kind === 'adjustment') { this.toast('Selecciona una capa de píxeles (esta es una capa de ajuste).', 'warn'); return false; }
    if (L.kind !== 'pixel') { this.rasterizeLayer(L.id); this.toast('Capa rasterizada para poder editar sus píxeles.'); }
    return true;
  }

  // ================================================================ capas de ajuste y relleno

  newAdjustmentLayer(type: AdjustmentType, params?: AdjustmentParams) {
    const d = this.doc;
    if (!d) return;
    const L = new PixelLayer(type === 'solidColor' ? `Relleno de color ${this.layerCounter++}` : `${ADJUSTMENT_LABELS[type]} 1`);
    L.kind = 'adjustment';
    L.adjustment = params ?? defaultAdjustment(type, this.fg, this.bg);
    // Como en Photoshop: la capa nace con máscara (la selección, si la hay).
    L.mask = this.maskFromSelection();
    this.insertLayer(L, this.above(L), `Nueva capa de ${ADJUSTMENT_LABELS[type].toLowerCase()}`);
    d.editMask = false;
    return L.id;
  }

  setAdjustment(id: number, params: AdjustmentParams, record = true) {
    const L = this.doc?.layer(id);
    if (!L || L.kind !== 'adjustment') return;
    const key = -id;
    const before = (this.pendingProps.get(key) as AdjustmentParams | undefined) ?? L.adjustment!;
    L.adjustment = params;
    this.invalidate(null);
    if (!record) {
      this.pendingProps.set(key, before);
      this.pushState(false);
      return;
    }
    this.pendingProps.delete(key);
    const set = (v: AdjustmentParams) => (doc: EditorDocument) => { const l = doc.layer(id); if (l) l.adjustment = v; };
    this.commit(new FnEntry(`Modificar ${ADJUSTMENT_LABELS[params.type].toLowerCase()}`, set(before), set(params)));
  }

  // ================================================================ máscaras de capa

  private maskFromSelection(): MaskChannel {
    const d = this.doc!;
    const sel = d.selection;
    if (!sel) return new MaskChannel(255);
    const m = new MaskChannel(0);
    for (const [k, t] of sel.tiles) m.setTile(k, t.slice());
    return m;
  }

  addMask(mode: 'reveal' | 'hide' | 'selection' = 'reveal') {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || L.mask) return;
    let mask: MaskChannel;
    if (mode === 'selection' && d.selection) {
      mask = new MaskChannel(0);
      for (const [k, t] of d.selection.tiles) {
        if (L.x === 0 && L.y === 0) { mask.setTile(k, t.slice()); continue; }
        const ox = keyTx(k) * TILE, oy = keyTy(k) * TILE;
        for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
          const v = t[y * TILE + x];
          if (!v) continue;
          const lx = ox + x - L.x, ly = oy + y - L.y;
          const tx = Math.floor(lx / TILE), ty = Math.floor(ly / TILE);
          const kk = tileKey(tx, ty);
          mask.ensureTile(kk)[(ly - ty * TILE) * TILE + (lx - tx * TILE)] = v;
          mask.touch(kk);
        }
      }
    } else {
      mask = new MaskChannel(mode === 'hide' ? 0 : 255);
    }
    L.mask = mask;
    L.maskEnabled = true;
    d.editMask = true;
    this.commit(new FnEntry('Añadir máscara de capa',
      (doc) => { const l = doc.layer(L.id); if (l) l.mask = null; doc.editMask = false; },
      (doc) => { const l = doc.layer(L.id); if (l) l.mask = mask; doc.editMask = true; }));
    this.invalidate(L.kind === 'adjustment' ? null : L.bounds());
  }

  deleteMask(applyIt = false) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || !L.mask) return;
    const mask = L.mask;
    const entries: HistoryEntry[] = [];
    if (applyIt && L.kind === 'pixel') {
      const patch = new TilePatch('Aplicar máscara', L);
      for (const k of [...L.tiles.keys()]) {
        patch.capture(L, k);
        const w = L.ensureTile(k);
        const mt = mask.getTile(k);
        for (let i = 0; i < TILE * TILE; i++) w[i * 4 + 3] = (w[i * 4 + 3] * (mt ? mt[i] : mask.fill)) / 255;
        L.touch(k);
      }
      pruneEmpty(L);
      entries.push(patch);
    }
    L.mask = null;
    d.editMask = false;
    entries.push(new FnEntry('', (doc) => { const l = doc.layer(L.id); if (l) l.mask = mask; }, (doc) => { const l = doc.layer(L.id); if (l) l.mask = null; }));
    this.commit(new GroupEntry(applyIt ? 'Aplicar máscara de capa' : 'Eliminar máscara de capa', entries));
    this.invalidate(L.kind === 'adjustment' ? null : L.bounds());
  }

  // ================================================================ máscaras vectoriales

  /** Capa > Máscara vectorial > Mostrar todo / Ocultar todo / Trazado actual. */
  addVectorMask(mode: 'reveal' | 'hide' | 'path', path?: VectorPath) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return;
    if (mode === 'path' && (!path || isEmptyPath(path))) { this.toast('Dibuja primero un trazado con la pluma o una forma.', 'warn'); return; }
    // El trazado se guarda en coordenadas de la capa (así se mueve con ella).
    const local = mode === 'path' ? clonePath(path!).map((sp) => ({ closed: true, points: sp.points.map((q) => ({ x: q.x - L.x, y: q.y - L.y, ix: q.ix - L.x, iy: q.iy - L.y, ox: q.ox - L.x, oy: q.oy - L.y })) })) : [];
    const before = L.vmask;
    const vm = before && mode === 'path' ? { ...before, path: local, rev: nextRev() } : newVectorMask(local, mode === 'reveal');
    L.vmask = vm;
    this.commit(new FnEntry(before ? 'Editar máscara vectorial' : 'Añadir máscara vectorial',
      (doc) => { const l = doc.layer(L.id); if (l) l.vmask = before; }, (doc) => { const l = doc.layer(L.id); if (l) l.vmask = vm; }));
    this.vmaskChanged(L);
  }

  /** Propiedades de la máscara vectorial: activar, invertir, densidad y calado. */
  setVectorMask(patch: Partial<Pick<VectorMask, 'enabled' | 'invert' | 'density' | 'feather'>>, id?: number) {
    const d = this.doc;
    const L = id ? d?.layer(id) : d?.active();
    if (!d || !L?.vmask) return;
    const before = L.vmask, vm = { ...before, ...patch, rev: nextRev() };
    L.vmask = vm;
    const label = patch.enabled !== undefined ? (patch.enabled ? 'Activar máscara vectorial' : 'Desactivar máscara vectorial') : 'Propiedades de máscara vectorial';
    this.commit(new FnEntry(label, (doc) => { const l = doc.layer(L.id); if (l) l.vmask = before; }, (doc) => { const l = doc.layer(L.id); if (l) l.vmask = vm; }));
    this.vmaskChanged(L);
  }

  /** Eliminar o rasterizar (pasar a la máscara de píxeles) la máscara vectorial. */
  deleteVectorMask(rasterize = false) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L?.vmask) return;
    const before = L.vmask, oldMask = L.mask, oldEn = L.maskEnabled;
    let newMask = oldMask;
    if (rasterize) {
      const vec = rasterVectorMask(before);
      newMask = combineMasks(vec, oldMask && oldEn ? oldMask : null);
      if (newMask === vec) { const c = new MaskChannel(vec.fill); for (const [k, t] of vec.tiles) c.setTile(k, t.slice()); newMask = c; }
      else for (const k of newMask.tiles.keys()) newMask.touch(k);
    }
    L.vmask = null; L.mask = newMask; if (rasterize) L.maskEnabled = true;
    this.commit(new FnEntry(rasterize ? 'Rasterizar máscara vectorial' : 'Eliminar máscara vectorial',
      (doc) => { const l = doc.layer(L.id); if (l) { l.vmask = before; l.mask = oldMask; l.maskEnabled = oldEn; } },
      (doc) => { const l = doc.layer(L.id); if (l) { l.vmask = null; l.mask = newMask; if (rasterize) l.maskEnabled = true; } }));
    this.vmaskChanged(L);
  }

  /** El trazado de la máscara vectorial (en coordenadas de documento) para editarlo con la pluma. */
  vectorMaskPath(id?: number): VectorPath | null {
    const L = id ? this.doc?.layer(id) : this.doc?.active();
    if (!L?.vmask) return null;
    return L.vmask.path.map((sp) => ({ closed: sp.closed, points: sp.points.map((q) => ({ x: q.x + L.x, y: q.y + L.y, ix: q.ix + L.x, iy: q.iy + L.y, ox: q.ox + L.x, oy: q.oy + L.y })) }));
  }

  private vmaskChanged(L: PixelLayer) {
    L.version++;
    this.scheduleEffects();
    this.invalidate(null);
    this.pushState(true);
  }

  setEditMask(on: boolean) {
    const d = this.doc;
    if (!d) return;
    d.editMask = on && !!d.active()?.mask;
    this.pushState(false);
  }

  /** Ctrl+clic en la miniatura: carga la transparencia (o la máscara) como selección. */
  loadSelectionFromLayer(id: number, fromMask = false, mode: CombineMode = 'replace') {
    const d = this.doc;
    const L = d?.layer(id);
    if (!d || !L) return;
    const r = this.docRect();
    const m = new Uint8Array(r.w * r.h);
    if (fromMask && L.mask) {
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) m[y * r.w + x] = L.mask.get(x - L.x, y - L.y);
    } else {
      const px = L.readRegion(-L.x, -L.y, r.w, r.h);
      for (let i = 0; i < m.length; i++) m[i] = px[i * 4 + 3];
    }
    this.setSelection(this.combine(Selection.fromMask(m, r.w, r.h), mode), 'Cargar selección');
  }

  // ================================================================ selección

  private setSelection(sel: Selection | null, label: string) {
    const d = this.doc;
    if (!d) return;
    const before = d.selection;
    const next = sel && !sel.isEmpty() ? sel : null;
    if (before && !next) this.lastSelection = before;
    d.selection = next;
    this.commit(new FnEntry(label, (doc) => { doc.selection = before; }, (doc) => { doc.selection = next; }));
    this.selectionChanged();
  }

  private combine(sel: Selection, mode: CombineMode): Selection {
    const cur = this.doc?.selection;
    if (!cur || mode === 'replace') return sel;
    return cur.combine(sel, mode);
  }

  selectAll() { if (this.doc) this.setSelection(Selection.fromRect(this.docRect()), 'Seleccionar todo'); }
  deselect() { if (this.doc?.selection) this.setSelection(null, 'Deseleccionar'); }
  reselect() { if (this.doc && this.lastSelection) this.setSelection(this.lastSelection, 'Volver a seleccionar'); }

  invertSelection() {
    const d = this.doc;
    if (!d) return;
    const cur = d.selection ?? new Selection(new Map());
    this.setSelection(cur.invert(d.width, d.height), 'Invertir selección');
  }

  selectShape(rect: Rect, shape: 'rect' | 'ellipse', mode: CombineMode = 'replace', feather = 0) {
    const d = this.doc;
    if (!d) return;
    const r = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
    if (r.w < 1 || r.h < 1) {
      if (mode === 'replace') this.deselect();
      return;
    }
    let sel = shape === 'rect' ? Selection.fromRect(clampRect(r, d.width, d.height)) : Selection.fromEllipse(r);
    if (shape === 'ellipse') sel = sel.combine(Selection.fromRect(this.docRect()), 'intersect');
    if (feather > 0) sel = sel.feather(feather, d.width, d.height);
    this.setSelection(this.combine(sel, mode), shape === 'rect' ? 'Marco rectangular' : 'Marco elíptico');
  }

  selectPolygon(points: [number, number][], mode: CombineMode = 'replace', label = 'Lazo') {
    const d = this.doc;
    if (!d || points.length < 3) return;
    this.setSelection(this.combine(Selection.fromPolygon(points, this.docRect()), mode), label);
  }

  /** Píxeles de la capa activa (o de todas) como RGBA del documento. */
  private samplePixels(sampleAll: boolean): Uint8ClampedArray {
    const d = this.doc!;
    const L = d.active()!;
    if (sampleAll || L.kind === 'adjustment') return this.r.flatten(d, d.layers, this.docRect());
    return L.readRegion(-L.x, -L.y, d.width, d.height);
  }

  magicWand(x: number, y: number, tolerance = 32, contiguous = true, sampleAll = false, mode: CombineMode = 'replace') {
    const d = this.doc;
    if (!d) return;
    const px = this.perf('Varita mágica', () => this.samplePixels(sampleAll));
    const m = floodMask(px, d.width, d.height, Math.floor(x), Math.floor(y), tolerance, contiguous);
    this.setSelection(this.combine(Selection.fromMask(m, d.width, d.height), mode), 'Varita mágica');
  }

  featherSelection(radius: number) {
    const d = this.doc;
    if (!d?.selection) return;
    this.setSelection(d.selection.feather(radius, d.width, d.height), 'Calar');
  }

  growSelection(n: number) {
    const d = this.doc;
    if (!d?.selection) return;
    this.setSelection(d.selection.grow(n, d.width, d.height), n > 0 ? 'Expandir selección' : 'Contraer selección');
  }

  /** Mueve la selección (flechas con una herramienta de selección). */
  moveSelectionBy(dx: number, dy: number) {
    const d = this.doc;
    if (!d?.selection) return;
    const cur = d.selection;
    const b = cur.bounds()!;
    const moved = cur.rect ? Selection.fromRect({ ...cur.rect, x: cur.rect.x + dx, y: cur.rect.y + dy })
      : Selection.fromMask(cur.region(b), b.w, b.h, b.x + dx, b.y + dy);
    this.setSelection(moved.combine(Selection.fromRect(this.docRect()), 'intersect'), 'Mover selección');
  }

  // ================================================================ edición

  private tileOp(label: string, L: PixelLayer, rect: Rect, op: () => void) {
    const patch = new TilePatch(label, L);
    forTiles({ x: rect.x - L.x, y: rect.y - L.y, w: rect.w, h: rect.h }, (tx, ty) => patch.capture(L, tileKey(tx, ty)));
    op();
    pruneEmpty(L);
    this.commit(patch);
    this.invalidate(rect);
  }

  /** Rellenar: frontal, fondo o un color; respeta selección y, opcionalmente, la transparencia. */
  fill(which: 'fg' | 'bg' | RGBA, preserveTransparency = false) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return;
    const c = which === 'fg' ? this.fg : which === 'bg' ? this.bg : which;
    if (this.qm) return this.fillMask(lumOf(c), this.qm);
    if (d.editMask && L.mask) return this.fillMask(lumOf(c));
    if (!this.ensurePixel(L)) return;
    const sel = d.selection;
    const rect = sel ? intersect(sel.bounds()!, this.docRect()) : this.docRect();
    if (!rect) return;
    if ((!sel || sel.rect) && !preserveTransparency && !L.lockAlpha) {
      this.perf('Rellenar', () => this.tileOp('Rellenar', L, rect, () => EditorDocument.fillLayer(L, rect, c)));
      return;
    }
    const px = L.readRegion(rect.x - L.x, rect.y - L.y, rect.w, rect.h);
    for (let i = 0; i < px.length; i += 4) {
      const a = preserveTransparency || L.lockAlpha ? px[i + 3] : 255;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = a;
    }
    const patch = new TilePatch('Rellenar', L);
    this.perf('Rellenar', () => applyRegion(L, patch, rect, px, sel));
    this.commit(patch);
    this.invalidate(rect);
  }

  private fillMask(value: number, target?: PixelLayer) {
    const d = this.doc!;
    const L = target ?? d.active()!;
    const mask = L.mask!;
    const patch = new TilePatch('Rellenar máscara', L, 'mask');
    const sel = d.selection;
    const r = sel ? sel.bounds()! : this.docRect();
    forTiles({ x: r.x - L.x, y: r.y - L.y, w: r.w, h: r.h }, (tx, ty, x0, y0, x1, y1) => {
      const k = tileKey(tx, ty);
      patch.capture(L, k);
      const t = mask.ensureTile(k);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const m = sel ? sel.get(tx * TILE + x + L.x, ty * TILE + y + L.y) : 255;
        if (!m) continue;
        const i = y * TILE + x;
        t[i] = t[i] + ((value - t[i]) * m) / 255;
      }
      mask.touch(k);
    });
    this.commit(patch);
    this.invalidate(L.kind === 'adjustment' ? null : r);
  }

  clear() {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || !d.selection) return;
    if (d.editMask && L.mask) return this.fillMask(0);
    if (!this.ensurePixel(L)) return;
    const sel = d.selection;
    const rect = intersect(sel.bounds()!, L.bounds() ?? this.docRect());
    if (!rect) return;
    if (sel.rect) { this.tileOp('Borrar', L, rect, () => EditorDocument.fillLayer(L, rect, [0, 0, 0, 0])); return; }
    const px = new Uint8ClampedArray(rect.w * rect.h * 4);
    const patch = new TilePatch('Borrar', L);
    applyRegion(L, patch, rect, px, sel);
    this.commit(patch);
    this.invalidate(rect);
  }

  /** Copiar / copiar combinado: devuelve PNG para el portapapeles del sistema. */
  async copy(merged = false, cut = false): Promise<Blob | null> {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return null;
    const rect = d.selection ? intersect(d.selection.bounds()!, this.docRect()) : merged ? this.docRect() : intersect(L.bounds() ?? this.docRect(), this.docRect());
    if (!rect) return null;
    const px = merged || L.kind === 'adjustment' ? this.r.flatten(d, d.layers, rect) : L.readRegion(rect.x - L.x, rect.y - L.y, rect.w, rect.h);
    if (d.selection && !d.selection.rect) {
      const m = d.selection.region(rect);
      for (let i = 0; i < m.length; i++) px[i * 4 + 3] = (px[i * 4 + 3] * m[i]) / 255;
    }
    this.clipboard = { data: px.slice(), rect };
    if (cut && !merged) this.clear();
    return encodeRaster(px, rect.w, rect.h, 'image/png', 1);
  }

  /** Pegar: usa el portapapeles interno si no llega imagen del sistema. inPlace = Ctrl+Mayús+V. */
  async paste(buffer: ArrayBuffer | null, inPlace = false) {
    const d = this.doc;
    if (!d) return;
    if (!buffer && this.clipboard) {
      const { data, rect } = this.clipboard;
      const x = inPlace ? rect.x : Math.round((d.width - rect.w) / 2), y = inPlace ? rect.y : Math.round((d.height - rect.h) / 2);
      const L = layerFromPixels(`Capa ${this.layerCounter++}`, data, rect.w, rect.h, x, y);
      this.insertLayer(L, this.above(L), 'Pegar');
      return;
    }
    if (buffer) await this.placeImage('Pegado', buffer, 'image/png', null);
  }

  // ================================================================ imagen

  /**
   * Imagen > Tamaño de imagen. `method`: automático, conservar detalles (ampliación nítida con
   * reducción de ruido), bicúbica, más suavizada, más nítida, bilineal o por aproximación.
   */
  async resizeImage(width: number, height: number, method: ResampleMethod | 'auto' | 'details' = 'auto', detailNoise = 0) {
    const d = this.doc;
    if (!d) return;
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    if (w === d.width && h === d.height) return;
    const sx = w / d.width, sy = h / d.height;
    const up = sx * sy > 1;
    // Automático (como Photoshop): bicúbica más suavizada al ampliar y bicúbica al reducir.
    // Conservar detalles es opcional (más lento: enfoca los bordes de lo ampliado).
    const mode = method === 'auto' ? (up ? 'smoother' : 'bicubic') : method;
    const kernel: ResampleMethod = mode === 'details' ? 'bicubic' : mode;
    const t0 = performance.now();
    const oldLayers = d.layers, oldW = d.width, oldH = d.height, oldActive = d.activeLayerId;
    const activeIdx = d.indexOf(oldActive);
    let done = 0;
    this.post({ type: 'busy', label: 'Tamaño de imagen', progress: 0 });
    const newLayers = await Promise.all(oldLayers.map(async (L) => {
      let nl: PixelLayer;
      if (L.kind === 'text' || L.kind === 'shape') {
        nl = L.clone(L.name);
        const scale: Matrix = [sx, 0, 0, sy, 0, 0];
        if (nl.text) nl.text = { ...nl.text, matrix: mul(scale, nl.text.matrix) };
        if (nl.shape) nl.shape = { ...nl.shape, matrix: mul(scale, nl.shape.matrix) };
        this.rasterizeInto(nl, w, h);
      } else if (L.kind === 'adjustment') {
        nl = L.clone(L.name);
      } else {
        nl = await resampleLayer(L, sx, sy, this.pool, kernel);
      }
      if (L.mask) nl.mask = transformMask(L, [sx, 0, 0, sy, 0, 0], w, h, { x: L.x, y: L.y }, nl);
      nl.vmask = L.vmask && mapVM(L.vmask, (x, y) => [(x + L.x) * sx - nl.x, (y + L.y) * sy - nl.y]);
      nl.maskEnabled = L.maskEnabled; nl.effects = L.effects && structuredClone(L.effects); nl.lockAlpha = L.lockAlpha;
      this.post({ type: 'busy', label: 'Tamaño de imagen', progress: ++done / oldLayers.length });
      return nl;
    }));
    this.post({ type: 'busy', label: null });
    if (this.doc !== d) return;
    // Conservar detalles: enfoque ligero de bordes (y reducción de ruido si se pide) sobre lo ampliado.
    if (mode === 'details' && up) {
      const cr = { ...CAMERA_RAW_DEFAULTS, noise: detailNoise, colorNoise: detailNoise ? 25 : 0, frame: { x: 0, y: 0, w, h } };
      for (const nl of newLayers) {
        if (nl.kind === 'adjustment' || oldLayers[newLayers.indexOf(nl)].kind !== 'pixel') continue;
        const b = nl.bounds();
        if (!b) continue;
        let px = await this.filterRegion(nl, b, 'detailSharpen', { amount: Math.min(90, 35 + 15 * Math.sqrt(sx * sy)) }, 3, false);
        if (detailNoise) {
          nl.writeRegion(px, b.w, b.h, b.x, b.y);
          px = await this.filterRegion(nl, b, 'cameraRaw', { cr }, cameraRawApron(cr), false);
        }
        nl.writeRegion(px, b.w, b.h, b.x, b.y);
      }
    }
    // Conserva la estructura (grupos, recortes, objetos inteligentes, mesas de trabajo) con los ids nuevos.
    const ids = new Map(oldLayers.map((L, i) => [L.id, newLayers[i].id]));
    oldLayers.forEach((L, i) => {
      const nl = newLayers[i];
      nl.kind = L.kind; nl.parent = L.parent == null ? null : ids.get(L.parent) ?? null;
      nl.clipped = L.clipped; nl.collapsed = L.collapsed; nl.visible = L.visible; nl.opacity = L.opacity; nl.blend = L.blend;
      if (L.artboard) nl.artboard = { ...L.artboard, x: Math.round(L.artboard.x * sx), y: Math.round(L.artboard.y * sy), w: Math.max(1, Math.round(L.artboard.w * sx)), h: Math.max(1, Math.round(L.artboard.h * sy)) };
      if (L.kind === 'smart' && L.smart) {
        const S: Matrix = [sx, 0, 0, sy, 0, 0];
        nl.smart = L.smart.warps?.length ? { ...L.smart, warps: [...L.smart.warps, { kind: 'affine', m: S }] } : { ...L.smart, matrix: mul(S, L.smart.matrix) };
      }
    });
    const newActive = newLayers[Math.max(0, activeIdx)].id;
    const oldSel = d.selection;
    const set = (layers: PixelLayer[], W: number, H: number, active: number, sel: Selection | null) => (doc: EditorDocument) => {
      doc.layers = layers; doc.width = W; doc.height = H; doc.activeLayerId = active; doc.selection = sel;
    };
    set(newLayers, w, h, newActive, null)(d);
    this.commit(new FnEntry('Tamaño de imagen', set(oldLayers, oldW, oldH, oldActive, oldSel), set(newLayers, w, h, newActive, null),
      oldLayers.reduce((a, l) => a + l.byteSize(), 0)));
    this.post({ type: 'perf', label: `Tamaño de imagen (${this.pool.size} hilos)`, ms: performance.now() - t0 });
    this.fit(true);
    this.invalidate(null);
    this.selectionChanged();
  }

  /** Tamaño de lienzo: cambia el documento y desplaza las capas según el ancla (0..8, 4 = centro). */
  canvasSize(width: number, height: number, anchor = 4) {
    const d = this.doc;
    if (!d) return;
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    const ax = anchor % 3, ay = Math.floor(anchor / 3);
    const dx = Math.round(((w - d.width) * ax) / 2), dy = Math.round(((h - d.height) * ay) / 2);
    this.shiftDocument(w, h, dx, dy, 'Tamaño de lienzo');
  }

  /**
   * Recortar (no destructivo: el contenido fuera del lienzo se conserva). Con `angle` (Enderezar o
   * girar el cuadro) el rectángulo está girado `angle` rad alrededor de `pivot` y se endereza la imagen.
   */
  async crop(rect: Rect & { angle?: number; pivot?: [number, number] }) {
    const d = this.doc;
    if (!d) return;
    const r = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(1, Math.round(rect.w)), h: Math.max(1, Math.round(rect.h)) };
    const a = rect.angle ?? 0;
    if (Math.abs(a) < 1e-6) { this.shiftDocument(r.w, r.h, -r.x, -r.y, 'Recortar'); return; }
    const [px, py] = rect.pivot ?? [d.width / 2, d.height / 2];
    const c = Math.cos(a), s = Math.sin(a);
    const m: Matrix = [c, -s, s, c, 0, 0];
    m[4] = px - rect.x - (m[0] * px + m[2] * py);
    m[5] = py - rect.y - (m[1] * px + m[3] * py);
    await this.warpDocument({ kind: 'affine', m }, r.w, r.h, 'Recortar');
  }

  /** Imagen > Rotación de imagen > Arbitraria… (grados, positivo = horario; el lienzo crece para que quepa). */
  async rotateArbitrary(deg: number) {
    const d = this.doc;
    if (!d || !deg) return;
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const W = d.width, H = d.height;
    const nW = Math.max(1, Math.round(Math.abs(W * c) + Math.abs(H * s))), nH = Math.max(1, Math.round(Math.abs(W * s) + Math.abs(H * c)));
    const m: Matrix = [c, s, -s, c, 0, 0];
    m[4] = nW / 2 - (c * W / 2 - s * H / 2);
    m[5] = nH / 2 - (s * W / 2 + c * H / 2);
    await this.warpDocument({ kind: 'affine', m }, nW, nH, `Rotación de imagen ${deg}°`);
  }

  /** Herramienta Recortar con perspectiva: el cuadrilátero (sup-izq, sup-der, inf-der, inf-izq) pasa a rectángulo. */
  async perspectiveCrop(quad: number[], size?: { w: number; h: number }) {
    const d = this.doc;
    if (!d || quad.length !== 8) return;
    const q = toQuad(quad);
    const len = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const w = Math.max(1, Math.round(size?.w ?? (len(q[0], q[1]) + len(q[3], q[2])) / 2));
    const h = Math.max(1, Math.round(size?.h ?? (len(q[0], q[3]) + len(q[1], q[2])) / 2));
    const hm = homographyOf(q, [[0, 0], [w, 0], [w, h], [0, h]]);
    await this.warpDocument({ kind: 'proj', h: hm, dst: { x: 0, y: 0, w, h } }, w, h, 'Recortar con perspectiva');
  }

  /** Aplica una transformación a todo el documento (todas las capas y máscaras) y cambia su tamaño. */
  private async warpDocument(spec: WarpSpec, w: number, h: number, label: string) {
    const d = this.doc!;
    const oldW = d.width, oldH = d.height, oldSel = d.selection;
    this.post({ type: 'busy', label: `${label}…` });
    const t0 = performance.now();
    const entries: HistoryEntry[] = [];
    try {
      d.width = w; d.height = h; d.selection = null;
      entries.push(new FnEntry('', (doc) => { doc.width = oldW; doc.height = oldH; doc.selection = oldSel; }, (doc) => { doc.width = w; doc.height = h; doc.selection = null; }));
      for (const L of d.layers) {
        if (L.artboard) {
          const ab = L.artboard, r = specBounds(spec, { x: ab.x, y: ab.y, w: ab.w, h: ab.h });
          const nab = { ...ab, x: r.x, y: r.y, w: Math.max(1, r.w), h: Math.max(1, r.h) };
          L.artboard = nab;
          entries.push(new FnEntry('', (doc) => { const l = doc.layer(L.id); if (l) l.artboard = ab; }, (doc) => { const l = doc.layer(L.id); if (l) l.artboard = nab; }));
        }
        if (L.kind === 'group' || L.kind === 'adjustment') {
          if (!L.mask) continue;
          const oldMask = L.mask, newMask = warpMask(oldMask, { x: L.x, y: L.y }, spec, w, h), ox = L.x, oy = L.y;
          L.mask = newMask; L.x = 0; L.y = 0;
          entries.push(new FnEntry('', (doc) => { const l = doc.layer(L.id); if (l) { l.mask = oldMask; l.x = ox; l.y = oy; } }, (doc) => { const l = doc.layer(L.id); if (l) { l.mask = newMask; l.x = 0; l.y = 0; } }));
          continue;
        }
        if ((L.kind === 'text' || L.kind === 'shape') && spec.kind !== 'affine') {
          // Texto/formas con perspectiva: se rasterizan (Photoshop hace lo mismo al recortar con perspectiva).
          const before = { kind: L.kind, text: L.text, shape: L.shape };
          L.kind = 'pixel'; L.text = undefined; L.shape = undefined;
          entries.push(new FnEntry('', (doc) => { const l = doc.layer(L.id); if (l) Object.assign(l, before); },
            (doc) => { const l = doc.layer(L.id); if (l) { l.kind = 'pixel'; l.text = undefined; l.shape = undefined; } }));
        }
        const e = spec.kind === 'affine' ? await this.transformOne(L, spec.m, label) : await this.warpOne(L, spec, label);
        if (e) entries.push(e);
      }
    } finally {
      this.post({ type: 'busy', label: null });
    }
    this.commit(new GroupEntry(label, entries));
    this.post({ type: 'perf', label, ms: performance.now() - t0 });
    this.fit(true);
    this.invalidate(null);
    this.selectionChanged();
  }

  cropToSelection() {
    const b = this.doc?.selection?.bounds();
    if (b) this.crop(b);
  }

  private shiftDocument(w: number, h: number, dx: number, dy: number, label: string) {
    const d = this.doc!;
    const oldW = d.width, oldH = d.height, oldSel = d.selection;
    const before = d.layers.map((L) => ({ L, x: L.x, y: L.y, text: L.text, shape: L.shape, mask: L.mask, smart: L.smart, artboard: L.artboard }));
    for (const L of d.layers) {
      if (L.kind === 'adjustment') { if (L.mask) L.mask = shiftMask(L.mask, dx, dy); continue; }
      this.shiftLayer(L, dx, dy);
    }
    d.width = w; d.height = h; d.selection = null;
    const after = d.layers.map((L) => ({ L, x: L.x, y: L.y, text: L.text, shape: L.shape, mask: L.mask, smart: L.smart, artboard: L.artboard }));
    const restore = (s: typeof before) => { for (const m of s) { m.L.x = m.x; m.L.y = m.y; m.L.text = m.text; m.L.shape = m.shape; m.L.mask = m.mask; m.L.smart = m.smart; m.L.artboard = m.artboard; } };
    this.commit(new FnEntry(label,
      (doc) => { doc.width = oldW; doc.height = oldH; doc.selection = oldSel; restore(before); },
      (doc) => { doc.width = w; doc.height = h; doc.selection = null; restore(after); }));
    this.fit(true);
    this.invalidate(null);
    this.selectionChanged();
  }

  /** Rotación de imagen (90°, -90°, 180°) y voltear lienzo. */
  rotateCanvas(deg: 90 | -90 | 180) { return this.transformCanvas(deg, null); }
  flipCanvas(horizontal: boolean) { return this.transformCanvas(null, horizontal); }

  private async transformCanvas(deg: 90 | -90 | 180 | null, flipH: boolean | null) {
    const d = this.doc;
    if (!d) return;
    const W = d.width, H = d.height;
    const nW = deg && deg !== 180 ? H : W, nH = deg && deg !== 180 ? W : H;
    const m: Matrix = deg === 90 ? [0, 1, -1, 0, H, 0] : deg === -90 ? [0, -1, 1, 0, 0, W] : deg === 180 ? [-1, 0, 0, -1, W, H]
      : flipH ? [-1, 0, 0, 1, W, 0] : [1, 0, 0, -1, 0, H];
    // En el sitio (conserva grupos, objetos inteligentes, máscaras vectoriales y mesas de trabajo).
    await this.warpDocument({ kind: 'affine', m }, nW, nH, deg ? `Rotación de imagen ${deg}°` : flipH ? 'Voltear lienzo horizontal' : 'Voltear lienzo vertical');
  }

  /** Ajustes destructivos (Ctrl+L, Ctrl+M, Ctrl+U…): se calculan en GPU con una capa temporal. */
  applyAdjustment(params: AdjustmentParams, preview = false) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return;
    this.restorePreview();
    if (d.editMask && L.mask && params.type === 'invert') return this.invertMask();
    if (!this.ensurePixel(L)) return;
    const b = L.bounds();
    if (!b) return;
    const proxy = new PixelLayer('tmp');
    proxy.tiles = L.tiles; proxy.x = L.x; proxy.y = L.y;
    const adj = new PixelLayer('adj');
    adj.kind = 'adjustment'; adj.adjustment = params;
    const px = this.perf(ADJUSTMENT_LABELS[params.type], () => this.r.flatten(d, [proxy, adj], b));
    const patch = new TilePatch(ADJUSTMENT_LABELS[params.type], L);
    applyRegion(L, patch, b, px, d.selection);
    if (preview) this.preview = patch; else this.commit(patch);
    this.invalidate(b);
  }

  /** Deshace la vista previa en curso (sin tocar el historial). */
  restorePreview() {
    if (!this.preview || !this.doc) return;
    this.preview.undo(this.doc);
    this.preview = null;
    this.invalidate(null);
  }

  /** Cierra la vista previa: la confirma (entra en el historial) o la descarta. */
  endPreview(commit: boolean) {
    this.previewSeq++;
    if (commit && this.preview) { this.commit(this.preview); this.preview = null; return; }
    this.restorePreview();
  }

  private invertMask() {
    const L = this.doc!.active()!;
    const mask = L.mask!;
    const patch = new TilePatch('Invertir máscara', L, 'mask');
    for (const k of [...mask.tiles.keys()]) {
      patch.capture(L, k);
      const t = mask.tiles.get(k)!;
      for (let i = 0; i < t.length; i++) t[i] = 255 - t[i];
      mask.touch(k);
    }
    const oldFill = mask.fill;
    mask.fill = 255 - oldFill;
    this.commit(new GroupEntry('Invertir máscara', [patch, new FnEntry('', () => { mask.fill = oldFill; }, () => { mask.fill = 255 - oldFill; })]));
    this.invalidate(null);
  }

  adjust(kind: 'invert' | 'desaturate' | 'brightness' | 'autoTone' | 'autoContrast', a = 0, b = 0) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return;
    if (kind === 'invert' && d.editMask && L.mask) return this.invertMask();
    if (!this.ensurePixel(L)) return;
    if (d.selection) {
      if (kind === 'invert') return this.applyAdjustment({ type: 'invert' });
      if (kind === 'brightness') return this.applyAdjustment({ type: 'brightness', brightness: a, contrast: b });
      if (kind === 'desaturate') return this.applyAdjustment({ type: 'hueSat', hue: 0, saturation: -100, lightness: 0, colorize: false });
    }
    const labels = { invert: 'Invertir', desaturate: 'Desaturar', brightness: 'Brillo/Contraste', autoTone: 'Tono automático', autoContrast: 'Contraste automático' };
    const patch = new TilePatch(labels[kind], L);
    const cap = (k: number) => patch.capture(L, k);
    this.perf(labels[kind], () => {
      if (kind === 'desaturate') desaturate(L, cap);
      else if (kind === 'autoTone' || kind === 'autoContrast') applyLut(L, autoLevelsLut(L, kind === 'autoTone'), cap);
      else applyLut(L, kind === 'invert' ? invertLut() : brightnessContrastLut(a, b), cap);
    });
    this.commit(patch);
    this.invalidate(L.bounds());
  }

  // ================================================================ filtros

  async applyFilter(name: FilterName, params: FilterParams = {}, preview = false) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return;
    const seq = ++this.previewSeq;
    while (this.busy) await new Promise((r) => setTimeout(r, 20));
    if (seq !== this.previewSeq) return; // llegó una petición más reciente
    this.restorePreview();
    if (L.kind === 'smart' && L.smart) {
      // Objeto inteligente: el filtro se añade como filtro inteligente (editable y reversible).
      this.busy = true;
      try {
        const next = { ...L.smart, filters: [...L.smart.filters, { name, params: { ...params, seed: Math.floor(Math.random() * 1e6) } as Record<string, unknown>, enabled: true }] };
        const e = await this.smartUpdate(L, next, `Filtro inteligente: ${FILTER_LABELS[name]}`);
        if (preview && seq !== this.previewSeq) { e.undo(this.doc!); this.invalidate(null); return; }
        if (preview) this.preview = e; else { this.commit(e); this.lastFilter = { name, params }; }
      } finally { this.busy = false; this.post({ type: 'busy', label: null }); }
      return;
    }
    if (!this.ensurePixel(L)) return;
    const lb = name === 'clouds' ? this.docRect() : L.bounds();
    if (!lb) return;
    const apron = filterApron(name, params);
    let region: Rect | null = name === 'clouds' ? this.docRect() : { x: lb.x - apron, y: lb.y - apron, w: lb.w + apron * 2, h: lb.h + apron * 2 };
    if (d.selection) region = intersect(region, d.selection.bounds()!);
    if (!region) return;
    this.busy = true;
    const t0 = performance.now();
    this.post({ type: 'busy', label: `${FILTER_LABELS[name]}…`, progress: 0 });
    try {
      const out = await this.filterRegion(L, region, name, params, apron);
      const reg = region;
      // La vista previa se canceló o se pidió otra mientras se calculaba: se descarta.
      if (preview && seq !== this.previewSeq) return;
      const patch = new TilePatch(FILTER_LABELS[name], L);
      applyRegion(L, patch, reg, out, d.selection);
      if (preview) this.preview = patch; else { this.commit(patch); this.lastFilter = { name, params }; }
      this.invalidate(reg);
      this.post({ type: 'perf', label: `${FILTER_LABELS[name]} (${this.pool.size} hilos)`, ms: performance.now() - t0 });
    } finally {
      this.busy = false;
      this.post({ type: 'busy', label: null });
    }
  }

  /** Calcula un filtro sobre una región de una capa (en paralelo por bandas); devuelve los píxeles nuevos. */
  private async filterRegion(L: PixelLayer, region: Rect, name: FilterName, params: FilterParams, apron: number, progress = true): Promise<Uint8ClampedArray> {
    const seed = (params as { seed?: number }).seed ?? Math.floor(Math.random() * 1e6);
    const p = { ...params, seed, fg: this.fg, bg: this.bg };
    const W = region.w + apron * 2;
    const src = L.readRegion(region.x - apron - L.x, region.y - apron - L.y, W, region.h + apron * 2);
    const out = new Uint8ClampedArray(region.w * region.h * 4);
    const bands = WHOLE_FILTERS.has(name) ? 1 : Math.max(1, Math.min(region.h, this.pool.size * 3));
    const rowsPer = Math.ceil(region.h / bands);
    let done = 0;
    const jobs: Promise<void>[] = [];
    const reg = region;
    for (let r0 = 0; r0 < reg.h; r0 += rowsPer) {
      const r1 = Math.min(reg.h, r0 + rowsPer);
      const s1 = r1 + apron * 2;
      const slice = src.slice(r0 * W * 4, s1 * W * 4);
      jobs.push(this.pool.run({ op: 'filter', name, params: p, src: slice, w: W, rows: s1 - r0, top: apron, outRows: r1 - r0, ox: reg.x - apron, oy: reg.y - apron + r0 })
        .then((band) => {
          for (let y = 0; y < r1 - r0; y++) out.set(band.subarray((y * W + apron) * 4, (y * W + apron + reg.w) * 4), (r0 + y) * reg.w * 4);
          if (progress) this.post({ type: 'busy', label: `${FILTER_LABELS[name]}…`, progress: ++done / bands });
        }));
    }
    await Promise.all(jobs);
    return out;
  }

  /** Copia reducida (promedio de área) de la capa activa para las vistas previas de los diálogos. */
  private layerPreview(size: number): { w: number; h: number; k: number; before: Uint8ClampedArray; b: Rect } | null {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || L.kind === 'adjustment' || L.kind === 'group') return null;
    const b = exactBounds(L);
    if (!b) return null;
    const full = L.readRegion(b.x - L.x, b.y - L.y, b.w, b.h);
    const k = Math.min(1, size / Math.max(b.w, b.h));
    const w = Math.max(1, Math.round(b.w * k)), h = Math.max(1, Math.round(b.h * k));
    const before = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y / k), y1 = Math.max(y0 + 1, Math.min(b.h, Math.floor((y + 1) / k)));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x / k), x1 = Math.max(x0 + 1, Math.min(b.w, Math.floor((x + 1) / k)));
        let r = 0, g = 0, bb = 0, a = 0, c = 0;
        for (let yy = y0; yy < y1; yy += Math.max(1, ((y1 - y0) / 4) | 0)) for (let xx = x0; xx < x1; xx += Math.max(1, ((x1 - x0) / 4) | 0)) {
          const i = (yy * b.w + xx) * 4; r += full[i]; g += full[i + 1]; bb += full[i + 2]; a += full[i + 3]; c++;
        }
        const o = (y * w + x) * 4; before[o] = r / c; before[o + 1] = g / c; before[o + 2] = bb / c; before[o + 3] = a / c;
      }
    }
    return { w, h, k, before, b };
  }

  /** Galería de desenfoques (diálogo): vista previa reducida; los controles van en coordenadas de documento. */
  blurGalleryPreview(g: BlurGallery, size = 900): { w: number; h: number; k: number; before: Uint8ClampedArray; after: Uint8ClampedArray; frame: Rect } | null {
    const P = this.layerPreview(size);
    if (!P) return null;
    const { w, h, k, before, b } = P;
    const tx = (x: number) => (x - b.x) * k, ty = (y: number) => (y - b.y) * k;
    const gp: BlurGallery = {
      ...g, blur: g.blur * k, scale: 1,
      pins: g.pins.map((p) => ({ x: tx(p.x), y: ty(p.y), blur: p.blur * k })),
      iris: { ...g.iris, cx: tx(g.iris.cx), cy: ty(g.iris.cy), rx: g.iris.rx * k, ry: g.iris.ry * k },
      tilt: { ...g.tilt, cx: tx(g.tilt.cx), cy: ty(g.tilt.cy), focus: g.tilt.focus * k, transition: g.tilt.transition * k },
    };
    const after = blurGalleryBand(before, w, h, 0, h, 0, 0, gp);
    return { w, h, k, before, after, frame: b };
  }

  /** Revelado (diálogo): vista previa reducida de la capa activa, antes/después e histograma. */
  developPreview(cr: CameraRaw, size = 900): { w: number; h: number; before: Uint8ClampedArray; after: Uint8ClampedArray; hist: Uint32Array; frame: Rect } | null {
    const P = this.layerPreview(size);
    if (!P) return null;
    const { w, h, k, before, b } = P;
    const frame = { x: 0, y: 0, w, h };
    const after = cameraRawBand(before, w, h, 0, h, 0, 0, { ...CAMERA_RAW_DEFAULTS, ...cr, frame, scale: k, radius: localRadius({ ...CAMERA_RAW_DEFAULTS, frame: b }) });
    const hist = new Uint32Array(768);
    for (let i = 0; i < after.length; i += 4) if (after[i + 3] > 8) { hist[after[i]]++; hist[256 + after[i + 1]]++; hist[512 + after[i + 2]]++; }
    return { w, h, before, after, hist, frame: b };
  }

  repeatFilter() {
    if (this.lastFilter) return this.applyFilter(this.lastFilter.name, this.lastFilter.params);
  }

  /** Confirma una vista previa de filtro y la recuerda como "último filtro". */
  async commitFilterPreview(name: FilterName, params: FilterParams) {
    while (this.busy) await new Promise((r) => setTimeout(r, 20)); // espera la vista previa en curso
    if (this.preview) this.endPreview(true);
    else await this.applyFilter(name, params, false);
    this.lastFilter = { name, params };
  }

  // ================================================================ degradado y bote

  applyGradient(p0: [number, number], p1: [number, number], type: GradientType = 'linear', toTransparent = false, reverse = false, stops: Stops | null = null) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return;
    if (d.editMask && L.mask) {
      const gs = stops ? { ...stops, c: stops.c.map(([t, r, g, b]) => [t, lumOf([r, g, b, 255]), 0, 0] as [number, number, number, number]) } : null;
      const px = gradientPixels(this.docRect(), p0, p1, type, [lumOf(this.fg), 0, 0, 255], [lumOf(this.bg), 0, 0, 255], reverse, gs);
      const mask = L.mask;
      const patch = new TilePatch('Degradado (máscara)', L, 'mask');
      forTiles({ x: -L.x, y: -L.y, w: d.width, h: d.height }, (tx, ty, x0, y0, x1, y1) => {
        const k = tileKey(tx, ty);
        patch.capture(L, k);
        const t = mask.ensureTile(k);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const dx = tx * TILE + x + L.x, dy = ty * TILE + y + L.y;
          const m = d.selection ? d.selection.get(dx, dy) : 255;
          if (!m) continue;
          const v = px[(dy * d.width + dx) * 4];
          t[y * TILE + x] += ((v - t[y * TILE + x]) * m) / 255;
        }
        mask.touch(k);
      });
      this.commit(patch);
      this.invalidate(null);
      return;
    }
    if (!this.ensurePixel(L)) return;
    const region = d.selection ? intersect(d.selection.bounds()!, this.docRect())! : this.docRect();
    const to: RGBA = toTransparent ? [this.fg[0], this.fg[1], this.fg[2], 0] : this.bg;
    const grad = this.perf('Degradado', () => gradientPixels(region, p0, p1, type, this.fg, to, reverse, stops));
    const orig = L.readRegion(region.x - L.x, region.y - L.y, region.w, region.h);
    for (let i = 0; i < grad.length; i += 4) {
      const sa = grad[i + 3] / 255, da = orig[i + 3] / 255;
      const a = sa + da * (1 - sa);
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) grad[i + c] = (grad[i + c] * sa + orig[i + c] * da * (1 - sa)) / a;
      grad[i + 3] = a * 255;
    }
    const patch = new TilePatch('Degradado', L);
    applyRegion(L, patch, region, grad, d.selection);
    this.commit(patch);
    this.invalidate(region);
  }

  bucketFill(x: number, y: number, tolerance = 32, contiguous = true, sampleAll = false) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || x < 0 || y < 0 || x >= d.width || y >= d.height) return;
    if (!this.ensurePixel(L)) return;
    const px = this.samplePixels(sampleAll);
    const m = floodMask(px, d.width, d.height, Math.floor(x), Math.floor(y), tolerance, contiguous);
    let sel = Selection.fromMask(m, d.width, d.height);
    if (d.selection) sel = sel.combine(d.selection, 'intersect');
    const b = sel.bounds();
    if (!b) return;
    const orig = L.readRegion(b.x - L.x, b.y - L.y, b.w, b.h);
    const c = this.fg;
    for (let i = 0; i < orig.length; i += 4) { orig[i] = c[0]; orig[i + 1] = c[1]; orig[i + 2] = c[2]; orig[i + 3] = L.lockAlpha ? orig[i + 3] : 255; }
    const patch = new TilePatch('Bote de pintura', L);
    this.perf('Bote de pintura', () => applyRegion(L, patch, b, orig, sel));
    this.commit(patch);
    this.invalidate(b);
  }

  /** Herramienta Pupilas rojas: clic o rectángulo alrededor del ojo. */
  redEye(x0: number, y0: number, x1: number, y1: number, pupil = 50, darken = 50) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return;
    if (!this.ensurePixel(L)) return;
    let r: Rect = { x: Math.floor(Math.min(x0, x1)), y: Math.floor(Math.min(y0, y1)), w: Math.ceil(Math.abs(x1 - x0)), h: Math.ceil(Math.abs(y1 - y0)) };
    if (r.w < 4 || r.h < 4) {
      // Un clic: busca en un cuadro proporcional a la imagen alrededor del punto.
      const s = Math.max(24, Math.round(Math.min(d.width, d.height) * 0.08));
      r = { x: Math.round(x0 - s / 2), y: Math.round(y0 - s / 2), w: s, h: s };
    }
    // La mancha puede salirse del cuadro: se trabaja con margen y se siembra dentro del cuadro.
    const m = Math.round(Math.max(r.w, r.h) * 0.75);
    const b = intersect({ x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 }, this.docRect());
    if (!b) return;
    const px = L.readRegion(b.x - L.x, b.y - L.y, b.w, b.h);
    const n = fixRedEye(px, b.w, b.h, pupil, darken, { x: r.x - b.x, y: r.y - b.y, w: r.w, h: r.h });
    if (!n) { this.toast('No se ha encontrado ningún ojo rojo en esa zona.', 'warn'); return; }
    const patch = new TilePatch('Pupilas rojas', L);
    this.perf('Pupilas rojas', () => applyRegion(L, patch, b, px, d.selection));
    this.commit(patch);
    this.invalidate(b);
  }

  /** Edición > Contornear: trazo del borde de la selección en la capa activa. */
  strokeSelection(p: { width: number; color?: RGBA; location: StrokeLocation; opacity?: number; preserve?: boolean }) {
    const d = this.doc;
    const L = d?.active();
    const sel = d?.selection;
    if (!d || !L) return;
    if (!sel) { this.toast('Contornear necesita una selección.', 'warn'); return; }
    if (!this.ensurePixel(L)) return;
    const W = Math.max(1, Math.min(250, Math.round(p.width)));
    const sb = sel.bounds()!;
    const pad = W + 2;
    const region = intersect({ x: sb.x - pad, y: sb.y - pad, w: sb.w + pad * 2, h: sb.h + pad * 2 }, this.docRect());
    if (!region) return;
    const cov = strokeCoverage(sel.region(region), region.w, region.h, W, p.location);
    const c = p.color ?? this.fg, op = p.opacity ?? 1;
    const px = L.readRegion(region.x - L.x, region.y - L.y, region.w, region.h);
    const keep = p.preserve || L.lockAlpha;
    for (let j = 0, i = 0; j < cov.length; j++, i += 4) {
      const a = (cov[j] / 255) * op;
      if (a <= 0) continue;
      const da = px[i + 3] / 255;
      if (keep) { for (let k = 0; k < 3; k++) px[i + k] += (c[k] - px[i + k]) * a; continue; }
      const oa = a + da * (1 - a);
      for (let k = 0; k < 3; k++) px[i + k] = (c[k] * a + px[i + k] * da * (1 - a)) / oa;
      px[i + 3] = oa * 255;
    }
    const patch = new TilePatch('Contornear', L);
    this.perf('Contornear', () => applyRegion(L, patch, region, px, null));
    this.commit(patch);
    this.invalidate(region);
  }

  /** Nueva capa con opciones (Ctrl+Mayús+N): modo, opacidad, recorte y relleno neutro. */
  newLayerWith(o: { name?: string; blend?: BlendMode; opacity?: number; clip?: boolean; neutral?: boolean }) {
    const d = this.doc;
    if (!d) return;
    const L = new PixelLayer(o.name?.trim() || `Capa ${this.layerCounter++}`);
    const idx = this.above(L);
    if (o.blend) L.blend = o.blend;
    if (o.opacity !== undefined) L.opacity = Math.max(0, Math.min(1, o.opacity));
    if (o.clip && d.active()) L.clipped = true;
    const nc = o.neutral && o.blend ? NEUTRAL[o.blend] : undefined;
    if (nc !== undefined) EditorDocument.fillLayer(L, this.docRect(), [nc, nc, nc, 255]);
    this.insertLayer(L, idx, 'Nueva capa');
    return L.id;
  }

  // ================================================================ mesas de trabajo

  private artboards(): PixelLayer[] { return this.doc?.layers.filter((l) => !!l.artboard) ?? []; }

  /** Amplía el lienzo (sin mover nada) para que quepa `r`. */
  private growCanvasFor(r: Rect) {
    const d = this.doc!;
    const w = Math.max(d.width, r.x + r.w), h = Math.max(d.height, r.y + r.h);
    if (w !== d.width || h !== d.height) this.shiftDocument(w, h, 0, 0, 'Tamaño de lienzo');
  }

  /** Capa > Nueva > Mesa de trabajo: a la derecha de las que ya haya (el lienzo crece si hace falta). */
  newArtboard(p: { w: number; h: number; name?: string; bg?: RGBA | null }) {
    const d = this.doc;
    if (!d) return;
    const list = this.artboards();
    const w = Math.max(1, Math.round(p.w)), h = Math.max(1, Math.round(p.h));
    const x = list.length ? Math.max(...list.map((a) => a.artboard!.x + a.artboard!.w)) + 100 : 0;
    const y = list.length ? Math.min(...list.map((a) => a.artboard!.y)) : 0;
    let id = 0;
    this.batched('Nueva mesa de trabajo', () => {
      this.growCanvasFor({ x, y, w, h });
      const G = new PixelLayer(p.name ?? `Mesa de trabajo ${list.length + 1}`);
      G.kind = 'group';
      G.blend = 'normal';
      G.artboard = { x, y, w, h, bg: p.bg === undefined ? [255, 255, 255, 255] : p.bg };
      this.insertLayer(G, d.layers.length, 'Nueva mesa de trabajo');
      d.selectedIds = new Set([G.id]);
      id = G.id;
    });
    this.fit(false);
    this.invalidate(null);
    return id;
  }

  /** Mesa de trabajo desde capas: agrupa las seleccionadas en una mesa del tamaño de su contenido. */
  artboardFromLayers() {
    const d = this.doc;
    if (!d) return;
    let bb: Rect | null = null;
    for (const U of this.topSelected()) for (const l of U.kind === 'group' ? d.descendants(U.id) : [U]) if (l.kind !== 'group' && l.kind !== 'adjustment') bb = union(bb, exactBounds(l));
    if (!bb) { this.toast('Las capas seleccionadas están vacías.', 'warn'); return; }
    this.batched('Mesa de trabajo desde capas', () => {
      const id = this.groupLayers()!;
      const G = d.layer(id)!;
      const n = this.artboards().length + 1;
      const before = { name: G.name, blend: G.blend, artboard: G.artboard };
      G.name = `Mesa de trabajo ${n}`; G.blend = 'normal'; G.artboard = { ...bb!, bg: null };
      const after = { name: G.name, blend: G.blend, artboard: G.artboard };
      this.commit(new FnEntry('', (doc) => { const l = doc.layer(id); if (l) Object.assign(l, before); }, (doc) => { const l = doc.layer(id); if (l) Object.assign(l, after); }));
    });
    this.invalidate(null);
  }

  /** Propiedades de la mesa de trabajo: posición, tamaño y fondo. */
  setArtboard(id: number, patch: Partial<Artboard>) {
    const d = this.doc, G = d?.layer(id);
    if (!d || !G?.artboard) return;
    const before = G.artboard;
    const next = { ...before, ...patch };
    next.w = Math.max(1, Math.round(next.w)); next.h = Math.max(1, Math.round(next.h)); next.x = Math.round(next.x); next.y = Math.round(next.y);
    this.batched('Cambiar mesa de trabajo', () => {
      G.artboard = next;
      this.commit(new FnEntry('', (doc) => { const l = doc.layer(id); if (l) l.artboard = before; }, (doc) => { const l = doc.layer(id); if (l) l.artboard = next; }));
      this.growCanvasFor(next);
    });
    this.invalidate(null);
  }

  /**
   * Exporta cada mesa de trabajo (o el documento si no hay) en uno o varios tamaños.
   * Formatos: PNG, JPEG, WebP, GIF (paleta), TIFF y PDF (RGB, CMYK o gris) y SVG (formas y texto como vectores).
   */
  async exportSet(type: ExportType, quality: number, scales: number[], which: 'document' | 'artboards', o: ExportOptions = {}): Promise<{ name: string; blob: Blob }[]> {
    const d = this.doc!;
    const color: ColorOut = o.color ?? (d.mode === 'cmyk' ? 'cmyk' : d.mode === 'gray' ? 'gray' : 'rgb');
    const opaque = type === 'image/jpeg' || ((type === 'application/pdf' || type === 'image/tiff') && color === 'cmyk');
    const bg: RGBA | undefined = opaque ? [255, 255, 255, 255] : undefined;
    const ext = EXT[type];
    const base = d.name.replace(/\.[^.]+$/, '');
    const jobs: { name: string; rect: Rect; layers: PixelLayer[] }[] = [];
    const abs = this.artboards();
    if (which === 'artboards' && abs.length) {
      for (const G of abs) jobs.push({ name: G.name, rect: { x: G.artboard!.x, y: G.artboard!.y, w: G.artboard!.w, h: G.artboard!.h }, layers: [...d.descendants(G.id), G] });
    } else jobs.push({ name: base, rect: this.docRect(), layers: d.layers });
    const out: { name: string; blob: Blob }[] = [];
    for (const j of jobs) {
      // Las capas del documento en orden (el árbol de composición necesita el orden original).
      const layers = j.layers === d.layers ? d.layers : d.layers.filter((l) => j.layers.includes(l));
      const fname = (s: number) => `${j.name.replace(/[\\/:*?"<>|]/g, '_')}${scales.length > 1 || s !== 1 ? (s === 1 ? '' : `@${s}x`) : ''}.${ext}`;
      if (type === 'image/svg+xml') {
        const { svg } = await buildSvg(d, layers, j.rect, {
          flatten: (ls, r) => this.modePixels(this.r.flatten(d, ls, r)),
          png: async (px, w, h) => blobToDataUrl(await encodeRaster(px, w, h, 'image/png', 1)),
        });
        for (const s of scales) {
          const sized = s === 1 ? svg : svg.replace(/<svg ([^>]*?)width="(\d+)" height="(\d+)"/, (_m, a, w, h) => `<svg ${a}width="${Math.round(+w * s)}" height="${Math.round(+h * s)}"`);
          out.push({ name: fname(s), blob: new Blob([sized], { type: 'image/svg+xml' }) });
        }
        continue;
      }
      const px = this.r.flatten(d, layers, j.rect, bg);
      for (const s of scales) {
        const w = Math.max(1, Math.round(j.rect.w * s)), h = Math.max(1, Math.round(j.rect.h * s));
        let data = px;
        if (s !== 1) data = await this.scalePixels(px, j.rect.w, j.rect.h, w, h);
        let blob: Blob;
        const dpi = d.dpi * s;
        if (type === 'image/tiff') blob = await encodeTiff(color === 'rgb' ? this.modePixels(data.slice()) : data, w, h, { mode: color, alpha: o.alpha !== false, dpi });
        else if (type === 'application/pdf') {
          const flat = color === 'rgb' ? this.modePixels(data.slice()) : data;
          blob = await encodePdf(flat, w, h, { mode: color, dpi, title: j.name, jpeg: color === 'rgb' && quality < 1 && !hasTransparency(flat) ? await encodeRaster(flat, w, h, 'image/jpeg', quality) : null });
        } else {
          const view = this.modePixels(s === 1 ? data.slice() : data);
          if (type === 'image/gif') blob = encodeGif([{ px: view, delay: 0 }], w, h, { colors: o.colors, dither: o.dither });
          else blob = await encodeRaster(view, w, h, type, quality);
        }
        out.push({ name: fname(s), blob });
      }
    }
    return out;
  }

  private async scalePixels(px: Uint8ClampedArray, w0: number, h0: number, w: number, h: number) {
    const bmp = await createImageBitmap(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, w0, h0), { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(w, h).getContext('2d')!;
    c.drawImage(bmp, 0, 0);
    bmp.close();
    return c.getImageData(0, 0, w, h).data;
  }

  // ================================================================ objetos inteligentes

  /** Vuelve a pintar un objeto inteligente (contenido → transformación → filtros inteligentes). */
  private async renderSmart(L: PixelLayer, label: string): Promise<TilePatch> {
    const d = this.doc!;
    const sm = L.smart!;
    const limit = rasterLimit(d.width, d.height);
    const dst = intersect(transformRect(sm.matrix, { x: 0, y: 0, w: sm.w, h: sm.h }), limit);
    let nl = new PixelLayer('smart');
    if (dst) {
      const inv = invertM(sm.matrix), m = sm.matrix;
      const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
      const ss = scale < 0.7 ? Math.min(4, Math.ceil(1 / scale)) : 1;
      const ident = Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && !m[1] && !m[2] && Number.isInteger(m[4]) && Number.isInteger(m[5]);
      if (ident) nl.writeRegion(sm.data.slice(), sm.w, sm.h, m[4], m[5]);
      else {
        const data = shareable(sm.data);
        const bands = Math.max(1, Math.min(dst.h, this.pool.size * 3)), rows = Math.ceil(dst.h / bands);
        const jobs: Promise<void>[] = [];
        for (let y0 = 0; y0 < dst.h; y0 += rows) {
          const r = Math.min(rows, dst.h - y0);
          jobs.push(this.pool.run({ op: 'affine', src: data, sw: sm.w, sh: sm.h, sx: 0, sy: 0, inv, x: dst.x, y: dst.y + y0, w: dst.w, rows: r, ss })
            .then((band) => nl.writeRegion(band, dst.w, r, dst.x, dst.y + y0)));
        }
        await Promise.all(jobs);
      }
      // Deformaciones (perspectiva, deformar, posición libre) guardadas en el objeto inteligente.
      for (const w of sm.warps ?? []) {
        const b = nl.bounds();
        if (!b) break;
        const next = new PixelLayer('smart');
        await this.warpPixels(nl.readRegion(b.x, b.y, b.w, b.h), b, w, next);
        nl = next;
      }
      // Filtros inteligentes en orden (de abajo arriba, como en el panel de Photoshop).
      for (const f of sm.filters) {
        if (!f.enabled) continue;
        const name = f.name as FilterName, params = f.params as FilterParams;
        const b = name === 'clouds' ? this.docRect() : nl.bounds();
        if (!b) break;
        const apron = filterApron(name, params);
        const region = intersect(name === 'clouds' ? b : { x: b.x - apron, y: b.y - apron, w: b.w + apron * 2, h: b.h + apron * 2 }, limit);
        if (!region) continue;
        let out = await this.filterRegion(nl, region, name, params, apron, false);
        const op = f.opacity ?? 1;
        if (op < 1) {
          const orig = nl.readRegion(region.x, region.y, region.w, region.h);
          for (let i = 0; i < out.length; i++) out[i] = orig[i] + (out[i] - orig[i]) * op;
        }
        const next = new PixelLayer('smart');
        for (const [k, t] of nl.tiles) next.tiles.set(k, t);
        next.writeRegion(out, region.w, region.h, region.x, region.y);
        nl = next;
        out = new Uint8ClampedArray(0);
      }
    }
    const patch = new TilePatch(label, L);
    const oldX = L.x, oldY = L.y;
    if (oldX || oldY) {
      // Las capas de objeto inteligente viven en (0,0); se pasan las teselas a coordenadas de documento.
      const tmp = new PixelLayer('t');
      const b = L.bounds();
      if (b) tmp.writeRegion(L.readRegion(b.x - L.x, b.y - L.y, b.w, b.h), b.w, b.h, b.x, b.y);
      for (const k of new Set([...L.tiles.keys(), ...tmp.tiles.keys()])) patch.capture(L, k);
      for (const k of [...L.tiles.keys()]) L.setTile(k, null);
      L.x = 0; L.y = 0;
    }
    for (const k of new Set([...L.tiles.keys(), ...nl.tiles.keys()])) patch.capture(L, k);
    for (const k of [...L.tiles.keys()]) L.setTile(k, null);
    for (const [k, t] of nl.tiles) L.setTile(k, t);
    L.version++;
    this.invalidate(null);
    this.scheduleEffects();
    return patch;
  }

  /** Cambia los datos del objeto inteligente, lo repinta y devuelve el paso de historial. */
  private async smartUpdate(L: PixelLayer, next: SmartObject, label: string, keepVMask = false): Promise<HistoryEntry> {
    const before = L.smart, bx = L.x, by = L.y;
    L.smart = next;
    const patch = await this.renderSmart(L, label);
    // La capa vuelve a (0,0): la máscara vectorial (en coordenadas de capa) se desplaza para no moverse.
    const vmB = L.vmask;
    const vmA = vmB && !keepVMask && (bx || by) ? shiftVM(vmB, bx, by) : vmB;
    L.vmask = vmA;
    const props = new FnEntry('', (doc) => { const l = doc.layer(L.id); if (l) { l.smart = before; l.x = bx; l.y = by; l.vmask = vmB; l.version++; } },
      (doc) => { const l = doc.layer(L.id); if (l) { l.smart = next; l.x = 0; l.y = 0; l.vmask = vmA; l.version++; } });
    return new GroupEntry(label, [patch, props]);
  }

  private async newSmartLayer(name: string, w: number, h: number, data: Uint8ClampedArray, contents: EditorDocument | null, matrix: Matrix, source?: string) {
    const L = new PixelLayer(name);
    L.kind = 'smart';
    L.smart = { w, h, data, contents, matrix, filters: [], source };
    await this.renderSmart(L, 'Objeto inteligente');
    return L;
  }

  /** Capa > Objetos inteligentes > Convertir en objeto inteligente (las capas seleccionadas). */
  async convertToSmart() {
    const d = this.doc;
    if (!d) return;
    const set = this.topSelected().filter((l) => l.kind !== 'adjustment' || this.topSelected().length > 1);
    if (!set.length) { this.toast('Selecciona las capas que quieres convertir.', 'warn'); return; }
    if (set.length === 1 && set[0].kind === 'smart') { this.toast('Ya es un objeto inteligente.'); return; }
    await this.smartFromSet(set);
  }

  /** Una capa de texto o forma pasa a objeto inteligente (para perspectiva, deformar…). */
  private smartFromLayer(L: PixelLayer) { return this.smartFromSet([L]); }

  private async smartFromSet(set: PixelLayer[]): Promise<PixelLayer | null> {
    const d = this.doc!;
    const all: PixelLayer[] = [];
    for (const l of set) { if (l.kind === 'group') all.push(...d.descendants(l.id)); all.push(l); }
    all.sort((a, b) => d.indexOf(a.id) - d.indexOf(b.id));
    let bb: Rect | null = null;
    for (const l of all) {
      if (l.kind === 'group' || l.kind === 'adjustment') continue;
      bb = union(bb, exactBounds(l));
      for (const f of l.fxLayers()) bb = union(bb, exactBounds(f));
    }
    bb = bb ? intersect(bb, rasterLimit(d.width, d.height)) : null;
    if (!bb) { this.toast('Las capas están vacías.', 'warn'); return null; }
    // Contenido: un documento propio con copias de las capas, con el origen en la esquina de la caja.
    const child = new EditorDocument(`${set[set.length - 1].name}.psb`, bb.w, bb.h);
    const { copies } = cloneLayers(all);
    for (const c of copies) {
      this.shiftLayer(c, -bb.x, -bb.y);
      if (hasEffects(c.effects)) { const fx = buildEffects(c); c.fxUnder = fx.under; c.fxStyled = fx.styled; }
    }
    child.layers = copies;
    child.activeLayerId = copies[copies.length - 1].id;
    const data = this.r.flatten(d, copies, { x: 0, y: 0, w: bb.w, h: bb.h });
    const top = set[set.length - 1];
    const L = await this.newSmartLayer(top.name, bb.w, bb.h, data, child, [1, 0, 0, 1, bb.x, bb.y]);
    L.parent = top.parent;
    const before = this.structSnap();
    const idx = d.indexOf(top.id);
    const gone = new Set(all.map((l) => l.id));
    d.layers.splice(idx + 1, 0, L);
    d.layers = d.layers.filter((l) => !gone.has(l.id));
    d.activeLayerId = L.id;
    d.selectedIds = new Set([L.id]);
    this.commitStruct('Convertir en objeto inteligente', before);
    this.invalidate(null);
    return L;
  }

  /** Coloca una imagen como objeto inteligente (Archivo > Colocar incrustado, como Photoshop). */
  async placeSmart(name: string, buffer: ArrayBuffer, mime: string, at?: { x: number; y: number } | null) {
    const d = this.doc;
    if (!d) return this.open(name, buffer, mime);
    const res = await importRaster(name, buffer, mime);
    const w = res.doc.width, h = res.doc.height;
    const data = res.doc.layers.length === 1 && res.doc.layers[0].kind === 'pixel' && !res.doc.layers[0].x && !res.doc.layers[0].y
      ? res.doc.layers[0].readRegion(0, 0, w, h) : this.r.flatten(d, res.doc.layers, { x: 0, y: 0, w, h });
    // Como Photoshop: si la imagen es mayor que el documento, se encaja dentro.
    const k = Math.min(1, d.width / w, d.height / h);
    const x = at ? at.x : (d.width - w * k) / 2, y = at ? at.y : (d.height - h * k) / 2;
    const m: Matrix = [k, 0, 0, k, k === 1 ? Math.round(x) : x, k === 1 ? Math.round(y) : y];
    const L = await this.newSmartLayer(name.replace(/\.[^.]+$/, '') || 'Imagen', w, h, data, res.doc.layers.length > 1 ? res.doc : null, m, name);
    this.insertLayer(L, this.above(L), 'Colocar incrustado');
    return { layers: d.layers.length };
  }

  /** Objetos inteligentes > Reemplazar contenido (mockups): la nueva imagen ocupa el mismo sitio. */
  async replaceSmartContents(name: string, buffer: ArrayBuffer, mime: string) {
    const d = this.doc, L = d?.active();
    if (!d || !L || L.kind !== 'smart' || !L.smart) { this.toast('Selecciona un objeto inteligente.', 'warn'); return; }
    const res = await importRaster(name, buffer, mime);
    const w = res.doc.width, h = res.doc.height;
    const data = this.r.flatten(d, res.doc.layers, { x: 0, y: 0, w, h });
    const sm = L.smart;
    // Se conserva el marco: la nueva imagen se encaja (sin deformar ni salirse) en el rectángulo del contenido anterior.
    const k = Math.min(sm.w / w, sm.h / h);
    const fit: Matrix = [k, 0, 0, k, (sm.w - w * k) / 2, (sm.h - h * k) / 2];
    const next = { ...sm, w, h, data, contents: res.doc.layers.length > 1 ? res.doc : null, matrix: mul(sm.matrix, fit), source: name };
    this.commit(await this.smartUpdate(L, next, 'Reemplazar contenido'));
  }

  /** Objetos inteligentes > Editar contenido: se abre en una pestaña; al guardar se actualiza la capa. */
  editSmartContents(id?: number) {
    const d = this.doc, L = id ? d?.layer(id) : d?.active();
    if (!d || !L || L.kind !== 'smart' || !L.smart) return;
    const sm = L.smart;
    let child: EditorDocument;
    if (sm.contents) {
      child = new EditorDocument(sm.contents.name, sm.contents.width, sm.contents.height);
      child.layers = cloneLayers(sm.contents.layers).copies;
      child.activeLayerId = child.layers[child.layers.length - 1]?.id ?? 0;
    } else {
      child = new EditorDocument(`${L.name}.psb`, sm.w, sm.h);
      const pl = new PixelLayer(L.name);
      pl.writeRegion(sm.data.slice(), sm.w, sm.h, 0, 0);
      child.layers = [pl];
      child.activeLayerId = pl.id;
    }
    const parent = this.slotId;
    this.setDoc(child, 'Abrir contenido');
    const slot = this.slots.find((x) => x.id === this.slotId)!;
    slot.smartLink = { slotId: parent, layerId: L.id, name: L.name };
    this.pushState(false);
    this.toast('Edita el contenido y pulsa Ctrl+S para actualizar el objeto inteligente.');
  }

  /** Guardar en una pestaña de contenido: actualiza el objeto inteligente del documento de origen. */
  async saveSmartContents(): Promise<boolean> {
    const slot = this.slots.find((x) => x.id === this.slotId);
    const d = this.doc;
    if (!slot?.smartLink || !d) return false;
    const link = slot.smartLink;
    const parent = this.slots.find((x) => x.id === link.slotId);
    const PL = parent?.doc.layer(link.layerId);
    if (!parent || !PL || PL.kind !== 'smart' || !PL.smart) { this.toast('El objeto inteligente de origen ya no existe.', 'warn'); return false; }
    const data = this.r.flatten(d, d.layers, { x: 0, y: 0, w: d.width, h: d.height });
    const contents = new EditorDocument(d.name, d.width, d.height);
    contents.layers = cloneLayers(d.layers).copies;
    const sm = PL.smart;
    // Si cambió el tamaño del lienzo del contenido, se mantiene la escala respecto al original.
    const next = { ...sm, w: d.width, h: d.height, data, contents };
    // El repintado necesita el documento de origen activo: se cambia un instante.
    const here = this.slotId;
    this.switchDoc(parent.id);
    const e = await this.smartUpdate(PL, next, 'Actualizar objeto inteligente');
    this.commit(e);
    this.switchDoc(here);
    d.dirty = false;
    this.pushState(false);
    this.toast(`"${link.name}" actualizado`);
    return true;
  }

  /** Filtros inteligentes: activar/ocultar, cambiar parámetros u opacidad, quitar u ordenar. */
  async setSmartFilter(id: number, index: number, patch: Partial<SmartFilter> | null, record = true) {
    const L = this.doc?.layer(id);
    if (!L?.smart) return;
    this.restorePreview();
    const filters = L.smart.filters.map((f) => ({ ...f }));
    if (patch === null) filters.splice(index, 1);
    else filters[index] = { ...filters[index], ...patch, params: { ...filters[index].params, ...(patch.params ?? {}) } };
    const e = await this.smartUpdate(L, { ...L.smart, filters }, patch === null ? 'Eliminar filtro inteligente' : 'Editar filtro inteligente');
    if (record) this.commit(e); else this.preview = e;
  }

  // ================================================================ texto y formas

  private rasterizeInto(L: PixelLayer, docW: number, docH: number) {
    const limit = rasterLimit(docW, docH);
    const r = L.kind === 'text' && L.text ? rasterizeText(L.text, limit) : L.shape ? rasterizeShape(L.shape, limit) : null;
    L.clearTiles();
    L.x = 0; L.y = 0;
    if (r) L.writeRegion(r.data, r.w, r.h, r.x, r.y);
  }

  private rerasterize(L: PixelLayer, silent = false) {
    const d = this.doc;
    if (!d || (L.kind !== 'text' && L.kind !== 'shape')) return;
    // Google Fonts: se pinta con la de reserva y se repinta cuando llega la fuente.
    if (L.text && !fontReady(L.text.font) && !this.fontWait.has(L.text.font)) {
      const fam = L.text.font;
      this.fontWait.add(fam);
      loadGoogleFont(fam).then((ok) => {
        this.fontWait.delete(fam);
        const dd = this.doc;
        if (!ok) { this.toast(`No se pudo descargar la fuente "${fam}" (¿sin conexión?).`, 'warn'); return; }
        if (!dd) return;
        // La fuente nueva se aplica al lienzo en la tarea siguiente: se repinta entonces.
        setTimeout(() => {
          const d2 = this.doc;
          if (!d2) return;
          resetTextCache();
          for (const l of d2.layers) if (l.text?.font === fam) this.rerasterize(l);
          this.scheduleEffects();
          this.pushState(false);
        }, 30);
      });
    }
    const before = L.bounds();
    this.rasterizeInto(L, d.width, d.height);
    if (!silent) this.invalidate(union(before, L.bounds()));
  }

  createText(params: Partial<TextParams> & { text: string; x: number; y: number }) {
    const d = this.doc;
    if (!d) return;
    const t: TextParams = { font: 'Arial', size: 48, color: this.fg, bold: false, italic: false, align: 'left', lineHeight: 1.2, matrix: [...IDENTITY] as Matrix, ...params };
    const L = new PixelLayer(t.text.split('\n')[0].slice(0, 30) || 'Texto');
    L.kind = 'text';
    L.text = t;
    this.rerasterize(L, true);
    this.insertLayer(L, this.above(L), 'Capa de texto');
    return L.id;
  }

  updateText(id: number, params: Partial<TextParams>, record = true) {
    const L = this.doc?.layer(id);
    if (!L || L.kind !== 'text' || !L.text) return;
    const before = (this.pendingProps.get(id) as TextParams | undefined) ?? L.text;
    const label = (t: TextParams) => t.text.split('\n')[0].slice(0, 30) || 'Texto';
    // El nombre sigue al texto mientras el usuario no lo haya renombrado (como Photoshop).
    const autoName = L.name === label(L.text);
    L.text = { ...L.text, ...params };
    if (params.text !== undefined && autoName) L.name = label(L.text);
    this.rerasterize(L);
    if (!record) { this.pendingProps.set(id, before); this.pushState(false); return; }
    this.pendingProps.delete(id);
    const after = L.text;
    const set = (v: TextParams, from: TextParams) => (doc: EditorDocument) => {
      const l = doc.layer(id);
      if (!l) return;
      if (l.name === label(from)) l.name = label(v);
      l.text = v;
    };
    this.commit(new FnEntry('Editar texto', set(before, after), set(after, before)));
  }

  /** Capa de texto bajo un punto (herramienta Texto: clic para editar). */
  hitText(x: number, y: number): number | null {
    const d = this.doc;
    if (!d) return null;
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const L = d.layers[i];
      if (L.kind !== 'text' || !L.text || !L.visible) continue;
      const inv = invertM(L.text.matrix);
      const lx = inv[0] * x + inv[2] * y + inv[4], ly = inv[1] * x + inv[3] * y + inv[5];
      const b = textBox(L.text);
      if (lx >= b.x && ly >= b.y && lx <= b.x + b.w && ly <= b.y + b.h) return L.id;
    }
    return null;
  }

  createShape(params: Partial<ShapeParams> & { shape: ShapeParams['shape']; x: number; y: number; w: number; h: number }) {
    const d = this.doc;
    if (!d) return;
    const s: ShapeParams = { fill: this.fg, stroke: null, strokeWidth: 3, radius: 0, sides: 6, matrix: [...IDENTITY] as Matrix, ...params };
    const names = { rect: 'Rectángulo', ellipse: 'Elipse', line: 'Línea', polygon: 'Polígono', path: 'Forma' };
    const L = new PixelLayer(`${names[s.shape]} ${this.layerCounter++}`);
    L.kind = 'shape';
    L.shape = s;
    this.rerasterize(L, true);
    this.insertLayer(L, this.above(L), `Crear ${names[s.shape].toLowerCase()}`);
    return L.id;
  }

  updateShape(id: number, params: Partial<ShapeParams>, record = true) {
    const L = this.doc?.layer(id);
    if (!L || L.kind !== 'shape' || !L.shape) return;
    const before = (this.pendingProps.get(id) as ShapeParams | undefined) ?? L.shape;
    L.shape = { ...L.shape, ...params };
    this.rerasterize(L);
    if (!record) { this.pendingProps.set(id, before); this.pushState(false); return; }
    this.pendingProps.delete(id);
    const after = L.shape;
    const set = (v: ShapeParams) => (doc: EditorDocument) => { const l = doc.layer(id); if (l) l.shape = v; };
    this.commit(new FnEntry('Editar forma', set(before), set(after)));
  }

  // ================================================================ estilos de capa

  setEffects(id: number, effects: LayerEffects | undefined, record = true) {
    const L = this.doc?.layer(id);
    if (!L || L.kind === 'adjustment' || L.kind === 'group') return;
    const key = id + 1e9;
    const before = this.pendingProps.has(key) ? (this.pendingProps.get(key) as LayerEffects | undefined) : L.effects;
    L.effects = effects;
    this.scheduleEffects();
    this.invalidate(union(L.bounds(), fxBounds(L)));
    if (!record) { this.pendingProps.set(key, before); this.pushState(false); return; }
    this.pendingProps.delete(key);
    if (JSON.stringify(before ?? null) === JSON.stringify(effects ?? null)) { this.pushState(false); return; }
    const set = (v: LayerEffects | undefined) => (doc: EditorDocument) => { const l = doc.layer(id); if (l) l.effects = v; };
    this.commit(new FnEntry('Estilo de capa', set(before), set(effects)));
  }

  // ================================================================ transformación libre

  /** Ctrl+T: prepara la vista previa y devuelve los límites del contenido. */
  async beginTransform(): Promise<{ bounds: Rect } | null> {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || L.kind === 'adjustment') return null;
    // Un grupo se transforma entero (todas sus capas con contenido).
    const set = this.moveSet(L).filter((l) => l.kind !== 'group');
    let src: Rect | null = null;
    for (const l of set) src = union(src, exactBounds(l));
    if (!src) { if (L.kind === 'group') this.toast('El grupo no tiene contenido que transformar.', 'warn'); return null; }
    const px = L.kind === 'group' || set.length > 1
      ? this.r.flatten(d, d.layers.filter((l) => set.includes(l) || (l.kind === 'group' && set.some((x) => d.isInside(x, l)))), src)
      : L.readRegion(src.x - L.x, src.y - L.y, src.w, src.h);
    const s = Math.min(1, 2048 / Math.max(src.w, src.h));
    const bmp = await createImageBitmap(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, src.w, src.h), {
      resizeWidth: Math.max(1, Math.round(src.w * s)), resizeHeight: Math.max(1, Math.round(src.h * s)), resizeQuality: 'medium',
    });
    const ids = [L.id];
    for (const l of set) { ids.push(l.id); for (const f of l.fxLayers()) ids.push(f.id); }
    this.r.setPreview(ids, bmp, src, [...IDENTITY] as Matrix);
    bmp.close();
    this.transform = { layers: set, src, matrix: [...IDENTITY] as Matrix };
    this.requestFrame();
    return { bounds: src };
  }

  updateTransform(m: Matrix) {
    if (!this.transform) return;
    this.transform.matrix = m;
    this.transform.spec = null;
    this.r.setPreviewMatrix(m);
    this.requestFrame();
  }

  /** Perspectiva, distorsionar, deformar y posición libre: vista previa con malla. */
  updateTransformSpec(spec: WarpSpec) {
    const t = this.transform;
    if (!t) return;
    if (spec.kind === 'affine') { this.updateTransform(spec.m); return; }
    t.spec = spec;
    this.r.setPreviewMesh(specToMesh(spec, 24));
    this.requestFrame();
  }

  cancelTransform() {
    this.transform = null;
    this.r.clearPreview();
    this.requestFrame();
  }

  async commitTransform(label = 'Transformación libre') {
    const t = this.transform;
    const d = this.doc;
    if (!t || !d) return;
    const m = t.matrix, spec = t.spec;
    if (!spec && m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9)) { this.cancelTransform(); return; }
    this.post({ type: 'busy', label: 'Transformando…' });
    const t0 = performance.now();
    try {
      const entries: HistoryEntry[] = [];
      let layers = t.layers;
      if (spec && layers.some((l) => l.kind === 'text' || l.kind === 'shape')) {
        // Como Photoshop: el texto y las formas sólo admiten deformaciones no afines como objeto inteligente.
        const next: PixelLayer[] = [];
        for (const l of layers) next.push(l.kind === 'text' || l.kind === 'shape' ? (await this.smartFromLayer(l)) ?? l : l);
        layers = next;
      }
      for (const L of layers) {
        const e = spec ? await this.warpOne(L, spec, label) : await this.transformOne(L, m, label);
        if (e) entries.push(e);
      }
      if (entries.length) this.commit(entries.length === 1 ? entries[0] : new GroupEntry(label, entries));
      this.post({ type: 'perf', label, ms: performance.now() - t0 });
    } finally {
      this.post({ type: 'busy', label: null });
      this.cancelTransform();
      this.invalidate(null);
    }
  }

  /** Lleva la máscara vectorial con la capa al transformarla (`f` en coordenadas de documento). */
  private transformVMask(L: PixelLayer, f: (x: number, y: number) => [number, number], oldX: number, oldY: number): HistoryEntry | null {
    const before = L.vmask;
    if (!before) return null;
    const nx = L.x, ny = L.y;
    const mp = (x: number, y: number) => { const [a, b] = f(x + oldX, y + oldY); return [a - nx, b - ny] as [number, number]; };
    const path = before.path.map((sp) => ({ closed: sp.closed, points: sp.points.map((q) => {
      const [x, y] = mp(q.x, q.y), [ix, iy] = mp(q.ix, q.iy), [ox, oy] = mp(q.ox, q.oy);
      return { x, y, ix, iy, ox, oy };
    }) }));
    const vm = { ...before, path, rev: nextRev() };
    L.vmask = vm;
    return new FnEntry('', (doc) => { const l = doc.layer(L.id); if (l) l.vmask = before; }, (doc) => { const l = doc.layer(L.id); if (l) l.vmask = vm; });
  }

  /** Rasteriza `src` (región del documento) con una deformación, repartido en bandas por los hilos. */
  private async warpPixels(data: Uint8ClampedArray, src: Rect, spec: WarpSpec, into: PixelLayer) {
    const d = this.doc!;
    const dst = intersect(specBounds(spec, src), rasterLimit(d.width, d.height));
    if (!dst) return;
    const sc = specMinScale(spec, src);
    const ss = sc < 0.7 ? Math.min(4, Math.ceil(2 / sc)) : 2;
    const shared = shareable(data);
    const bands = Math.max(1, Math.min(dst.h, this.pool.size * 3)), rows = Math.ceil(dst.h / bands);
    const jobs: Promise<void>[] = [];
    for (let y0 = 0; y0 < dst.h; y0 += rows) {
      const r = Math.min(rows, dst.h - y0);
      jobs.push(this.pool.run({ op: 'mapwarp', src: shared, sw: src.w, sh: src.h, sx: src.x, sy: src.y, spec, x: dst.x, y: dst.y + y0, w: dst.w, rows: r, ss })
        .then((band) => into.writeRegion(band, dst.w, r, dst.x, dst.y + y0)));
    }
    await Promise.all(jobs);
  }

  /** Perspectiva / distorsionar / deformar / posición libre sobre una capa (paso de historial sin registrar). */
  private async warpOne(L: PixelLayer, spec: WarpSpec, label: string): Promise<HistoryEntry | null> {
    const d = this.doc!;
    if (L.kind === 'smart' && L.smart) {
      // Sin pérdida: la deformación se guarda en el objeto inteligente.
      const sx0 = L.x, sy0 = L.y;
      const e0 = await this.smartUpdate(L, { ...L.smart, warps: [...(L.smart.warps ?? []), spec] }, label, true);
      const vmE = this.transformVMask(L, specForward(spec), sx0, sy0);
      const e = vmE ? new GroupEntry(label, [e0, vmE]) : e0;
      if (!L.mask) return e;
      const oldMask = L.mask, newMask = warpMask(oldMask, { x: 0, y: 0 }, spec, d.width, d.height);
      L.mask = newMask;
      return new GroupEntry(label, [e, new FnEntry('', (doc) => { const l = doc.layer(L.id); if (l) l.mask = oldMask; }, (doc) => { const l = doc.layer(L.id); if (l) l.mask = newMask; })]);
    }
    const src = exactBounds(L);
    if (!src) return null;
    const nl = new PixelLayer(L.name);
    await this.warpPixels(L.readRegion(src.x - L.x, src.y - L.y, src.w, src.h), src, spec, nl);
    const oldX = L.x, oldY = L.y, oldMask = L.mask;
    const patch = new TilePatch(label, L);
    for (const k of new Set([...L.tiles.keys(), ...nl.tiles.keys()])) patch.capture(L, k);
    for (const k of [...L.tiles.keys()]) L.setTile(k, null);
    for (const [k, tile] of nl.tiles) L.setTile(k, tile);
    L.x = 0; L.y = 0;
    const newMask = oldMask ? warpMask(oldMask, { x: oldX, y: oldY }, spec, d.width, d.height) : null;
    L.mask = newMask;
    const pos = new FnEntry('',
      (doc) => { const l = doc.layer(L.id); if (l) { l.x = oldX; l.y = oldY; l.mask = oldMask; } },
      (doc) => { const l = doc.layer(L.id); if (l) { l.x = 0; l.y = 0; l.mask = newMask; } });
    const vmE = this.transformVMask(L, specForward(spec), oldX, oldY);
    return new GroupEntry(label, vmE ? [patch, pos, vmE] : [patch, pos]);
  }

  /** Aplica la matriz a una capa y devuelve su paso de historial (sin registrarlo). */
  private async transformOne(L: PixelLayer, m: Matrix, label: string): Promise<HistoryEntry | null> {
    const ox = L.x, oy = L.y;
    const e = await this.transformOneInner(L, m, label);
    const vmE = this.transformVMask(L, (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]], ox, oy);
    if (!vmE) return e;
    return e ? new GroupEntry(label, [e, vmE]) : vmE;
  }

  private async transformOneInner(L: PixelLayer, m: Matrix, label: string): Promise<HistoryEntry | null> {
    const d = this.doc!;
    if (L.kind === 'smart' && L.smart) {
      // Sin pérdida: se transforma desde el contenido original.
      // Con deformaciones previas, la nueva transformación va después de ellas.
      const next = L.smart.warps?.length ? { ...L.smart, warps: [...L.smart.warps, { kind: 'affine' as const, m }] } : { ...L.smart, matrix: mul(m, L.smart.matrix) };
      const e = await this.smartUpdate(L, next, label, true);
      if (L.mask) {
        const oldMask = L.mask;
        const newMask = transformMask(L, m, d.width, d.height, { x: 0, y: 0 }, L, oldMask);
        L.mask = newMask;
        return new GroupEntry(label, [e, new FnEntry('', (doc) => { const l = doc.layer(L.id); if (l) l.mask = oldMask; }, (doc) => { const l = doc.layer(L.id); if (l) l.mask = newMask; })]);
      }
      return e;
    }
    if (L.kind === 'text' || L.kind === 'shape') {
      const before = { text: L.text, shape: L.shape };
      if (L.text) L.text = { ...L.text, matrix: mul(m, L.text.matrix) };
      if (L.shape) L.shape = { ...L.shape, matrix: mul(m, L.shape.matrix) };
      this.rerasterize(L, true);
      const after = { text: L.text, shape: L.shape };
      return new FnEntry(label, (doc) => { const l = doc.layer(L.id); if (l) Object.assign(l, before); }, (doc) => { const l = doc.layer(L.id); if (l) Object.assign(l, after); });
    }
    const src = exactBounds(L);
    if (!src) return null;
    const data = shareable(L.readRegion(src.x - L.x, src.y - L.y, src.w, src.h));
    const dst = intersect(transformRect(m, src), rasterLimit(d.width, d.height));
    const inv = invertM(m);
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const ss = scale < 0.7 ? Math.min(4, Math.ceil(1 / scale)) : 1;
    const nl = new PixelLayer(L.name);
    if (dst) {
      const bands = Math.max(1, Math.min(dst.h, this.pool.size * 3));
      const rows = Math.ceil(dst.h / bands);
      const jobs: Promise<void>[] = [];
      for (let y0 = 0; y0 < dst.h; y0 += rows) {
        const r = Math.min(rows, dst.h - y0);
        jobs.push(this.pool.run({ op: 'affine', src: data, sw: src.w, sh: src.h, sx: src.x, sy: src.y, inv, x: dst.x, y: dst.y + y0, w: dst.w, rows: r, ss })
          .then((band) => nl.writeRegion(band, dst.w, r, dst.x, dst.y + y0)));
      }
      await Promise.all(jobs);
    }
    const oldX = L.x, oldY = L.y;
    const oldMask = L.mask;
    // Los tiles nuevos están en coordenadas de documento (capa en 0,0).
    const patch = new TilePatch(label, L);
    for (const k of new Set([...L.tiles.keys(), ...nl.tiles.keys()])) patch.capture(L, k);
    for (const k of [...L.tiles.keys()]) L.setTile(k, null);
    for (const [k, tile] of nl.tiles) L.setTile(k, tile);
    L.x = 0; L.y = 0;
    const newMask = oldMask ? transformMask(L, m, d.width, d.height, { x: oldX, y: oldY }, L, oldMask) : null;
    L.mask = newMask;
    const pos = new FnEntry('',
      (doc) => { const l = doc.layer(L.id); if (l) { l.x = oldX; l.y = oldY; l.mask = oldMask; } },
      (doc) => { const l = doc.layer(L.id); if (l) { l.x = 0; l.y = 0; l.mask = newMask; } });
    return new GroupEntry(label, [patch, pos]);
  }

  /** Edición > Transformar > Voltear / Rotar (capa activa). */
  async transformLayer(kind: 'flipH' | 'flipV' | 'rot90' | 'rot-90' | 'rot180') {
    const info = await this.beginTransform();
    if (!info) return;
    const b = info.bounds, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const about = (a: number, bb: number, c: number, dd: number): Matrix => [a, bb, c, dd, cx - a * cx - c * cy, cy - bb * cx - dd * cy];
    const m = kind === 'flipH' ? about(-1, 0, 0, 1) : kind === 'flipV' ? about(1, 0, 0, -1)
      : kind === 'rot90' ? about(0, 1, -1, 0) : kind === 'rot-90' ? about(0, -1, 1, 0) : about(-1, 0, 0, -1);
    this.updateTransform(m);
    const labels = { flipH: 'Voltear horizontal', flipV: 'Voltear vertical', rot90: 'Rotar 90° AC', 'rot-90': 'Rotar 90° ACD', rot180: 'Rotar 180°' };
    await this.commitTransform(labels[kind]);
  }

  // ================================================================ licuar

  /** Vista reducida de la capa activa para el diálogo Licuar. */
  liquifySource(maxSide = 1400) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || L.kind === 'adjustment') return null;
    const r = this.docRect();
    const s = Math.min(1, maxSide / Math.max(r.w, r.h));
    const w = Math.max(1, Math.round(r.w * s)), h = Math.max(1, Math.round(r.h * s));
    const full = L.readRegion(-L.x, -L.y, r.w, r.h);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.min(r.w - 1, Math.floor((x + 0.5) / s)), sy = Math.min(r.h - 1, Math.floor((y + 0.5) / s));
      out.set(full.subarray((sy * r.w + sx) * 4, (sy * r.w + sx) * 4 + 4), (y * w + x) * 4);
    }
    return { data: out, w, h, scale: s };
  }

  /** Aplica el campo de desplazamiento del diálogo Licuar (en px de la vista) a resolución completa. */
  async applyLiquify(field: Float32Array, fw: number, fh: number, previewScale: number) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || !this.ensurePixel(L)) return;
    const r = this.docRect();
    this.post({ type: 'busy', label: 'Licuar…' });
    try {
      // El campo está en píxeles de la vista previa: se pasa a píxeles reales.
      const f = new Float32Array(field.length);
      for (let i = 0; i < field.length; i++) f[i] = field[i] / previewScale;
      const src = shareable(L.readRegion(-L.x, -L.y, r.w, r.h));
      const out = new Uint8ClampedArray(r.w * r.h * 4);
      const bands = Math.max(1, Math.min(r.h, this.pool.size * 3));
      const rows = Math.ceil(r.h / bands);
      const jobs: Promise<void>[] = [];
      for (let y0 = 0; y0 < r.h; y0 += rows) {
        const n = Math.min(rows, r.h - y0);
        jobs.push(this.pool.run({ op: 'warp', src, sw: r.w, sh: r.h, field: f.slice(), fw, fh, scale: 1 / previewScale, y0, rows: n })
          .then((band) => out.set(band, y0 * r.w * 4)));
      }
      await Promise.all(jobs);
      const patch = new TilePatch('Licuar', L);
      applyRegion(L, patch, r, out, null);
      this.commit(patch);
      this.invalidate(null);
    } finally {
      this.post({ type: 'busy', label: null });
    }
  }

  // ================================================================ IA

  /** Quitar fondo: crea una máscara de capa con el sujeto (no destructivo, como Photoshop). */
  async removeBackground() {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || L.kind === 'adjustment') return;
    const b = intersect(L.bounds() ?? this.docRect(), this.docRect());
    if (!b) return;
    this.post({ type: 'busy', label: 'Quitando fondo con IA local…' });
    const t0 = performance.now();
    try {
      const { subjectMask } = await import('./ai');
      const px = L.readRegion(b.x - L.x, b.y - L.y, b.w, b.h);
      const m = await subjectMask(px, b.w, b.h, this.base);
      const oldMask = L.mask, oldEnabled = L.maskEnabled;
      const mask = new MaskChannel(0);
      forTiles({ x: b.x - L.x, y: b.y - L.y, w: b.w, h: b.h }, (tx, ty, x0, y0, x1, y1) => {
        const k = tileKey(tx, ty);
        const t = mask.ensureTile(k);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          t[y * TILE + x] = m[(ty * TILE + y + L.y - b.y) * b.w + (tx * TILE + x + L.x - b.x)];
        }
        mask.touch(k);
      });
      L.mask = mask;
      L.maskEnabled = true;
      d.editMask = true;
      this.commit(new FnEntry('Quitar fondo',
        (doc) => { const l = doc.layer(L.id); if (l) { l.mask = oldMask; l.maskEnabled = oldEnabled; } },
        (doc) => { const l = doc.layer(L.id); if (l) { l.mask = mask; l.maskEnabled = true; } }));
      this.invalidate(null);
      this.post({ type: 'perf', label: 'Quitar fondo (IA local)', ms: performance.now() - t0 });
    } finally {
      this.post({ type: 'busy', label: null });
    }
  }

  /** Píxeles para las selecciones inteligentes: la capa activa o todo el documento. */
  private selectionSource(sampleAll: boolean): Uint8ClampedArray {
    const d = this.doc!;
    const L = d.active();
    if (sampleAll || !L || L.kind === 'adjustment' || L.kind === 'group') return this.r.flatten(d, d.layers, this.docRect());
    return L.readRegion(-L.x, -L.y, d.width, d.height);
  }

  /**
   * Herramienta Selección rápida (W): con los puntos del trazo (documento) crece la selección por
   * las zonas parecidas y se para en los bordes. Sin selección crea una; con ella, añade (Alt: resta).
   */
  quickSelect(points: [number, number][], radius: number, mode: CombineMode = 'add', sampleAll = true, autoEnhance = true) {
    const d = this.doc;
    if (!d || !points.length) return;
    const t0 = performance.now();
    const px = this.selectionSource(sampleAll);
    const { img, W, H, s } = downscale(px, d.width, d.height, 640);
    const seeds = new Set<number>();
    const r = Math.max(1, radius * s);
    for (const [x, y] of points) {
      const cx = x * s, cy = y * s;
      for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++) for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H || (xx - cx) ** 2 + (yy - cy) ** 2 > r * r) continue;
        seeds.add(yy * W + xx);
      }
    }
    if (!seeds.size) return;
    const small = quickRegion(img, W, H, [...seeds]);
    let m = upscaleMask(small, W, H, d.width, d.height);
    if (autoEnhance) m = snapEdges(px, m, d.width, d.height, Math.max(2, 1.5 / s));
    const sel = Selection.fromMask(m, d.width, d.height);
    const cur = d.selection;
    const next = !cur ? (mode === 'subtract' ? null : sel) : cur.combine(sel, mode === 'replace' ? 'add' : mode);
    this.setSelection(next, 'Selección rápida');
    this.post({ type: 'perf', label: 'Selección rápida', ms: performance.now() - t0 });
  }

  /** Herramienta Selección de objeto: rectángulo alrededor del objeto → IA local en esa zona. */
  async objectSelect(rect: Rect, mode: CombineMode = 'replace', sampleAll = true) {
    const d = this.doc;
    if (!d) return;
    const r0 = intersect({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }, this.docRect());
    if (!r0 || r0.w < 4 || r0.h < 4) return;
    this.post({ type: 'busy', label: 'Buscando el objeto…' });
    try {
      // Un poco de margen alrededor ayuda a la red a ver el objeto entero.
      const m0 = Math.round(Math.max(r0.w, r0.h) * 0.08);
      const r = intersect({ x: r0.x - m0, y: r0.y - m0, w: r0.w + m0 * 2, h: r0.h + m0 * 2 }, this.docRect())!;
      const all = this.selectionSource(sampleAll);
      const px = new Uint8ClampedArray(r.w * r.h * 4);
      for (let y = 0; y < r.h; y++) px.set(all.subarray(((r.y + y) * d.width + r.x) * 4, ((r.y + y) * d.width + r.x + r.w) * 4), y * r.w * 4);
      const { subjectMask } = await import('./ai');
      const raw = await subjectMask(px, r.w, r.h, this.base);
      // Solo dentro del rectángulo y la mancha principal (la que toca el centro).
      const bin = new Uint8Array(r.w * r.h);
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const inR = x + r.x >= r0.x && x + r.x < r0.x + r0.w && y + r.y >= r0.y && y + r.y < r0.y + r0.h;
        bin[y * r.w + x] = inR && raw[y * r.w + x] >= 128 ? 1 : 0;
      }
      const cx = Math.round(r0.x + r0.w / 2 - r.x), cy = Math.round(r0.y + r0.h / 2 - r.y);
      const comp = component(bin, r.w, r.h, bin[cy * r.w + cx] ? cy * r.w + cx : undefined);
      const soft = new Uint8Array(r.w * r.h);
      for (let i = 0; i < soft.length; i++) soft[i] = comp[i] ? Math.max(raw[i], 128) : Math.min(raw[i], comp[i] ? 255 : 0);
      const refined = snapEdges(px, soft, r.w, r.h, 3);
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const inR = x + r.x >= r0.x && x + r.x < r0.x + r0.w && y + r.y >= r0.y && y + r.y < r0.y + r0.h;
        if (!inR) refined[y * r.w + x] = 0;
      }
      const sel = Selection.fromMask(refined, r.w, r.h, r.x, r.y);
      if (sel.isEmpty()) { this.toast('No se ha encontrado ningún objeto en ese rectángulo.', 'warn'); return; }
      this.setSelection(this.combine(sel, mode), 'Selección de objeto');
    } finally {
      this.post({ type: 'busy', label: null });
    }
  }

  /** Selección > Gama de colores (con vista previa: devuelve la máscara reducida sin aplicar). */
  colorRangeMask(p: ColorRangeParams, sampleAll = true, preview = 0): { w: number; h: number; data: Uint8Array } | null {
    const d = this.doc;
    if (!d) return null;
    const px = this.selectionSource(sampleAll);
    const m = colorRange(px, d.width * d.height, p);
    if (!preview) {
      this.setSelection(Selection.fromMask(m, d.width, d.height), 'Gama de colores');
      return null;
    }
    // Miniatura en escala de grises para el diálogo.
    const k = Math.min(1, preview / Math.max(d.width, d.height));
    const w = Math.max(1, Math.round(d.width * k)), h = Math.max(1, Math.round(d.height * k));
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = m[Math.min(d.height - 1, Math.floor(y / k)) * d.width + Math.min(d.width - 1, Math.floor(x / k))];
    return { w, h, data: out };
  }

  /** Imagen compuesta reducida (vistas previas de los diálogos de selección). */
  docPreview(size = 480, sampleAll = true): { w: number; h: number; image: Uint8ClampedArray } | null {
    const d = this.doc;
    if (!d) return null;
    const px = this.selectionSource(sampleAll);
    const k = Math.min(1, size / Math.max(d.width, d.height));
    const w = Math.max(1, Math.round(d.width * k)), h = Math.max(1, Math.round(d.height * k));
    const img = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = Math.min(d.height - 1, Math.floor((y + 0.5) / k)) * d.width + Math.min(d.width - 1, Math.floor((x + 0.5) / k));
      img.set(px.subarray(si * 4, si * 4 + 4), (y * w + x) * 4);
    }
    return { w, h, image: img };
  }

  /** Color del documento en un punto (cuentagotas de Gama de colores). */
  sampleColor(x: number, y: number, sampleAll = true): [number, number, number] | null {
    const d = this.doc;
    if (!d || x < 0 || y < 0 || x >= d.width || y >= d.height) return null;
    if (sampleAll) { const c = this.pickColor(x, y); return c ? [c[0], c[1], c[2]] : null; }
    const L = d.active();
    const c = L?.pixel(Math.floor(x), Math.floor(y));
    return c ? [c[0], c[1], c[2]] : null;
  }

  /** Seleccionar y aplicar máscara: vista previa (máscara refinada) o aplicar con una salida. */
  async refineSelection(p: RefineParams & { decontaminate?: number; output: 'preview' | 'selection' | 'mask' | 'newLayerMask'; previewSize?: number }): Promise<{ w: number; h: number; image: Uint8ClampedArray; mask: Uint8Array } | null> {
    const d = this.doc;
    if (!d) return null;
    const L = d.active();
    const base = d.selection ?? (L?.mask && L.kind !== 'group' ? this.selFromLayerMask(L) : null);
    if (!base) { this.toast('Haz primero una selección (o usa una capa con máscara).', 'warn'); return null; }
    const px = this.selectionSource(true);
    const mask = base.region(this.docRect());
    if (p.output === 'preview') {
      // Vista previa rápida a tamaño reducido (los radios se escalan igual).
      const k = Math.min(1, (p.previewSize ?? 640) / Math.max(d.width, d.height));
      const w = Math.max(1, Math.round(d.width * k)), h = Math.max(1, Math.round(d.height * k));
      const img = new Uint8ClampedArray(w * h * 4), mm = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const X = Math.min(d.width - 1, Math.floor((x + 0.5) / k)), Y = Math.min(d.height - 1, Math.floor((y + 0.5) / k));
        const si = Y * d.width + X, di = y * w + x;
        img.set(px.subarray(si * 4, si * 4 + 4), di * 4);
        mm[di] = mask[si];
      }
      const pr = { ...p, radius: p.radius * k, feather: p.feather * k };
      return { w, h, image: img, mask: refineMask(img, mm, w, h, pr) };
    }
    const m = refineMask(px, mask, d.width, d.height, p);
    const sel = Selection.fromMask(m, d.width, d.height);
    if (p.output === 'selection') { this.setSelection(sel.isEmpty() ? null : sel, 'Seleccionar y aplicar máscara'); return null; }
    if (!L || L.kind === 'adjustment' || L.kind === 'group') { this.toast('Elige una capa de píxeles para la máscara.', 'warn'); return null; }
    this.batched('Seleccionar y aplicar máscara', () => {
      let target = L;
      if (p.output === 'newLayerMask') {
        // Capa nueva con máscara (y, si se pide, colores descontaminados), como Photoshop.
        const b = L.bounds() ?? this.docRect();
        let src = L.readRegion(b.x - L.x, b.y - L.y, b.w, b.h);
        if (p.decontaminate) {
          const mm = new Uint8Array(b.w * b.h);
          for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
            const X = b.x + x, Y = b.y + y;
            mm[y * b.w + x] = X >= 0 && Y >= 0 && X < d.width && Y < d.height ? m[Y * d.width + X] : 0;
          }
          src = decontaminate(src, mm, b.w, b.h, p.decontaminate / 100);
        }
        target = layerFromPixels(`${L.name} (refinada)`, src, b.w, b.h, b.x, b.y);
        L.visible = false;
        const lid = L.id;
        this.commit(new FnEntry('', (doc) => { const l = doc.layer(lid); if (l) l.visible = true; }, (doc) => { const l = doc.layer(lid); if (l) l.visible = false; }));
        this.insertLayer(target, this.above(target), 'Capa nueva con máscara');
      }
      const oldMask = target.mask, oldEn = target.maskEnabled;
      const mk = new MaskChannel(0);
      const T = target;
      forTiles({ x: -T.x, y: -T.y, w: d.width, h: d.height }, (tx, ty, x0, y0, x1, y1) => {
        const k = tileKey(tx, ty);
        const t = mk.ensureTile(k);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const X = tx * TILE + x + T.x, Y = ty * TILE + y + T.y;
          t[y * TILE + x] = X >= 0 && Y >= 0 && X < d.width && Y < d.height ? m[Y * d.width + X] : 0;
        }
        mk.touch(k);
      });
      T.mask = mk; T.maskEnabled = true;
      const id = T.id;
      this.commit(new FnEntry('', (doc) => { const l = doc.layer(id); if (l) { l.mask = oldMask; l.maskEnabled = oldEn; } }, (doc) => { const l = doc.layer(id); if (l) { l.mask = mk; l.maskEnabled = true; } }));
      if (d.selection) this.setSelection(null, 'Deseleccionar');
    });
    this.invalidate(null);
    return null;
  }

  private selFromLayerMask(L: PixelLayer): Selection {
    const d = this.doc!;
    const m = new Uint8Array(d.width * d.height);
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) m[y * d.width + x] = L.mask!.get(x - L.x, y - L.y);
    return Selection.fromMask(m, d.width, d.height);
  }

  /** Selección > Sujeto: la misma IA, pero como selección. */
  async selectSubject() {
    const d = this.doc;
    if (!d) return;
    this.post({ type: 'busy', label: 'Seleccionando sujeto…' });
    try {
      const { subjectMask } = await import('./ai');
      const px = this.r.flatten(d, d.layers, this.docRect());
      const m = await subjectMask(px, d.width, d.height, this.base);
      this.setSelection(Selection.fromMask(m, d.width, d.height), 'Sujeto');
    } finally {
      this.post({ type: 'busy', label: null });
    }
  }

  /** Imagen y máscara de la selección para el relleno generativo (proveedor externo). */
  async generativeInput(): Promise<{ image: Blob; mask: Blob; rect: Rect } | null> {
    const d = this.doc;
    const sel = d?.selection;
    if (!d || !sel) return null;
    const b = sel.bounds()!;
    const pad = Math.round(Math.max(b.w, b.h) * 0.25);
    const rect = intersect({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, this.docRect())!;
    const px = this.r.flatten(d, d.layers, rect);
    const m = sel.region(rect);
    const maskPx = new Uint8ClampedArray(rect.w * rect.h * 4);
    for (let i = 0; i < m.length; i++) { maskPx[i * 4] = maskPx[i * 4 + 1] = maskPx[i * 4 + 2] = 255; maskPx[i * 4 + 3] = 255 - m[i]; }
    return { image: await encodeRaster(px, rect.w, rect.h, 'image/png', 1), mask: await encodeRaster(maskPx, rect.w, rect.h, 'image/png', 1), rect };
  }

  /** Coloca el resultado generado como capa nueva con la selección como máscara (como Photoshop). */
  async placeGenerated(buffer: ArrayBuffer, rect: Rect, prompt: string) {
    const d = this.doc;
    if (!d) return;
    const res = await importRaster('gen.png', buffer, 'image/png');
    let px = res.doc.layers[0].readRegion(0, 0, res.doc.width, res.doc.height);
    if (res.doc.width !== rect.w || res.doc.height !== rect.h) {
      const { resample } = await import('./resample');
      px = resample(px, res.doc.width, res.doc.height, rect.w, rect.h);
    }
    const L = layerFromPixels(prompt.slice(0, 40) || 'Relleno generativo', px, rect.w, rect.h, rect.x, rect.y);
    L.mask = this.maskFromSelection();
    this.insertLayer(L, this.above(L), 'Relleno generativo');
  }

  // ================================================================ herramientas

  setTool(t: ToolId) { this.tool = t; }
  setBrush(b: Partial<BrushSettings>) { this.brush = { ...this.brush, ...b }; }

  // Puntas de pincel muestreadas (pinceles importados .abr, definidos por el usuario o incluidos).
  private brushTips = new Map<string, { w: number; h: number; a: Float32Array }>();
  registerBrushTip(id: string, w: number, h: number, alpha: Uint8Array) {
    const a = new Float32Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = alpha[i] / 255;
    this.brushTips.set(id, { w, h, a });
  }
  hasBrushTip(id: string) { return this.brushTips.has(id); }

  /** Simetría al pintar (null = desactivada). */
  private symmetry: Symmetry | null = null;
  setSymmetry(sym: Symmetry | null) { this.symmetry = sym; }

  /** Depósito del pincel mezclador: Cargar (color frontal) o Limpiar. */
  private mixerState: { color: RGBA | null } = { color: null };
  mixerReservoir(action: 'load' | 'clean') { this.mixerState.color = action === 'load' ? [...this.fg] as RGBA : null; }

  /** Motivos del usuario: se registran desde la interfaz (IndexedDB) o al definirlos. */
  registerPattern(id: string, w: number, h: number, data: Uint8ClampedArray) {
    USER_PATTERNS.set(id, { w, h, data });
    // Las capas con superposición de este motivo se recalculan.
    for (const L of this.doc?.layers ?? []) if (L.effects?.patternOverlay?.pattern === id) this.fxVersions.delete(L.id);
    this.scheduleEffects();
  }

  /** Edición > Definir motivo: la selección (o la capa) compuesta como motivo en mosaico. */
  definePattern(): { w: number; h: number; data: Uint8ClampedArray } | null {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return null;
    const b = d.selection?.bounds() ?? exactBounds(L) ?? this.docRect();
    const r = intersect(b, this.docRect());
    if (!r) return null;
    if (r.w * r.h > 4096 * 4096) { this.toast('El motivo es demasiado grande (máx. 4096 × 4096).', 'warn'); return null; }
    return { w: r.w, h: r.h, data: this.r.flatten(d, d.layers, r) };
  }

  /** Edición > Rellenar con un motivo (de imagen o generado), con escala. */
  fillPattern(id: PatternId, scale = 1, preserveTransparency = false) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || !this.ensurePixel(L)) return;
    const sel = d.selection;
    const rect = sel ? intersect(sel.bounds()!, this.docRect()) : this.docRect();
    if (!rect) return;
    const px = L.readRegion(rect.x - L.x, rect.y - L.y, rect.w, rect.h);
    const cell = Math.max(2, 16 * scale);
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const i = (y * rect.w + x) * 4, X = rect.x + x, Y = rect.y + y;
      const keep = preserveTransparency || L.lockAlpha ? px[i + 3] / 255 : 1;
      let c: RGBA;
      if (id.startsWith('user:')) c = userPatternAt(id, X, Y, scale) ?? [0, 0, 0, 0];
      else { const t = pattern(id, X, Y, cell); c = [this.fg[0] + (this.bg[0] - this.fg[0]) * t, this.fg[1] + (this.bg[1] - this.fg[1]) * t, this.fg[2] + (this.bg[2] - this.fg[2]) * t, 255]; }
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3] * keep;
    }
    const patch = new TilePatch('Rellenar con motivo', L);
    applyRegion(L, patch, rect, px, sel);
    this.commit(patch);
    this.invalidate(rect);
  }

  /** Edición > Definir valor de pincel: la selección (o la capa) en escala de grises; lo oscuro pinta. */
  defineBrushTip(): { w: number; h: number; alpha: Uint8Array } | null {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return null;
    const b = d.selection?.bounds() ?? exactBounds(L);
    if (!b) { this.toast('No hay nada que convertir en pincel.', 'warn'); return null; }
    const r = intersect(b, this.docRect());
    if (!r) return null;
    const px = this.r.flatten(d, d.layers, r);
    const k = Math.min(1, 1000 / Math.max(r.w, r.h));
    const w = Math.max(1, Math.round(r.w * k)), h = Math.max(1, Math.round(r.h * k));
    const alpha = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const X = Math.min(r.w - 1, Math.floor(x / k)), Y = Math.min(r.h - 1, Math.floor(y / k));
      const i = (Y * r.w + X) * 4, sel = d.selection ? d.selection.get(r.x + X, r.y + Y) / 255 : 1;
      const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
      alpha[y * w + x] = Math.round((1 - lum) * (px[i + 3] / 255) * sel * 255);
    }
    return { w, h, alpha };
  }
  setColors(fg: RGBA, bg: RGBA) { this.fg = fg; this.bg = bg; }
  setAutoSelect(on: boolean) { this.autoSelect = on; }

  /** Herramienta Mover: capa con píxeles bajo el cursor (Ctrl+clic en Photoshop). */
  private layerAt(x: number, y: number): PixelLayer | null {
    const d = this.doc!;
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const L = d.layers[i];
      if (!L.visible || L.kind === 'adjustment') continue;
      if (L.pixel(Math.floor(x), Math.floor(y))[3] > 10 && L.maskAt(Math.floor(x), Math.floor(y)) > 10) return L;
    }
    return null;
  }

  moveLayerBy(dx: number, dy: number) {
    const d = this.doc;
    const A = d?.active();
    if (!d || !A || A.kind === 'adjustment') return;
    const set = this.moveSet(A);
    if (!set.length) return;
    const pos = (l: PixelLayer) => ({ x: l.x, y: l.y, text: l.text, shape: l.shape, smart: l.smart, artboard: l.artboard });
    const from = set.map(pos);
    let dirty: Rect | null = null;
    for (const L of set) {
      dirty = union(dirty, this.fullBounds(L));
      this.shiftLayer(L, dx, dy);
      dirty = union(dirty, this.fullBounds(L));
    }
    const to = set.map(pos);
    const apply = (v: typeof from) => (doc: EditorDocument) => { set.forEach((L, i) => { const l = doc.layer(L.id); if (l) Object.assign(l, v[i]); }); };
    this.commit(new FnEntry('Mover', apply(from), apply(to)));
    this.invalidate(dirty);
  }

  private fullBounds(L: PixelLayer): Rect | null {
    return union(L.bounds(), fxBounds(L));
  }

  private shiftLayer(L: PixelLayer, dx: number, dy: number) {
    if (!dx && !dy) return;
    L.x += dx; L.y += dy;
    if (L.text) L.text = { ...L.text, matrix: mul([1, 0, 0, 1, dx, dy], L.text.matrix) };
    if (L.shape) L.shape = { ...L.shape, matrix: mul([1, 0, 0, 1, dx, dy], L.shape.matrix) };
    if (L.smart) L.smart = { ...L.smart, matrix: mul([1, 0, 0, 1, dx, dy], L.smart.matrix) };
    if (L.artboard) L.artboard = { ...L.artboard, x: L.artboard.x + dx, y: L.artboard.y + dy };
    // El contenido rasterizado se mueve con x/y; las matrices ya contemplan el desplazamiento
    // para la próxima rasterización, que vuelve a situar la capa en (0,0).
    for (const f of L.fxLayers()) { f.x += dx; f.y += dy; }
    if (this.fxVersions.get(L.id)) this.fxVersions.set(L.id, fxKey(L));
  }

  pointer(m: PointerMsg) {
    // Mientras se calcula una corrección, los trazos nuevos esperan (no se pierden).
    if (this.healing) { this.pointerQueue.push(m); return; }
    if (this.view.rot) m = { ...m, points: m.points.map((q) => { const [x, y] = this.unrot(q.x, q.y); return { ...q, x, y }; }) };
    const d = this.doc;
    if (!d || !m.points.length || this.transform) return;
    const first = m.points[0];
    const last = m.points[m.points.length - 1];
    const tool: ToolId | 'pan' = m.button === 1 ? 'pan' : this.tool;

    if (m.phase === 'down') {
      const p = this.toDoc(first.x, first.y);
      if (tool === 'pan' || tool === 'hand') {
        this.drag = { kind: 'pan', x0: first.x, y0: first.y, panX: this.view.panX, panY: this.view.panY, lx: 0, ly: 0 };
        return;
      }
      if (tool === 'zoom') { this.stepZoom(m.alt ? -1 : 1, first.x, first.y); return; }
      if (tool === 'eyedropper') {
        const c = this.r.readCompositePixel(Math.floor(p.x), Math.floor(p.y));
        if (c[3] > 0) this.post({ type: 'color', which: m.alt ? 'bg' : 'fg', rgba: [c[0], c[1], c[2], 255] });
        return;
      }
      if (tool === 'move') {
        let L = d.active();
        if (this.autoSelect || m.ctrl) {
          const hit = this.layerAt(p.x, p.y);
          if (hit) { L = hit; d.activeLayerId = hit.id; this.pushState(false); }
        }
        if (!L || L.kind === 'adjustment') return;
        const set = this.moveSet(L).map((l) => ({ L: l, x: l.x, y: l.y, text: l.text, shape: l.shape, smart: l.smart, artboard: l.artboard }));
        if (!set.length) return;
        let box: Rect | null = null;
        if (this.snap) for (const e of set) box = union(box, exactBounds(e.L));
        this.drag = { kind: 'move', x0: first.x, y0: first.y, panX: 0, panY: 0, lx: 0, ly: 0, layer: L, moved: false, set, box };
        return;
      }
      const mode = BRUSH_TOOLS[tool as ToolId];
      if (mode) {
        // En Máscara rápida los pinceles pintan la selección.
        const L = this.qm ?? d.active();
        if (!L) return;
        if ((tool === 'clone' || tool === 'heal') && m.alt) {
          this.cloneSource = { x: p.x, y: p.y };
          this.cloneOffset = null;
          this.toast(tool === 'heal' ? 'Origen de corrección definido' : 'Origen de clonación definido');
          return;
        }
        const toMask = this.qm ? true : d.editMask && !!L.mask;
        if (!toMask && !this.ensurePixel(L)) return;
        if (!L.visible) { this.toast('La capa está oculta. Hazla visible para pintar.', 'warn'); return; }
        if (tool === 'clone' || tool === 'heal') {
          if (!this.cloneSource) { this.toast(tool === 'heal' ? 'Alt+clic para definir el origen de la corrección.' : 'Alt+clic para definir el origen de clonación.', 'warn'); return; }
          if (!this.cloneOffset) this.cloneOffset = { dx: Math.round(this.cloneSource.x - p.x), dy: Math.round(this.cloneSource.y - p.y) };
        }
        const selB = d.selection?.bounds() ?? null;
        const clip = selB ? intersect(selB, this.docRect()) : this.docRect();
        if (!clip) return;
        const healTool = tool === 'spotHeal' || tool === 'heal' || tool === 'remove';
        let sourceLayer: PixelLayer | undefined;
        if (tool === 'historyBrush') {
          const snap = d.snapshots.find((x) => x.id === d.historySource);
          sourceLayer = snap?.map.get(L.id);
          if (!sourceLayer || toMask) { this.toast('El estado de origen del pincel de historia no contiene esta capa.', 'warn'); return; }
          if (snap && (snap.width !== d.width || snap.height !== d.height)) { this.toast('El tamaño del documento ha cambiado desde la instantánea de origen.', 'warn'); return; }
        }
        if (healTool && toMask) { this.toast('Los pinceles correctores actúan sobre los píxeles, no sobre la máscara.', 'warn'); return; }
        const color: RGBA = tool === 'spotHeal' ? [20, 20, 20, 255] : tool === 'remove' ? [235, 40, 150, 255] : mode === 'erase' && toMask ? this.bg : this.fg;
        this.strokeTool = tool as ToolId;
        this.stroke = new BrushStroke({
          layer: L,
          // Corrector puntual: una marca translúcida indica la zona; al soltar se rellena.
          settings: tool === 'mixer' ? { ...this.brush, mixer: this.brush.mixer ?? { wet: 0.5, load: 0.5, mix: 0.5, loadEach: true, cleanEach: false, sampleAll: false } }
            : tool === 'pencil' ? { ...this.brush, hardness: 1, mixer: undefined }
            : tool === 'spotHeal' ? { ...this.brush, opacity: 0.45, flow: 1 }
            : tool === 'remove' ? { ...this.brush, opacity: 0.5, flow: 1, hardness: 1 }
            : tool === 'heal' ? { ...this.brush, opacity: 1, flow: 1 } : { ...this.brush, mixer: undefined },
          tips: this.brushTips,
          symmetry: tool === 'brush' || tool === 'pencil' || tool === 'eraser' || tool === 'mixer' ? this.symmetry : null,
          bgColor: this.bg,
          mixerState: this.mixerState,
          color,
          mode: toMask ? 'paint' : mode,
          clip,
          selection: d.selection,
          target: toMask ? 'mask' : 'pixels',
          maskValue: lumOf(color),
          cloneOffset: tool === 'clone' || tool === 'heal' ? this.cloneOffset! : undefined,
          healTool: healTool ? tool as 'spotHeal' | 'heal' | 'remove' : undefined,
          sourceLayer,
          label: tool === 'historyBrush' ? 'Pincel de historia' : undefined,
          aliased: tool === 'pencil',
        });
        this.strokePoints(m);
      }
      return;
    }

    if (this.stroke) {
      if (m.points.length) this.strokePoints(m);
      if (m.phase === 'up') {
        const st = this.stroke;
        this.stroke = null;
        if (this.strokeTool === 'spotHeal' || this.strokeTool === 'heal' || this.strokeTool === 'remove') { void this.finishHeal(st, this.strokeTool); return; }
        const patch = st.finish();
        if (patch) this.commit(patch);
        this.requestFrame();
      }
      return;
    }

    const g = this.drag;
    if (!g) return;
    if (g.kind === 'pan') {
      this.setView(this.view.zoom, g.panX + (last.x - g.x0), g.panY + (last.y - g.y0));
    } else if (g.kind === 'move' && g.set) {
      let dx = Math.round((last.x - g.x0) / this.view.zoom), dy = Math.round((last.y - g.y0) / this.view.zoom);
      if (m.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (g.box) {
        const [sx, sy] = this.snapDelta(g.box, dx, dy, new Set(g.set.map((e) => e.L)));
        // Con Mayús (eje fijo) sólo se ajusta el eje libre.
        const lockX = m.shift && dx === 0, lockY = m.shift && dy === 0;
        if (!lockX) dx = Math.round(sx);
        if (!lockY) dy = Math.round(sy);
      }
      let dirty: Rect | null = null;
      for (const e of g.set) {
        dirty = union(dirty, this.fullBounds(e.L));
        this.shiftLayer(e.L, e.x + dx - e.L.x, e.y + dy - e.L.y);
        dirty = union(dirty, this.fullBounds(e.L));
      }
      if (dx || dy) g.moved = true;
      this.invalidate(dirty);
      if (m.phase === 'up' && g.moved && (dx || dy)) {
        const set = g.set;
        const prev = set.map((e) => ({ x: e.x, y: e.y, text: e.text, shape: e.shape, smart: e.smart, artboard: e.artboard }));
        const cur = set.map((e) => ({ x: e.L.x, y: e.L.y, text: e.L.text, shape: e.L.shape, smart: e.L.smart, artboard: e.L.artboard }));
        const apply = (v: typeof cur) => (doc: EditorDocument) => { set.forEach((e, i) => { const l = doc.layer(e.L.id); if (l) Object.assign(l, v[i]); }); };
        this.commit(new FnEntry('Mover', apply(prev), apply(cur)));
      }
    }
    if (m.phase === 'up') this.drag = null;
  }

  // ================================================================ trazados (pluma)

  private pathsSnap() {
    const d = this.doc!;
    return { list: d.paths.map((p) => ({ ...p, path: clonePath(p.path) })), active: d.activePathId };
  }

  private pathsApply(sn: ReturnType<Engine['pathsSnap']>) {
    return (doc: EditorDocument) => { doc.paths = sn.list.map((p) => ({ ...p, path: clonePath(p.path) })); doc.activePathId = sn.active; };
  }

  private commitPaths(label: string, before: ReturnType<Engine['pathsSnap']>) {
    this.commit(new FnEntry(label, this.pathsApply(before), this.pathsApply(this.pathsSnap())));
  }

  /**
   * Guarda la edición de un trazado (cada clic o arrastre de la pluma es un paso del historial).
   * id null = trazado de trabajo nuevo (reemplaza al anterior, como en Photoshop).
   */
  setPathData(id: number | null, path: VectorPath, label = 'Editar trazado') {
    const d = this.doc;
    if (!d) return;
    const before = this.pathsSnap();
    let e = id != null ? d.paths.find((p) => p.id === id) : undefined;
    if (!e) {
      if (!path.length) return;
      d.paths = d.paths.filter((p) => !p.work);
      e = { id: this.pathCounter++, name: 'Trazado de trabajo', work: true, path: [] };
      d.paths.push(e);
    }
    e.path = clonePath(path);
    d.activePathId = e.id;
    if (!path.length && e.work) { d.paths = d.paths.filter((p) => p !== e); d.activePathId = null; }
    this.commitPaths(label, before);
  }

  // ================================================================ guías y ajuste

  private guidesChange(label: string, fn: (d: EditorDocument) => void) {
    const d = this.doc;
    if (!d) return;
    const before = d.guides.map((g) => ({ ...g }));
    fn(d);
    const after = d.guides.map((g) => ({ ...g }));
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const set = (v: typeof before) => (doc: EditorDocument) => { doc.guides = v.map((g) => ({ ...g })); };
    this.commit(new FnEntry(label, set(before), set(after)));
  }

  addGuide(dir: 'h' | 'v', pos: number) {
    this.guidesChange('Nueva guía', (d) => { d.guides.push({ id: Date.now() + Math.random(), dir, pos: Math.round(pos * 100) / 100 }); });
  }

  moveGuide(id: number, pos: number) {
    this.guidesChange('Mover guía', (d) => {
      const g = d.guides.find((x) => x.id === id);
      if (!g) return;
      // Soltarla fuera del documento la elimina (como Photoshop).
      const max = g.dir === 'h' ? d.height : d.width;
      if (pos < 0 || pos > max) d.guides = d.guides.filter((x) => x !== g);
      else g.pos = Math.round(pos * 100) / 100;
    });
  }

  clearGuides() { this.guidesChange('Borrar guías', (d) => { d.guides = []; }); }

  /** Ajuste magnético (Vista > Ajustar): guías, bordes y centro del documento y de otras capas. */
  setSnap(on: boolean) { this.snap = on; }

  /** Desplazamiento corregido para que la caja `b` (movida dx, dy) se pegue a lo más cercano. */
  private snapDelta(b: Rect, dx: number, dy: number, exclude: Set<PixelLayer>): [number, number] {
    const d = this.doc;
    if (!d || !this.snap) return [dx, dy];
    const tol = 8 / this.view.zoom;
    const xs = [0, d.width / 2, d.width], ys = [0, d.height / 2, d.height];
    for (const g of d.guides) (g.dir === 'v' ? xs : ys).push(g.pos);
    for (const L of d.layers) {
      if (exclude.has(L) || !L.visible || L.kind === 'group' || L.kind === 'adjustment') continue;
      const lb = L.bounds();
      if (!lb || lb.w * lb.h > 4e6) continue;
      xs.push(lb.x, lb.x + lb.w / 2, lb.x + lb.w); ys.push(lb.y, lb.y + lb.h / 2, lb.y + lb.h);
    }
    const best = (edges: number[], targets: number[]) => {
      let bd = tol + 1, off = 0;
      for (const e of edges) for (const t of targets) { const k = t - e; if (Math.abs(k) < Math.abs(bd)) { bd = k; off = k; } }
      return Math.abs(bd) <= tol ? off : 0;
    };
    const nx = b.x + dx, ny = b.y + dy;
    return [dx + best([nx, nx + b.w / 2, nx + b.w], xs), dy + best([ny, ny + b.h / 2, ny + b.h], ys)];
  }

  // ================================================================ instantáneas y pincel de historia

  private takeSnapshot(doc: EditorDocument, name: string) {
    const { copies, map } = cloneLayers(doc.layers);
    const snap = { id: this.snapCounter++, name, width: doc.width, height: doc.height, layers: copies, map, activeIndex: doc.indexOf(doc.activeLayerId) };
    doc.snapshots.push(snap);
    return snap;
  }

  /** Panel Historial > Nueva instantánea. */
  newSnapshot(name?: string) {
    const d = this.doc;
    if (!d) return;
    const n = d.snapshots.length;
    this.takeSnapshot(d, name ?? `Instantánea ${n}`);
    this.pushState(false);
  }

  deleteSnapshot(id: number) {
    const d = this.doc;
    if (!d) return;
    d.snapshots = d.snapshots.filter((x) => x.id !== id);
    if (d.historySource === id) d.historySource = d.snapshots[0]?.id ?? null;
    this.pushState(false);
  }

  /** Clic en una instantánea: el documento vuelve a ese estado (un paso más del historial). */
  restoreSnapshot(id: number) {
    const d = this.doc;
    const snap = d?.snapshots.find((x) => x.id === id);
    if (!d || !snap) return;
    this.restorePreview();
    const before = { layers: d.layers, w: d.width, h: d.height, active: d.activeLayerId, sel: d.selection };
    const { copies } = cloneLayers(snap.layers);
    const after = { layers: copies, w: snap.width, h: snap.height, active: copies[Math.max(0, Math.min(copies.length - 1, snap.activeIndex))].id, sel: null as Selection | null };
    const apply = (v: typeof before) => (doc: EditorDocument) => {
      doc.layers = v.layers; doc.width = v.w; doc.height = v.h; doc.activeLayerId = v.active; doc.selection = v.sel; doc.selectedIds = new Set([v.active]);
    };
    apply(after)(d);
    this.commit(new FnEntry(snap.name, apply(before), apply(after)));
    this.afterHistory();
    this.fit(true);
  }

  /** Origen del pincel de historia (la casilla junto a la instantánea en Photoshop). */
  setHistorySource(id: number) {
    const d = this.doc;
    if (!d || !d.snapshots.some((x) => x.id === id)) return;
    d.historySource = id;
    this.pushState(false);
  }

  // ================================================================ máscara rápida y canales

  /** Q: entra o sale de Máscara rápida. Dentro, pintar en negro enmascara y en blanco selecciona. */
  toggleQuickMask() {
    const d = this.doc;
    if (!d) return;
    if (!this.qm) {
      const L = new PixelLayer('Máscara rápida');
      const sel = d.selection;
      L.mask = new MaskChannel(sel ? 0 : 255);
      if (sel) for (const [k, t] of sel.tiles) L.mask.setTile(k, t.slice());
      this.qm = L;
      d.extras = [L];
      this.lastSelection = d.selection ?? this.lastSelection;
      d.selection = null;
      this.r.setMaskOverlay(L.mask);
      this.selectionChanged();
      this.pushState(false);
      this.requestFrame();
      return;
    }
    const m = this.qm.mask!;
    const tiles = new Map<number, Uint8Array>();
    for (let ty = 0; ty < d.tilesY; ty++) for (let tx = 0; tx < d.tilesX; tx++) {
      const k = tileKey(tx, ty);
      const t = m.tiles.get(k);
      if (t) { if (t.some((v) => v)) tiles.set(k, t.slice()); }
      else if (m.fill) tiles.set(k, new Uint8Array(TILE * TILE).fill(m.fill));
    }
    this.qm = null;
    d.extras = [];
    this.r.setMaskOverlay(null);
    // Recorta al documento (los tiles del borde pueden salirse).
    const sel = new Selection(tiles);
    this.setSelection(sel.isEmpty() ? null : sel.combine(Selection.fromRect(this.docRect()), 'intersect'), 'Salir de Máscara rápida');
    this.requestFrame();
  }

  /** Panel Canales: ver un solo canal en escala de grises (0 = compuesto; en CMYK 1..4 = C, M, Y, K). */
  setViewChannel(c: number) {
    const mode = this.doc?.mode ?? 'rgb';
    this.viewChannel = Math.max(0, Math.min(mode === 'cmyk' ? 4 : mode === 'gray' ? 0 : 3, c | 0));
    this.r.viewChannel = mode === 'cmyk' && this.viewChannel ? this.viewChannel + 4 : this.viewChannel;
    this.pushState(false);
    this.requestFrame();
  }

  /** Ctrl+clic en un canal: su luminosidad (compuesto), su valor (R, G, B) o la ausencia de tinta (C, M, Y, K) como selección. */
  loadChannelSelection(c: number, mode: CombineMode = 'replace') {
    const d = this.doc;
    if (!d) return;
    const px = this.r.flatten(d, d.layers, this.docRect());
    const n = d.width * d.height;
    const m = new Uint8Array(n);
    const ink = d.mode === 'cmyk' && c > 0 ? toCmyk(px) : null;
    for (let i = 0; i < n; i++) {
      const a = px[i * 4 + 3] / 255;
      const v = ink ? 255 - ink[i * 4 + c - 1] : c === 0 ? 0.3 * px[i * 4] + 0.59 * px[i * 4 + 1] + 0.11 * px[i * 4 + 2] : px[i * 4 + c - 1];
      m[i] = Math.round(v * a);
    }
    this.setSelection(this.combine(Selection.fromMask(m, d.width, d.height), mode), 'Cargar selección');
  }

  // ================================================================ línea de tiempo (animación de cuadros)

  /** Posición de referencia de una capa (las de texto, forma y objeto inteligente se mueven con su matriz). */
  private animPos(L: PixelLayer): [number, number] {
    const m = L.text?.matrix ?? L.shape?.matrix ?? L.smart?.matrix;
    return m ? [m[4], m[5]] : [L.x, L.y];
  }

  private captureFrame(): AnimFrame['layers'] {
    const out: AnimFrame['layers'] = {};
    for (const L of this.doc!.layers) { const [x, y] = this.animPos(L); out[L.id] = { v: L.visible, o: L.opacity, x, y }; }
    return out;
  }

  /** Lleva las capas al estado del cuadro i (sin historial: los cuadros guardan su propio estado). */
  private applyFrame(i: number) {
    const d = this.doc!, f = d.frames[i];
    if (!f) return;
    for (const L of d.layers) {
      const st = f.layers[L.id];
      if (!st) continue;
      L.visible = st.v; L.opacity = st.o;
      const [x, y] = this.animPos(L);
      if (L.kind !== 'group' && L.kind !== 'adjustment' && (x !== st.x || y !== st.y)) this.shiftLayer(L, st.x - x, st.y - y);
    }
  }

  /** Guarda en el cuadro activo los cambios hechos en las capas. */
  private storeFrame() {
    const d = this.doc;
    if (d?.frames[d.activeFrame]) d.frames[d.activeFrame].layers = this.captureFrame();
  }

  /** Ventana > Línea de tiempo > Crear animación de cuadros. */
  timelineCreate() {
    const d = this.doc;
    if (!d || d.frames.length) return;
    d.frames = [{ delay: 100, layers: this.captureFrame() }];
    d.activeFrame = 0;
    this.pushState(false);
  }

  timelineSelect(i: number) {
    const d = this.doc;
    if (!d || !d.frames[i]) return;
    if (i !== d.activeFrame) { this.storeFrame(); d.activeFrame = i; this.applyFrame(i); }
    this.invalidate(null);
    this.pushState(false);
  }

  /** Duplica el cuadro activo detrás de él y lo selecciona. */
  timelineAdd() {
    const d = this.doc;
    if (!d) return;
    if (!d.frames.length) return this.timelineCreate();
    this.storeFrame();
    const cur = d.frames[d.activeFrame];
    d.frames.splice(d.activeFrame + 1, 0, { delay: cur.delay, layers: this.captureFrame() });
    d.activeFrame++;
    this.pushState(false);
  }

  timelineDelete(i?: number) {
    const d = this.doc;
    if (!d || !d.frames.length) return;
    const k = i ?? d.activeFrame;
    d.frames.splice(k, 1);
    if (!d.frames.length) { d.activeFrame = 0; this.pushState(false); return; }
    d.activeFrame = Math.min(d.activeFrame, d.frames.length - 1);
    this.applyFrame(d.activeFrame);
    this.invalidate(null);
    this.pushState(false);
  }

  timelineDelay(i: number | 'all', ms: number) {
    const d = this.doc;
    if (!d) return;
    for (const [k, f] of d.frames.entries()) if (i === 'all' || i === k) f.delay = Math.max(0, Math.round(ms));
    this.pushState(false);
  }

  timelineLoop(n: number) {
    if (!this.doc) return;
    this.doc.loop = Math.max(0, n | 0);
    this.pushState(false);
  }

  timelineMove(from: number, to: number) {
    const d = this.doc;
    if (!d || !d.frames[from] || to < 0 || to >= d.frames.length) return;
    this.storeFrame();
    const [f] = d.frames.splice(from, 1);
    d.frames.splice(to, 0, f);
    d.activeFrame = to;
    this.applyFrame(to);
    this.invalidate(null);
    this.pushState(false);
  }

  /** Interpolar: añade `n` cuadros entre el activo y el siguiente (opacidad y posición). */
  timelineTween(n: number) {
    const d = this.doc;
    if (!d || d.activeFrame >= d.frames.length - 1 || n < 1) return;
    this.storeFrame();
    const a = d.frames[d.activeFrame], b = d.frames[d.activeFrame + 1];
    const add: AnimFrame[] = [];
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1), layers: AnimFrame['layers'] = {};
      for (const id of Object.keys(a.layers).map(Number)) {
        const p = a.layers[id], q = b.layers[id] ?? p;
        layers[id] = { v: p.v || q.v, o: p.v && q.v ? p.o + (q.o - p.o) * t : p.v ? p.o * (1 - t) : q.o * t, x: Math.round(p.x + (q.x - p.x) * t), y: Math.round(p.y + (q.y - p.y) * t) };
      }
      add.push({ delay: a.delay, layers });
    }
    d.frames.splice(d.activeFrame + 1, 0, ...add);
    this.pushState(false);
  }

  /** Miniaturas de los cuadros. */
  timelineThumbs(max = 64): { w: number; h: number; data: Uint8ClampedArray }[] {
    const d = this.doc;
    if (!d || !d.frames.length) return [];
    this.storeFrame();
    const k = Math.min(1, max / Math.max(d.width, d.height));
    const w = Math.max(1, Math.round(d.width * k)), h = Math.max(1, Math.round(d.height * k));
    const out: { w: number; h: number; data: Uint8ClampedArray }[] = [];
    for (let i = 0; i < d.frames.length; i++) {
      this.applyFrame(i);
      const full = this.modePixels(this.r.flatten(d, d.layers, this.docRect()));
      const t = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const si = (Math.min(d.height - 1, Math.floor((y + 0.5) / k)) * d.width + Math.min(d.width - 1, Math.floor((x + 0.5) / k))) * 4;
        t.set(full.subarray(si, si + 4), (y * w + x) * 4);
      }
      out.push({ w, h, data: t });
    }
    this.applyFrame(d.activeFrame);
    this.r.invalidate(null);
    return out;
  }

  /** Exporta la animación como GIF (o los cuadros sueltos en PNG). */
  async timelineExport(o: { colors?: number; dither?: boolean; scale?: number; format?: 'gif' | 'png' } = {}): Promise<{ name: string; blob: Blob }[]> {
    const d = this.doc;
    if (!d) return [];
    if (!d.frames.length) this.timelineCreate();
    this.storeFrame();
    const s = o.scale ?? 1, w = Math.max(1, Math.round(d.width * s)), h = Math.max(1, Math.round(d.height * s));
    const frames: { px: Uint8ClampedArray; delay: number }[] = [];
    for (let i = 0; i < d.frames.length; i++) {
      this.applyFrame(i);
      let px = this.r.flatten(d, d.layers, this.docRect());
      if (s !== 1) px = await this.scalePixels(px, d.width, d.height, w, h);
      frames.push({ px: this.modePixels(px), delay: d.frames[i].delay });
    }
    this.applyFrame(d.activeFrame);
    this.invalidate(null);
    const base = d.name.replace(/\.[^.]+$/, '');
    if (o.format === 'png') {
      const out: { name: string; blob: Blob }[] = [];
      for (const [i, f] of frames.entries()) out.push({ name: `${base}_${String(i + 1).padStart(3, '0')}.png`, blob: await encodeRaster(f.px, w, h, 'image/png', 1) });
      return out;
    }
    return [{ name: `${base}.gif`, blob: encodeGif(frames, w, h, { colors: o.colors, dither: o.dither, loop: d.loop === 0 ? 0 : d.loop === 1 ? -1 : d.loop - 1 }) }];
  }

  // ================================================================ modos de color

  /**
   * Imagen > Modo. Escala de grises descarta el color de las capas de píxeles; CMYK lleva sus colores
   * a la gama imprimible. Las capas de texto, formas y ajustes conservan sus parámetros: la vista y
   * la exportación aplican el modo al resultado.
   */
  setMode(mode: 'rgb' | 'gray' | 'cmyk') {
    const d = this.doc;
    if (!d || d.mode === mode) return;
    const before = d.mode;
    const label = { rgb: 'Color RGB', gray: 'Escala de grises', cmyk: 'Color CMYK' }[mode];
    this.perf(label, () => this.batched(label, () => {
      if (mode !== 'rgb') {
        for (const L of d.layers) {
          if (L.kind !== 'pixel' || !L.tiles.size) continue;
          const patch = new TilePatch('', L);
          if (mode === 'gray') desaturate(L, (k) => patch.capture(L, k));
          else for (const k of [...L.tiles.keys()]) { patch.capture(L, k); proofPixels(L.ensureTile(k)); L.touch(k); }
          this.commit(patch);
        }
      }
      const sync = () => { this.viewChannel = 0; this.r.viewChannel = 0; };
      this.commit(new FnEntry('', (doc) => { doc.mode = before; sync(); }, (doc) => { doc.mode = mode; sync(); }));
      d.mode = mode;
      sync();
    }));
    this.invalidate(null);
  }

  /** Vista > Prueba de colores (Ctrl+Y). */
  setProof(on?: boolean) {
    this.r.proof = on ?? !this.r.proof;
    this.pushState(false);
    this.requestFrame();
  }

  /** Vista > Avisar sobre gama (Mayús+Ctrl+Y): gris donde el color no se puede imprimir. */
  setGamutWarning(on?: boolean) {
    this.r.gamutWarning = on ?? !this.r.gamutWarning;
    this.pushState(false);
    this.requestFrame();
  }

  /** Resolución del documento (no remuestrea). */
  setResolution(dpi: number) {
    const d = this.doc;
    if (!d) return;
    const before = d.dpi, after = Math.max(1, Math.min(9999, Math.round(dpi)));
    if (before === after) return;
    d.dpi = after;
    this.commit(new FnEntry('Resolución', (doc) => { doc.dpi = before; }, (doc) => { doc.dpi = after; }));
  }

  /** Aplica a una imagen acoplada lo que el modo de color hace en la vista (para PNG, JPEG, WebP, GIF). */
  private modePixels(px: Uint8ClampedArray, proof = false) {
    const mode = this.doc?.mode ?? 'rgb';
    if (mode === 'gray') {
      for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
    } else if (mode === 'cmyk' || proof) proofPixels(px);
    return px;
  }

  /** Selección > Guardar selección: nuevo canal alfa. */
  saveSelection(name?: string) {
    const d = this.doc;
    if (!d || !d.selection) { this.toast('No hay selección que guardar.', 'warn'); return; }
    const before = d.alphas.slice();
    const a = { id: this.alphaCounter++, name: name ?? `Alfa ${d.alphas.length + 1}`, tiles: new Map([...d.selection.tiles].map(([k, t]) => [k, t.slice()])) };
    d.alphas = [...d.alphas, a];
    const after = d.alphas.slice();
    this.commit(new FnEntry('Guardar selección', (doc) => { doc.alphas = before; }, (doc) => { doc.alphas = after; }));
  }

  /** Selección > Cargar selección (Ctrl+clic en un canal alfa). */
  loadAlpha(id: number, mode: CombineMode = 'replace', invert = false) {
    const d = this.doc;
    const a = d?.alphas.find((x) => x.id === id);
    if (!d || !a) return;
    let sel = new Selection(new Map([...a.tiles].map(([k, t]) => [k, t.slice()])));
    if (invert) sel = sel.invert(d.width, d.height);
    this.setSelection(this.combine(sel, mode), 'Cargar selección');
  }

  deleteAlpha(id: number) {
    const d = this.doc;
    if (!d || !d.alphas.some((a) => a.id === id)) return;
    const before = d.alphas.slice(), after = d.alphas.filter((a) => a.id !== id);
    d.alphas = after;
    this.commit(new FnEntry('Eliminar canal', (doc) => { doc.alphas = before; }, (doc) => { doc.alphas = after; }));
  }

  /** Miniaturas del panel Canales: composición reducida (RGBA) y canales alfa (gris). */
  channelThumbs(max = 48) {
    const d = this.doc;
    if (!d) return null;
    const k = Math.min(1, max / Math.max(d.width, d.height));
    const w = Math.max(1, Math.round(d.width * k)), h = Math.max(1, Math.round(d.height * k));
    const full = this.r.flatten(d, d.layers, this.docRect(), [255, 255, 255, 255]);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.min(d.width - 1, Math.floor(x / k)), sy = Math.min(d.height - 1, Math.floor(y / k));
      out.set(full.subarray((sy * d.width + sx) * 4, (sy * d.width + sx) * 4 + 4), (y * w + x) * 4);
    }
    // En CMYK, las tintas (0 = sin tinta); el compuesto como se verá impreso.
    const cmyk = d.mode === 'cmyk' ? toCmyk(out) : undefined;
    this.modePixels(out);
    const alphas = d.alphas.map((a) => {
      const g = new Uint8ClampedArray(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.floor(x / k), sy = Math.floor(y / k), tx = Math.floor(sx / TILE), ty = Math.floor(sy / TILE);
        const t = a.tiles.get(tileKey(tx, ty));
        g[y * w + x] = t ? t[(sy - ty * TILE) * TILE + (sx - tx * TILE)] : 0;
      }
      return { id: a.id, data: g };
    });
    return { w, h, data: out, alphas, cmyk };
  }

  /**
   * Imagen > Aplicar imagen: mezcla un origen (una capa o la imagen combinada, todos los
   * canales o uno) sobre la capa activa. Con Sumar/Restar admite escala y desplazamiento
   * (separación de frecuencias: Restar, escala 2, desplazamiento 128).
   */
  applyImage(p: { source: number | 'merged'; channel: number; invert: boolean; blend: string; opacity: number; scale?: number; offset?: number; preserve?: boolean }) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || !this.ensurePixel(L)) return;
    const R = d.selection ? intersect(d.selection.bounds()!, this.docRect()) : this.docRect();
    if (!R) return;
    let src: Uint8ClampedArray;
    if (p.source === 'merged') src = this.r.flatten(d, d.layers, R);
    else { const S = d.layer(p.source); if (!S) return; src = S.readRegion(R.x - S.x, R.y - S.y, R.w, R.h); }
    const dst = L.readRegion(R.x - L.x, R.y - L.y, R.w, R.h);
    const out = dst.slice();
    const scale = p.scale ?? 1, offset = p.offset ?? 0, op = Math.max(0, Math.min(1, p.opacity));
    for (let i = 0; i < out.length; i += 4) {
      const da = dst[i + 3];
      if (!da && (p.preserve || L.lockAlpha)) continue;
      for (let c = 0; c < 3; c++) {
        let s = p.channel === 0 ? src[i + c] : src[i + p.channel - 1];
        if (p.invert) s = 255 - s;
        const b = dst[i + c];
        const v = blend1(p.blend, b / 255, s / 255, scale, offset / 255);
        out[i + c] = Math.round(b + (v * 255 - b) * op * (src[i + 3] / 255));
      }
      if (!p.preserve && !L.lockAlpha) out[i + 3] = Math.max(da, Math.round(src[i + 3] * op));
    }
    const patch = new TilePatch('Aplicar imagen', L);
    applyRegion(L, patch, R, out, d.selection);
    this.commit(patch);
    this.invalidate(R);
  }

  /** Panel Trazados: seleccionar (null = ninguno; el trazado deja de verse). */
  setActivePath(id: number | null) {
    const d = this.doc;
    if (!d) return;
    d.activePathId = id != null && d.paths.some((p) => p.id === id) ? id : null;
    this.pushState(false);
  }

  /** Guardar el trazado de trabajo con nombre (o crear un trazado vacío). */
  savePath(id?: number, name?: string) {
    const d = this.doc;
    if (!d) return;
    const before = this.pathsSnap();
    const n = d.paths.filter((p) => !p.work).length + 1;
    const e = id != null ? d.paths.find((p) => p.id === id) : undefined;
    if (e) { e.work = false; e.name = name ?? `Trazado ${n}`; d.activePathId = e.id; }
    else { const np = { id: this.pathCounter++, name: name ?? `Trazado ${n}`, work: false, path: [] as VectorPath }; d.paths.push(np); d.activePathId = np.id; }
    this.commitPaths(e ? 'Guardar trazado' : 'Nuevo trazado', before);
  }

  renamePath(id: number, name: string) {
    const d = this.doc;
    const e = d?.paths.find((p) => p.id === id);
    if (!d || !e || !name.trim()) return;
    const before = this.pathsSnap();
    e.name = name.trim();
    e.work = false;
    this.commitPaths('Cambiar nombre de trazado', before);
  }

  deletePath(id: number) {
    const d = this.doc;
    if (!d || !d.paths.some((p) => p.id === id)) return;
    const before = this.pathsSnap();
    d.paths = d.paths.filter((p) => p.id !== id);
    if (d.activePathId === id) d.activePathId = null;
    this.commitPaths('Eliminar trazado', before);
  }

  duplicatePath(id: number) {
    const d = this.doc;
    const e = d?.paths.find((p) => p.id === id);
    if (!d || !e) return;
    const before = this.pathsSnap();
    const c = { id: this.pathCounter++, name: `${e.name} copia`, work: false, path: clonePath(e.path) };
    d.paths.splice(d.paths.indexOf(e) + 1, 0, c);
    d.activePathId = c.id;
    this.commitPaths('Duplicar trazado', before);
  }

  /** Selección > Hacer trazado de trabajo (contorno de la selección, simplificado). */
  workPathFromSelection(tolerance = 2) {
    const d = this.doc;
    const sel = d?.selection;
    if (!d || !sel) { this.toast('No hay selección.', 'warn'); return; }
    const b = intersect(sel.bounds()!, this.docRect());
    if (!b) return;
    const m = sel.region(b);
    const path = traceMask(m, b.w, b.h, b.x, b.y, tolerance);
    if (!path.length) return;
    this.setPathData(null, path, 'Hacer trazado de trabajo');
  }

  /** Ctrl+Intro: el trazado se convierte en selección (regla par-impar, como Photoshop). */
  selectPath(path: VectorPath, mode: CombineMode = 'replace', feather = 0) {
    const d = this.doc;
    if (!d || isEmptyPath(path)) return;
    let sel = Selection.fromPolygons(flattenPath(path), this.docRect());
    if (feather > 0) sel = sel.feather(feather, d.width, d.height);
    this.setSelection(this.combine(sel, mode), 'Hacer selección');
  }

  /** Capa de forma a partir del trazado (pluma en modo Forma). */
  shapeFromPath(path: VectorPath, fill?: RGBA | null, stroke?: RGBA | null, strokeWidth = 3) {
    const b = pathBounds(path);
    if (!b || isEmptyPath(path)) return;
    return this.createShape({ shape: 'path', path: toSvg(path), x: b.x, y: b.y, w: b.w, h: b.h, fill: fill === undefined ? this.fg : fill, stroke: stroke ?? null, strokeWidth });
  }

  /** Rellenar trazado con el color frontal en la capa activa. */
  fillPath(path: VectorPath) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || isEmptyPath(path) || !this.ensurePixel(L)) return;
    const sel = Selection.fromPolygons(flattenPath(path), this.docRect());
    const rect = sel.bounds();
    if (!rect) return;
    const px = new Uint8ClampedArray(rect.w * rect.h * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = this.fg[0]; px[i + 1] = this.fg[1]; px[i + 2] = this.fg[2]; px[i + 3] = 255; }
    const patch = new TilePatch('Rellenar trazado', L);
    applyRegion(L, patch, rect, px, sel);
    this.commit(patch);
    this.invalidate(rect);
  }

  /** Contornear trazado con el pincel actual y el color frontal. */
  strokePath(path: VectorPath) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || isEmptyPath(path) || !this.ensurePixel(L)) return;
    const st = new BrushStroke({
      layer: L, settings: { ...this.brush, pressureSize: false, pressureOpacity: false }, color: this.fg, mode: 'paint',
      clip: this.docRect(), selection: null, target: 'pixels', label: 'Contornear trazado',
    });
    for (const sp of path) {
      const ring = flattenPath([sp])[0];
      if (!ring) continue;
      const pts = sp.closed ? [...ring, ring[0]] : ring;
      for (const [x, y] of pts) st.addPoint(x, y, 1);
    }
    const dirty = st.total;
    const patch = st.finish();
    if (patch) this.commit(patch);
    this.invalidate(dirty);
  }

  /** Valor de la selección en un punto (0..255); lo usa la herramienta Parche. */
  selectionValueAt(x: number, y: number): number {
    const sel = this.doc?.selection;
    return sel ? sel.get(Math.floor(x), Math.floor(y)) : 0;
  }

  /**
   * Parche (modo Origen): la zona seleccionada se sustituye por la textura de la zona a la
   * que se arrastró, adaptando color y luz al entorno (mezcla de Poisson).
   */
  async patchSelection(dx: number, dy: number) {
    const d = this.doc;
    const L = d?.active();
    const sel = d?.selection;
    if (!d || !L || !sel || (!dx && !dy) || this.healing) return;
    if (!this.ensurePixel(L)) return;
    const sb = sel.bounds();
    const R = sb && intersect({ x: sb.x - 4, y: sb.y - 4, w: sb.w + 8, h: sb.h + 8 }, this.docRect());
    if (!R) return;
    const src = L.readRegion(R.x + dx - L.x, R.y + dy - L.y, R.w, R.h);
    const dst = L.readRegion(R.x - L.x, R.y - L.y, R.w, R.h);
    const m = sel.region(R);
    const mask = new Float32Array(m.length);
    for (let i = 0; i < m.length; i++) mask[i] = m[i] / 255;
    this.healing = true;
    this.post({ type: 'busy', label: 'Parche…' });
    try {
      const out = await this.pool.run({ op: 'heal', src, dst, mask, w: R.w, h: R.h });
      const patch = new TilePatch('Parche', L);
      applyRegion(L, patch, R, out, null);
      this.commit(patch);
    } finally {
      this.healing = false;
      this.post({ type: 'busy', label: null });
      this.invalidate(R);
      const queued = this.pointerQueue.splice(0);
      for (const q of queued) this.pointer(q);
    }
  }

  /** Edición > Relleno según contenido: rellena la selección con textura del entorno. */
  async contentAwareFill() {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return;
    if (!d.selection) { this.toast('Selecciona primero la zona que quieres rellenar.', 'warn'); return; }
    if (!this.ensurePixel(L) || this.busy) return;
    const sb = d.selection.bounds();
    if (!sb) return;
    const margin = Math.max(32, Math.round(Math.max(sb.w, sb.h) * 0.75));
    const R = intersect({ x: sb.x - margin, y: sb.y - margin, w: sb.w + margin * 2, h: sb.h + margin * 2 }, this.docRect());
    if (!R) return;
    const orig = L.readRegion(R.x - L.x, R.y - L.y, R.w, R.h);
    const sel = d.selection.region(R);
    const hole = new Uint8Array(sel.length), soft = new Float32Array(sel.length);
    for (let i = 0; i < sel.length; i++) { hole[i] = sel[i] > 0 ? 1 : 0; soft[i] = sel[i] / 255; }
    this.busy = true;
    this.post({ type: 'busy', label: 'Relleno según contenido…' });
    const t0 = performance.now();
    try {
      const filled = await this.pool.run({ op: 'inpaint', src: orig.slice(), w: R.w, h: R.h, hole, seed: (Math.random() * 1e6) | 0 });
      // Bordes suaves de la selección: mezcla con el original.
      for (let i = 0; i < soft.length; i++) {
        const k = soft[i];
        if (k >= 1) continue;
        for (let c = 0; c < 4; c++) filled[i * 4 + c] = orig[i * 4 + c] + (filled[i * 4 + c] - orig[i * 4 + c]) * k;
      }
      const patch = new TilePatch('Relleno según contenido', L);
      applyRegion(L, patch, R, filled, null);
      this.commit(patch);
      this.post({ type: 'perf', label: 'Relleno según contenido', ms: performance.now() - t0 });
    } finally {
      this.busy = false;
      this.post({ type: 'busy', label: null });
      this.invalidate(R);
    }
  }

  /**
   * Pinceles correctores, al soltar:
   * - puntual: rellena la zona pintada con textura del entorno (PatchMatch) y funde los bordes;
   * - corrector: mantiene la textura clonada y adapta color y luz al destino (Poisson).
   */
  private async finishHeal(st: BrushStroke, tool: 'spotHeal' | 'heal' | 'remove') {
    const d = this.doc!;
    const L = d.layer(st.layerId);
    const t = st.total;
    if (!L || !t) { const p = st.finish(); if (p) this.commit(p); return; }
    const margin = tool === 'remove' ? Math.max(96, Math.round(this.brush.size * 4)) : tool === 'spotHeal' ? Math.max(48, Math.round(this.brush.size * 2.5)) : 4;
    const R = intersect({ x: t.x - margin, y: t.y - margin, w: t.w + margin * 2, h: t.h + margin * 2 }, this.docRect());
    if (!R) { const p = st.finish(); if (p) this.commit(p); return; }
    const cov = st.coverage(R);
    for (let i = 0; i < cov.length; i++) cov[i] = Math.min(1, cov[i]);
    const orig = st.original(R);
    const off = this.cloneOffset;
    const srcPx = tool === 'heal' && off ? st.original({ x: R.x + off.dx, y: R.y + off.dy, w: R.w, h: R.h }) : null;
    const patch = st.finish();
    if (!patch) return;
    this.healing = true;
    this.post({ type: 'busy', label: tool === 'remove' ? 'Quitando…' : tool === 'spotHeal' ? 'Corrigiendo…' : 'Fundiendo…' });
    const t0 = performance.now();
    try {
      let out: Uint8ClampedArray;
      if (tool === 'remove') {
        // Quitar: lo pintado y lo que el trazo rodea (como al dibujar un contorno alrededor del objeto),
        // ampliado un poco para no dejar el borde del objeto; transición corta.
        const hole = removeHole(cov, R.w, R.h, Math.max(2, Math.round(this.brush.size * 0.12)));
        const blend = new Float32Array(hole.length);
        for (let i = 0; i < hole.length; i++) blend[i] = hole[i];
        out = await this.pool.run({ op: 'inpaint', src: orig.slice(), w: R.w, h: R.h, hole, blend: featherMask(blend, R.w, R.h, 2), seed: (Math.random() * 1e6) | 0 });
      } else if (tool === 'spotHeal') {
        const hole = new Uint8Array(cov.length);
        for (let i = 0; i < cov.length; i++) hole[i] = cov[i] > 0.01 ? 1 : 0;
        out = await this.pool.run({ op: 'inpaint', src: orig.slice(), w: R.w, h: R.h, hole, blend: cov, seed: (Math.random() * 1e6) | 0 });
      } else {
        out = await this.pool.run({ op: 'heal', src: srcPx!, dst: orig, mask: cov, w: R.w, h: R.h });
      }
      applyRegion(L, patch, R, out, null);
      this.commit(patch);
      this.post({ type: 'perf', label: TOOL_LABEL[tool], ms: performance.now() - t0 });
    } catch (e) {
      patch.undo(d);
      this.toast(`No se pudo corregir: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      this.healing = false;
      this.post({ type: 'busy', label: null });
      this.invalidate(R);
      this.requestFrame();
      const queued = this.pointerQueue.splice(0);
      for (const q of queued) this.pointer(q);
    }
  }

  private strokePoints(m: PointerMsg) {
    const s = this.stroke!;
    for (const pt of m.points) {
      const p = this.toDoc(pt.x, pt.y);
      s.addPoint(p.x, p.y, pt.p);
    }
    const dirty = s.takeDirty();
    if (dirty) this.invalidate(dirty);
  }

  // ================================================================ exportar

  async exportImage(type: 'image/png' | 'image/jpeg' | 'image/webp', quality = 0.92): Promise<Blob> {
    const d = this.doc!;
    const bg: RGBA | undefined = type === 'image/jpeg' ? [255, 255, 255, 255] : undefined;
    const px = this.modePixels(this.r.flatten(d, d.layers, this.docRect(), bg));
    return encodeRaster(px, d.width, d.height, type, quality);
  }

  async savePsd(psb = false): Promise<Uint8Array> {
    const d = this.doc!;
    const { exportPsd } = await import('./psd');
    this.storeFrame();
    const composite = this.r.flatten(d, d.layers, this.docRect());
    const out = exportPsd(d, composite, psb);
    d.dirty = false;
    this.pushState(false);
    return out;
  }

  // ================================================================ utilidades de prueba

  stats() {
    const d = this.doc;
    return {
      renderer: this.r.info,
      layers: d?.layers.length ?? 0,
      tiles: d?.layers.reduce((a, l) => a + l.tiles.size, 0) ?? 0,
      layerMB: Math.round((d?.layers.reduce((a, l) => a + l.byteSize(), 0) ?? 0) / 1048576),
      historyMB: Math.round(this.history.entries.reduce((a, e) => a + e.bytes, 0) / 1048576),
      composeMs: Math.round(this.r.lastComposeMs * 10) / 10,
      gpuTextures: this.r.gpuTextures,
      poolSize: this.pool.size,
    };
  }

  debugPixel(x: number, y: number) {
    if (this.doc) this.r.compose(this.doc);
    return this.r.readCompositePixel(x, y);
  }

  /** Color en pantalla (tras la vista: canal, modo de color, prueba) del punto de documento (x, y). */
  debugScreenPixel(x: number, y: number) {
    if (!this.doc) return null;
    this.frame();
    const v = this.view;
    return this.r.readScreenPixel((v.panX + (x + 0.5) * v.zoom) * v.dpr, (v.panY + (y + 0.5) * v.zoom) * v.dpr);
  }

  debugLayerBounds() {
    const L = this.doc?.active();
    return L ? exactBounds(L) : null;
  }

  debugLayerPixel(x: number, y: number) {
    return this.doc?.active()?.pixel(x, y) ?? null;
  }

  debugSelection(x: number, y: number) {
    return this.doc?.selection?.get(x, y) ?? 0;
  }

  debugStroke(points: [number, number, number][]) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return 0;
    const t0 = performance.now();
    const toMask = d.editMask && !!L.mask;
    const s = new BrushStroke({ layer: L, settings: this.brush, color: this.fg, mode: 'paint', clip: this.docRect(), selection: d.selection, target: toMask ? 'mask' : 'pixels', maskValue: lumOf(this.fg) });
    for (const [x, y, p] of points) s.addPoint(x, y, p);
    const patch = s.finish();
    if (patch) this.commit(patch);
    this.invalidate(this.docRect());
    return performance.now() - t0;
  }

  debugComposeAll() {
    if (!this.doc) return 0;
    const t0 = performance.now();
    this.r.invalidate(null);
    this.r.compose(this.doc);
    this.r.readCompositePixel(0, 0);
    return performance.now() - t0;
  }

  /** Espera a que se calculen los estilos pendientes (para pruebas). */
  async debugFlushEffects() {
    await new Promise((r) => setTimeout(r, 300));
    return true;
  }
}

// ================================================================ auxiliares

export const FILTER_LABELS: Record<FilterName, string> = {
  cameraRaw: 'Revelado', lensCorrection: 'Corrección de lente', reduceNoise: 'Reducir ruido', dustScratches: 'Polvo y rascaduras', blurGallery: 'Galería de desenfoques', detailSharpen: 'Conservar detalles',
  gaussianBlur: 'Desenfoque gaussiano', boxBlur: 'Desenfoque de cuadro', motionBlur: 'Desenfoque de movimiento',
  unsharpMask: 'Máscara de enfoque', sharpen: 'Enfocar', addNoise: 'Añadir ruido', mosaic: 'Mosaico', highPass: 'Paso alto',
  findEdges: 'Hallar bordes', emboss: 'Relieve', clouds: 'Nubes', median: 'Mediana',
};

function exactBounds(L: PixelLayer): Rect | null {
  const b = L.bounds();
  if (!b) return null;
  const px = L.readRegion(b.x - L.x, b.y - L.y, b.w, b.h);
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
    if (!px[(y * b.w + x) * 4 + 3]) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: b.x + x0, y: b.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function maskThumb(L: PixelLayer, docW: number, docH: number, max = 48) {
  const s = Math.min(max / docW, max / docH);
  const w = Math.max(1, Math.round(docW * s)), h = Math.max(1, Math.round(docH * s));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = L.mask!.get(Math.floor((x + 0.5) / s) - L.x, Math.floor((y + 0.5) / s) - L.y);
    const o = (y * w + x) * 4;
    data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255;
  }
  return { w, h, data };
}

/** Máscara re-teselada tras desplazar (capas de ajuste alineadas al documento). */
function shiftMask(m: MaskChannel, dx: number, dy: number): MaskChannel {
  const out = new MaskChannel(m.fill);
  for (const [k, t] of m.tiles) {
    const ox = keyTx(k) * TILE + dx, oy = keyTy(k) * TILE + dy;
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const v = t[y * TILE + x];
      if (v === out.fill) continue;
      const X = ox + x, Y = oy + y;
      const tx = Math.floor(X / TILE), ty = Math.floor(Y / TILE);
      out.ensureTile(tileKey(tx, ty))[(Y - ty * TILE) * TILE + (X - tx * TILE)] = v;
    }
  }
  for (const k of out.tiles.keys()) out.touch(k);
  return out;
}

/**
 * Transforma la máscara de `L` con una matriz de documento (vecino más cercano).
 * `origin` es la posición de la capa original; `target` la capa destino (su x/y define las coordenadas locales).
 */
/** Máscara vectorial con el trazado desplazado / transformado (coordenadas de capa). */
function mapVM(vm: VectorMask, f: (x: number, y: number) => [number, number]): VectorMask {
  return { ...vm, rev: nextRev(), path: vm.path.map((sp) => ({ closed: sp.closed, points: sp.points.map((q) => {
    const [x, y] = f(q.x, q.y), [ix, iy] = f(q.ix, q.iy), [ox, oy] = f(q.ox, q.oy);
    return { x, y, ix, iy, ox, oy };
  }) })) };
}
const shiftVM = (vm: VectorMask, dx: number, dy: number) => mapVM(vm, (x, y) => [x + dx, y + dy]);

/** Deforma una máscara (vecino más próximo; fuera queda el valor por defecto de la máscara). */
function warpMask(src: MaskChannel, origin: { x: number; y: number }, spec: WarpSpec, docW: number, docH: number): MaskChannel {
  const out = new MaskChannel(src.fill);
  if (!src.tiles.size) return out;
  let r: Rect | null = null;
  for (const k of src.tiles.keys()) r = union(r, { x: keyTx(k) * TILE + origin.x, y: keyTy(k) * TILE + origin.y, w: TILE, h: TILE });
  // La deformación está definida sobre su rectángulo de origen: se aplica a todo el documento.
  const dst = intersect(specBounds(spec, 'src' in spec ? spec.src : r!), rasterLimit(docW, docH));
  if (!dst) return out;
  const BAND = 64;
  for (let y0 = dst.y; y0 < dst.y + dst.h; y0 += BAND) {
    const rows = Math.min(BAND, dst.y + dst.h - y0);
    const map = backMap(spec, dst.x, y0, dst.w, rows, 1);
    for (let j = 0; j < rows; j++) for (let i = 0; i < dst.w; i++) {
      const k = (j * dst.w + i) * 2, sx = map[k];
      if (sx !== sx) continue;
      const v = src.get(Math.floor(sx) - origin.x, Math.floor(map[k + 1]) - origin.y);
      if (v === out.fill) continue;
      const x = dst.x + i, y = y0 + j, tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
      out.ensureTile(tileKey(tx, ty))[(y - ty * TILE) * TILE + (x - tx * TILE)] = v;
    }
  }
  for (const k of out.tiles.keys()) out.touch(k);
  return out;
}

function transformMask(L: PixelLayer, m: Matrix, docW: number, docH: number, origin: { x: number; y: number }, target: PixelLayer, src: MaskChannel = L.mask!): MaskChannel {
  const out = new MaskChannel(src.fill);
  if (!src.tiles.size) return out;
  let r: Rect | null = null;
  for (const k of src.tiles.keys()) r = union(r, { x: keyTx(k) * TILE + origin.x, y: keyTy(k) * TILE + origin.y, w: TILE, h: TILE });
  const dst = intersect(transformRect(m, r!), rasterLimit(docW, docH));
  if (!dst) return out;
  const inv = invertM(m);
  for (let y = dst.y; y < dst.y + dst.h; y++) {
    for (let x = dst.x; x < dst.x + dst.w; x++) {
      const sx = inv[0] * (x + 0.5) + inv[2] * (y + 0.5) + inv[4], sy = inv[1] * (x + 0.5) + inv[3] * (y + 0.5) + inv[5];
      const v = src.get(Math.floor(sx) - origin.x, Math.floor(sy) - origin.y);
      if (v === out.fill) continue;
      const lx = x - target.x, ly = y - target.y;
      const tx = Math.floor(lx / TILE), ty = Math.floor(ly / TILE);
      out.ensureTile(tileKey(tx, ty))[(ly - ty * TILE) * TILE + (lx - tx * TILE)] = v;
    }
  }
  for (const k of out.tiles.keys()) out.touch(k);
  return out;
}

/** Tono/Contraste automático: estira los niveles recortando el 0,1 % de cada extremo. */
function autoLevelsLut(L: PixelLayer, perChannel: boolean): Uint8Array {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (const t of L.tiles.values()) {
    for (let i = 0; i < t.length; i += 4) {
      if (t[i + 3] < 128) continue;
      n++;
      if (perChannel) { hist[0][t[i]]++; hist[1][t[i + 1]]++; hist[2][t[i + 2]]++; }
      else { const l = Math.round(t[i] * 0.299 + t[i + 1] * 0.587 + t[i + 2] * 0.114); hist[0][l]++; }
    }
  }
  const lut = new Uint8Array(768);
  const clip = n * 0.001;
  for (let c = 0; c < 3; c++) {
    const h = perChannel ? hist[c] : hist[0];
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += h[lo]) <= clip) lo++;
    acc = 0;
    while (hi > 0 && (acc += h[hi]) <= clip) hi--;
    for (let v = 0; v < 256; v++) lut[c * 256 + v] = Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / Math.max(1, hi - lo))));
  }
  return lut;
}

/** Fusión de un canal (0..1) para Aplicar imagen / Cálculos: fórmulas de Photoshop. */
function blend1(mode: string, b: number, s: number, scale = 1, offset = 0): number {
  switch (mode) {
    case 'multiply': return b * s;
    case 'screen': return b + s - b * s;
    case 'overlay': return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'soft-light': return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b);
    case 'hard-light': return s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'linear-light': return Math.min(1, Math.max(0, b + 2 * s - 1));
    case 'darken': return Math.min(b, s);
    case 'lighten': return Math.max(b, s);
    case 'difference': return Math.abs(b - s);
    case 'exclusion': return b + s - 2 * b * s;
    case 'color-dodge': return s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 'color-burn': return s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    case 'linear-burn': return Math.max(0, b + s - 1);
    case 'add': case 'linear-dodge': return Math.min(1, Math.max(0, (b + s) / scale + offset));
    case 'subtract': return Math.min(1, Math.max(0, (b - s) / scale + offset));
    case 'divide': return s <= 0 ? (b > 0 ? 1 : 0) : Math.min(1, b / s);
    default: return s; // normal
  }
}

/** Zona a quitar: lo pintado + lo encerrado por el trazo, dilatado `grow` px. */
function removeHole(cov: Float32Array, w: number, h: number, grow: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = cov[i] > 0.02 ? 1 : 0;
  // Relleno desde el borde: lo que no se alcanza sin cruzar el trazo está encerrado.
  const seen = new Uint8Array(w * h), stack: number[] = [];
  const push = (i: number) => { if (!seen[i] && !m[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!, x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  for (let i = 0; i < m.length; i++) if (!seen[i]) m[i] = 1;
  // Dilatación (cuadrada, por pasadas separables).
  let cur = m;
  for (let k = 0; k < grow; k++) {
    const nx = cur.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (cur[i]) continue;
      if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])) nx[i] = 1;
    }
    cur = nx;
  }
  return cur;
}

/** Suaviza una máscara 0..1 (caja de radio r, dos pasadas). */
function featherMask(m: Float32Array, w: number, h: number, r: number): Float32Array {
  const a = m.slice(), b = new Float32Array(m.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += a[y * w + xx]; n++; } }
      b[y * w + x] = s / n;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += b[yy * w + x]; n++; } }
      a[y * w + x] = s / n;
    }
  }
  // Dentro de la zona siempre 1 (sólo se suaviza hacia fuera).
  for (let i = 0; i < a.length; i++) if (m[i] >= 1) a[i] = 1;
  return a;
}

export type ExportType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/tiff' | 'application/pdf' | 'image/svg+xml';
export interface ExportOptions { color?: ColorOut; alpha?: boolean; colors?: number; dither?: boolean }
const EXT: Record<ExportType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/tiff': 'tif', 'application/pdf': 'pdf', 'image/svg+xml': 'svg' };

function hasTransparency(px: Uint8ClampedArray) {
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
  return false;
}

async function blobToDataUrl(b: Blob): Promise<string> {
  const u = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return `data:${b.type};base64,${btoa(bin)}`;
}
