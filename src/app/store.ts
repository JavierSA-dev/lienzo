import { create } from 'zustand';
import { engine } from '../engine/client';
import type { BrushSettings, DocState, Matrix, Rect, RGBA, ShapeKind, ToolId, ViewState, AdjustmentType } from '../engine/types';
import type { FilterName } from '../engine/filters';
import type { GradientType } from '../engine/ops';

export type DialogId =
  | { kind: 'new' } | { kind: 'imageSize' } | { kind: 'canvasSize' } | { kind: 'export' }
  | { kind: 'adjust'; type: AdjustmentType } | { kind: 'filter'; name: FilterName }
  | { kind: 'feather' } | { kind: 'grow'; dir: 1 | -1 } | { kind: 'fill' } | { kind: 'layerStyle' }
  | { kind: 'shortcuts' } | { kind: 'liquify' } | { kind: 'generative' } | { kind: 'about' }
  | null;

export interface Toast { id: number; text: string; kind: 'info' | 'warn' | 'error' }

interface Thumb { w: number; h: number; data: Uint8ClampedArray }

export interface ToolOptions {
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
  history: [], historyIndex: 0, selection: null, editMask: false, dirty: false,
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
  wandTolerance: 32, contiguous: true, sampleAll: false, antiAlias: true, feather: 0,
  gradientType: 'linear', gradientReverse: false, gradientTransparent: false,
  shapeKind: 'rect', shapeFill: true, shapeStroke: false, strokeWidth: 3, cornerRadius: 0, sides: 6,
  font: 'Arial', fontSize: 48, bold: false, italic: false, align: 'left', autoSelect: false,
};

let toastId = 1;

export const useStore = create<Store>((set, get) => ({
  ready: false,
  renderer: '',
  doc: EMPTY_DOC,
  view: { zoom: 1, panX: 0, panY: 0, dpr: 1 },
  tool: 'brush',
  groupTool: {},
  tempTool: null,
  brush: loadPrefs('brush', { size: 30, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.1, pressureSize: true, pressureOpacity: false }),
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

  setTool(t) {
    set({ tool: t, tempTool: null });
    engine.call('setTool', t);
  },
  pushTempTool(t, key) {
    const s = get();
    if (s.tempTool || s.tool === t) return;
    set({ tempTool: { tool: t, prev: s.tool, key }, tool: t });
    engine.call('setTool', t);
  },
  popTempTool(key) {
    const s = get();
    if (!s.tempTool || s.tempTool.key !== key) return;
    const back = s.tempTool.prev;
    set({ tool: back, tempTool: null });
    engine.call('setTool', back);
  },
  setBrush(b) {
    const brush = { ...get().brush, ...b };
    brush.size = Math.max(1, Math.min(5000, Math.round(brush.size)));
    brush.hardness = Math.max(0, Math.min(1, brush.hardness));
    brush.opacity = Math.max(0.01, Math.min(1, brush.opacity));
    brush.flow = Math.max(0.01, Math.min(1, brush.flow));
    set({ brush });
    savePrefs('brush', brush);
    engine.call('setBrush', brush);
  },
  setOpts(o) {
    const opts = { ...get().opts, ...o };
    set({ opts });
    savePrefs('opts', opts);
    if (o.autoSelect !== undefined) engine.call('setAutoSelect', o.autoSelect);
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
engine.on((m) => {
  const s = useStore.getState();
  switch (m.type) {
    case 'ready': {
      useStore.setState({ ready: true, renderer: m.renderer });
      // Sincroniza las preferencias recordadas con el motor.
      engine.call('setBrush', s.brush);
      engine.call('setAutoSelect', s.opts.autoSelect);
      break;
    }
    case 'state':
      useStore.setState({ doc: m.state });
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
