import { useEffect, useRef, useState } from 'react';
import { engine } from '../engine/client';
import { useStore, toRgba } from './store';
import { Modal } from './Dialogs';
import type { ColorRangeParams, RefineParams } from '../engine/smartsel';

type Preview = { w: number; h: number; image: Uint8ClampedArray };

/** Pide la imagen reducida del documento una vez al abrir el diálogo. */
function useDocPreview(size: number, sampleAll = true) {
  const [img, setImg] = useState<Preview | null>(null);
  useEffect(() => {
    let live = true;
    void engine.call<Preview | null>('docPreview', size, sampleAll).then((r) => { if (live) setImg(r); });
    return () => { live = false; };
  }, [size, sampleAll]);
  return img;
}

/** Ejecuta `fn` tras `ms` sin cambios (las vistas previas no bloquean los deslizadores). */
function useDebounced(fn: () => void, deps: unknown[], ms = 90) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const t = setTimeout(() => ref.current(), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

const PRESETS: { id: NonNullable<ColorRangeParams['preset']>; label: string }[] = [
  { id: 'sampled', label: 'Colores de muestra' }, { id: 'reds', label: 'Rojos' }, { id: 'yellows', label: 'Amarillos' },
  { id: 'greens', label: 'Verdes' }, { id: 'cyans', label: 'Cianes' }, { id: 'blues', label: 'Azules' },
  { id: 'magentas', label: 'Magentas' }, { id: 'highlights', label: 'Iluminaciones' }, { id: 'midtones', label: 'Medios tonos' },
  { id: 'shadows', label: 'Sombras' }, { id: 'skin', label: 'Tonos de piel' },
];

/** Selección > Gama de colores… (cuentagotas, +muestra, tolerancia, rangos predefinidos e invertir). */
export function ColorRangeDialog({ close }: { close: () => void }) {
  const sampleAll = useStore((s) => s.opts.sampleAll);
  const img = useDocPreview(320, sampleAll);
  const [preset, setPreset] = useState<NonNullable<ColorRangeParams['preset']>>('sampled');
  const [fuzz, setFuzz] = useState(40);
  const [invert, setInvert] = useState(false);
  const [samples, setSamples] = useState<[number, number, number][]>(() => { const c = toRgba(useStore.getState().fg); return [[c[0], c[1], c[2]]]; });
  const [dropper, setDropper] = useState<'set' | 'add'>('set');
  const [view, setView] = useState<'selection' | 'image'>('selection');
  const [mask, setMask] = useState<{ w: number; h: number; data: Uint8Array } | null>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const params = (): ColorRangeParams => ({ samples, fuzziness: fuzz, preset, invert });

  useDebounced(() => {
    void engine.call<{ w: number; h: number; data: Uint8Array } | null>('colorRangeMask', params(), sampleAll, 320).then(setMask);
  }, [samples, fuzz, preset, invert, sampleAll]);

  useEffect(() => {
    const c = cv.current;
    const src = view === 'image' ? img : mask;
    if (!c || !src) return;
    c.width = src.w; c.height = src.h;
    const id = new ImageData(src.w, src.h);
    if (view === 'image' && img) id.data.set(img.image);
    else if (mask) for (let i = 0; i < mask.data.length; i++) { const v = mask.data[i]; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    c.getContext('2d')!.putImageData(id, 0, 0);
  }, [mask, img, view]);

  const pick = async (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = useStore.getState().doc;
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * d.width, y = ((e.clientY - r.top) / r.height) * d.height;
    const c = await engine.call<[number, number, number] | null>('sampleColor', x, y, sampleAll);
    if (!c) return;
    setPreset('sampled');
    const add = dropper === 'add' || e.shiftKey;
    setSamples((s) => (add ? [...s, c] : [c]));
  };

  return (
    <Modal title="Gama de colores" wide onClose={close} onOk={() => { engine.call('colorRangeMask', params(), sampleAll, 0); close(); }}>
      <label className="field">Seleccionar
        <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)} aria-label="Seleccionar">
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      {preset === 'sampled' && (
        <div className="row-tools">
          <button type="button" className={`chip ${dropper === 'set' ? 'on' : ''}`} onClick={() => setDropper('set')} title="Cuentagotas">Cuentagotas</button>
          <button type="button" className={`chip ${dropper === 'add' ? 'on' : ''}`} onClick={() => setDropper('add')} title="Añadir a muestra (Mayús)">+ Añadir</button>
          <span className="cr-swatches">{samples.map((s, i) => <i key={i} style={{ background: `rgb(${s.join(',')})` }} />)}</span>
        </div>
      )}
      <label className="field sfield">Tolerancia <b>{fuzz}</b>
        <input type="range" min={0} max={200} value={fuzz} onChange={(e) => setFuzz(Number(e.target.value))} aria-label="Tolerancia" disabled={preset !== 'sampled' && preset !== 'skin'} />
      </label>
      <div className="sel-preview">
        <canvas ref={cv} className="cr-canvas" data-testid="cr-preview" onPointerDown={pick} style={{ cursor: preset === 'sampled' ? 'crosshair' : 'default' }} />
      </div>
      <div className="row-tools">
        <label><input type="radio" checked={view === 'selection'} onChange={() => setView('selection')} /> Selección</label>
        <label><input type="radio" checked={view === 'image'} onChange={() => setView('image')} /> Imagen</label>
        <label className="push"><input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Invertir</label>
      </div>
    </Modal>
  );
}

