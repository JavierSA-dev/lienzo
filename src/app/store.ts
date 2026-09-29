import type { VectorPath } from '../engine/path';
import { create } from 'zustand';
import { engine } from '../engine/client';
import type { BrushSettings, DocState, Matrix, Rect, RGBA, ShapeKind, ToolId, ViewState, AdjustmentType } from '../engine/types';
import type { FilterName } from '../engine/filters';
import type { GradientType } from '../engine/ops';

export type DialogId =
  | { kind: 'new' } | { kind: 'imageSize' } | { kind: 'canvasSize' } | { kind: 'export' }
  | { kind: 'adjust'; type: AdjustmentType } | { kind: 'filter'; name: FilterName }
  | { kind: 'feather' } | { kind: 'grow'; dir: 1 | -1 } | { kind: 'fill' } | { kind: 'layerStyle' }
  | { kind: 'shortcuts' } | { kind: 'liquify' } | { kind: 'generative' } | { kind: 'about' } | { kind: 'confirmClose'; docId: number } | { kind: 'newGuide' } | { kind: 'colorPicker'; which: 'fg' | 'bg' } | { kind: 'applyImage' } | { kind: 'stroke' } | { kind: 'newLayer' }
  | null;

export type MobileSheet = 'menu' | 'layers' | 'adjust' | 'props' | 'history' | 'color' | 'export' | 'tools' | 'select';

export interface Toast { id: number; text: string; kind: 'info' | 'warn' | 'error' }

interface Thumb { w: number; h: number; data: Uint8ClampedArray }

export interface ToolOptions {
  /** Vista: reglas (Ctrl+R), guías (Ctrl+;), ajuste magnético (Ctrl+Mayús+;), bloquear guías (Ctrl+Alt+;). */
  rulers: boolean;
  guides: boolean;
  snap: boolean;
  lockGuides: boolean;
  wandTolerance: number;
  contiguous: boolean;
  sampleAll: boolean;
  antiAlias: boolean;
  feather: number;
  gradientType: GradientType;
  gradientReverse: boolean;
  gradientTransparent: boolean;
  shapeKind: ShapeKind;
  shapeFill: boolean;
  shapeStroke: boolean;
  strokeWidth: number;
  cornerRadius: number;
  sides: number;
  font: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  autoSelect: boolean;
  /** Pupilas rojas: tamaño de pupila y cantidad de oscurecimiento (%). */
  pupilSize: number;
  darkenAmount: number;
}

/** Estado de la transformación libre (Ctrl+T) mientras está activa. */
export interface TransformState { bounds: Rect; matrix: Matrix }

/** Edición de texto en curso (cuadro sobre el lienzo). */
export interface TextEdit { layerId: number | null; x: number; y: number; text: string }

interface Store {
  ready: boolean;
  renderer: string;
  doc: DocState;
  view: ViewState;
  tool: ToolId;
  /** Última herramienta usada de cada grupo (para que la letra la recupere, como en Photoshop). */
  groupTool: Record<string, ToolId>;
  tempTool: { tool: ToolId; prev: ToolId; key: string } | null;
  brush: BrushSettings;
  /** Ajustes de cada herramienta de pintura (como Photoshop: cada una recuerda los suyos). */
  brushes: Record<string, BrushSettings>;
  /** Herramienta de pintura a la que pertenece `brush`. */
  brushTool: ToolId;
  opts: ToolOptions;
  fg: string;
  bg: string;
  thumbs: Record<number, Thumb>;
  toasts: Toast[];
  busy: { label: string; progress?: number } | null;
  perf: { label: string; ms: number } | null;
  cursor: { x: number; y: number } | null;
  panelsHidden: boolean;
  dialog: DialogId;
  selectionPath: string;
  transform: TransformState | null;
  textEdit: TextEdit | null;
  crop: Rect | null;
  recording: boolean;
  actions: { name: string; steps: { id: string; args?: unknown[] }[] }[];
  fullscreen: boolean;
  /** Colores recientes (selector de color) y muestras del usuario. */
  recentColors: string[];
  swatches: string[];
  /** Trazado de trabajo de la pluma (coordenadas de documento). */
  path: VectorPath;
  /** Subtrazado que se está dibujando con la pluma (null = ninguno). */
  penDrawing: number | null;
  /** Punto de ancla seleccionado (muestra sus manejadores). */
  pathSel: { sub: number; idx: number } | null;
  /** true mientras se arrastra con la pluma (el trazado local manda). */
  penLocal: boolean;
  /** Interfaz: automática según la pantalla, o forzada a móvil/escritorio. */
  layout: 'auto' | 'mobile' | 'desktop';
  /** Hoja inferior abierta en la interfaz móvil. */
  sheet: MobileSheet | null;

