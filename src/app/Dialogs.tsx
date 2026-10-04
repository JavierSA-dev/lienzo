import { useEffect, useRef, useState, type ReactNode } from 'react';
import { engine } from '../engine/client';
import { useStore, toRgba } from './store';
import { saveCurrent, COMMANDS, formatKeys, BROWSER_RESERVED } from './commands';
import { PRESETS } from './Home';
import { AdjustmentEditor } from './Adjustments';
import { defaultAdjustment, ADJUSTMENT_LABELS } from '../engine/adjust';
import { BLEND_GROUPS, type AdjustmentParams, type AdjustmentType, type BlendMode, type RGBA } from '../engine/types';
import type { FilterName, FilterParams } from '../engine/filters';
import { LiquifyDialog } from './Liquify';
import { ColorPickerDialog } from './ColorPicker';
import { LayerStyleDialog } from './LayerStyle';
import { WarpTextDialog } from './TextPanels';
import { NewArtboardDialog, ExportAsDialog } from './Artboards';
import { GenerativeDialog } from './Generative';
import { ColorRangeDialog, RefineDialog } from './SelectDialogs';

export function Modal({ title, children, onOk, okLabel = 'OK', onClose, wide }: { title: string; children: ReactNode; onOk: () => void; okLabel?: string; onClose: () => void; wide?: boolean }) {
  const cb = useRef({ onOk, onClose });
  cb.current = { onOk, onClose };
  const formRef = useRef<HTMLFormElement>(null);
  // Como en Photoshop: Intro = OK y Esc = Cancelar aunque el foco no esté en el diálogo.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const inside = formRef.current?.contains(e.target as Node);
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cb.current.onClose(); return; }
      if (e.key === 'Enter' && !inside) { e.preventDefault(); e.stopImmediatePropagation(); formRef.current?.requestSubmit(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  return (
    <div className="modal-veil" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form ref={formRef} noValidate className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}
        onSubmit={(e) => { e.preventDefault(); cb.current.onOk(); }}
        onKeyDown={(e) => e.stopPropagation()}>
        <header>{title}</header>
        <div className="body">{children}</div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary">{okLabel}</button>
        </footer>
      </form>
    </div>
  );
}

