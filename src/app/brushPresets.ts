/**
 * Valores preestablecidos de pincel: incluidos (con puntas generadas), importados de .abr y
 * definidos por el usuario. Las puntas se registran en el motor la primera vez que se usan y los
 * pinceles del usuario se guardan en IndexedDB (siguen ahí al volver).
 */
import { engine } from '../engine/client';
import { DEFAULT_DYN, type BrushDynamics, type BrushSettings, type DynControl } from '../engine/types';

export interface BrushPreset {
  name: string;
  /** Ajustes que fija el valor (el resto vuelve a los de por defecto). */
  settings: Partial<BrushSettings>;
  /** Punta muestreada: id y, si es del usuario, sus datos. */
  tip?: { id: string; w: number; h: number; alpha?: Uint8Array };
  group?: string;
  user?: boolean;
}

// ------------------------------------------------------------------ puntas generadas

type Gen = (w: number) => { w: number; h: number; alpha: Uint8Array };

function rngOf(seed: number) { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

function fromCanvas(w: number, h: number, draw: (c: OffscreenCanvasRenderingContext2D) => void) {
  const cv = new OffscreenCanvas(w, h), c = cv.getContext('2d')!;
  draw(c);
  const d = c.getImageData(0, 0, w, h).data, a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return { w, h, alpha: a };
}

const GENERATORS: Record<string, Gen> = {
  chalk: (n) => fromCanvas(n, n, (c) => {
    const R = rngOf(7);
    for (let i = 0; i < 900; i++) {
      const a = R() * Math.PI * 2, r = Math.sqrt(R()) * n * 0.46;
      c.fillStyle = `rgba(0,0,0,${0.25 + R() * 0.6})`;
      c.fillRect(n / 2 + Math.cos(a) * r, n / 2 + Math.sin(a) * r, 1 + R() * 2, 1 + R() * 2);
    }
  }),
  charcoal: (n) => fromCanvas(n, n, (c) => {
    const R = rngOf(11);
    c.translate(n / 2, n / 2); c.rotate(-0.5);
    for (let i = 0; i < 60; i++) {
      c.strokeStyle = `rgba(0,0,0,${0.2 + R() * 0.5})`; c.lineWidth = 0.6 + R() * 1.8;
      const y = (R() - 0.5) * n * 0.35, l = n * (0.2 + R() * 0.25);
      c.beginPath(); c.moveTo(-l, y); c.lineTo(l, y + (R() - 0.5) * 3); c.stroke();
    }
  }),
  spatter: (n) => fromCanvas(n, n, (c) => {
    const R = rngOf(23);
    for (let i = 0; i < 40; i++) {
      const a = R() * Math.PI * 2, r = R() ** 0.7 * n * 0.42, s = 1 + R() * n * 0.06;
      c.fillStyle = '#000'; c.beginPath(); c.arc(n / 2 + Math.cos(a) * r, n / 2 + Math.sin(a) * r, s, 0, Math.PI * 2); c.fill();
    }
  }),
  grass: (n) => fromCanvas(n, n, (c) => {
    const R = rngOf(5);
    for (let i = 0; i < 7; i++) {
      const x = n * (0.3 + R() * 0.4), bend = (R() - 0.5) * n * 0.4;
      c.fillStyle = '#000'; c.beginPath(); c.moveTo(x - 2, n);
      c.quadraticCurveTo(x + bend * 0.5, n * 0.5, x + bend, n * (0.05 + R() * 0.2)); c.quadraticCurveTo(x + bend * 0.5 + 2, n * 0.5, x + 2, n); c.fill();
    }
  }),
  leaf: (n) => fromCanvas(n, n, (c) => {
    c.fillStyle = '#000'; c.beginPath(); c.moveTo(n * 0.5, n * 0.05);
    c.bezierCurveTo(n * 0.95, n * 0.35, n * 0.75, n * 0.8, n * 0.5, n * 0.95);
    c.bezierCurveTo(n * 0.25, n * 0.8, n * 0.05, n * 0.35, n * 0.5, n * 0.05); c.fill();
    c.globalCompositeOperation = 'destination-out'; c.lineWidth = n * 0.02;
    c.beginPath(); c.moveTo(n * 0.5, n * 0.1); c.lineTo(n * 0.5, n * 0.9); c.stroke();
  }),
  star: (n) => fromCanvas(n, n, (c) => {
    c.fillStyle = '#000'; c.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? n * 0.19 : n * 0.47, a = (i * Math.PI) / 5 - Math.PI / 2; c.lineTo(n / 2 + Math.cos(a) * r, n / 2 + Math.sin(a) * r); }
    c.closePath(); c.fill();
  }),
  bristle: (n) => fromCanvas(n, Math.round(n / 3), (c) => {
    const R = rngOf(17), h = Math.round(n / 3);
    for (let i = 0; i < 26; i++) {
      const y = (i + 0.5) * (h / 26), r = 0.6 + R() * 1.4;
      c.fillStyle = `rgba(0,0,0,${0.45 + R() * 0.55})`; c.beginPath(); c.ellipse(n / 2 + (R() - 0.5) * n * 0.1, y, n * (0.35 + R() * 0.12), r, 0, 0, Math.PI * 2); c.fill();
    }
  }),
  watercolor: (n) => fromCanvas(n, n, (c) => {
    const R = rngOf(31), g = c.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n * 0.45);
    g.addColorStop(0, 'rgba(0,0,0,0.35)'); g.addColorStop(0.75, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.beginPath();
    for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI * 2, r = n * (0.38 + R() * 0.08); c.lineTo(n / 2 + Math.cos(a) * r, n / 2 + Math.sin(a) * r); }
    c.fill();
  }),
  square: (n) => fromCanvas(n, n, (c) => { c.fillStyle = '#000'; c.fillRect(n * 0.1, n * 0.1, n * 0.8, n * 0.8); }),
};

