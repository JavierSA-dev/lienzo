import {
  TILE, type BrushSettings, type DocState, type FromWorker, type PointerMsg, type Rect, type RGBA,
  type ToolId, type ViewState, type BlendMode,
} from './types';
import { EditorDocument, PixelLayer, tileKey } from './document';
import { History, TilePatch, FnEntry, type HistoryEntry } from './history';
import { BrushStroke } from './brush';
import { Renderer } from './renderer';
import { Pool } from './pool';
import { importRaster, encodeRaster } from './io';
import {
  resampleLayer, applyLut, invertLut, brightnessContrastLut, desaturate, layerThumb, layerFromPixels, pruneEmpty,
} from './ops';

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

/** Motor del editor: vive entero en el worker; la interfaz sólo envía comandos. */
export class Engine {
  private post: Post;
  private r: Renderer;
  doc: EditorDocument | null = null;
  private history = new History();
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
  private layerCounter = 1;
  private pool = new Pool();

  // Estado de gestos en curso.
  private stroke: BrushStroke | null = null;
  private drag: { kind: 'pan' | 'move' | 'marquee'; x0: number; y0: number; panX: number; panY: number; lx: number; ly: number; sel: Rect | null; layer?: PixelLayer; bounds?: Rect | null } | null = null;
  private pendingProps = new Map<number, { opacity: number; blend: BlendMode; name: string; visible: boolean }>();

  constructor(canvas: OffscreenCanvas, width: number, height: number, dpr: number, post: Post) {
    this.post = post;
    this.r = new Renderer(canvas);
    this.resize(width, height, dpr);
    post({ type: 'ready', renderer: this.r.info, maxTexture: this.r.maxTexture });
  }

  // ---------------------------------------------------------------- vista

  resize(w: number, h: number, dpr: number) {
    this.cw = w; this.ch = h;
    const firstFit = this.view.dpr !== dpr;
    this.view.dpr = dpr;
    this.r.resize(w * dpr, h * dpr);
    if (firstFit && this.doc) this.fit(false);
    this.requestFrame(true);
  }

  private setView(zoom: number, panX: number, panY: number) {
    this.view.zoom = Math.min(64, Math.max(0.005, zoom));
    this.view.panX = panX;
    this.view.panY = panY;
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

  fit(capAt100: boolean) {
    const d = this.doc;
    if (!d) return;
    const m = 24;
    let z = Math.min((this.cw - m * 2) / d.width, (this.ch - m * 2) / d.height);
    if (capAt100) z = Math.min(1, z);
    z = Math.max(0.005, z);
    this.setView(z, Math.round((this.cw - d.width * z) / 2), Math.round((this.ch - d.height * z) / 2));
  }

  zoomIn() { this.stepZoom(1); }
  zoomTo(z: number) { this.zoomAt(z, this.cw / 2, this.ch / 2); }
  zoomOut() { this.stepZoom(-1); }

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
    if (zoom) this.zoomAt(this.view.zoom * Math.exp(-dy * 0.0025), x, y);
    else this.setView(this.view.zoom, this.view.panX - dx, this.view.panY - dy);
  }

  // ---------------------------------------------------------------- render

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

  // ---------------------------------------------------------------- estado

