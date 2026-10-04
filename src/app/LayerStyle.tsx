// Estilo de capa (doble clic en la capa o Capa > Estilo de capa…), con la misma estructura que Photoshop:
// a la izquierda Opciones de fusión y los 10 efectos con su casilla; a la derecha los ajustes del elegido.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { engine } from '../engine/client';
import { useStore, toHex, toRgba } from './store';
import { Modal } from './Dialogs';
import {
  BLEND_GROUPS, type BlendMode, type LayerEffects, type RGBA, type BlendIf, type PatternId, type GradientStyle, type BevelStyle,
} from '../engine/types';

type FxKey = Exclude<keyof LayerEffects, 'fill' | 'blendIf'>;

/** Valores por defecto de Photoshop para cada efecto. */
export function fxDefaults(fg: RGBA = [0, 0, 0, 255], bg: RGBA = [255, 255, 255, 255]): Required<Pick<LayerEffects, FxKey>> {
  return {
    dropShadow: { enabled: false, color: [0, 0, 0, 255], opacity: 0.75, angle: 120, distance: 5, size: 5, spread: 0, blend: 'multiply' },
    innerShadow: { enabled: false, color: [0, 0, 0, 255], opacity: 0.75, angle: 120, distance: 5, size: 5, spread: 0, blend: 'multiply' },
    outerGlow: { enabled: false, color: [255, 255, 190, 255], opacity: 0.75, size: 5, spread: 0, blend: 'screen' },
    innerGlow: { enabled: false, color: [255, 255, 190, 255], opacity: 0.75, size: 5, spread: 0, blend: 'screen', source: 'edge' },
    bevel: {
      enabled: false, style: 'inner', technique: 'smooth', depth: 100, up: true, size: 5, soften: 0, angle: 120, altitude: 30,
      highlight: [255, 255, 255, 255], highlightOpacity: 0.75, highlightBlend: 'screen', shadow: [0, 0, 0, 255], shadowOpacity: 0.75, shadowBlend: 'multiply',
    },
    satin: { enabled: false, color: [0, 0, 0, 255], opacity: 0.5, angle: 19, distance: 11, size: 14, invert: true, blend: 'multiply' },
    colorOverlay: { enabled: false, color: [255, 0, 0, 255], opacity: 1, blend: 'normal' },
    gradientOverlay: { enabled: false, from: fg, to: bg, opacity: 1, angle: 90, style: 'linear', reverse: false, scale: 100, blend: 'normal' },
    patternOverlay: { enabled: false, pattern: 'checker', colorA: [255, 255, 255, 255], colorB: [200, 200, 200, 255], scale: 100, opacity: 1, blend: 'normal' },
    stroke: { enabled: false, color: [0, 0, 0, 255], size: 3, position: 'outside', opacity: 1, blend: 'normal' },
  };
}

const ITEMS: [FxKey, string][] = [
  ['bevel', 'Bisel y relieve'], ['stroke', 'Trazo'], ['innerShadow', 'Sombra interior'], ['innerGlow', 'Resplandor interior'],
  ['satin', 'Satinado'], ['colorOverlay', 'Superposición de colores'], ['gradientOverlay', 'Superposición de degradado'],
  ['patternOverlay', 'Superposición de motivo'], ['outerGlow', 'Resplandor exterior'], ['dropShadow', 'Sombra paralela'],
];
const PATTERNS: [PatternId, string][] = [['checker', 'Cuadros'], ['dots', 'Lunares'], ['stripes', 'Rayas'], ['grid', 'Cuadrícula'], ['noise', 'Ruido'], ['canvas', 'Lienzo']];
const GSTYLES: [GradientStyle, string][] = [['linear', 'Lineal'], ['radial', 'Radial'], ['angle', 'Angular'], ['reflected', 'Reflejado'], ['diamond', 'Diamante']];
const BSTYLES: [BevelStyle, string][] = [['inner', 'Bisel interior'], ['outer', 'Bisel exterior'], ['emboss', 'Relieve'], ['pillow', 'Relieve acolchado']];