const num = (v: string, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function NewDocDialog({ close }: { close: () => void }) {
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [name, setName] = useState('Sin título-1');
  const [bgMode, setBg] = useState<'white' | 'black' | 'transparent' | 'bg'>('white');
  const [artboard, setArtboard] = useState(false);
  return (
    <Modal title="Nuevo documento" okLabel="Crear" onClose={close} onOk={() => { engine.call('newDoc', w, h, bgMode, `${name}.psd`, artboard); close(); }}>
      <div className="preset-list">{PRESETS.map((p) => <button type="button" key={p.name} className="chip" onClick={() => { setW(p.w); setH(p.h); }}>{p.name}</button>)}</div>
      <label className="field">Nombre<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label className="field">Anchura (px)<input type="number" min={1} max={30000} value={w} onChange={(e) => setW(num(e.target.value, 1))} /></label>
      <label className="field">Altura (px)<input type="number" min={1} max={30000} value={h} onChange={(e) => setH(num(e.target.value, 1))} /></label>
      <label className="field">Fondo
        <select value={bgMode} onChange={(e) => setBg(e.target.value as typeof bgMode)}>
          <option value="white">Blanco</option><option value="black">Negro</option><option value="bg">Color de fondo</option><option value="transparent">Transparente</option>
        </select>
      </label>
      <label className="field">Mesas de trabajo<span><input type="checkbox" checked={artboard} onChange={(e) => setArtboard(e.target.checked)} aria-label="Mesas de trabajo" /> Para varias piezas (post, historia, miniatura…)</span></label>
    </Modal>
  );
}

function ImageSizeDialog({ close }: { close: () => void }) {
  const doc = useStore((s) => s.doc);
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [keep, setKeep] = useState(true);
  const ratio = doc.width / doc.height;
  return (
    <Modal title="Tamaño de imagen" onClose={close} onOk={() => { engine.call('resizeImage', w, h); close(); }}>
      <label className="field">Anchura (px)<input type="number" min={1} value={w} autoFocus onChange={(e) => { const v = num(e.target.value, 1); setW(v); if (keep) setH(Math.max(1, Math.round(v / ratio))); }} /></label>
      <label className="field">Altura (px)<input type="number" min={1} value={h} onChange={(e) => { const v = num(e.target.value, 1); setH(v); if (keep) setW(Math.max(1, Math.round(v * ratio))); }} /></label>
      <label className="field">Proporciones<span><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Restringir</span></label>
      <span className="hint">{Math.round((w / doc.width) * 100)} % · se calcula en paralelo en todos los núcleos; la interfaz no se bloquea.</span>
    </Modal>
  );
}

function CanvasSizeDialog({ close }: { close: () => void }) {
  const doc = useStore((s) => s.doc);
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [anchor, setAnchor] = useState(4);
  return (
    <Modal title="Tamaño de lienzo" onClose={close} onOk={() => { engine.call('canvasSize', w, h, anchor); close(); }}>
      <label className="field">Anchura (px)<input type="number" min={1} value={w} autoFocus onChange={(e) => setW(num(e.target.value, 1))} /></label>
      <label className="field">Altura (px)<input type="number" min={1} value={h} onChange={(e) => setH(num(e.target.value, 1))} /></label>
      <div className="field">Ancla
        <div className="anchor-grid">{Array.from({ length: 9 }, (_, i) => <button type="button" key={i} className={i === anchor ? 'on' : ''} onClick={() => setAnchor(i)} aria-label={`Ancla ${i}`} />)}</div>
      </div>
    </Modal>
  );
}


/** Ajuste destructivo (Imagen > Ajustes) con vista previa en vivo. */
function AdjustDialog({ type, close }: { type: AdjustmentType; close: () => void }) {
  const fg = useStore((s) => s.fg), bg = useStore((s) => s.bg);
  const [params, setParams] = useState<AdjustmentParams>(() => defaultAdjustment(type, toRgba(fg), toRgba(bg)));
  const [previewOn, setPreviewOn] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (previewOn) engine.call('applyAdjustment', params, true); else engine.call('restorePreview'); }, 60);
  }, [params, previewOn]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const cancel = () => { if (timer.current) clearTimeout(timer.current); engine.call('endPreview', false); close(); };
  return (
    <Modal title={ADJUSTMENT_LABELS[type]} onClose={cancel} wide={type === 'curves' || type === 'colorBalance'}
      onOk={async () => { if (timer.current) clearTimeout(timer.current); await engine.call('applyAdjustment', params, true); await engine.call('endPreview', true); close(); }}>
      <AdjustmentEditor params={params} onChange={(p) => setParams(p)} />
      <label className="field">Previsualizar<span><input type="checkbox" checked={previewOn} onChange={(e) => setPreviewOn(e.target.checked)} /></span></label>
    </Modal>
  );
}

export const FILTER_FIELDS: Record<FilterName, { title: string; fields: [keyof FilterParams, string, number, number, number, number?][]; checks?: [keyof FilterParams, string][] }> = {
  gaussianBlur: { title: 'Desenfoque gaussiano', fields: [['radius', 'Radio (px)', 0.1, 250, 5, 0.1]] },
  boxBlur: { title: 'Desenfoque de cuadro', fields: [['radius', 'Radio (px)', 1, 250, 5]] },
  motionBlur: { title: 'Desenfoque de movimiento', fields: [['angle', 'Ángulo (°)', -90, 90, 0], ['distance', 'Distancia (px)', 1, 500, 20]] },
  unsharpMask: { title: 'Máscara de enfoque', fields: [['amount', 'Cantidad (%)', 1, 500, 100], ['radius', 'Radio (px)', 0.1, 250, 1.5, 0.1], ['threshold', 'Umbral (niveles)', 0, 255, 0]] },
  sharpen: { title: 'Enfocar', fields: [] },
  addNoise: { title: 'Añadir ruido', fields: [['amount', 'Cantidad (%)', 0.1, 400, 12.5, 0.1]], checks: [['gaussian', 'Gaussiano'], ['monochrome', 'Monocromático']] },
  median: { title: 'Mediana', fields: [['radius', 'Radio (px)', 1, 20, 2]] },
  mosaic: { title: 'Mosaico', fields: [['cell', 'Tamaño de celda (px)', 2, 200, 10]] },
  highPass: { title: 'Paso alto', fields: [['radius', 'Radio (px)', 0.1, 250, 10, 0.1]] },
  findEdges: { title: 'Hallar bordes', fields: [] },
  emboss: { title: 'Relieve', fields: [['angle', 'Ángulo (°)', -180, 180, 135], ['height', 'Altura (px)', 1, 10, 3], ['amount', 'Cantidad (%)', 1, 500, 100]] },
  clouds: { title: 'Nubes', fields: [] },
};