  private snapshot(): DocState {
    const d = this.doc;
    if (!d) {
      return { open: false, name: '', width: 0, height: 0, layers: [], activeLayerId: 0, history: [], historyIndex: 0, selection: null, dirty: false };
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
      selection: d.selection,
      dirty: d.dirty,
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
    if (thumbs) this.scheduleThumbs();
  }

  private scheduleThumbs() {
    if (this.thumbTimer) clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(() => {
      this.thumbTimer = null;
      const d = this.doc;
      if (!d) return;
      const thumbs = d.layers.map((l) => ({ id: l.id, ...layerThumb(l, d.width, d.height) }));
      this.post({ type: 'thumbs', thumbs }, thumbs.map((t) => t.data.buffer));
    }, 150);
  }

  private commit(e: HistoryEntry) {
    this.history.push(e);
    if (this.doc) this.doc.dirty = true;
    this.pushState();
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

  // ---------------------------------------------------------------- documentos

  private setDoc(doc: EditorDocument, label: string) {
    this.r.reset();
    this.doc = doc;
    this.history.clear();
    this.baseLabel = label;
    this.layerCounter = doc.layers.length + 1;
    this.fit(true);
    this.invalidate(null);
    this.pushState();
  }

  newDoc(width: number, height: number, background: 'white' | 'black' | 'transparent' | 'bg', name = 'Sin título-1') {
    const w = Math.max(1, Math.min(30000, Math.round(width)));
    const h = Math.max(1, Math.min(30000, Math.round(height)));
    const doc = new EditorDocument(name, w, h);
    const L = new PixelLayer(background === 'transparent' ? 'Capa 1' : 'Fondo');
    const color: RGBA | null = background === 'white' ? [255, 255, 255, 255] : background === 'black' ? [0, 0, 0, 255] : background === 'bg' ? this.bg : null;
    if (color) EditorDocument.fillLayer(L, { x: 0, y: 0, w, h }, color);
    doc.layers.push(L);
    doc.activeLayerId = L.id;
    this.setDoc(doc, 'Nuevo');
    return { width: w, height: h };
  }

  async open(name: string, buffer: ArrayBuffer, mime: string) {
    this.post({ type: 'busy', label: `Abriendo ${name}…` });
    try {
      const t0 = performance.now();
      const isPsd = /\.(psd|psb)$/i.test(name) || mime === 'image/vnd.adobe.photoshop';
      // El lector de PSD se carga sólo cuando hace falta (arranque más ligero).
      const res = isPsd ? (await import('./psd')).importPsd(name, buffer) : await importRaster(name, buffer, mime);
      this.setDoc(res.doc, 'Abrir');
      const ms = performance.now() - t0;
      this.post({ type: 'perf', label: 'Abrir', ms });
      if (res.warnings.length) {
        this.post({ type: 'toast', kind: 'warn', text: `Abierto. Aún no se editan: ${res.warnings.join(', ')}.` });
      }
      return { layers: res.doc.layers.length, ms, warnings: res.warnings };
    } finally {
      this.post({ type: 'busy', label: null });
    }
  }

  closeDoc() {
    this.r.reset();
    this.doc = null;
    this.history.clear();
    this.pushState(false);
    this.requestFrame();
  }

  // ---------------------------------------------------------------- historial

  undo() { if (this.doc && this.history.undo(this.doc)) this.afterHistory(); }
  redo() { if (this.doc && this.history.redo(this.doc)) this.afterHistory(); }
  jumpHistory(i: number) { if (this.doc) { this.history.jump(this.doc, i); this.afterHistory(); } }

  private afterHistory() {
    this.invalidate(null);
    this.pushState();
  }

  // ---------------------------------------------------------------- capas

  private insertLayer(L: PixelLayer, index: number, label: string) {
    const d = this.doc!;
    const prevActive = d.activeLayerId;
    d.layers.splice(index, 0, L);
    d.activeLayerId = L.id;
    this.commit(new FnEntry(label,
      (doc) => { doc.layers.splice(doc.indexOf(L.id), 1); doc.activeLayerId = prevActive; },
      (doc) => { doc.layers.splice(index, 0, L); doc.activeLayerId = L.id; },
      L.byteSize()));
    this.invalidate(L.bounds());
  }

  newLayer() {
    const d = this.doc;
    if (!d) return;
    const L = new PixelLayer(`Capa ${this.layerCounter++}`);
    this.insertLayer(L, d.indexOf(d.active()?.id ?? -1) + 1, 'Nueva capa');
  }

  duplicateLayer() {
    const d = this.doc;
    const A = d?.active();
    if (!d || !A) return;
    const L = A.clone(`${A.name} copia`);
    this.insertLayer(L, d.indexOf(A.id) + 1, 'Duplicar capa');
  }

  deleteLayer(id?: number) {
    const d = this.doc;
    if (!d || d.layers.length <= 1) return;
    const L = id ? d.layer(id) : d.active();
    if (!L) return;
    const idx = d.indexOf(L.id);
    const prevActive = d.activeLayerId;
    const remove = (doc: EditorDocument) => {
      doc.layers.splice(idx, 1);
      doc.activeLayerId = doc.layers[Math.max(0, idx - 1)].id;
    };
    remove(d);
    this.commit(new FnEntry('Eliminar capa',
      (doc) => { doc.layers.splice(idx, 0, L); doc.activeLayerId = prevActive; },
      remove));
    this.invalidate(L.bounds());
  }

  selectLayer(id: number) {
    if (!this.doc?.layer(id)) return;
    this.doc.activeLayerId = id;
    this.pushState(false);
  }

  /** Cambia propiedades. record=false para cambios en vivo (arrastrar un deslizador). */
  setLayer(id: number, props: Partial<{ name: string; visible: boolean; opacity: number; blend: BlendMode }>, record = true) {
    const L = this.doc?.layer(id);
    if (!L) return;
    const before = this.pendingProps.get(id) ?? { opacity: L.opacity, blend: L.blend, name: L.name, visible: L.visible };
    if (props.name !== undefined) L.name = props.name;
    if (props.visible !== undefined) L.visible = props.visible;
    if (props.opacity !== undefined) L.opacity = Math.min(1, Math.max(0, props.opacity));
    if (props.blend !== undefined) L.blend = props.blend;
    this.invalidate(L.bounds());
    if (!record) {
      this.pendingProps.set(id, before);
      this.pushState(false);
      return;
    }
    this.pendingProps.delete(id);
    const after = { opacity: L.opacity, blend: L.blend, name: L.name, visible: L.visible };
    if (JSON.stringify(before) === JSON.stringify(after)) { this.pushState(false); return; }
    const label = before.name !== after.name ? 'Cambiar nombre de capa'
      : before.blend !== after.blend ? 'Modo de fusión'
      : before.opacity !== after.opacity ? 'Opacidad de capa'
      : 'Visibilidad de capa';
    const apply = (v: typeof before) => (doc: EditorDocument) => {
      const l = doc.layer(id);
      if (l) Object.assign(l, v);
    };
    this.commit(new FnEntry(label, apply(before), apply(after)));
  }

  moveLayer(id: number, toIndex: number) {
    const d = this.doc;
    if (!d) return;
    const from = d.indexOf(id);
    const to = Math.max(0, Math.min(d.layers.length - 1, toIndex));
    if (from < 0 || from === to) return;
    const mv = (a: number, b: number) => (doc: EditorDocument) => {
      const [l] = doc.layers.splice(a, 1);
      doc.layers.splice(b, 0, l);
    };
    mv(from, to)(d);
    this.commit(new FnEntry('Ordenar capas', mv(to, from), mv(from, to)));
    this.invalidate(d.layer(id)!.bounds());
  }

  /** Reemplaza un conjunto de capas por otras (combinar, acoplar) con deshacer. */
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

  mergeDown() {
    const d = this.doc;
    const A = d?.active();
    if (!d || !A) return;
    const i = d.indexOf(A.id);
    if (i <= 0) return;
    const B = d.layers[i - 1];
    const region = union(A.bounds(), B.bounds());
    const merged = new PixelLayer(B.name);
    if (region) {
      const vis = [B, A].filter((l) => l.visible);
      const px = this.perf('Combinar', () => this.r.flatten(d, vis, region));
      merged.writeRegion(px, region.w, region.h, region.x, region.y);
    }
    this.replaceLayers('Combinar hacia abajo', [B, A], [merged], i - 1);
  }

  flattenImage() {
    const d = this.doc;
    if (!d) return;
    const px = this.perf('Acoplar', () => this.r.flatten(d, d.layers, this.docRect(), [255, 255, 255, 255]));
    const L = layerFromPixels('Fondo', px, d.width, d.height);
    this.replaceLayers('Acoplar imagen', [...d.layers], [L], 0);
  }

  // ---------------------------------------------------------------- selección y relleno

  private setSelection(sel: Rect | null, label: string) {
    const d = this.doc;
    if (!d) return;
    const before = d.selection;
    d.selection = sel;
    this.commit(new FnEntry(label, (doc) => { doc.selection = before; }, (doc) => { doc.selection = sel; }));
  }

  selectAll() { if (this.doc) this.setSelection(this.docRect(), 'Seleccionar todo'); }
  deselect() { if (this.doc?.selection) this.setSelection(null, 'Deseleccionar'); }

  /** Aplica una operación de píxeles a los tiles de un rectángulo, con deshacer. */
  private tileOp(label: string, L: PixelLayer, rect: Rect, op: () => void) {
    const patch = new TilePatch(label, L);
    const lx0 = rect.x - L.x, ly0 = rect.y - L.y;
    const tx0 = Math.floor(lx0 / TILE), ty0 = Math.floor(ly0 / TILE);
    const tx1 = Math.floor((lx0 + rect.w - 1) / TILE), ty1 = Math.floor((ly0 + rect.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) patch.capture(L, tileKey(tx, ty));
    op();
    pruneEmpty(L);
    this.commit(patch);
    this.invalidate(rect);
  }

  fill(which: 'fg' | 'bg') {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return;
    const rect = d.selection ? intersect(d.selection, this.docRect()) : this.docRect();
    if (!rect) return;
    const c = which === 'fg' ? this.fg : this.bg;
    this.perf('Rellenar', () => this.tileOp('Rellenar', L, rect, () => EditorDocument.fillLayer(L, rect, c)));
  }

  clear() {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L || !d.selection) return;
    const rect = d.selection;
    this.tileOp('Borrar', L, rect, () => EditorDocument.fillLayer(L, rect, [0, 0, 0, 0]));
  }

  // ---------------------------------------------------------------- imagen

  async resizeImage(width: number, height: number) {
    const d = this.doc;
    if (!d) return;
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    if (w === d.width && h === d.height) return;
    const sx = w / d.width, sy = h / d.height;
    const t0 = performance.now();
    const oldLayers = d.layers, oldW = d.width, oldH = d.height, oldActive = d.activeLayerId, oldSel = d.selection;
    const activeIdx = d.indexOf(oldActive);
    let done = 0;
    this.post({ type: 'busy', label: 'Tamaño de imagen', progress: 0 });
    const newLayers = await Promise.all(oldLayers.map((L) => resampleLayer(L, sx, sy, this.pool).then((nl) => {
      this.post({ type: 'busy', label: 'Tamaño de imagen', progress: ++done / oldLayers.length });
      return nl;
    })));
    this.post({ type: 'busy', label: null });
    if (this.doc !== d) return; // se cerró o se abrió otro documento mientras tanto
    const newActive = newLayers[Math.max(0, activeIdx)].id;
    const set = (layers: PixelLayer[], W: number, H: number, active: number, sel: Rect | null) => (doc: EditorDocument) => {
      doc.layers = layers; doc.width = W; doc.height = H; doc.activeLayerId = active; doc.selection = sel;
    };
    set(newLayers, w, h, newActive, null)(d);
    this.commit(new FnEntry('Tamaño de imagen', set(oldLayers, oldW, oldH, oldActive, oldSel), set(newLayers, w, h, newActive, null),
      oldLayers.reduce((a, l) => a + l.byteSize(), 0)));
    this.post({ type: 'perf', label: `Tamaño de imagen (${this.pool.size} hilos)`, ms: performance.now() - t0 });
    this.fit(true);
    this.invalidate(null);
  }

  adjust(kind: 'invert' | 'desaturate' | 'brightness', a = 0, b = 0) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return;
    const labels = { invert: 'Invertir', desaturate: 'Desaturar', brightness: 'Brillo/Contraste' };
    const patch = new TilePatch(labels[kind], L);
    const cap = (k: number) => patch.capture(L, k);
    this.perf(labels[kind], () => {
      if (kind === 'desaturate') desaturate(L, cap);
      else applyLut(L, kind === 'invert' ? invertLut() : brightnessContrastLut(a, b), cap);
    });
    this.commit(patch);
    this.invalidate(L.bounds());
  }

  // ---------------------------------------------------------------- herramientas

  setTool(t: ToolId) { this.tool = t; }
  setBrush(b: Partial<BrushSettings>) { this.brush = { ...this.brush, ...b }; }
  setColors(fg: RGBA, bg: RGBA) { this.fg = fg; this.bg = bg; }

  pointer(m: PointerMsg) {
    const d = this.doc;
    if (!d || !m.points.length) return;
    const first = m.points[0];
    const last = m.points[m.points.length - 1];
    const tool: ToolId | 'pan' = m.button === 1 ? 'pan' : this.tool;

    if (m.phase === 'down') {
      const p = this.toDoc(first.x, first.y);
      switch (tool) {
        case 'pan':
        case 'hand':
          this.drag = { kind: 'pan', x0: first.x, y0: first.y, panX: this.view.panX, panY: this.view.panY, lx: 0, ly: 0, sel: null };
          return;
        case 'zoom':
          this.stepZoom(m.alt ? -1 : 1, first.x, first.y);
          return;
        case 'eyedropper': {
          const c = this.r.readCompositePixel(Math.floor(p.x), Math.floor(p.y));
          if (c[3] > 0) this.post({ type: 'color', which: m.alt ? 'bg' : 'fg', rgba: [c[0], c[1], c[2], 255] });
          return;
        }
        case 'move': {
          const L = d.active();
          if (!L) return;
          this.drag = { kind: 'move', x0: first.x, y0: first.y, panX: 0, panY: 0, lx: L.x, ly: L.y, sel: null, layer: L, bounds: L.bounds() };
          return;
        }
        case 'marquee':
          this.drag = { kind: 'marquee', x0: p.x, y0: p.y, panX: 0, panY: 0, lx: 0, ly: 0, sel: d.selection };
          return;
        case 'brush':
        case 'eraser': {
          const L = d.active();
          if (!L) return;
          if (!L.visible) {
            this.post({ type: 'toast', kind: 'warn', text: 'La capa está oculta. Hazla visible para pintar.' });
            return;
          }
          const clip = d.selection ? intersect(d.selection, this.docRect()) : this.docRect();
          if (!clip) return;
          this.stroke = new BrushStroke(L, this.brush, this.fg, tool === 'eraser', clip);
          this.strokePoints(m);
          return;
        }
      }
    }

    if (this.stroke) {
      if (m.phase !== 'up' || m.points.length) this.strokePoints(m);
      if (m.phase === 'up') {
        const patch = this.stroke.finish();
        this.stroke = null;
        if (patch) this.commit(patch);
        this.requestFrame();
      }
      return;
    }

    const g = this.drag;
    if (!g) return;
    if (g.kind === 'pan') {
      this.setView(this.view.zoom, g.panX + (last.x - g.x0), g.panY + (last.y - g.y0));
    } else if (g.kind === 'move' && g.layer) {
      const L = g.layer;
      let dx = Math.round((last.x - g.x0) / this.view.zoom), dy = Math.round((last.y - g.y0) / this.view.zoom);
      if (m.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const before = L.bounds();
      L.x = g.lx + dx; L.y = g.ly + dy;
      this.invalidate(union(before, L.bounds()));
      if (m.phase === 'up') {
        const from = { x: g.lx, y: g.ly }, to = { x: L.x, y: L.y };
        if (from.x !== to.x || from.y !== to.y) {
          const set = (v: { x: number; y: number }) => (doc: EditorDocument) => { const l = doc.layer(L.id); if (l) { l.x = v.x; l.y = v.y; } };
          this.commit(new FnEntry('Mover', set(from), set(to)));
        }
      }
    } else if (g.kind === 'marquee') {
      const p = this.toDoc(last.x, last.y);
      let w = p.x - g.x0, h = p.y - g.y0;
      if (m.shift) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
      let x0 = g.x0, y0 = g.y0;
      if (m.alt) { x0 -= w; y0 -= h; w *= 2; h *= 2; }
      const raw = {
        x: Math.round(Math.min(x0, x0 + w)), y: Math.round(Math.min(y0, y0 + h)),
        w: Math.round(Math.abs(w)), h: Math.round(Math.abs(h)),
      };
      const sel = raw.w >= 1 && raw.h >= 1 ? intersect(raw, this.docRect()) : null;
      d.selection = sel;
      this.pushState(false);
      if (m.phase === 'up') {
        d.selection = g.sel;
        if (sel) this.setSelection(sel, 'Marco rectangular');
        else if (g.sel) this.setSelection(null, 'Deseleccionar');
      }
    }
    if (m.phase === 'up') this.drag = null;
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

  // ---------------------------------------------------------------- exportar

  async exportImage(type: 'image/png' | 'image/jpeg' | 'image/webp', quality = 0.92): Promise<Blob> {
    const d = this.doc!;
    const bg: RGBA | undefined = type === 'image/jpeg' ? [255, 255, 255, 255] : undefined;
    const px = this.r.flatten(d, d.layers, this.docRect(), bg);
    return encodeRaster(px, d.width, d.height, type, quality);
  }

  async savePsd(): Promise<Uint8Array> {
    const d = this.doc!;
    const { exportPsd } = await import('./psd');
    const composite = this.r.flatten(d, d.layers, this.docRect());
    const out = exportPsd(d, composite);
    d.dirty = false;
    this.pushState(false);
    return out;
  }

  // ---------------------------------------------------------------- utilidades de prueba

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
    };
  }

  debugPixel(x: number, y: number) {
    return this.r.readCompositePixel(x, y);
  }

  /** Simula un trazo (coordenadas de documento) para medir el pincel sin la interfaz. */
  debugStroke(points: [number, number, number][]) {
    const d = this.doc;
    const L = d?.active();
    if (!d || !L) return 0;
    const t0 = performance.now();
    const s = new BrushStroke(L, this.brush, this.fg, false, this.docRect());
    for (const [x, y, p] of points) s.addPoint(x, y, p);
    const patch = s.finish();
    if (patch) this.commit(patch);
    this.invalidate(this.docRect());
    return performance.now() - t0;
  }

  /** Fuerza una composición completa y devuelve lo que tardó (ms). */
  debugComposeAll() {
    if (!this.doc) return 0;
    const t0 = performance.now();
    this.r.invalidate(null);
    this.r.compose(this.doc);
    this.r.readCompositePixel(0, 0); // fuerza a esperar a la GPU
    return performance.now() - t0;
  }
}