export function LayerStyleDialog({ close }: { close: () => void }) {
  const doc = useStore((s) => s.doc);
  const fgHex = useStore((s) => s.fg), bgHex = useStore((s) => s.bg);
  const L = doc.layers.find((l) => l.id === doc.activeLayerId);
  const initial = useMemo(() => ({ effects: structuredClone(L?.effects), blend: L?.blend, opacity: L?.opacity }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [fx, setFx] = useState<LayerEffects>(() => {
    const d = fxDefaults(toRgba(fgHex), toRgba(bgHex));
    const cur = initial.effects ?? {};
    const out: LayerEffects = { fill: cur.fill ?? 1, blendIf: cur.blendIf };
    for (const [k] of ITEMS) (out as Record<string, unknown>)[k] = { ...d[k], ...(cur[k] as object | undefined) };
    return out;
  });
  const [sel, setSel] = useState<FxKey | 'blending'>(() => ITEMS.find(([k]) => initial.effects?.[k]?.enabled)?.[0] ?? 'blending');
  const [blend, setBlend] = useState<BlendMode>(L?.blend ?? 'normal');
  const [opacity, setOpacity] = useState(L?.opacity ?? 1);
  const first = useRef(true);
  useEffect(() => {
    if (!L) return;
    if (first.current) { first.current = false; return; }
    engine.call('setEffects', L.id, clean(fx), false);
  }, [fx]); // eslint-disable-line react-hooks/exhaustive-deps
  const invalid = !L || L.kind === 'adjustment' || L.kind === 'group';
  useEffect(() => { if (invalid) { useStore.getState().toast('Los estilos de capa se aplican a capas de píxeles, texto o forma.'); close(); } }, [invalid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (invalid || !L) return null;

  const upd = <K extends FxKey>(k: K, patch: Partial<NonNullable<LayerEffects[K]>>) =>
    setFx((cur) => ({ ...cur, [k]: { ...(cur[k] as object), ...patch } }));
  const fxOf = <K extends FxKey>(k: K) => fx[k] as NonNullable<LayerEffects[K]>;

  // Controles (funciones, no componentes, para no remontarlos al arrastrar).
  const rng = (label: string, v: number, min: number, max: number, on: (v: number) => void, unit = '') => (
    <label className="adj-row" key={label}><span>{label}</span>
      <input type="range" min={min} max={max} value={v} aria-label={label} onChange={(e) => on(Number(e.target.value))} />
      <input type="number" className="num" min={min} max={max} value={Math.round(v)} aria-label={`${label} (valor)`}
        onKeyDown={(e) => e.stopPropagation()} onChange={(e) => on(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />{unit}
    </label>
  );
  const col = (label: string, c: RGBA, on: (c: RGBA) => void) => (
    <label className="adj-row" key={label}><span>{label}</span><input type="color" aria-label={label} value={toHex(c)} onChange={(e) => on(toRgba(e.target.value))} /></label>
  );
  const mode = (label: string, v: BlendMode | undefined, on: (m: BlendMode) => void) => (
    <label className="adj-row" key={label}><span>{label}</span>
      <select value={v ?? 'normal'} aria-label={label} onChange={(e) => on(e.target.value as BlendMode)}>
        {BLEND_GROUPS.map((g, i) => <optgroup key={i} label="—">{g.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</optgroup>)}
      </select>
    </label>
  );
  const pick = <T extends string>(label: string, v: T, opts: [T, string][], on: (v: T) => void) => (
    <label className="adj-row" key={label}><span>{label}</span>
      <select value={v} aria-label={label} onChange={(e) => on(e.target.value as T)}>{opts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
    </label>
  );
  const check = (label: string, v: boolean, on: (v: boolean) => void) => (
    <label className="adj-row" key={label}><span>{label}</span><input type="checkbox" aria-label={label} checked={v} onChange={(e) => on(e.target.checked)} /></label>
  );
  const pct = (v: number | undefined) => Math.round((v ?? 1) * 100);

  let body: ReactNode = null;
  switch (sel) {
    case 'blending': {
      const bi: BlendIf = fx.blendIf ?? { channel: 'gray', self: [0, 0, 255, 255], under: [0, 0, 255, 255] };
      const setBi = (p: Partial<BlendIf>) => {
        const next = { ...bi, ...p };
        const neutral = next.self.join() === '0,0,255,255' && next.under.join() === '0,0,255,255';
        setFx((cur) => ({ ...cur, blendIf: neutral ? undefined : next }));
      };
      body = <>
        {mode('Modo de fusión', blend, (m) => { setBlend(m); engine.call('setLayer', L.id, { blend: m }, false); })}
        {rng('Opacidad', Math.round(opacity * 100), 0, 100, (v) => { setOpacity(v / 100); engine.call('setLayer', L.id, { opacity: v / 100 }, false); }, '%')}
        {rng('Opacidad de relleno', pct(fx.fill), 0, 100, (v) => setFx((c) => ({ ...c, fill: v / 100 })), '%')}
        <fieldset className="adj-group"><legend>Fusionar si</legend>
          {pick('Canal', bi.channel, [['gray', 'Gris'], ['red', 'Rojo'], ['green', 'Verde'], ['blue', 'Azul']], (channel) => setBi({ channel }))}
          <BlendIfSlider label="Esta capa" value={bi.self} onChange={(self) => setBi({ self })} />
          <BlendIfSlider label="Capa subyacente" value={bi.under} onChange={(under) => setBi({ under })} />
          <span className="hint">Alt+arrastrar divide cada marca para una transición suave.</span>
        </fieldset>
      </>;
      break;
    }
    case 'dropShadow': case 'innerShadow': {
      const e = fxOf(sel);
      body = <>
        {mode('Modo de fusión', e.blend, (blend) => upd(sel, { blend }))}{col('Color', e.color, (color) => upd(sel, { color }))}
        {rng('Opacidad', pct(e.opacity), 0, 100, (v) => upd(sel, { opacity: v / 100 }), '%')}
        {rng('Ángulo', e.angle, -180, 180, (angle) => upd(sel, { angle }), '°')}
        {rng('Distancia', e.distance, 0, 300, (distance) => upd(sel, { distance }), 'px')}
        {rng(sel === 'dropShadow' ? 'Extensión' : 'Estrangular', e.spread ?? 0, 0, 100, (spread) => upd(sel, { spread }), '%')}
        {rng('Tamaño', e.size, 0, 250, (size) => upd(sel, { size }), 'px')}
      </>;
      break;
    }
    case 'outerGlow': case 'innerGlow': {
      const e = fxOf(sel);
      body = <>
        {mode('Modo de fusión', e.blend, (blend) => upd(sel, { blend }))}{col('Color', e.color, (color) => upd(sel, { color }))}
        {rng('Opacidad', pct(e.opacity), 0, 100, (v) => upd(sel, { opacity: v / 100 }), '%')}
        {sel === 'innerGlow' && pick('Origen', e.source ?? 'edge', [['edge', 'Borde'], ['center', 'Centro']], (source) => upd('innerGlow', { source }))}
        {rng(sel === 'outerGlow' ? 'Extensión' : 'Estrangular', e.spread ?? 0, 0, 100, (spread) => upd(sel, { spread }), '%')}
        {rng('Tamaño', e.size, 0, 250, (size) => upd(sel, { size }), 'px')}
      </>;
      break;
    }
    case 'bevel': {
      const e = fxOf('bevel');
      body = <>
        {pick('Estilo', e.style, BSTYLES, (style) => upd('bevel', { style }))}
        {pick('Técnica', e.technique ?? 'smooth', [['smooth', 'Suavizar'], ['chisel', 'Cincelar']], (technique) => upd('bevel', { technique }))}
        {rng('Profundidad', e.depth, 1, 1000, (depth) => upd('bevel', { depth }), '%')}
        {pick('Dirección', e.up ? 'up' : 'down', [['up', 'Arriba'], ['down', 'Abajo']], (v) => upd('bevel', { up: v === 'up' }))}
        {rng('Tamaño', e.size, 0, 250, (size) => upd('bevel', { size }), 'px')}
        {rng('Suavizar', e.soften, 0, 16, (soften) => upd('bevel', { soften }), 'px')}
        {rng('Ángulo', e.angle, -180, 180, (angle) => upd('bevel', { angle }), '°')}
        {rng('Altitud', e.altitude, 0, 90, (altitude) => upd('bevel', { altitude }), '°')}
        {mode('Iluminación', e.highlightBlend, (highlightBlend) => upd('bevel', { highlightBlend }))}
        {col('Color de iluminación', e.highlight, (highlight) => upd('bevel', { highlight }))}
        {rng('Opacidad de iluminación', pct(e.highlightOpacity), 0, 100, (v) => upd('bevel', { highlightOpacity: v / 100 }), '%')}
        {mode('Sombra', e.shadowBlend, (shadowBlend) => upd('bevel', { shadowBlend }))}
        {col('Color de sombra', e.shadow, (shadow) => upd('bevel', { shadow }))}
        {rng('Opacidad de sombra', pct(e.shadowOpacity), 0, 100, (v) => upd('bevel', { shadowOpacity: v / 100 }), '%')}
      </>;
      break;
    }
    case 'satin': {
      const e = fxOf('satin');
      body = <>
        {mode('Modo de fusión', e.blend, (blend) => upd('satin', { blend }))}{col('Color', e.color, (color) => upd('satin', { color }))}
        {rng('Opacidad', pct(e.opacity), 0, 100, (v) => upd('satin', { opacity: v / 100 }), '%')}
        {rng('Ángulo', e.angle, -180, 180, (angle) => upd('satin', { angle }), '°')}
        {rng('Distancia', e.distance, 1, 250, (distance) => upd('satin', { distance }), 'px')}
        {rng('Tamaño', e.size, 0, 250, (size) => upd('satin', { size }), 'px')}
        {check('Invertir', e.invert, (invert) => upd('satin', { invert }))}
      </>;
      break;
    }
    case 'colorOverlay': {
      const e = fxOf('colorOverlay');
      body = <>
        {mode('Modo de fusión', e.blend, (blend) => upd('colorOverlay', { blend }))}{col('Color', e.color, (color) => upd('colorOverlay', { color }))}
        {rng('Opacidad', pct(e.opacity), 0, 100, (v) => upd('colorOverlay', { opacity: v / 100 }), '%')}
      </>;
      break;
    }
    case 'gradientOverlay': {
      const e = fxOf('gradientOverlay');
      body = <>
        {mode('Modo de fusión', e.blend, (blend) => upd('gradientOverlay', { blend }))}
        {rng('Opacidad', pct(e.opacity), 0, 100, (v) => upd('gradientOverlay', { opacity: v / 100 }), '%')}
        {col('Color inicial', e.from, (from) => upd('gradientOverlay', { from }))}{col('Color final', e.to, (to) => upd('gradientOverlay', { to }))}
        {check('Invertir', e.reverse, (reverse) => upd('gradientOverlay', { reverse }))}
        {pick('Estilo', e.style, GSTYLES, (style) => upd('gradientOverlay', { style }))}
        {rng('Ángulo', e.angle, -180, 180, (angle) => upd('gradientOverlay', { angle }), '°')}
        {rng('Escala', e.scale, 10, 150, (scale) => upd('gradientOverlay', { scale }), '%')}
      </>;
      break;
    }
    case 'patternOverlay': {
      const e = fxOf('patternOverlay');
      body = <>
        {mode('Modo de fusión', e.blend, (blend) => upd('patternOverlay', { blend }))}
        {rng('Opacidad', pct(e.opacity), 0, 100, (v) => upd('patternOverlay', { opacity: v / 100 }), '%')}
        {pick('Motivo', e.pattern, PATTERNS, (pattern) => upd('patternOverlay', { pattern }))}
        {col('Color A', e.colorA, (colorA) => upd('patternOverlay', { colorA }))}{col('Color B', e.colorB, (colorB) => upd('patternOverlay', { colorB }))}
        {rng('Escala', e.scale, 10, 1000, (scale) => upd('patternOverlay', { scale }), '%')}
      </>;
      break;
    }
    case 'stroke': {
      const e = fxOf('stroke');
      body = <>
        {rng('Tamaño', e.size, 1, 250, (size) => upd('stroke', { size }), 'px')}
        {pick('Posición', e.position ?? 'outside', [['outside', 'Fuera'], ['inside', 'Dentro'], ['center', 'Centro']], (position) => upd('stroke', { position }))}
        {mode('Modo de fusión', e.blend, (blend) => upd('stroke', { blend }))}
        {rng('Opacidad', pct(e.opacity), 0, 100, (v) => upd('stroke', { opacity: v / 100 }), '%')}
        {col('Color', e.color, (color) => upd('stroke', { color }))}
      </>;
      break;
    }
  }

  const cancel = () => {
    engine.call('setEffects', L.id, initial.effects, false);
    engine.call('setLayer', L.id, { blend: initial.blend, opacity: initial.opacity }, false);
    engine.call('setEffects', L.id, initial.effects, true);
    close();
  };
  const ok = () => {
    // Modo y opacidad de la capa: un paso de historial propio si cambiaron.
    if (blend !== initial.blend || opacity !== initial.opacity) {
      engine.call('setLayer', L.id, { blend: initial.blend, opacity: initial.opacity }, false);
      engine.call('setLayer', L.id, { blend, opacity }, true);
    }
    engine.call('setEffects', L.id, clean(fx), true);
    close();
  };
  return (
    <Modal title={`Estilo de capa · ${L.name}`} wide onClose={cancel} onOk={ok}>
      <div className="lstyle" data-testid="layer-style">
        <nav className="lstyle-list">
          <button type="button" className={`lstyle-item ${sel === 'blending' ? 'on' : ''}`} onClick={() => setSel('blending')}>Opciones de fusión</button>
          {ITEMS.map(([k, label]) => (
            <div key={k} className={`lstyle-item ${sel === k ? 'on' : ''}`}>
              <input type="checkbox" aria-label={`Activar ${label}`} checked={!!fx[k]?.enabled}
                onChange={(e) => { upd(k, { enabled: e.target.checked } as never); if (e.target.checked) setSel(k); }} />
              <button type="button" onClick={() => { setSel(k); if (!fx[k]?.enabled) upd(k, { enabled: true } as never); }}>{label}</button>
            </div>
          ))}
        </nav>
        <div className="lstyle-body">
          <h3>{sel === 'blending' ? 'Opciones de fusión' : ITEMS.find(([k]) => k === sel)![1]}</h3>
          {body}
        </div>
      </div>
    </Modal>
  );
}

/** Quita los efectos desactivados (el documento guarda solo lo que se usa). */
function clean(fx: LayerEffects): LayerEffects | undefined {
  const out: LayerEffects = {};
  for (const [k] of ITEMS) if (fx[k]?.enabled) (out as Record<string, unknown>)[k] = fx[k];
  if (fx.fill !== undefined && fx.fill < 1) out.fill = fx.fill;
  if (fx.blendIf) out.blendIf = fx.blendIf;
  return Object.keys(out).length ? out : undefined;
}

/** Barra de "Fusionar si": marcas negra y blanca que se dividen con Alt. */
function BlendIfSlider({ label, value, onChange }: { label: string; value: [number, number, number, number]; onChange: (v: [number, number, number, number]) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [b0, b1, w0, w1] = value;
  const start = (idx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current!;
    (e.target as Element).setPointerCapture(e.pointerId);
    const split = e.altKey;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const v = Math.round(Math.max(0, Math.min(255, ((ev.clientX - r.left) / r.width) * 255)));
      const nv = [...value] as [number, number, number, number];
      const pair = idx < 2 ? [0, 1] : [2, 3];
      if (split || ev.altKey || nv[pair[0]] !== nv[pair[1]]) nv[idx] = v; else { nv[pair[0]] = v; nv[pair[1]] = v; }
      // Orden: negro inicio ≤ negro fin ≤ blanco inicio ≤ blanco fin.
      if (idx < 2) { nv[0] = Math.min(nv[0], nv[2]); nv[1] = Math.max(nv[0], Math.min(nv[1], nv[2])); }
      else { nv[3] = Math.max(nv[3], nv[1]); nv[2] = Math.min(nv[3], Math.max(nv[2], nv[1])); }
      onChange(nv);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const knob = (i: number, v: number, dark: boolean) => (
    <span key={i} className={`bif-knob ${dark ? 'dark' : 'light'}`} style={{ left: `${(v / 255) * 100}%` }} onPointerDown={start(i)} data-testid={`bif-${label}-${i}`} />
  );
  return (
    <div className="bif">
      <div className="bif-head"><span>{label}:</span><span className="bif-vals">{b0 === b1 ? b0 : `${b0}/${b1}`} &nbsp; {w0 === w1 ? w0 : `${w0}/${w1}`}</span></div>
      <div className="bif-bar" ref={ref}>
        {knob(0, b0, true)}{b1 !== b0 && knob(1, b1, true)}{w0 !== w1 && knob(2, w0, false)}{knob(3, w1, false)}
      </div>
    </div>
  );
}