type RefineView = 'onion' | 'overlay' | 'black' | 'white' | 'bw' | 'layer';
const VIEWS: { id: RefineView; label: string; key: string }[] = [
  { id: 'onion', label: 'Papel cebolla', key: 'O' }, { id: 'overlay', label: 'Superposición', key: 'V' },
  { id: 'black', label: 'Sobre negro', key: 'A' }, { id: 'white', label: 'Sobre blanco', key: 'T' },
  { id: 'bw', label: 'Blanco y negro', key: 'K' }, { id: 'layer', label: 'En capas', key: 'Y' },
];

type Output = 'selection' | 'mask' | 'newLayerMask';

/** Selección > Seleccionar y aplicar máscara… (Ctrl+Alt+R): radio inteligente, ajustes globales, descontaminar y salida. */
export function RefineDialog({ close }: { close: () => void }) {
  const [view, setView] = useState<RefineView>('overlay');
  const [opacity, setOpacity] = useState(50);
  const [p, setP] = useState<RefineParams>({ radius: 0, smart: false, smooth: 0, feather: 0, contrast: 0, shift: 0 });
  const [deco, setDeco] = useState(false);
  const [decoAmt, setDecoAmt] = useState(100);
  const [out, setOut] = useState<Output>('selection');
  const [res, setRes] = useState<{ w: number; h: number; image: Uint8ClampedArray; mask: Uint8Array } | null>(null);
  const [none, setNone] = useState(false);
  const cv = useRef<HTMLCanvasElement>(null);
  const set = <K extends keyof RefineParams>(k: K, v: RefineParams[K]) => setP((o) => ({ ...o, [k]: v }));

  useDebounced(() => {
    void engine.call<typeof res>('refineSelection', { ...p, output: 'preview', previewSize: 480 }).then((r) => { if (r) setRes(r); else setNone(true); });
  }, [p]);

  // Atajos de vista como en Photoshop (O, V, A, T, K, Y).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const v = VIEWS.find((x) => x.key === e.key.toUpperCase());
      if (v) { e.preventDefault(); setView(v.id); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  useEffect(() => {
    const c = cv.current;
    if (!c || !res) return;
    const { w, h, image, mask } = res;
    c.width = w; c.height = h;
    const id = new ImageData(w, h), o = id.data, a = opacity / 100;
    for (let i = 0; i < w * h; i++) {
      const m = mask[i] / 255, j = i * 4;
      let r = image[j], g = image[j + 1], b = image[j + 2];
      switch (view) {
        case 'bw': r = g = b = mask[i]; break;
        case 'black': r *= m; g *= m; b *= m; break;
        case 'white': r = r * m + 255 * (1 - m); g = g * m + 255 * (1 - m); b = b * m + 255 * (1 - m); break;
        case 'overlay': { const k = (1 - m) * a; r = r * (1 - k) + 255 * k; g *= 1 - k; b *= 1 - k; break; }
        case 'onion': { const k = 1 - (1 - m) * a; const ch = ((i % w) >> 3 ^ ((i / w) | 0) >> 3) & 1 ? 204 : 255; r = r * k + ch * (1 - k); g = g * k + ch * (1 - k); b = b * k + ch * (1 - k); break; }
        case 'layer': { const ch = ((i % w) >> 3 ^ ((i / w) | 0) >> 3) & 1 ? 204 : 255; r = r * m + ch * (1 - m); g = g * m + ch * (1 - m); b = b * m + ch * (1 - m); break; }
      }
      o[j] = r; o[j + 1] = g; o[j + 2] = b; o[j + 3] = 255;
    }
    c.getContext('2d')!.putImageData(id, 0, 0);
  }, [res, view, opacity]);

  const apply = () => {
    engine.call('refineSelection', { ...p, decontaminate: deco && out === 'newLayerMask' ? decoAmt : 0, output: out });
    close();
  };

  const slider = (label: string, k: keyof RefineParams, min: number, max: number, unit = '', step = 1) => (
    <label className="field sfield">{label} <b>{p[k] as number}{unit}</b>
      <input type="range" min={min} max={max} step={step} value={p[k] as number} aria-label={label} onChange={(e) => set(k, Number(e.target.value) as never)} />
    </label>
  );

  return (
    <Modal title="Seleccionar y aplicar máscara" wide onClose={close} onOk={apply}>
      {none ? <p className="hint">Haz primero una selección (o elige una capa con máscara).</p> : (
        <div className="refine-layout">
          <div className="sel-preview"><canvas ref={cv} className="cr-canvas" data-testid="refine-preview" /></div>
          <div className="refine-controls">
            <label className="field">Vista
              <select value={view} onChange={(e) => setView(e.target.value as RefineView)} aria-label="Vista">
                {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label} ({v.key})</option>)}
              </select>
            </label>
            {(view === 'overlay' || view === 'onion') && (
              <label className="field sfield">Opacidad <b>{opacity}%</b><input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Opacidad" /></label>
            )}
            <h4>Detección de bordes</h4>
            {slider('Radio', 'radius', 0, 250, ' px')}
            <label className="check-row"><input type="checkbox" checked={p.smart} onChange={(e) => set('smart', e.target.checked)} /> Radio inteligente</label>
            <h4>Ajustes globales</h4>
            {slider('Suavizar', 'smooth', 0, 100)}
            {slider('Calar', 'feather', 0, 100, ' px', 0.5)}
            {slider('Contraste', 'contrast', 0, 100, '%')}
            {slider('Desplazar borde', 'shift', -100, 100, '%')}
            <h4>Ajustes de salida</h4>
            <label className="check-row"><input type="checkbox" checked={deco} onChange={(e) => { setDeco(e.target.checked); if (e.target.checked) setOut('newLayerMask'); }} /> Descontaminar colores</label>
            {deco && <label className="field sfield">Cantidad <b>{decoAmt}%</b><input type="range" min={0} max={100} value={decoAmt} onChange={(e) => setDecoAmt(Number(e.target.value))} aria-label="Cantidad" /></label>}
            <label className="field">Enviar a
              <select value={out} onChange={(e) => setOut(e.target.value as Output)} aria-label="Enviar a">
                {!deco && <option value="selection">Selección</option>}
                {!deco && <option value="mask">Máscara de capa</option>}
                <option value="newLayerMask">Nueva capa con máscara de capa</option>
              </select>
            </label>
          </div>
        </div>
      )}
    </Modal>
  );
}