function FilterDialog({ name, close }: { name: FilterName; close: () => void }) {
  const def = FILTER_FIELDS[name];
  const [p, setP] = useState<FilterParams>(() => Object.fromEntries([...def.fields.map((f) => [f[0], f[4]]), ...(def.checks ?? []).map((c) => [c[0], false])]));
  const [previewOn, setPreviewOn] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewed = useRef('');
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (previewOn) { previewed.current = JSON.stringify(p); engine.call('applyFilter', name, p, true); }
      else { previewed.current = ''; engine.call('restorePreview'); }
    }, 200);
  }, [p, previewOn, name]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const cancel = () => { if (timer.current) clearTimeout(timer.current); engine.call('endPreview', false); close(); };
  return (
    <Modal title={def.title} onClose={cancel} onOk={async () => {
      if (timer.current) clearTimeout(timer.current);
      // Si la vista previa ya corresponde a estos valores se confirma tal cual; si no, se calcula de nuevo.
      if (previewed.current !== JSON.stringify(p)) await engine.call('restorePreview');
      close();
      await engine.call('commitFilterPreview', name, p);
    }}>
      {def.fields.map(([key, label, min, max, , step]) => (
        <label className="field" key={key}>{label}
          <span className="range-num">
            <input type="range" min={min} max={max} step={step ?? 1} value={p[key] as number} onChange={(e) => setP({ ...p, [key]: Number(e.target.value) })} />
            <input type="number" min={min} max={max} step={step ?? 1} value={p[key] as number} onChange={(e) => setP({ ...p, [key]: num(e.target.value, min) })} />
          </span>
        </label>
      ))}
      {def.checks?.map(([key, label]) => (
        <label className="field" key={key}>{label}<span><input type="checkbox" checked={!!p[key]} onChange={(e) => setP({ ...p, [key]: e.target.checked })} /></span></label>
      ))}
      <label className="field">Previsualizar<span><input type="checkbox" checked={previewOn} onChange={(e) => setPreviewOn(e.target.checked)} /></span></label>
      <span className="hint">Se aplica a la capa activa{useStore.getState().doc.selection ? ', dentro de la selección' : ''}. Ctrl+Alt+F lo repite.</span>
    </Modal>
  );
}

function NumberDialog({ title, label, initial, min, max, onOk, close }: { title: string; label: string; initial: number; min: number; max: number; onOk: (v: number) => void; close: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <Modal title={title} onClose={close} onOk={() => { onOk(Math.max(min, Math.min(max, v))); close(); }}>
      <label className="field">{label}<input type="number" autoFocus step="any" min={min} max={max} value={v} onChange={(e) => setV(num(e.target.value, min))} /></label>
    </Modal>
  );
}

function FillDialog({ close }: { close: () => void }) {
  const [what, setWhat] = useState('fg');
  const [color, setColor] = useState('#808080');
  const [preserve, setPreserve] = useState(false);
  const ok = () => {
    if (what === 'content') { engine.call('contentAwareFill'); close(); return; }
    const c: RGBA | 'fg' | 'bg' = what === 'fg' ? 'fg' : what === 'bg' ? 'bg' : what === 'gray' ? [128, 128, 128, 255] : what === 'white' ? [255, 255, 255, 255] : what === 'black' ? [0, 0, 0, 255] : toRgba(color);
    engine.call('fill', c, preserve);
    close();
  };
  return (
    <Modal title="Rellenar" onClose={close} onOk={ok}>
      <label className="field">Contenido
        <select value={what} onChange={(e) => setWhat(e.target.value)} autoFocus>
          <option value="fg">Color frontal</option><option value="bg">Color de fondo</option><option value="color">Color…</option>
          <option value="content" disabled={!useStore.getState().doc.selection}>Según el contenido</option>
          <option value="gray">Gris al 50 %</option><option value="black">Negro</option><option value="white">Blanco</option>
        </select>
      </label>
      {what === 'color' && <label className="field">Color<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>}
      <label className="field">Conservar transparencia<span><input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} /></span></label>
    </Modal>
  );
}


