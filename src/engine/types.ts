// Tipos compartidos entre la interfaz (hilo principal) y el motor (worker).

export const TILE = 256;

export type BlendMode =
  | 'normal' | 'dissolve'
  | 'darken' | 'multiply' | 'color-burn' | 'linear-burn' | 'darker-color'
  | 'lighten' | 'screen' | 'color-dodge' | 'linear-dodge' | 'lighter-color'
  | 'overlay' | 'soft-light' | 'hard-light' | 'vivid-light' | 'linear-light' | 'pin-light' | 'hard-mix'
  | 'difference' | 'exclusion' | 'subtract' | 'divide'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

/** Los 27 modos de fusión en el orden y grupos del menú de Photoshop. */
export const BLEND_GROUPS: { id: BlendMode; label: string }[][] = [
  [{ id: 'normal', label: 'Normal' }, { id: 'dissolve', label: 'Disolver' }],
  [
    { id: 'darken', label: 'Oscurecer' }, { id: 'multiply', label: 'Multiplicar' },
    { id: 'color-burn', label: 'Subexposición de color' }, { id: 'linear-burn', label: 'Subexposición lineal' },
    { id: 'darker-color', label: 'Color más oscuro' },
  ],
  [
    { id: 'lighten', label: 'Aclarar' }, { id: 'screen', label: 'Trama' },
    { id: 'color-dodge', label: 'Sobreexposición de color' }, { id: 'linear-dodge', label: 'Sobreexposición lineal (añadir)' },
    { id: 'lighter-color', label: 'Color más claro' },
  ],
  [
    { id: 'overlay', label: 'Superponer' }, { id: 'soft-light', label: 'Luz suave' },
    { id: 'hard-light', label: 'Luz fuerte' }, { id: 'vivid-light', label: 'Luz intensa' },
    { id: 'linear-light', label: 'Luz lineal' }, { id: 'pin-light', label: 'Luz focal' },
    { id: 'hard-mix', label: 'Mezcla definida' },
  ],
  [
    { id: 'difference', label: 'Diferencia' }, { id: 'exclusion', label: 'Exclusión' },
    { id: 'subtract', label: 'Restar' }, { id: 'divide', label: 'Dividir' },
  ],
  [
    { id: 'hue', label: 'Tono' }, { id: 'saturation', label: 'Saturación' },
    { id: 'color', label: 'Color' }, { id: 'luminosity', label: 'Luminosidad' },
  ],
];

export const BLEND_MODES: BlendMode[] = BLEND_GROUPS.flat().map((b) => b.id);

export type ToolId =
  | 'move' | 'marquee' | 'brush' | 'eraser' | 'eyedropper' | 'hand' | 'zoom';

export interface BrushSettings {
  size: number;      // px
  hardness: number;  // 0..1
  opacity: number;   // 0..1
  flow: number;      // 0..1
  spacing: number;   // fracción del diámetro
  pressureSize: boolean;
  pressureOpacity: boolean;
}

export type RGBA = [number, number, number, number]; // 0..255

export interface Rect { x: number; y: number; w: number; h: number }

export interface LayerInfo {
  id: number;
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  blend: BlendMode;
  x: number;
  y: number;
}

export interface HistoryInfo { label: string }

export interface DocState {
  open: boolean;
  name: string;
  width: number;
  height: number;
  layers: LayerInfo[];       // de abajo a arriba
  activeLayerId: number;
  history: HistoryInfo[];    // [0] = estado inicial
  historyIndex: number;
  selection: Rect | null;
  dirty: boolean;
}

export interface ViewState { zoom: number; panX: number; panY: number; dpr: number }

export interface PointerSample { x: number; y: number; p: number; t: number } // px CSS relativos al lienzo

export type PointerPhase = 'down' | 'move' | 'up';

export interface PointerMsg {
  type: 'pointer';
  phase: PointerPhase;
  points: PointerSample[];
  button: number;
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
}

/** Mensajes del hilo principal al worker. */
export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | PointerMsg
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number; zoom: boolean }
  | { type: 'hover'; x: number; y: number }
  | { type: 'call'; id: number; method: string; args: unknown[] };

/** Mensajes del worker al hilo principal. */
export type FromWorker =
  | { type: 'ready'; renderer: string; maxTexture: number }
  | { type: 'state'; state: DocState }
  | { type: 'view'; view: ViewState }
  | { type: 'cursor'; x: number; y: number; inside: boolean }
  | { type: 'thumbs'; thumbs: { id: number; w: number; h: number; data: Uint8ClampedArray }[] }
  | { type: 'color'; which: 'fg' | 'bg'; rgba: RGBA }
  | { type: 'perf'; label: string; ms: number }
  | { type: 'toast'; text: string; kind: 'info' | 'warn' | 'error' }
  | { type: 'busy'; label: string | null; progress?: number }
  | { type: 'reply'; id: number; ok: boolean; value?: unknown; error?: string };
