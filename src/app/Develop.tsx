// Filtro > Revelado… (Ctrl+Mayús+A): revelado de fotos con vista previa, antes/después e histograma.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { engine } from '../engine/client';
import { useStore } from './store';
import { Modal } from './Dialogs';
import { CAMERA_RAW_DEFAULTS, type CameraRaw } from '../engine/camraw';

type Preview = { w: number; h: number; before: Uint8ClampedArray; after: Uint8ClampedArray; hist: Uint32Array; frame: { x: number; y: number; w: number; h: number } };

const HSL_NAMES = ['Rojos', 'Naranjas', 'Amarillos', 'Verdes', 'Aguamarinas', 'Azules', 'Morados', 'Magentas'];
const HSL_COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#8e24aa', '#d81b60'];

const fresh = (): CameraRaw => structuredClone(CAMERA_RAW_DEFAULTS);

/** Ajuste automático (como «Auto» de Camera Raw): exposición, contraste, iluminaciones, sombras, blancos y negros. */
function autoTone(hist: Uint32Array): Partial<CameraRaw> {
  const lum = new Float64Array(256);
  let n = 0;
  for (let i = 0; i < 256; i++) { lum[i] = hist[i] * 0.2126 + hist[256 + i] * 0.7152 + hist[512 + i] * 0.0722; n += lum[i]; }
  if (!n) return {};
  const pct = (p: number) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += lum[i]; if (acc >= n * p) return i / 255; } return 1; };
  const lo = pct(0.005), mid = pct(0.5), hi = pct(0.995);
  const exposure = Math.max(-2, Math.min(2, Math.log2(0.46 / Math.max(0.02, mid)) * 0.6));
  const range = hi - lo;
  return {
    exposure: Math.round(exposure * 100) / 100,
    contrast: Math.round(Math.max(-30, Math.min(40, (0.85 - range) * 60))),
    highlights: Math.round(hi > 0.97 ? -45 : -15), shadows: Math.round(lo < 0.04 ? 35 : 15),
    whites: Math.round(Math.max(-40, Math.min(40, (0.96 - hi) * 120))), blacks: Math.round(Math.max(-40, Math.min(30, (0.03 - lo) * 160))),
    vibrance: 12,
  };
}