/** Lista de atajos con buscador; marca los que el navegador se reserva. */
function ShortcutsDialog({ close }: { close: () => void }) {
  const [q, setQ] = useState('');
  const list = COMMANDS.filter((c) => c.keys?.length && (!q || c.label.toLowerCase().includes(q.toLowerCase()) || c.keys.some((k) => k.toLowerCase().includes(q.toLowerCase()))));
  return (
    <Modal title="Métodos abreviados de teclado" okLabel="Cerrar" wide onClose={close} onOk={close}>
      <input className="search" placeholder="Buscar comando o tecla…" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
      <div className="shortcut-list">
        {list.map((c) => (
          <div key={c.id} className="shortcut-row">
            <span>{c.label}</span>
            <span className="keys">
              {c.keys!.map((k) => (
                <kbd key={k} className={BROWSER_RESERVED.has(k) ? 'reserved' : ''} title={BROWSER_RESERVED.has(k) ? 'El navegador la reserva: funciona en pantalla completa (F)' : undefined}>{formatKeys(k)}</kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
      <p className="hint">Atenuadas: el navegador las reserva en una pestaña normal. Pulsa F para pantalla completa y funcionarán todas, o usa la alternativa indicada al lado. Además: Espacio (mano), Ctrl+Espacio (zoom), Alt (cuentagotas al pintar), Ctrl (mover), 1-0 (opacidad), Mayús+1-0 (flujo), Alt+clic derecho arrastrando (tamaño/dureza del pincel).</p>
    </Modal>
  );
}

function AboutDialog({ close }: { close: () => void }) {
  const renderer = useStore((s) => s.renderer);
  return (
    <Modal title="Acerca de" okLabel="Cerrar" onClose={close} onOk={close}>
      <p>Editor de imágenes en el navegador. Motor en un Web Worker con composición en GPU (WebGL2), cálculo en paralelo con varios workers e IA local con ONNX Runtime.</p>
      <p className="hint">GPU: {renderer}</p>
      <p className="hint">Modelo de quitar fondo: U²-Net (u2netp), licencia Apache-2.0.</p>
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const close = () => useStore.getState().setDialog(null);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'new': return <NewDocDialog close={close} />;
    case 'imageSize': return <ImageSizeDialog close={close} />;
    case 'canvasSize': return <CanvasSizeDialog close={close} />;
    case 'export': return <ExportAsDialog close={close} />;
    case 'adjust': return <AdjustDialog type={dialog.type} close={close} />;
    case 'filter': return <FilterDialog name={dialog.name} close={close} />;
    case 'feather': return <NumberDialog title="Calar selección" label="Radio de calado (px)" initial={5} min={0.5} max={500} onOk={(v) => engine.call('featherSelection', v)} close={close} />;
    case 'grow': return <NumberDialog title={dialog.dir > 0 ? 'Expandir selección' : 'Contraer selección'} label={`${dialog.dir > 0 ? 'Expandir' : 'Contraer'} (px)`} initial={5} min={1} max={100} onOk={(v) => engine.call('growSelection', v * dialog.dir)} close={close} />;
    case 'fill': return <FillDialog close={close} />;
    case 'rotateArbitrary': return <NumberDialog title="Rotar lienzo" label="Ángulo (°, + horario)" initial={0} min={-359.99} max={359.99} onOk={(v) => engine.call('rotateArbitrary', v)} close={close} />;
    case 'layerStyle': return <LayerStyleDialog close={close} />;
    case 'newGuide': return <NewGuideDialog close={close} />;
    case 'applyImage': return <ApplyImageDialog close={close} />;
    case 'stroke': return <StrokeDialog close={close} />;
    case 'newLayer': return <NewLayerDialog close={close} />;
    case 'warpText': return <WarpTextDialog close={close} />;
    case 'newArtboard': return <NewArtboardDialog close={close} />;
    case 'colorRange': return <ColorRangeDialog close={close} />;
    case 'refine': return <RefineDialog close={close} />;
    case 'colorPicker': return <ColorPickerDialog which={dialog.which} close={close} />;
    case 'confirmClose': return <ConfirmCloseDialog docId={dialog.docId} close={close} />;
    case 'shortcuts': return <ShortcutsDialog close={close} />;
    case 'liquify': return <LiquifyDialog close={close} />;
    case 'generative': return <GenerativeDialog close={close} />;
    case 'about': return <AboutDialog close={close} />;
  }
}

/** ¿Guardar los cambios antes de cerrar? (Guardar / No guardar / Cancelar, como Photoshop). */
function ConfirmCloseDialog({ docId, close }: { docId: number; close: () => void }) {
  const tab = useStore((s) => s.doc.docs.find((x) => x.id === docId));
  useEffect(() => { if (!tab) close(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!tab) return null;
  const save = async () => {
    if (useStore.getState().doc.activeDocId !== docId) await engine.call('switchDoc', docId);
    close();
    if (await saveCurrent()) await engine.call('closeDoc', docId);
  };
  return (
    <Modal title="Lienzo" okLabel="Guardar" onClose={close} onOk={save}>
      <p className="confirm-text">¿Quieres guardar los cambios de «{tab.name}» antes de cerrarlo?</p>
      <button type="button" className="btn" data-testid="dont-save" onClick={() => { close(); engine.call('closeDoc', docId); }}>No guardar</button>
    </Modal>
  );
}

/** Vista > Nueva guía… */
function NewGuideDialog({ close }: { close: () => void }) {
  const [dir, setDir] = useState<'h' | 'v'>('v');
  const [pos, setPos] = useState(0);
  return (
    <Modal title="Nueva guía" onClose={close} onOk={() => { engine.call('addGuide', dir, pos); useStore.getState().setOpts({ guides: true }); close(); }}>
      <div className="field">Orientación
        <span>
          <label><input type="radio" checked={dir === 'h'} onChange={() => setDir('h')} /> Horizontal</label>{' '}
          <label><input type="radio" checked={dir === 'v'} onChange={() => setDir('v')} /> Vertical</label>
        </span>
      </div>
      <label className="field">Posición (px)<input type="number" step="any" autoFocus value={pos} onChange={(e) => setPos(num(e.target.value, 0))} /></label>
    </Modal>
  );
}

const APPLY_MODES: [string, string][] = [
  ['normal', 'Normal'], ['multiply', 'Multiplicar'], ['screen', 'Trama'], ['overlay', 'Superponer'], ['soft-light', 'Luz suave'],
  ['hard-light', 'Luz fuerte'], ['linear-light', 'Luz lineal'], ['darken', 'Oscurecer'], ['lighten', 'Aclarar'],
  ['color-dodge', 'Sobreexposición de color'], ['color-burn', 'Subexposición de color'], ['linear-burn', 'Subexposición lineal'],
  ['difference', 'Diferencia'], ['exclusion', 'Exclusión'], ['add', 'Añadir'], ['subtract', 'Restar'], ['divide', 'Dividir'],
];

/** Imagen > Aplicar imagen… (base de la separación de frecuencias y de los cálculos de canales). */
function ApplyImageDialog({ close }: { close: () => void }) {
  const doc = useStore((s) => s.doc);
  const layers = doc.layers.filter((l) => l.kind !== 'group' && l.kind !== 'adjustment');
  const [source, setSource] = useState<string>('merged');
  const [channel, setChannel] = useState(0);
  const [invert, setInvert] = useState(false);
  const [blend, setBlend] = useState('multiply');
  const [opacity, setOpacity] = useState(100);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState(0);
  const [preserve, setPreserve] = useState(false);
  const scaled = blend === 'add' || blend === 'subtract';
  return (
    <Modal title="Aplicar imagen" onClose={close} onOk={() => {
      engine.call('applyImage', { source: source === 'merged' ? 'merged' : Number(source), channel, invert, blend, opacity: opacity / 100, scale, offset, preserve });
      close();
    }}>
      <label className="field">Capa de origen
        <select value={source} aria-label="Capa de origen" onChange={(e) => setSource(e.target.value)} autoFocus>
          <option value="merged">Combinado</option>
          {[...layers].reverse().map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      <label className="field">Canal
        <select value={channel} aria-label="Canal" onChange={(e) => setChannel(Number(e.target.value))}>
          <option value={0}>RGB</option><option value={1}>Rojo</option><option value={2}>Verde</option><option value={3}>Azul</option>
        </select>
      </label>
      <label className="field">Invertir<span><input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /></span></label>
      <label className="field">Fusión
        <select value={blend} aria-label="Fusión" onChange={(e) => setBlend(e.target.value)}>{APPLY_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </label>
      <label className="field">Opacidad (%)<input type="number" min={0} max={100} value={opacity} onChange={(e) => setOpacity(num(e.target.value, 100))} /></label>
      {scaled && <>
        <label className="field">Escala<input type="number" step="any" min={1} max={2} value={scale} onChange={(e) => setScale(Math.max(1, Math.min(2, num(e.target.value, 1))))} /></label>
        <label className="field">Desplazamiento<input type="number" min={-255} max={255} value={offset} onChange={(e) => setOffset(num(e.target.value, 0))} /></label>
      </>}
      <label className="field">Conservar transparencia<span><input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} /></span></label>
      <span className="hint">Separación de frecuencias (8 bits): capa de detalle ← Aplicar imagen de la capa original, Restar, escala 2, desplazamiento 128; después, modo Luz lineal.</span>
    </Modal>
  );
}

/** Edición > Contornear… (anchura, color y posición del trazo alrededor de la selección). */
function StrokeDialog({ close }: { close: () => void }) {
  const fg = useStore((s) => s.fg);
  const [width, setWidth] = useState(3);
  const [color, setColor] = useState(fg);
  const [location, setLocation] = useState<'inside' | 'center' | 'outside'>('center');
  const [opacity, setOpacity] = useState(100);
  const [preserve, setPreserve] = useState(false);
  return (
    <Modal title="Contornear" onClose={close} onOk={() => { engine.call('strokeSelection', { width, color: toRgba(color), location, opacity: opacity / 100, preserve }); close(); }}>
      <label className="field">Anchura (px)<input type="number" autoFocus min={1} max={250} value={width} onChange={(e) => setWidth(Math.max(1, Math.min(250, num(e.target.value, 1))))} /></label>
      <label className="field">Color<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
      <fieldset className="field-radios"><legend>Posición</legend>
        {([['inside', 'Interior'], ['center', 'Centro'], ['outside', 'Exterior']] as const).map(([v, l]) => (
          <label key={v}><input type="radio" name="stroke-loc" checked={location === v} onChange={() => setLocation(v)} /> {l}</label>
        ))}
      </fieldset>
      <label className="field">Opacidad (%)<input type="number" min={1} max={100} value={opacity} onChange={(e) => setOpacity(Math.max(1, Math.min(100, num(e.target.value, 100))))} /></label>
      <label className="field">Conservar transparencia<span><input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} /></span></label>
    </Modal>
  );
}

/** Modos con color neutro (gris 50 %, blanco o negro) para "Rellenar con color neutro". */
const NEUTRAL_LABEL: Partial<Record<BlendMode, string>> = {
  overlay: 'gris al 50 %', 'soft-light': 'gris al 50 %', 'hard-light': 'gris al 50 %', 'vivid-light': 'gris al 50 %', 'linear-light': 'gris al 50 %', 'pin-light': 'gris al 50 %',
  multiply: 'blanco', 'color-burn': 'blanco', 'linear-burn': 'blanco', darken: 'blanco', divide: 'blanco', 'darker-color': 'blanco',
  screen: 'negro', 'color-dodge': 'negro', 'linear-dodge': 'negro', lighten: 'negro', difference: 'negro', exclusion: 'negro', subtract: 'negro', 'lighter-color': 'negro',
};

/** Capa > Nueva > Capa… (Ctrl+Mayús+N): nombre, recorte, modo, opacidad y relleno neutro. */
function NewLayerDialog({ close }: { close: () => void }) {
  const [name, setName] = useState('');
  const [clip, setClip] = useState(false);
  const [blend, setBlend] = useState<BlendMode>('normal');
  const [opacity, setOpacity] = useState(100);
  const [neutral, setNeutral] = useState(false);
  const nl = NEUTRAL_LABEL[blend];
  return (
    <Modal title="Nueva capa" onClose={close} onOk={() => { engine.call('newLayerWith', { name, blend, opacity: opacity / 100, clip, neutral: neutral && !!nl }); close(); }}>
      <label className="field">Nombre<input autoFocus value={name} placeholder="Capa" onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">Usar la capa anterior para crear una máscara de recorte<span><input type="checkbox" checked={clip} onChange={(e) => setClip(e.target.checked)} /></span></label>
      <label className="field">Modo
        <select value={blend} aria-label="Modo" onChange={(e) => setBlend(e.target.value as BlendMode)}>
          {BLEND_GROUPS.map((g, i) => <optgroup key={i} label="—">{g.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</optgroup>)}
        </select>
      </label>
      <label className="field">Opacidad (%)<input type="number" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Math.max(0, Math.min(100, num(e.target.value, 100))))} /></label>
      <label className={`field ${nl ? '' : 'disabled'}`}>{nl ? `Rellenar con color neutro para ${BLEND_GROUPS.flat().find((b) => b.id === blend)?.label} (${nl})` : 'No existe color neutro para este modo'}
        <span><input type="checkbox" disabled={!nl} checked={neutral && !!nl} onChange={(e) => setNeutral(e.target.checked)} aria-label="Rellenar con color neutro" /></span></label>
    </Modal>
  );
}
