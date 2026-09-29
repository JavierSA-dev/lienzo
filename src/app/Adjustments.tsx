import { useRef, useState } from 'react';
import { SELECTIVE_RANGES, type AdjustmentParams, type RGBA, type SelectiveRange } from '../engine/types';
import { curveLut, PHOTO_FILTERS } from '../engine/adjust';
import { toHex, toRgba } from './store';

type OnChange = (p: AdjustmentParams, commit: boolean) => void;

function Row({ label, value, min, max, step = 1, onChange, onCommit }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit: () => void }) {
  return (
    <label className="adj-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} />
      <input type="number" className="num" min={min} max={max} step={step} value={Math.round(value * 100) / 100}
        onChange={(e) => onChange(Number(e.target.value))} onBlur={onCommit} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') onCommit(); }} />
    </label>
  );
}

/** Editor de curvas: clic añade punto, arrastrar mueve, sacarlo del cuadro lo elimina. */
function CurvesEditor({ points, onChange, onCommit }: { points: [number, number][]; onChange: (p: [number, number][]) => void; onCommit: () => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const S = 200;
  const toLocal = (e: React.PointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * 255), Math.round((1 - (e.clientY - r.top) / r.height) * 255)];
  };
  const f = curveLut(points);
  const d = Array.from({ length: 65 }, (_, i) => { const x = (i / 64) * 255; return `${i ? 'L' : 'M'}${(x / 255) * S} ${S - (Math.max(0, Math.min(255, f(x))) / 255) * S}`; }).join('');
  return (
    <svg ref={ref} className="curves" viewBox={`0 0 ${S} ${S}`} width={S} height={S}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        const [x, y] = toLocal(e);
        let i = points.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 12);
        if (i < 0) {
          const next = [...points, [x, y] as [number, number]].sort((a, b) => a[0] - b[0]);
          i = next.findIndex((p) => p[0] === x && p[1] === y);
          onChange(next);
        }
        setDrag(i);
      }}
      onPointerMove={(e) => {
        if (drag === null) return;
        const [x, y] = toLocal(e);
        const out = x < -20 || x > 275 || y < -20 || y > 275;
        const next = points.map((p, i) => (i === drag ? [Math.max(0, Math.min(255, x)), Math.max(0, Math.min(255, y))] as [number, number] : p));
        if (out && points.length > 2 && drag !== 0 && drag !== points.length - 1) { onChange(points.filter((_, i) => i !== drag)); setDrag(null); return; }
        onChange(next.sort((a, b) => a[0] - b[0]));
      }}
      onPointerUp={() => { setDrag(null); onCommit(); }}
    >
      <rect width={S} height={S} className="curves-bg" />
      {[1, 2, 3].map((i) => <path key={i} className="curves-grid" d={`M${(S * i) / 4} 0V${S}M0 ${(S * i) / 4}H${S}`} />)}
      <path className="curves-diag" d={`M0 ${S}L${S} 0`} />
      <path className="curves-line" d={d} />
      {points.map(([x, y], i) => <circle key={i} className="curves-pt" cx={(x / 255) * S} cy={S - (y / 255) * S} r={4} />)}
    </svg>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: RGBA; onChange: (c: RGBA) => void }) {
  return (
    <label className="adj-row"><span>{label}</span><input type="color" value={toHex(value)} onChange={(e) => onChange(toRgba(e.target.value))} /></label>
  );
}

