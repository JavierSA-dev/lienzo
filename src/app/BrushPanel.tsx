// Pinceles: selector de valores preestablecidos, Ajustes de pincel (F5), simetría y pincel mezclador.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { engine } from '../engine/client';
import { useStore } from './store';
import { Modal } from './Dialogs';
import { BUILTIN_PRESETS, presetSettings, tipAlpha, importAbr, saveUserPresets, deleteUserPreset, ensureTip, type BrushPreset } from './brushPresets';
import { DEFAULT_DYN, type BrushDynamics, type BrushSettings, type DynControl, type Symmetry } from '../engine/types';

/** Dibuja un trazo de muestra (aproximado) con la punta y las dinámicas del valor. */
export function drawStrokePreview(cv: HTMLCanvasElement, s: Partial<BrushSettings>, alpha: { w: number; h: number; alpha: Uint8Array } | null) {
  const W = cv.width, H = cv.height, c = cv.getContext('2d')!;
  c.clearRect(0, 0, W, H);
  let tip: HTMLCanvasElement | null = null;
  if (alpha) {
    tip = document.createElement('canvas'); tip.width = alpha.w; tip.height = alpha.h;
    const id = new ImageData(alpha.w, alpha.h);
    for (let i = 0; i < alpha.alpha.length; i++) { id.data[i * 4 + 3] = alpha.alpha[i]; }
    tip.getContext('2d')!.putImageData(id, 0, 0);
  }
  const d = { ...DEFAULT_DYN, ...s.dyn };
  const size = Math.min(H * 0.55, 26), spacing = Math.max(0.02, s.spacing ?? 0.25) * size;
  let seed = 3; const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pts: [number, number, number][] = [];
  for (let x = size; x < W - size; x += 2) pts.push([x, H / 2 + Math.sin((x / W) * Math.PI * 2) * H * 0.22, Math.sin((x / W) * Math.PI)]);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc < spacing) continue;
    acc = 0;
    const [x, y, p] = pts[i], dir = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    const n = Math.max(1, Math.round(d.count * (1 - d.countJitter * R())));
    for (let k = 0; k < n; k++) {
      let sz = size * (d.sizeControl === 'pressure' || s.pressureSize ? Math.max(d.minDiameter, p) : 1) * (1 - d.sizeJitter * R());
      sz = Math.max(1, sz);
      const ang = ((s.angle ?? 0) * Math.PI) / 180 + (d.angleControl === 'direction' ? dir : 0) + (R() - 0.5) * Math.PI * 2 * d.angleJitter;
      const sc = d.scatter * size * (R() - 0.5) * 2, ox = d.scatterBoth ? sc : -Math.sin(dir) * sc, oy = d.scatterBoth ? d.scatter * size * (R() - 0.5) * 2 : Math.cos(dir) * sc;
      c.save(); c.translate(x + ox, y + oy); c.rotate(ang); c.scale(1, s.roundness ?? 1);
      c.globalAlpha = Math.min(1, (s.flow ?? 1) * (1 - d.opacityJitter * R()) * (d.opacityControl === 'pressure' ? p : 1)) * (s.wetEdges ? 0.6 : 1);
      if (tip) { const k2 = sz / Math.max(tip.width, tip.height); c.drawImage(tip, -tip.width * k2 / 2, -tip.height * k2 / 2, tip.width * k2, tip.height * k2); }
      else {
        const g = c.createRadialGradient(0, 0, 0, 0, 0, sz / 2), hd = s.hardness ?? 1;
        g.addColorStop(0, '#ddd'); g.addColorStop(Math.min(0.99, hd), '#ddd'); g.addColorStop(1, 'rgba(221,221,221,0)');
        c.fillStyle = g; c.beginPath(); c.arc(0, 0, sz / 2, 0, Math.PI * 2); c.fill();
      }
      c.restore();
    }
  }
  if (tip) { c.globalCompositeOperation = 'source-in'; c.fillStyle = '#ddd'; c.fillRect(0, 0, W, H); c.globalCompositeOperation = 'source-over'; }
}

function PresetThumb({ p }: { p: BrushPreset }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) drawStrokePreview(ref.current, p.settings, tipAlpha(p)); }, [p]);
  return <canvas ref={ref} width={150} height={34} />;
}