  setTool(t: ToolId): void;
  pushTempTool(t: ToolId, key: string): void;
  popTempTool(key: string): void;
  setBrush(b: Partial<BrushSettings>): void;
  setOpts(o: Partial<ToolOptions>): void;
  setColors(fg: string, bg: string): void;
  toast(text: string, kind?: Toast['kind']): void;
  setDialog(d: DialogId): void;
}

export const toHex = (c: RGBA) => '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
export const toRgba = (hex: string): RGBA => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
};

const EMPTY_DOC: DocState = {
  open: false, name: '', width: 0, height: 0, layers: [], activeLayerId: 0,
  history: [], historyIndex: 0, selection: null, editMask: false, dirty: false, selectedLayerIds: [], paths: [], activePathId: null, docs: [], activeDocId: 0, guides: [], quickMask: false, alphas: [], viewChannel: 0, snapshots: [], historySource: null,
};

/** Preferencias que se recuerdan entre sesiones (sólo en este navegador). */
function loadPrefs<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`lienzo:${key}`);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}
export function savePrefs(key: string, value: unknown) {
  try { localStorage.setItem(`lienzo:${key}`, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
}

const DEFAULT_OPTS: ToolOptions = {
  rulers: false, guides: true, snap: true, lockGuides: false,
  wandTolerance: 32, contiguous: true, sampleAll: false, antiAlias: true, feather: 0,
  gradientType: 'linear', gradientReverse: false, gradientTransparent: false,
  shapeKind: 'rect', shapeFill: true, shapeStroke: false, strokeWidth: 3, cornerRadius: 0, sides: 6,
  font: 'Arial', fontSize: 48, bold: false, italic: false, align: 'left', autoSelect: false,
  pupilSize: 50, darkenAmount: 50,
};

let toastId = 1;

const DEFAULT_SWATCHES = [
  '#000000', '#404040', '#808080', '#bfbfbf', '#ffffff', '#ff0000', '#ff8000', '#ffff00', '#80ff00', '#00ff00', '#00ffff', '#0080ff',
  '#0000ff', '#8000ff', '#ff00ff', '#ff0080', '#7f1d1d', '#7c2d12', '#713f12', '#14532d', '#134e4a', '#1e3a8a', '#4c1d95', '#831843',
];

function loadList(key: string, fallback: string[]): string[] {
  try { const v = localStorage.getItem(`lienzo:${key}`); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

const BASE_BRUSH: BrushSettings = { size: 30, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.1, pressureSize: true, pressureOpacity: false };
/** Valores iniciales de Photoshop: exposición e intensidad al 50 %, correctores duros. */
const TOOL_DEFAULTS: Partial<Record<ToolId, Partial<BrushSettings>>> = {
  dodge: { opacity: 0.5, hardness: 0 }, burn: { opacity: 0.5, hardness: 0 },
  blur: { opacity: 0.5, hardness: 0 }, sharpen: { opacity: 0.5, hardness: 0 }, smudge: { opacity: 0.5, hardness: 0 },
  spotHeal: { hardness: 1, size: 20 }, heal: { hardness: 1, size: 20 }, pencil: { hardness: 1, size: 1, pressureSize: false },
  eraser: { hardness: 1 },
};
const BRUSH_TOOLS = new Set<ToolId>(['brush', 'pencil', 'eraser', 'clone', 'dodge', 'burn', 'spotHeal', 'heal', 'blur', 'sharpen', 'smudge', 'historyBrush']);

function brushDefaults(t: ToolId, saved: Record<string, BrushSettings>): BrushSettings {
  return saved[t] ?? { ...BASE_BRUSH, ...TOOL_DEFAULTS[t] };
}

/** Al cambiar a otra herramienta de pintura se cargan sus propios ajustes. */
function brushSwap(s: { brushTool: ToolId; brushes: Record<string, BrushSettings> }, t: ToolId) {
  if (!BRUSH_TOOLS.has(t) || t === s.brushTool) return {};
  const brush = brushDefaults(t, s.brushes);
  engine.call('setBrush', brush);
  return { brush, brushTool: t };
}

export const useStore = create<Store>((set, get) => ({
  ready: false,
  renderer: '',
  doc: EMPTY_DOC,
  view: { zoom: 1, panX: 0, panY: 0, dpr: 1 },
  tool: 'brush',
  groupTool: {},
  tempTool: null,
  brush: brushDefaults('brush', loadPrefs('brushes', {} as Record<string, BrushSettings>)),
  brushes: loadPrefs('brushes', {} as Record<string, BrushSettings>),
  brushTool: 'brush',
  opts: loadPrefs('opts', DEFAULT_OPTS),
  fg: '#000000',
  bg: '#ffffff',
  thumbs: {},
  toasts: [],
  busy: null,
  perf: null,
  cursor: null,
  panelsHidden: false,
  dialog: null,
  selectionPath: '',
  transform: null,
  textEdit: null,
  crop: null,
  recording: false,
  actions: loadPrefs('actions', { list: [] as Store['actions'] }).list,
  fullscreen: false,
  path: [],
  recentColors: loadList('recent', []),
  swatches: loadList('swatches', DEFAULT_SWATCHES),
  penDrawing: null,
  pathSel: null,
  penLocal: false,
  layout: loadPrefs('layout', 'auto' as 'auto' | 'mobile' | 'desktop'),
  sheet: null,

  setTool(t) {
    set({ tool: t, tempTool: null, ...brushSwap(get(), t) });
    engine.call('setTool', t);
  },
  pushTempTool(t, key) {
    const s = get();
    if (s.tempTool || s.tool === t) return;
    set({ tempTool: { tool: t, prev: s.tool, key }, tool: t, ...brushSwap(s, t) });
    engine.call('setTool', t);
  },
  popTempTool(key) {
    const s = get();
    if (!s.tempTool || s.tempTool.key !== key) return;
    const back = s.tempTool.prev;
    set({ tool: back, tempTool: null, ...brushSwap(s, back) });
    engine.call('setTool', back);
  },
  setBrush(b) {
    const brush = { ...get().brush, ...b };
    brush.size = Math.max(1, Math.min(5000, Math.round(brush.size)));
    brush.hardness = Math.max(0, Math.min(1, brush.hardness));
    brush.opacity = Math.max(0.01, Math.min(1, brush.opacity));
    brush.flow = Math.max(0.01, Math.min(1, brush.flow));
    const key = get().brushTool;
    const brushes = { ...get().brushes, [key]: brush };
    set({ brush, brushes });
    savePrefs('brushes', brushes);
    engine.call('setBrush', brush);
  },
  setOpts(o) {
    const opts = { ...get().opts, ...o };
    set({ opts });
    savePrefs('opts', opts);
    if (o.autoSelect !== undefined) engine.call('setAutoSelect', o.autoSelect);
    if (o.snap !== undefined) engine.call('setSnap', o.snap);
  },
  setColors(fg, bg) {
    set({ fg, bg });
    engine.call('setColors', toRgba(fg), toRgba(bg));
  },
  toast(text, kind = 'info') {
    if (get().toasts.some((t) => t.text === text)) return; // sin avisos repetidos
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 4500);
  },
  setDialog(d) {
    set({ dialog: d });
  },
}));

// Mensajes del motor -> estado de la interfaz.
/** Ediciones de trazado enviadas al motor y aún sin confirmar. */
let pathEdits = 0;

/** El trazado visible es el trazado activo del documento (panel Trazados). */
export function syncPathFromDoc() {
  const { doc, penDrawing, pathSel } = useStore.getState();
  const ap = doc.paths.find((p) => p.id === doc.activePathId);
  const path = ap?.path ?? [];
  useStore.setState({
    path,
    penDrawing: penDrawing != null && path[penDrawing] && !path[penDrawing].closed ? penDrawing : null,
    pathSel: pathSel && path[pathSel.sub]?.points[pathSel.idx] ? pathSel : null,
  });
}

/** Guarda en el documento (y en el historial) la edición actual del trazado. */
export function commitPath(label: string) {
  const s = useStore.getState();
  useStore.setState({ penLocal: false });
  pathEdits++;
  engine.call('setPathData', s.doc.activePathId, s.path, label).finally(() => {
    if (--pathEdits === 0) syncPathFromDoc();
  });
}

engine.on((m) => {
  const s = useStore.getState();
  switch (m.type) {
    case 'ready': {
      useStore.setState({ ready: true, renderer: m.renderer });
      // Sincroniza las preferencias recordadas con el motor.
      engine.call('setBrush', s.brush);
      engine.call('setAutoSelect', s.opts.autoSelect);
      engine.call('setSnap', s.opts.snap);
      break;
    }
    case 'state':
      useStore.setState({ doc: m.state });
      if (!pathEdits && !useStore.getState().penLocal) syncPathFromDoc();
      break;
    case 'view':
      useStore.setState({ view: m.view });
      break;
    case 'thumbs': {
      const thumbs: Record<number, Thumb> = {};
      for (const t of m.thumbs) thumbs[t.id] = t;
      useStore.setState({ thumbs });
      break;
    }
    case 'color':
      if (m.which === 'fg') s.setColors(toHex(m.rgba), s.bg);
      else s.setColors(s.fg, toHex(m.rgba));
      break;
    case 'perf':
      useStore.setState({ perf: { label: m.label, ms: m.ms } });
      break;
    case 'toast':
      s.toast(m.text, m.kind);
      break;
    case 'busy':
      useStore.setState({ busy: m.label ? { label: m.label, progress: m.progress } : null });
      break;
    case 'selection':
      useStore.setState({ selectionPath: m.path });
      break;
  }
});

// Acceso para pruebas automáticas.
(globalThis as unknown as { __lienzoStore: typeof useStore }).__lienzoStore = useStore;