const dyn = (d: Partial<BrushDynamics>): BrushDynamics => ({ ...DEFAULT_DYN, ...d });

/** Valores incluidos (agrupados como en el panel Pinceles de Photoshop). */
export const BUILTIN_PRESETS: BrushPreset[] = [
  { group: 'General', name: 'Redondo duro', settings: { hardness: 1, spacing: 0.25 } },
  { group: 'General', name: 'Redondo suave', settings: { hardness: 0, spacing: 0.25 } },
  { group: 'General', name: 'Redondo duro con presión', settings: { hardness: 1, pressureSize: true, dyn: dyn({ sizeControl: 'pressure' }) } },
  { group: 'General', name: 'Aerógrafo suave', settings: { hardness: 0, flow: 0.1, spacing: 0.05 } },
  { group: 'General', name: 'Plano (caligrafía)', settings: { hardness: 0.9, roundness: 0.2, angle: 45, spacing: 0.08 } },
  { group: 'Secos', name: 'Tiza', settings: { spacing: 0.15, dyn: dyn({ angleJitter: 1 }) }, tip: { id: 'gen:chalk', w: 96, h: 96 } },
  { group: 'Secos', name: 'Carboncillo', settings: { spacing: 0.1, dyn: dyn({ angleControl: 'direction', sizeJitter: 0.15 }) }, tip: { id: 'gen:charcoal', w: 96, h: 96 } },
  { group: 'Secos', name: 'Pincel seco', settings: { spacing: 0.05, dyn: dyn({ angleControl: 'direction' }) }, tip: { id: 'gen:bristle', w: 120, h: 40 } },
  { group: 'Húmedos', name: 'Acuarela', settings: { spacing: 0.12, wetEdges: true, flow: 0.6, dyn: dyn({ sizeJitter: 0.2, angleJitter: 1 }) }, tip: { id: 'gen:watercolor', w: 96, h: 96 } },
  { group: 'Húmedos', name: 'Tinta con presión', settings: { hardness: 0.85, smoothing: 0.4, pressureSize: true, dyn: dyn({ sizeControl: 'pressure', minDiameter: 0.1 }) } },
  { group: 'Especiales', name: 'Salpicadura', settings: { spacing: 0.6, dyn: dyn({ angleJitter: 1, sizeJitter: 0.5, scatter: 1.2, scatterBoth: true }) }, tip: { id: 'gen:spatter', w: 96, h: 96 } },
  { group: 'Especiales', name: 'Hierba', settings: { spacing: 0.3, dyn: dyn({ sizeJitter: 0.4, angleJitter: 0.08, scatter: 0.6, count: 2, fgBgJitter: 1, hueJitter: 0.05, briJitter: 0.2 }) }, tip: { id: 'gen:grass', w: 96, h: 96 } },
  { group: 'Especiales', name: 'Hojas dispersas', settings: { spacing: 0.7, dyn: dyn({ sizeJitter: 0.6, angleJitter: 1, scatter: 1.5, scatterBoth: true, count: 2, fgBgJitter: 1, hueJitter: 0.08 }) }, tip: { id: 'gen:leaf', w: 96, h: 96 } },
  { group: 'Especiales', name: 'Estrellas', settings: { spacing: 1.2, dyn: dyn({ sizeJitter: 0.7, angleJitter: 1, scatter: 2, scatterBoth: true, opacityJitter: 0.5 }) }, tip: { id: 'gen:star', w: 96, h: 96 } },
  { group: 'Especiales', name: 'Cuadrado', settings: { spacing: 0.25 }, tip: { id: 'gen:square', w: 64, h: 64 } },
];