/** Botón de la barra de opciones con el pincel actual y el selector de valores preestablecidos. */
export function BrushPresetPicker() {
  const brush = useStore((s) => s.brush);
  const setBrush = useStore((s) => s.setBrush);
  const user = useStore((s) => s.userBrushes);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const all = [...BUILTIN_PRESETS, ...user];
  const groups = [...new Set(all.map((p) => p.group ?? 'Mis pinceles'))];
  const choose = async (p: BrushPreset) => { setBrush(await presetSettings(p)); setOpen(false); };
  const onAbr = async (f: File | undefined) => {
    if (!f) return;
    try {
      const list = await importAbr(await f.arrayBuffer(), f.name);
      for (const p of list) await ensureTip(p);
      useStore.setState({ userBrushes: [...useStore.getState().userBrushes.filter((u) => !list.some((l) => l.name === u.name)), ...list] });
      await saveUserPresets(list);
      useStore.getState().toast(`${list.length} pinceles importados de ${f.name}`);
    } catch (e) { useStore.getState().toast(`No se pudo leer ${f.name}: ${(e as Error).message}`, 'error'); }
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!(e.target as Element).closest?.('.brush-pop, .brush-pick')) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <span className="brush-pick-wrap">
      <button ref={btn} className="chip brush-pick" title="Valores preestablecidos de pincel" aria-label="Valores preestablecidos de pincel" onClick={() => setOpen(!open)}>
        <span className="brush-dot" style={{ background: `radial-gradient(circle, #ddd ${Math.round((brush.hardness ?? 1) * 60)}%, transparent 70%)` }} />
        {Math.round(brush.size)} <ChevronDown size={12} />
      </button>
      {open && createPortal(
        // En un portal: la barra de opciones recorta lo que sobresale.
        <div className="brush-pop" data-testid="brush-presets" onKeyDown={(e) => e.stopPropagation()}
          style={(() => { const r = btn.current?.getBoundingClientRect(); return r ? { left: Math.min(r.left, window.innerWidth - 340), top: r.bottom + 6 } : undefined; })()}>
          <label className="adj-row"><span>Tamaño</span><input type="range" min={1} max={1000} value={brush.size} aria-label="Tamaño del pincel" onChange={(e) => setBrush({ size: Number(e.target.value) })} /><span className="val">{Math.round(brush.size)} px</span></label>
          {!brush.tip && <label className="adj-row"><span>Dureza</span><input type="range" min={0} max={100} value={Math.round(brush.hardness * 100)} aria-label="Dureza del pincel" onChange={(e) => setBrush({ hardness: Number(e.target.value) / 100 })} /><span className="val">{Math.round(brush.hardness * 100)} %</span></label>}
          <div className="brush-list">
            {groups.map((g) => (
              <div key={g}>
                <div className="dv-sub">{g}</div>
                {all.filter((p) => (p.group ?? 'Mis pinceles') === g).map((p) => (
                  <div key={p.name} className={`brush-item ${brush.preset === p.name ? 'on' : ''}`} role="button" tabIndex={0} onClick={() => void choose(p)} title={p.name}>
                    <PresetThumb p={p} /><span>{p.name}</span>
                    {p.user && <button className="icon-btn" aria-label={`Eliminar ${p.name}`} onClick={(e) => { e.stopPropagation(); useStore.setState({ userBrushes: useStore.getState().userBrushes.filter((u) => u.name !== p.name) }); void deleteUserPreset(p.name); }}>×</button>}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="row-btns">
            <button className="chip" onClick={() => input.current?.click()}>Importar pinceles (.abr)…</button>
            <button className="chip" onClick={() => { setOpen(false); useStore.getState().setDialog({ kind: 'brushSettings' }); }}>Ajustes de pincel… (F5)</button>
          </div>
          <input ref={input} type="file" accept=".abr" hidden data-testid="abr-input" onChange={(e) => { void onAbr(e.target.files?.[0]); e.target.value = ''; }} />
        </div>, document.body,
      )}
    </span>
  );
}

/** Edición > Definir valor de pincel… (lo oscuro de la selección pinta). */
export async function defineBrushPreset() {
  const r = await engine.call<{ w: number; h: number; alpha: Uint8Array } | null>('defineBrushTip');
  if (!r) return;
  const n = useStore.getState().userBrushes.filter((u) => u.group === 'Mis pinceles').length + 1;
  const name = `Pincel ${n}`;
  const p: BrushPreset = { name, group: 'Mis pinceles', user: true, settings: { size: Math.max(r.w, r.h), spacing: 0.25 }, tip: { id: `user:${Date.now()}`, w: r.w, h: r.h, alpha: r.alpha } };
  await ensureTip(p);
  useStore.setState({ userBrushes: [...useStore.getState().userBrushes, p] });
  await saveUserPresets([p]);
  useStore.getState().setBrush(await presetSettings(p));
  useStore.getState().toast(`Pincel «${name}» definido (${r.w} × ${r.h} px)`);
}

// ------------------------------------------------------------------ Ajustes de pincel (F5)

const SECTIONS = ['Forma de la punta', 'Dinámica de forma', 'Dispersión', 'Dinámica de color', 'Transferencia', 'Otras opciones'] as const;
const CONTROLS: [DynControl, string][] = [['off', 'Desactivado'], ['pressure', 'Presión de la pluma'], ['fade', 'Desvanecer'], ['direction', 'Dirección'], ['initialDirection', 'Dirección inicial']];

function Row({ label, value, min, max, step = 1, unit = '%', scale = 100, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; scale?: number; onChange: (v: number) => void }) {
  return (
    <label className="dv-slider">
      <span className="dv-label">{label}{unit && <span className="hint"> ({unit})</span>}</span>
      <input type="number" className="dv-num" aria-label={`${label} (valor)`} value={Math.round(value * scale * 10) / 10} min={min} max={max} step={step}
        onKeyDown={(e) => e.stopPropagation()} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)) / scale)} />
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value * scale} onChange={(e) => onChange(Number(e.target.value) / scale)} />
    </label>
  );
}

