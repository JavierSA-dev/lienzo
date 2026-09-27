import { create } from 'zustand';
import { engine } from '../engine/client';
import type { BrushSettings, DocState, RGBA, ToolId, ViewState } from '../engine/types';

export type DialogId = 'new' | 'imageSize' | 'export' | 'brightness' | 'about' | null;

export interface Toast { id: number; text: string; kind: 'info' | 'warn' | 'error' }

interface Thumb { w: number; h: number; data: Uint8ClampedArray }

interface Store {
  ready: boolean;
  renderer: string;
  doc: DocState;
  view: ViewState;
  tool: ToolId;
  prevTool: ToolId | null;
  brush: BrushSettings;
  fg: string;
  bg: string;
  thumbs: Record<number, Thumb>;
  toasts: Toast[];
  busy: { label: string; progress?: number } | null;
  perf: { label: string; ms: number } | null;
  cursor: { x: number; y: number } | null;
  panelsHidden: boolean;
  dialog: DialogId;

  setTool(t: ToolId): void;
  holdTool(t: ToolId | null): void;
  setBrush(b: Partial<BrushSettings>): void;
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
  history: [], historyIndex: 0, selection: null, dirty: false,
};

let toastId = 1;

export const useStore = create<Store>((set, get) => ({
  ready: false,
  renderer: '',
  doc: EMPTY_DOC,
  view: { zoom: 1, panX: 0, panY: 0, dpr: 1 },
  tool: 'brush',
  prevTool: null,
  brush: { size: 30, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.1, pressureSize: true, pressureOpacity: false },
  fg: '#000000',
  bg: '#ffffff',
  thumbs: {},
  toasts: [],
  busy: null,
  perf: null,
  cursor: null,
  panelsHidden: false,
  dialog: null,

  setTool(t) {
    set({ tool: t, prevTool: null });
    engine.call('setTool', t);
  },
  holdTool(t) {
    const s = get();
    if (t && !s.prevTool) {
      set({ prevTool: s.tool, tool: t });
      engine.call('setTool', t);
    } else if (!t && s.prevTool) {
      const back = s.prevTool;
      set({ tool: back, prevTool: null });
      engine.call('setTool', back);
    }
  },
  setBrush(b) {
    const brush = { ...get().brush, ...b };
    brush.size = Math.max(1, Math.min(5000, Math.round(brush.size)));
    brush.hardness = Math.max(0, Math.min(1, brush.hardness));
    brush.opacity = Math.max(0.01, Math.min(1, brush.opacity));
    brush.flow = Math.max(0.01, Math.min(1, brush.flow));
    set({ brush });
    engine.call('setBrush', brush);
  },
  setColors(fg, bg) {
    set({ fg, bg });
    engine.call('setColors', toRgba(fg), toRgba(bg));
  },
  toast(text, kind = 'info') {
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
    case 'ready':
      useStore.setState({ ready: true, renderer: m.renderer });
      break;
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
  }
});

// Acceso para pruebas automáticas.
(globalThis as unknown as { __lienzoStore: typeof useStore }).__lienzoStore = useStore;
