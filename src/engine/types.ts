// Tipos compartidos entre la interfaz (hilo principal) y el motor (worker).

export const TILE = 256;

export type BlendMode =
  | 'normal' | 'dissolve'
  | 'darken' | 'multiply' | 'color-burn' | 'linear-burn' | 'darker-color'
  | 'lighten' | 'screen' | 'color-dodge' | 'linear-dodge' | 'lighter-color'
  | 'overlay' | 'soft-light' | 'hard-light' | 'vivid-light' | 'linear-light' | 'pin-light' | 'hard-mix'
  | 'difference' | 'exclusion' | 'subtract' | 'divide'
  | 'hue' | 'saturation' | 'color' | 'luminosity'
  | 'pass-through'; // sólo grupos: sus capas se funden directamente con lo de debajo

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
export const PASS_THROUGH = { id: 'pass-through' as BlendMode, label: 'Pasar a través' };

export type ToolId =
  | 'move' | 'marquee' | 'marqueeEllipse' | 'lasso' | 'polylasso' | 'wand' | 'crop' | 'eyedropper'
  | 'brush' | 'pencil' | 'clone' | 'eraser' | 'gradient' | 'bucket' | 'dodge' | 'burn'
  | 'text' | 'shape' | 'hand' | 'zoom'
  | 'spotHeal' | 'heal' | 'patch' | 'pen' | 'pathSelect' | 'blur' | 'sharpen' | 'smudge' | 'historyBrush' | 'rotateView' | 'redEye' | 'objectSelect' | 'quickSelect';

export type LayerKind = 'pixel' | 'adjustment' | 'text' | 'shape' | 'group' | 'smart';

export interface Artboard { x: number; y: number; w: number; h: number; bg: RGBA | null }

/** Filtro inteligente: se vuelve a calcular cada vez; se puede ocultar, editar o quitar. */
export interface SmartFilter { name: string; params: Record<string, unknown>; enabled: boolean; opacity?: number }
/** Datos visibles de un objeto inteligente (los píxeles del contenido viven en el motor). */
export interface SmartInfo { w: number; h: number; matrix: Matrix; filters: SmartFilter[]; source?: string; hasContents: boolean }

export type AdjustmentParams =
  | { type: 'brightness'; brightness: number; contrast: number }
  | { type: 'levels'; inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number }
  | { type: 'curves'; points: [number, number][] }
  | { type: 'exposure'; exposure: number; offset: number; gamma: number }
  | { type: 'hueSat'; hue: number; saturation: number; lightness: number; colorize: boolean }
  | { type: 'colorBalance'; shadows: [number, number, number]; midtones: [number, number, number]; highlights: [number, number, number] }
  | { type: 'blackWhite'; reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number }
  | { type: 'invert' }
  | { type: 'threshold'; level: number }
  | { type: 'posterize'; levels: number }
  | { type: 'gradientMap'; from: RGBA; to: RGBA }
  | { type: 'vibrance'; vibrance: number; saturation: number }
  | { type: 'solidColor'; color: RGBA }
  | { type: 'photoFilter'; color: RGBA; density: number; preserveLuminosity: boolean }
  | { type: 'selectiveColor'; relative: boolean; ranges: Record<SelectiveRange, [number, number, number, number]> }
  | { type: 'colorLookup'; name: string; size: number; data: string }
  | { type: 'channelMixer'; red: [number, number, number, number]; green: [number, number, number, number]; blue: [number, number, number, number]; monochrome: boolean };

/** Gamas de Corrección selectiva (cada una con cian, magenta, amarillo y negro en %). */
export type SelectiveRange = 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas' | 'whites' | 'neutrals' | 'blacks';
export const SELECTIVE_RANGES: [SelectiveRange, string][] = [
  ['reds', 'Rojos'], ['yellows', 'Amarillos'], ['greens', 'Verdes'], ['cyans', 'Cianes'], ['blues', 'Azules'],
  ['magentas', 'Magentas'], ['whites', 'Blancos'], ['neutrals', 'Neutros'], ['blacks', 'Negros'],
];

export type AdjustmentType = AdjustmentParams['type'];

/** Matriz afín [a, b, c, d, e, f]: x' = a·x + c·y + e ; y' = b·x + d·y + f */
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export type WarpStyle = 'none' | 'arc' | 'arcLower' | 'arcUpper' | 'arch' | 'bulge' | 'shellLower' | 'shellUpper' | 'flag' | 'wave' | 'fish' | 'rise' | 'fisheye' | 'inflate' | 'squeeze' | 'twist';
/** Deformar texto: estilo, curvatura y distorsiones horizontal/vertical (−100..100, como Photoshop). */
export interface TextWarp { style: WarpStyle; bend: number; hDist: number; vDist: number; vertical?: boolean }