/** Controles de cada ajuste (se usan en Propiedades y en los diálogos destructivos). */
export function AdjustmentEditor({ params, onChange }: { params: AdjustmentParams; onChange: OnChange }) {
  const set = (patch: Partial<AdjustmentParams>) => onChange({ ...params, ...patch } as AdjustmentParams, false);
  const commit = () => onChange(params, true);
  const R = (label: string, key: string, min: number, max: number, step = 1) => (
    <Row label={label} value={(params as unknown as Record<string, number>)[key]} min={min} max={max} step={step}
      onChange={(v) => set({ [key]: v } as Partial<AdjustmentParams>)} onCommit={commit} />
  );
  switch (params.type) {
    case 'brightness': return <>{R('Brillo', 'brightness', -150, 150)}{R('Contraste', 'contrast', -50, 100)}</>;
    case 'levels': return <>{R('Entrada: negro', 'inBlack', 0, 253)}{R('Gamma', 'gamma', 0.1, 9.99, 0.01)}{R('Entrada: blanco', 'inWhite', 2, 255)}{R('Salida: negro', 'outBlack', 0, 255)}{R('Salida: blanco', 'outWhite', 0, 255)}</>;
    case 'curves': return (
      <>
        <CurvesEditor points={params.points} onChange={(points) => onChange({ ...params, points }, false)} onCommit={commit} />
        <button className="chip" onClick={() => onChange({ ...params, points: [[0, 0], [255, 255]] }, true)}>Restablecer</button>
      </>
    );
    case 'exposure': return <>{R('Exposición', 'exposure', -5, 5, 0.01)}{R('Desplazamiento', 'offset', -0.5, 0.5, 0.001)}{R('Gamma', 'gamma', 0.1, 9.99, 0.01)}</>;
    case 'vibrance': return <>{R('Intensidad', 'vibrance', -100, 100)}{R('Saturación', 'saturation', -100, 100)}</>;
    case 'hueSat': return (
      <>
        {R('Tono', 'hue', -180, 180)}{R('Saturación', 'saturation', -100, 100)}{R('Luminosidad', 'lightness', -100, 100)}
        <label className="adj-row"><span>Colorear</span><input type="checkbox" checked={params.colorize} onChange={(e) => onChange({ ...params, colorize: e.target.checked }, true)} /></label>
      </>
    );
    case 'colorBalance': {
      const tone = (label: string, key: 'shadows' | 'midtones' | 'highlights') => (
        <fieldset className="adj-group" key={key}>
          <legend>{label}</legend>
          {(['Cian ↔ Rojo', 'Magenta ↔ Verde', 'Amarillo ↔ Azul'] as const).map((l, i) => (
            <Row key={l} label={l} value={params[key][i]} min={-100} max={100}
              onChange={(v) => { const arr = [...params[key]] as [number, number, number]; arr[i] = v; set({ [key]: arr } as Partial<AdjustmentParams>); }} onCommit={commit} />
          ))}
        </fieldset>
      );
      return <>{tone('Sombras', 'shadows')}{tone('Medios tonos', 'midtones')}{tone('Iluminaciones', 'highlights')}</>;
    }
    case 'blackWhite': return <>{R('Rojos', 'reds', -200, 300)}{R('Amarillos', 'yellows', -200, 300)}{R('Verdes', 'greens', -200, 300)}{R('Cianes', 'cyans', -200, 300)}{R('Azules', 'blues', -200, 300)}{R('Magentas', 'magentas', -200, 300)}</>;
    case 'invert': return <p className="hint">Invierte los colores de las capas inferiores.</p>;
    case 'threshold': return R('Nivel de umbral', 'level', 1, 255);
    case 'posterize': return R('Niveles', 'levels', 2, 255);
    case 'gradientMap': return <><ColorField label="Sombras" value={params.from} onChange={(c) => onChange({ ...params, from: c }, true)} /><ColorField label="Iluminaciones" value={params.to} onChange={(c) => onChange({ ...params, to: c }, true)} /></>;
    case 'solidColor': return <ColorField label="Color" value={params.color} onChange={(c) => onChange({ ...params, color: c }, true)} />;
    case 'photoFilter': {
      const hex = toHex(params.color);
      const preset = PHOTO_FILTERS.find(([, h]) => h === hex)?.[1] ?? '';
      return (
        <>
          <label className="adj-row"><span>Filtro</span>
            <select value={preset} aria-label="Filtro" onChange={(e) => e.target.value && onChange({ ...params, color: toRgba(e.target.value) }, true)}>
              {!preset && <option value="">Personalizado</option>}
              {PHOTO_FILTERS.map(([n, h]) => <option key={h} value={h}>{n}</option>)}
            </select>
          </label>
          <ColorField label="Color" value={params.color} onChange={(c) => onChange({ ...params, color: c }, true)} />
          {R('Densidad', 'density', 1, 100)}
          <label className="adj-row"><span>Conservar luminosidad</span><input type="checkbox" checked={params.preserveLuminosity} onChange={(e) => onChange({ ...params, preserveLuminosity: e.target.checked }, true)} /></label>
        </>
      );
    }
    case 'selectiveColor': return <SelectiveColorEditor params={params} onChange={onChange} />;
    case 'channelMixer': return <ChannelMixerEditor params={params} onChange={onChange} />;
  }
}