function Slider({ label, value, min, max, step = 1, onChange, gradient, dflt = 0 }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; gradient?: string; dflt?: number }) {
  return (
    <label className="dv-slider" onDoubleClick={() => onChange(dflt)} title="Doble clic: restablecer">
      <span className="dv-label">{label}</span>
      <input type="number" className="dv-num" value={Math.round(value * 100) / 100} step={step} min={min} max={max} aria-label={`${label} (valor)`}
        onKeyDown={(e) => e.stopPropagation()} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} style={gradient ? { background: gradient } : undefined}
        className={gradient ? 'dv-grad' : ''} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Section({ title, children, open: o = false }: { title: string; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(o);
  return (
    <div className={`dv-section ${open ? 'open' : ''}`}>
      <button type="button" className="dv-head" onClick={() => setOpen(!open)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{title}</button>
      {open && <div className="dv-body">{children}</div>}
    </div>
  );
}

export function DevelopDialog({ close, edit }: { close: () => void; edit?: { layerId: number; index: number; cr: CameraRaw } }) {
  const [cr, setCr] = useState<CameraRaw>(() => (edit ? { ...fresh(), ...structuredClone(edit.cr) } : fresh()));
  const [pv, setPv] = useState<Preview | null>(null);
  const [view, setView] = useState<'after' | 'before' | 'split'>('after');
  const [hslTab, setHslTab] = useState<0 | 1 | 2>(0);
  const [bw, setBw] = useState(cr.saturation === -100);
  const cv = useRef<HTMLCanvasElement>(null), hc = useRef<HTMLCanvasElement>(null);
  const seq = useRef(0);
  const set = <K extends keyof CameraRaw>(k: K, v: CameraRaw[K]) => setCr((o) => ({ ...o, [k]: v }));

  // Al editar un filtro inteligente se oculta mientras tanto (la vista previa parte de la imagen sin él).
  useEffect(() => {
    if (edit) engine.call('setSmartFilter', edit.layerId, edit.index, { enabled: false }, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = ++seq.current;
    const t = setTimeout(() => {
      void engine.call<Preview | null>('developPreview', cr, 900).then((r) => { if (id === seq.current && r) setPv(r); });
    }, 50);
    return () => clearTimeout(t);
  }, [cr]);

  // Y alterna antes/después, P lo mismo (como el revelador de Photoshop).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' && (e.target as HTMLInputElement).type === 'number') return;
      if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); setView((v) => (v === 'after' ? 'split' : v === 'split' ? 'before' : 'after')); }
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); setView((v) => (v === 'before' ? 'after' : 'before')); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  useEffect(() => {
    const c = cv.current;
    if (!c || !pv) return;
    c.width = pv.w; c.height = pv.h;
    const ctx = c.getContext('2d')!;
    const img = new ImageData(pv.w, pv.h);
    if (view === 'split') {
      const half = pv.w >> 1;
      for (let y = 0; y < pv.h; y++) {
        img.data.set(pv.before.subarray(y * pv.w * 4, (y * pv.w + half) * 4), y * pv.w * 4);
        img.data.set(pv.after.subarray((y * pv.w + half) * 4, (y + 1) * pv.w * 4), (y * pv.w + half) * 4);
      }
    } else img.data.set(view === 'before' ? pv.before : pv.after);
    ctx.putImageData(img, 0, 0);
    if (view === 'split') { ctx.fillStyle = '#fff'; ctx.fillRect((pv.w >> 1) - 1, 0, 2, pv.h); }
    // Histograma RGB (como Camera Raw).
    const h = hc.current;
    if (!h) return;
    const hx = h.getContext('2d')!, W = h.width, H = h.height;
    hx.clearRect(0, 0, W, H);
    let mx = 1;
    for (let i = 2; i < 766; i++) if (i % 256 > 1 && i % 256 < 254) mx = Math.max(mx, pv.hist[i]);
    hx.globalCompositeOperation = 'lighter';
    ['#e33', '#3c3', '#36f'].forEach((col, c2) => {
      hx.fillStyle = col; hx.globalAlpha = 0.75;
      hx.beginPath(); hx.moveTo(0, H);
      for (let i = 0; i < 256; i++) hx.lineTo((i / 255) * W, H - Math.min(1, pv.hist[c2 * 256 + i] / mx) * H);
      hx.lineTo(W, H); hx.closePath(); hx.fill();
    });
    hx.globalCompositeOperation = 'source-over'; hx.globalAlpha = 1;
  }, [pv, view]);

  const cancel = () => {
    if (edit) engine.call('setSmartFilter', edit.layerId, edit.index, { enabled: true }, false);
    close();
  };
  const ok = () => {
    const full = { ...cr, frame: pv?.frame, scale: 1, radius: undefined };
    if (edit) engine.call('setSmartFilter', edit.layerId, edit.index, { enabled: true, params: { cr: full } });
    else engine.call('applyFilter', 'cameraRaw', { cr: full });
    close();
  };
  const hsl = (band: number, v: number) => setCr((o) => { const a = [...o.hsl]; a[band * 3 + hslTab] = v; return { ...o, hsl: a }; });
  const grade = (k: 'sh' | 'mid' | 'hi', i: 0 | 1, v: number) => setCr((o) => { const g = { ...o.grade, [k]: [...o.grade[k]] as [number, number] }; g[k][i] = v; return { ...o, grade: g }; });
  const curve = (i: number, v: number) => setCr((o) => { const c = [...o.curve] as CameraRaw['curve']; c[i] = v; return { ...o, curve: c }; });
  const tempGrad = 'linear-gradient(90deg,#3b6fd6,#ddd,#e2b33b)', tintGrad = 'linear-gradient(90deg,#3fae4a,#ddd,#c84fc4)';

  return (
    <Modal title="Revelado" wide onClose={cancel} onOk={ok}>
      <div className="develop" data-testid="develop">
        <div className="dv-view">
          <canvas ref={cv} data-testid="develop-preview" />
          <div className="dv-viewbar">
            <div className="seg">
              {(['after', 'split', 'before'] as const).map((v) => (
                <button type="button" key={v} className={`chip ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>{v === 'after' ? 'Después' : v === 'before' ? 'Antes' : 'Antes | Después'}</button>
              ))}
            </div>
            <span className="hint">Y: comparar · P: ver el original</span>
          </div>
        </div>
        <div className="dv-panel">
          <canvas ref={hc} className="dv-hist" width={260} height={90} />
          <div className="dv-top">
            <button type="button" className="chip" onClick={() => pv && setCr((o) => ({ ...o, ...autoTone(pv.hist) }))}>Auto</button>
            <button type="button" className={`chip ${bw ? 'on' : ''}`} onClick={() => { const nb = !bw; setBw(nb); set('saturation', nb ? -100 : 0); }}>Blanco y negro</button>
            <button type="button" className="chip" title="Restablecer todo" onClick={() => { setCr(fresh()); setBw(false); }}><RotateCcw size={13} /> Restablecer</button>
          </div>
          <div className="dv-scroll">
            <Section title="Básico" open>
              <div className="dv-sub">Balance de blancos</div>
              <Slider label="Temperatura" value={cr.temp} min={-100} max={100} gradient={tempGrad} onChange={(v) => set('temp', v)} />
              <Slider label="Matiz" value={cr.tint} min={-100} max={100} gradient={tintGrad} onChange={(v) => set('tint', v)} />
              <div className="dv-sub">Tono</div>
              <Slider label="Exposición" value={cr.exposure} min={-5} max={5} step={0.05} onChange={(v) => set('exposure', v)} />
              <Slider label="Contraste" value={cr.contrast} min={-100} max={100} onChange={(v) => set('contrast', v)} />
              <Slider label="Iluminaciones" value={cr.highlights} min={-100} max={100} onChange={(v) => set('highlights', v)} />
              <Slider label="Sombras" value={cr.shadows} min={-100} max={100} onChange={(v) => set('shadows', v)} />
              <Slider label="Blancos" value={cr.whites} min={-100} max={100} onChange={(v) => set('whites', v)} />
              <Slider label="Negros" value={cr.blacks} min={-100} max={100} onChange={(v) => set('blacks', v)} />
              <div className="dv-sub">Presencia</div>
              <Slider label="Textura" value={cr.texture} min={-100} max={100} onChange={(v) => set('texture', v)} />
              <Slider label="Claridad" value={cr.clarity} min={-100} max={100} onChange={(v) => set('clarity', v)} />
              <Slider label="Neblina" value={cr.dehaze} min={-100} max={100} onChange={(v) => set('dehaze', v)} />
              <Slider label="Intensidad" value={cr.vibrance} min={-100} max={100} onChange={(v) => set('vibrance', v)} />
              <Slider label="Saturación" value={cr.saturation} min={-100} max={100} onChange={(v) => { set('saturation', v); setBw(v === -100); }} />
            </Section>
            <Section title="Curva">
              <Slider label="Iluminaciones" value={cr.curve[3]} min={-100} max={100} onChange={(v) => curve(3, v)} />
              <Slider label="Claros" value={cr.curve[2]} min={-100} max={100} onChange={(v) => curve(2, v)} />
              <Slider label="Oscuros" value={cr.curve[1]} min={-100} max={100} onChange={(v) => curve(1, v)} />
              <Slider label="Sombras" value={cr.curve[0]} min={-100} max={100} onChange={(v) => curve(0, v)} />
            </Section>
            <Section title="Mezclador de color">
              <div className="seg dv-tabs">
                {(['Tono', 'Saturación', 'Luminancia'] as const).map((t, i) => <button type="button" key={t} className={`chip ${hslTab === i ? 'on' : ''}`} onClick={() => setHslTab(i as 0 | 1 | 2)}>{t}</button>)}
              </div>
              {HSL_NAMES.map((nm, i) => (
                <Slider key={nm} label={nm} value={cr.hsl[i * 3 + hslTab]} min={-100} max={100} onChange={(v) => hsl(i, v)}
                  gradient={hslTab === 1 ? `linear-gradient(90deg,#888,${HSL_COLORS[i]})` : hslTab === 2 ? `linear-gradient(90deg,#000,${HSL_COLORS[i]},#fff)` : `linear-gradient(90deg,${HSL_COLORS[(i + 7) % 8]},${HSL_COLORS[i]},${HSL_COLORS[(i + 1) % 8]})`} />
              ))}
            </Section>
            <Section title="Gradación de color">
              {([['sh', 'Sombras'], ['mid', 'Medios tonos'], ['hi', 'Iluminaciones']] as const).map(([k, nm]) => (
                <div key={k} className="dv-grade">
                  <div className="dv-sub">{nm}</div>
                  <Slider label="Tono" value={cr.grade[k][0]} min={0} max={360} gradient="linear-gradient(90deg,red,yellow,lime,cyan,blue,magenta,red)" onChange={(v) => grade(k, 0, v)} />
                  <Slider label="Saturación" value={cr.grade[k][1]} min={0} max={100} onChange={(v) => grade(k, 1, v)} />
                </div>
              ))}
              <Slider label="Fusión" value={cr.grade.blending} min={0} max={100} dflt={50} onChange={(v) => setCr((o) => ({ ...o, grade: { ...o.grade, blending: v } }))} />
              <Slider label="Equilibrio" value={cr.grade.balance} min={-100} max={100} onChange={(v) => setCr((o) => ({ ...o, grade: { ...o.grade, balance: v } }))} />
            </Section>
            <Section title="Detalle">
              <div className="dv-sub">Enfoque</div>
              <Slider label="Cantidad" value={cr.sharpen} min={0} max={150} onChange={(v) => set('sharpen', v)} />
              <Slider label="Radio" value={cr.sharpenRadius} min={0.5} max={3} step={0.1} dflt={1} onChange={(v) => set('sharpenRadius', v)} />
              <Slider label="Máscara" value={cr.sharpenMasking} min={0} max={100} onChange={(v) => set('sharpenMasking', v)} />
              <div className="dv-sub">Reducción de ruido</div>
              <Slider label="Luminancia" value={cr.noise} min={0} max={100} onChange={(v) => set('noise', v)} />
              <Slider label="Color" value={cr.colorNoise} min={0} max={100} onChange={(v) => set('colorNoise', v)} />
            </Section>
            <Section title="Efectos">
              <div className="dv-sub">Viñeta</div>
              <Slider label="Cantidad" value={cr.vignette} min={-100} max={100} onChange={(v) => set('vignette', v)} />
              <Slider label="Punto medio" value={cr.vigMidpoint} min={0} max={100} dflt={50} onChange={(v) => set('vigMidpoint', v)} />
              <Slider label="Redondez" value={cr.vigRoundness} min={-100} max={100} onChange={(v) => set('vigRoundness', v)} />
              <Slider label="Desvanecer" value={cr.vigFeather} min={0} max={100} dflt={50} onChange={(v) => set('vigFeather', v)} />
              <div className="dv-sub">Grano</div>
              <Slider label="Cantidad" value={cr.grain} min={0} max={100} onChange={(v) => set('grain', v)} />
              <Slider label="Tamaño" value={cr.grainSize} min={0} max={100} dflt={25} onChange={(v) => set('grainSize', v)} />
            </Section>
          </div>
        </div>
      </div>
      <span className="hint">{useStore.getState().doc.layers.find((l) => l.id === useStore.getState().doc.activeLayerId)?.kind === 'smart' ? 'Se añadirá como filtro inteligente (editable).' : 'Se aplica a la capa activa. Conviértela en objeto inteligente para poder editarlo después.'}</span>
    </Modal>
  );
}