export interface TextParams {
  text: string;
  font: string;
  size: number;
  color: RGBA;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right' | 'justify';
  /** Interlineado como múltiplo del cuerpo (1,2 = automático). */
  lineHeight: number;
  /** Punto de origen (texto de punto: línea base) o esquina superior izquierda de la caja (texto de párrafo). */
  x: number;
  y: number;
  matrix: Matrix;
  /** Carácter: seguimiento (milésimas de eme), escalas (%), desplazamiento de la línea base (px). */
  tracking?: number;
  hScale?: number;
  vScale?: number;
  baselineShift?: number;
  caps?: 'none' | 'all' | 'small';
  underline?: boolean;
  strike?: boolean;
  /** Texto de párrafo: caja donde se ajustan las líneas. */
  box?: { w: number; h: number } | null;
  /** Párrafo: sangrías y espacio después (px). */
  indentLeft?: number;
  indentRight?: number;
  indentFirst?: number;
  spaceAfter?: number;
  warp?: TextWarp | null;
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'polygon' | 'path';

export interface ShapeParams {
  shape: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: RGBA | null;
  stroke: RGBA | null;
  strokeWidth: number;
  radius: number;
  sides: number;
  matrix: Matrix;
  /** Forma libre (pluma): datos SVG en coordenadas de documento. */
  path?: string;
}

/** Sombra (paralela o interior): `spread` es Extensión/Estrangular en %. */
export interface ShadowFx { enabled: boolean; color: RGBA; opacity: number; angle: number; distance: number; size: number; spread?: number; blend?: BlendMode }
/** Resplandor (exterior o interior). */
export interface GlowFx { enabled: boolean; color: RGBA; opacity: number; size: number; spread?: number; blend?: BlendMode; source?: 'edge' | 'center' }
export type BevelStyle = 'inner' | 'outer' | 'emboss' | 'pillow';
export interface BevelFx {
  enabled: boolean; style: BevelStyle; technique?: 'smooth' | 'chisel'; depth: number; up: boolean; size: number; soften: number;
  angle: number; altitude: number; highlight: RGBA; highlightOpacity: number; highlightBlend?: BlendMode;
  shadow: RGBA; shadowOpacity: number; shadowBlend?: BlendMode;
}
export interface SatinFx { enabled: boolean; color: RGBA; opacity: number; angle: number; distance: number; size: number; invert: boolean; blend?: BlendMode }
export interface OverlayFx { enabled: boolean; color: RGBA; opacity: number; blend?: BlendMode }
export type GradientStyle = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
export interface GradientOverlayFx { enabled: boolean; from: RGBA; to: RGBA; opacity: number; angle: number; style: GradientStyle; reverse: boolean; scale: number; blend?: BlendMode }
export type PatternId = 'checker' | 'dots' | 'stripes' | 'grid' | 'noise' | 'canvas';
export interface PatternOverlayFx { enabled: boolean; pattern: PatternId; colorA: RGBA; colorB: RGBA; scale: number; opacity: number; blend?: BlendMode }
export interface StrokeFx { enabled: boolean; color: RGBA; size: number; position?: 'outside' | 'inside' | 'center'; opacity?: number; blend?: BlendMode }
/** Fusión condicional ("Fusionar si"): [negro inicio, negro fin, blanco inicio, blanco fin] en 0..255. */
export interface BlendIf { channel: 'gray' | 'red' | 'green' | 'blue'; self: [number, number, number, number]; under: [number, number, number, number] }

/** Estilos de capa y opciones de fusión (los mismos 10 efectos de Photoshop). */
export interface LayerEffects {
  dropShadow?: ShadowFx;
  innerShadow?: ShadowFx;
  outerGlow?: GlowFx;
  innerGlow?: GlowFx;
  bevel?: BevelFx;
  satin?: SatinFx;
  colorOverlay?: OverlayFx;
  gradientOverlay?: GradientOverlayFx;
  patternOverlay?: PatternOverlayFx;
  stroke?: StrokeFx;
  /** Opacidad de relleno (0..1): afecta al contenido pero no a los efectos. */
  fill?: number;
  blendIf?: BlendIf;
}

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
  kind: LayerKind;
  visible: boolean;
  opacity: number; // 0..1
  blend: BlendMode;
  x: number;
  y: number;
  hasMask: boolean;
  maskEnabled: boolean;
  lockAlpha: boolean;
  adjustment?: AdjustmentParams;
  text?: TextParams;
  shape?: ShapeParams;
  effects?: LayerEffects;
  smart?: SmartInfo;
  /** Mesa de trabajo (grupo especial): rectángulo y fondo (null = transparente). */
  artboard?: Artboard;
  /** Grupo que contiene la capa (null = raíz). */
  parent: number | null;
  /** Máscara de recorte: la capa se recorta a la capa base de debajo. */
  clipped: boolean;
  /** Grupo plegado en el panel. */
  collapsed?: boolean;
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
  selection: Rect | null;     // límites de la selección
  editMask: boolean;          // se pinta en la máscara de la capa activa
  dirty: boolean;
  /** Capas seleccionadas en el panel (incluye la activa). */
  selectedLayerIds: number[];
  /** Trazados del documento (panel Trazados). */
  paths: DocPathInfo[];
  activePathId: number | null;
  guides: { id: number; dir: 'h' | 'v'; pos: number }[];
  /** Modo Máscara rápida (Q). */
  quickMask: boolean;
  /** Canales alfa guardados. */
  alphas: { id: number; name: string }[];
  snapshots: { id: number; name: string }[];
  historySource: number | null;
  /** Canal que se está viendo: 0 = RGB, 1 R, 2 G, 3 B. */
  viewChannel: number;
  /** Pestañas abiertas. */
  docs: { id: number; name: string; dirty: boolean }[];
  activeDocId: number;
  /** Si el documento es el contenido de un objeto inteligente: nombre de la capa (Guardar lo actualiza). */
  smartParent?: string | null;
}

export interface DocPathInfo { id: number; name: string; work: boolean; path: import('./path').VectorPath }

/** rot: rotación de la vista en radianes (herramienta Rotar vista, R), alrededor del centro del lienzo visible. */
export interface ViewState { zoom: number; panX: number; panY: number; dpr: number; rot?: number }

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
  | { type: 'selection'; path: string; bounds: Rect | null }
  | { type: 'reply'; id: number; ok: boolean; value?: unknown; error?: string };