function Ctrl({ label, value, onChange, only }: { label: string; value: DynControl; onChange: (v: DynControl) => void; only?: DynControl[] }) {
  return (
    <label className="field">{label}
      <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value as DynControl)}>
        {CONTROLS.filter(([k]) => !only || only.includes(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </label>
  );
}

export function BrushSettingsDialog({ close }: { close: () => void }) {
  const brush = useStore((s) => s.brush);
  const setBrush = useStore((s) => s.setBrush);
  const user = useStore((s) => s.userBrushes);
  const [sec, setSec] = useState<(typeof SECTIONS)[number]>('Forma de la punta');
  const before = useRef(brush);
  const d = { ...DEFAULT_DYN, ...brush.dyn };
  const setD = (p: Partial<BrushDynamics>) => setBrush({ dyn: { ...d, ...p } });
  const cv = useRef<HTMLCanvasElement>(null);
  const tipP = brush.tip ? [...BUILTIN_PRESETS, ...user].find((p) => p.tip?.id === brush.tip) : undefined;
  useEffect(() => { if (cv.current) drawStrokePreview(cv.current, brush, tipP ? tipAlpha(tipP) : null); }, [brush, tipP]);
  const saveAs = async () => {
    const name = `${brush.preset ?? 'Pincel'} (personalizado ${user.length + 1})`;
    const p: BrushPreset = { name, group: 'Mis pinceles', user: true, settings: { ...brush, preset: undefined }, tip: tipP?.tip };
    useStore.setState({ userBrushes: [...user, p] });
    await saveUserPresets([p]);
    setBrush({ preset: name });
    useStore.getState().toast(`Guardado como «${name}»`);
  };
  return (
    <Modal title="Ajustes de pincel" wide onClose={() => { setBrush(before.current); close(); }} onOk={close}>
      <div className="brush-settings" data-testid="brush-settings">
        <nav>{SECTIONS.map((s) => <button type="button" key={s} className={`chip ${sec === s ? 'on' : ''}`} onClick={() => setSec(s)}>{s}</button>)}</nav>
        <div className="bs-body">
          {sec === 'Forma de la punta' && <>
            <Row label="Tamaño" value={brush.size} min={1} max={2500} unit="px" scale={1} onChange={(v) => setBrush({ size: v })} />
            <Row label="Ángulo" value={brush.angle ?? 0} min={-180} max={180} unit="°" scale={1} onChange={(v) => setBrush({ angle: v })} />
            <Row label="Redondez" value={brush.roundness ?? 1} min={1} max={100} onChange={(v) => setBrush({ roundness: v })} />
            {!brush.tip && <Row label="Dureza" value={brush.hardness} min={0} max={100} onChange={(v) => setBrush({ hardness: v })} />}
            <Row label="Espaciado" value={brush.spacing} min={1} max={1000} onChange={(v) => setBrush({ spacing: v })} />
            <label className="check-row"><input type="checkbox" checked={!!brush.flipX} onChange={(e) => setBrush({ flipX: e.target.checked })} /> Voltear X</label>
            <label className="check-row"><input type="checkbox" checked={!!brush.flipY} onChange={(e) => setBrush({ flipY: e.target.checked })} /> Voltear Y</label>
          </>}
          {sec === 'Dinámica de forma' && <>
            <Row label="Variación de tamaño" value={d.sizeJitter} min={0} max={100} onChange={(v) => setD({ sizeJitter: v })} />
            <Ctrl label="Control del tamaño" value={d.sizeControl} only={['off', 'pressure', 'fade']} onChange={(v) => setD({ sizeControl: v })} />
            <Row label="Diámetro mínimo" value={d.minDiameter} min={0} max={100} onChange={(v) => setD({ minDiameter: v })} />
            <Row label="Variación del ángulo" value={d.angleJitter} min={0} max={100} onChange={(v) => setD({ angleJitter: v })} />
            <Ctrl label="Control del ángulo" value={d.angleControl} only={['off', 'direction', 'initialDirection']} onChange={(v) => setD({ angleControl: v })} />
            <Row label="Variación de redondez" value={d.roundJitter} min={0} max={100} onChange={(v) => setD({ roundJitter: v })} />
            <Row label="Redondez mínima" value={d.minRoundness} min={1} max={100} onChange={(v) => setD({ minRoundness: v })} />
            <Row label="Pasos de desvanecimiento" value={d.fadeSteps} min={1} max={500} unit="" scale={1} onChange={(v) => setD({ fadeSteps: v })} />
          </>}
          {sec === 'Dispersión' && <>
            <Row label="Dispersión" value={d.scatter} min={0} max={1000} onChange={(v) => setD({ scatter: v })} />
            <label className="check-row"><input type="checkbox" checked={d.scatterBoth} onChange={(e) => setD({ scatterBoth: e.target.checked })} /> Ambos ejes</label>
            <Row label="Recuento" value={d.count} min={1} max={16} unit="" scale={1} onChange={(v) => setD({ count: Math.round(v) })} />
            <Row label="Variación de recuento" value={d.countJitter} min={0} max={100} onChange={(v) => setD({ countJitter: v })} />
          </>}
          {sec === 'Dinámica de color' && <>
            <label className="check-row"><input type="checkbox" checked={d.perTip} onChange={(e) => setD({ perTip: e.target.checked })} /> Aplicar a cada punta</label>
            <Row label="Variación frontal/fondo" value={d.fgBgJitter} min={0} max={100} onChange={(v) => setD({ fgBgJitter: v })} />
            <Ctrl label="Control frontal/fondo" value={d.fgBgControl} only={['off', 'pressure', 'fade']} onChange={(v) => setD({ fgBgControl: v })} />
            <Row label="Variación de tono" value={d.hueJitter} min={0} max={100} onChange={(v) => setD({ hueJitter: v })} />
            <Row label="Variación de saturación" value={d.satJitter} min={0} max={100} onChange={(v) => setD({ satJitter: v })} />
            <Row label="Variación de brillo" value={d.briJitter} min={0} max={100} onChange={(v) => setD({ briJitter: v })} />
          </>}
          {sec === 'Transferencia' && <>
            <Row label="Variación de opacidad" value={d.opacityJitter} min={0} max={100} onChange={(v) => setD({ opacityJitter: v })} />
            <Ctrl label="Control de opacidad" value={d.opacityControl} only={['off', 'pressure', 'fade']} onChange={(v) => setD({ opacityControl: v })} />
            <Row label="Variación de flujo" value={d.flowJitter} min={0} max={100} onChange={(v) => setD({ flowJitter: v })} />
            <Ctrl label="Control de flujo" value={d.flowControl} only={['off', 'pressure', 'fade']} onChange={(v) => setD({ flowControl: v })} />
          </>}
          {sec === 'Otras opciones' && <>
            <label className="check-row"><input type="checkbox" checked={!!brush.noise} onChange={(e) => setBrush({ noise: e.target.checked })} /> Ruido</label>
            <label className="check-row"><input type="checkbox" checked={!!brush.wetEdges} onChange={(e) => setBrush({ wetEdges: e.target.checked })} /> Bordes húmedos</label>
            <Row label="Suavizado" value={brush.smoothing ?? 0} min={0} max={100} onChange={(v) => setBrush({ smoothing: v })} />
          </>}
        </div>
        <canvas ref={cv} className="bs-preview" width={520} height={70} data-testid="brush-preview" />
        <div className="row-btns"><button type="button" className="chip" onClick={() => void saveAs()}>Guardar como pincel nuevo</button></div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ simetría

const SYM_LABELS: [Symmetry['type'] | 'off', string][] = [['off', 'Desactivada'], ['vertical', 'Vertical'], ['horizontal', 'Horizontal'], ['dual', 'Eje doble'], ['diagonal', 'Diagonal'], ['radial', 'Radial'], ['mandala', 'Mandala']];

export function SymmetryControl() {
  const sym = useStore((s) => s.symmetry);
  const doc = useStore((s) => s.doc);
  const set = (type: Symmetry['type'] | 'off', segments = sym?.segments ?? 6) => {
    const next: Symmetry | null = type === 'off' ? null : { type, cx: doc.width / 2, cy: doc.height / 2, angle: 0, segments };
    useStore.setState({ symmetry: next });
    engine.call('setSymmetry', next);
  };
  return (
    <>
      <label className="opt">Simetría
        <select value={sym?.type ?? 'off'} aria-label="Simetría" onChange={(e) => set(e.target.value as Symmetry['type'] | 'off')}>
          {SYM_LABELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {(sym?.type === 'radial' || sym?.type === 'mandala') && (
        <label className="opt">Segmentos
          <select value={sym.segments} aria-label="Segmentos" onChange={(e) => set(sym.type, Number(e.target.value))}>
            {[2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 24].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

/** Opciones del pincel mezclador. */
export function MixerOptions() {
  const brush = useStore((s) => s.brush);
  const setBrush = useStore((s) => s.setBrush);
  const mx = brush.mixer ?? { wet: 0.5, load: 0.5, mix: 0.5, loadEach: true, cleanEach: false, sampleAll: false };
  const set = (p: Partial<typeof mx>) => setBrush({ mixer: { ...mx, ...p } });
  const COMBOS: [string, number, number, number][] = [['Seco', 0, 0.5, 0], ['Húmedo', 0.5, 0.5, 0.5], ['Muy húmedo', 0.8, 0.5, 0.8], ['Muy húmedo, mezcla intensa', 1, 0.2, 1]];
  return (
    <>
      <button className="chip" title="Cargar el pincel con el color frontal" onClick={() => engine.call('mixerReservoir', 'load')}>Cargar</button>
      <button className="chip" title="Limpiar el pincel" onClick={() => engine.call('mixerReservoir', 'clean')}>Limpiar</button>
      <label className="opt">
        <select aria-label="Combinación de mezcla" value="" onChange={(e) => { const c = COMBOS.find((x) => x[0] === e.target.value); if (c) set({ wet: c[1], load: c[2], mix: c[3] }); }}>
          <option value="">Combinaciones…</option>
          {COMBOS.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      {(['wet', 'load', 'mix'] as const).map((k) => (
        <label className="opt" key={k}>{k === 'wet' ? 'Humedad' : k === 'load' ? 'Carga' : 'Mezcla'}
          <input type="range" min={0} max={100} value={Math.round(mx[k] * 100)} aria-label={k === 'wet' ? 'Humedad' : k === 'load' ? 'Carga' : 'Mezcla'} onChange={(e) => set({ [k]: Number(e.target.value) / 100 })} />
          <span className="val">{Math.round(mx[k] * 100)}%</span>
        </label>
      ))}
      <button className={`chip ${mx.loadEach ? 'on' : ''}`} title="Cargar el pincel tras cada trazo" onClick={() => set({ loadEach: !mx.loadEach })}>Cargar en cada trazo</button>
      <button className={`chip ${mx.cleanEach ? 'on' : ''}`} title="Limpiar el pincel tras cada trazo" onClick={() => set({ cleanEach: !mx.cleanEach })}>Limpiar en cada trazo</button>
    </>
  );
}