/** Ajustes base: un valor preestablecido parte de aquí (no hereda dinámicas del anterior). */
export const PRESET_BASE: Partial<BrushSettings> = {
  hardness: 1, spacing: 0.25, flow: 1, angle: 0, roundness: 1, flipX: false, flipY: false, tip: null,
  dyn: undefined, noise: false, wetEdges: false, smoothing: 0, pressureSize: false,
};

const registered = new Set<string>();

/** Registra la punta en el motor si hace falta. */
export async function ensureTip(p: BrushPreset) {
  if (!p.tip || registered.has(p.tip.id)) return;
  let w = p.tip.w, h = p.tip.h, alpha = p.tip.alpha;
  if (!alpha) {
    const g = GENERATORS[p.tip.id.replace(/^gen:/, '')];
    if (!g) return;
    const t = g(p.tip.w);
    w = t.w; h = t.h; alpha = t.alpha;
    p.tip.w = w; p.tip.h = h; p.tip.alpha = alpha;
  }
  await engine.call('registerBrushTip', p.tip.id, w, h, alpha);
  registered.add(p.tip.id);
}

export async function presetSettings(p: BrushPreset): Promise<Partial<BrushSettings>> {
  await ensureTip(p);
  return { ...PRESET_BASE, ...p.settings, tip: p.tip?.id ?? null, preset: p.name };
}

/** Alfa de la punta (para las miniaturas). */
export function tipAlpha(p: BrushPreset): { w: number; h: number; alpha: Uint8Array } | null {
  if (!p.tip) return null;
  if (!p.tip.alpha) {
    const g = GENERATORS[p.tip.id.replace(/^gen:/, '')];
    if (!g) return null;
    const t = g(p.tip.w); p.tip.w = t.w; p.tip.h = t.h; p.tip.alpha = t.alpha;
  }
  return { w: p.tip.w, h: p.tip.h, alpha: p.tip.alpha };
}

// ------------------------------------------------------------------ .abr (Photoshop)

const CTRL: Record<string, DynControl> = { 'pen pressure': 'pressure', fade: 'fade', direction: 'direction', 'initial direction': 'initialDirection' };