function SelectiveColorEditor({ params, onChange }: { params: Extract<AdjustmentParams, { type: 'selectiveColor' }>; onChange: OnChange }) {
  const [range, setRange] = useState<SelectiveRange>('reds');
  const v = params.ranges[range];
  const set = (i: number, x: number, commit: boolean) => {
    const arr = [...v] as [number, number, number, number]; arr[i] = x;
    onChange({ ...params, ranges: { ...params.ranges, [range]: arr } }, commit);
  };
  return (
    <>
      <label className="adj-row"><span>Colores</span>
        <select value={range} aria-label="Colores" onChange={(e) => setRange(e.target.value as SelectiveRange)}>
          {SELECTIVE_RANGES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
        </select>
      </label>
      {(['Cian', 'Magenta', 'Amarillo', 'Negro'] as const).map((l, i) => (
        <Row key={l} label={l} value={v[i]} min={-100} max={100} onChange={(x) => set(i, x, false)} onCommit={() => onChange(params, true)} />
      ))}
      <div className="adj-row adj-radio">
        <label><input type="radio" checked={params.relative} onChange={() => onChange({ ...params, relative: true }, true)} /> Relativo</label>
        <label><input type="radio" checked={!params.relative} onChange={() => onChange({ ...params, relative: false }, true)} /> Absoluto</label>
      </div>
    </>
  );
}

function ChannelMixerEditor({ params, onChange }: { params: Extract<AdjustmentParams, { type: 'channelMixer' }>; onChange: OnChange }) {
  const [out, setOut] = useState<'red' | 'green' | 'blue'>('red');
  const key = params.monochrome ? 'red' : out;
  const v = params[key];
  const set = (i: number, x: number) => { const arr = [...v] as [number, number, number, number]; arr[i] = x; onChange({ ...params, [key]: arr }, false); };
  const commit = () => onChange(params, true);
  return (
    <>
      <label className="adj-row"><span>Canal de salida</span>
        <select value={params.monochrome ? 'gray' : out} aria-label="Canal de salida" disabled={params.monochrome} onChange={(e) => setOut(e.target.value as 'red')}>
          {params.monochrome ? <option value="gray">Gris</option> : <><option value="red">Rojo</option><option value="green">Verde</option><option value="blue">Azul</option></>}
        </select>
      </label>
      {(['Rojo', 'Verde', 'Azul', 'Constante'] as const).map((l, i) => (
        <Row key={l} label={l} value={v[i]} min={-200} max={200} onChange={(x) => set(i, x)} onCommit={commit} />
      ))}
      <p className="hint">Total: {v[0] + v[1] + v[2]} %</p>
      <label className="adj-row"><span>Monocromo</span><input type="checkbox" checked={params.monochrome}
        onChange={(e) => onChange(e.target.checked ? { ...params, monochrome: true, red: [40, 40, 20, 0] } : { ...params, monochrome: false, red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0] }, true)} /></label>
    </>
  );
}