export async function importAbr(buffer: ArrayBuffer, fileName: string): Promise<BrushPreset[]> {
  const { readAbr } = await import('ag-psd/dist/abr');
  const abr = readAbr(new Uint8Array(buffer));
  const samples = new Map(abr.samples.map((s) => [s.id, s]));
  const out: BrushPreset[] = [];
  const group = fileName.replace(/\.abr$/i, '');
  abr.brushes.forEach((b, i) => {
    const sh = b.shape as { type: string; size?: number; angle?: number; roundness?: number; hardness?: number; spacing?: number; spacingOn?: boolean; flipX?: boolean; flipY?: boolean; sampledData?: string };
    // ag-psd da redondez, dureza y espaciado como fracción (1 = 100 %); los ABR antiguos, en porcentaje.
    const frac = (v: number | undefined, d: number) => (v === undefined ? d : v > 1.5 ? v / 100 : v);
    const st: Partial<BrushSettings> = {
      size: Math.max(1, Math.round(sh.size ?? 30)), angle: sh.angle ?? 0, roundness: Math.max(0.01, frac(sh.roundness, 1)),
      hardness: frac(sh.hardness, 1), spacing: sh.spacingOn === false ? 0.25 : Math.max(0.01, frac(sh.spacing, 0.25)),
      flipX: !!sh.flipX, flipY: !!sh.flipY, noise: !!b.noise, wetEdges: !!b.wetEdges,
    };
    const d: Partial<BrushDynamics> = {};
    if (b.shapeDynamics) {
      const s2 = b.shapeDynamics;
      d.sizeJitter = s2.sizeDynamics.jitter; d.sizeControl = CTRL[s2.sizeDynamics.control] ?? 'off'; d.minDiameter = s2.minimumDiameter;
      d.angleJitter = s2.angleDynamics.jitter; d.angleControl = CTRL[s2.angleDynamics.control] ?? 'off';
      d.roundJitter = s2.roundnessDynamics.jitter; d.minRoundness = s2.minimumRoundness;
      if (d.sizeControl === 'pressure') st.pressureSize = false;
    }
    if (b.scatter) { d.scatter = b.scatter.scatterDynamics.jitter; d.scatterBoth = b.scatter.bothAxes; d.count = b.scatter.count; d.countJitter = b.scatter.countDynamics.jitter; }
    if (b.colorDynamics) { const c = b.colorDynamics; d.fgBgJitter = c.foregroundBackground.jitter; d.fgBgControl = CTRL[c.foregroundBackground.control] ?? 'off'; d.hueJitter = c.hue; d.satJitter = c.saturation; d.briJitter = c.brightness; d.perTip = c.perTip; }
    if (b.transfer) { d.opacityJitter = b.transfer.opacityDynamics.jitter; d.opacityControl = CTRL[b.transfer.opacityDynamics.control] ?? 'off'; d.flowJitter = b.transfer.flowDynamics.jitter; d.flowControl = CTRL[b.transfer.flowDynamics.control] ?? 'off'; }
    if (Object.keys(d).length) st.dyn = dyn(d);
    const p: BrushPreset = { name: b.name || `${group} ${i + 1}`, settings: st, group, user: true };
    if (sh.type === 'sampled' && sh.sampledData) {
      const sm = samples.get(sh.sampledData);
      if (sm) p.tip = { id: `abr:${group}:${sm.id}`, w: sm.bounds.w, h: sm.bounds.h, alpha: sm.alpha };
    }
    out.push(p);
  });
  // Muestras sin valor preestablecido (ABR antiguos): una punta por muestra.
  if (!out.length) abr.samples.forEach((sm, i) => out.push({ name: `${group} ${i + 1}`, group, user: true, settings: { size: Math.max(sm.bounds.w, sm.bounds.h), spacing: 0.25 }, tip: { id: `abr:${group}:${sm.id}`, w: sm.bounds.w, h: sm.bounds.h, alpha: sm.alpha } }));
  return out;
}

// ------------------------------------------------------------------ persistencia (IndexedDB)

const DB = 'lienzo', STORE = 'brushes';
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'name' }); if (!d.objectStoreNames.contains('patterns')) d.createObjectStore('patterns', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
export async function loadUserPresets(): Promise<BrushPreset[]> {
  try {
    const d = await db();
    return await new Promise((res) => { const q = d.transaction(STORE).objectStore(STORE).getAll(); q.onsuccess = () => res(q.result as BrushPreset[]); q.onerror = () => res([]); });
  } catch { return []; }
}
export async function saveUserPresets(list: BrushPreset[]) {
  try {
    const d = await db();
    await new Promise<void>((res) => { const t = d.transaction(STORE, 'readwrite'); const s = t.objectStore(STORE); for (const p of list) s.put(p); t.oncomplete = () => res(); t.onerror = () => res(); });
  } catch { /* sin almacenamiento: sólo en esta sesión */ }
}
export async function deleteUserPreset(name: string) {
  try { const d = await db(); d.transaction(STORE, 'readwrite').objectStore(STORE).delete(name); } catch { /* nada */ }
}
export { db as openLienzoDb };
