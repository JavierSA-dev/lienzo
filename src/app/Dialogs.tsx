import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { engine } from '../engine/client';
import { useStore, toHex, toRgba } from './store';
import { exportImage, COMMANDS, formatKeys, BROWSER_RESERVED } from './commands';
import { PRESETS } from './Home';
import { AdjustmentEditor } from './Adjustments';
import { defaultAdjustment, ADJUSTMENT_LABELS } from '../engine/adjust';
import type { AdjustmentParams, AdjustmentType, LayerEffects, RGBA } from '../engine/types';
import type { FilterName, FilterParams } from '../engine/filters';
import { LiquifyDialog } from './Liquify';
import { GenerativeDialog } from './Generative';

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
  return (
    <Modal title="Nuevo documento" okLabel="Crear" onClose={close} onOk={() => { engine.call('newDoc', w, h, bgMode, `${name}.psd`); close(); }}>
      <div className="preset-list">{PRESETS.map((p) => <button type="button" key={p.name} className="chip" onClick={() => { setW(p.w); setH(p.h); }}>{p.name}</button>)}</div>
      <label className="field">Nombre<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label className="field">Anchura (px)<input type="number" min={1} max={30000} value={w} onChange={(e) => setW(num(e.target.value, 1))} /></label>
      <label className="field">Altura (px)<input type="number" min={1} max={30000} value={h} onChange={(e) => setH(num(e.target.value, 1))} /></label>
      <label className="field">Fondo
        <select value={bgMode} onChange={(e) => setBg(e.target.value as typeof bgMode)}>
          <option value="white">Blanco</option><option value="black">Negro</option><option value="bg">Color de fondo</option><option value="transparent">Transparente</option>
        </select>
      </label>
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

function ExportDialog({ close }: { close: () => void }) {
  const [fmt, setFmt] = useState<'image/png' | 'image/jpeg' | 'image/webp'>('image/png');
  const [q, setQ] = useState(90);
  return (
    <Modal title="Exportar como" okLabel="Exportar" onClose={close} onOk={() => { exportImage(fmt, q / 100); close(); }}>
      <label className="field">Formato
        <select value={fmt} onChange={(e) => setFmt(e.target.value as typeof fmt)}>
          <option value="image/png">PNG</option><option value="image/jpeg">JPEG</option><option value="image/webp">WebP</option>
        </select>
      </label>
      {fmt !== 'image/png' && <label className="field">Calidad: {q}<input type="range" min={1} max={100} value={q} onChange={(e) => setQ(Number(e.target.value))} /></label>}
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

const FILTER_FIELDS: Record<FilterName, { title: string; fields: [keyof FilterParams, string, number, number, number, number?][]; checks?: [keyof FilterParams, string][] }> = {
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
    const c: RGBA | 'fg' | 'bg' = what === 'fg' ? 'fg' : what === 'bg' ? 'bg' : what === 'gray' ? [128, 128, 128, 255] : what === 'white' ? [255, 255, 255, 255] : what === 'black' ? [0, 0, 0, 255] : toRgba(color);
    engine.call('fill', c, preserve);
    close();
  };
  return (
    <Modal title="Rellenar" onClose={close} onOk={ok}>
      <label className="field">Contenido
        <select value={what} onChange={(e) => setWhat(e.target.value)} autoFocus>
          <option value="fg">Color frontal</option><option value="bg">Color de fondo</option><option value="color">Color…</option>
          <option value="gray">Gris al 50 %</option><option value="black">Negro</option><option value="white">Blanco</option>
        </select>
      </label>
      {what === 'color' && <label className="field">Color<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>}
      <label className="field">Conservar transparencia<span><input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} /></span></label>
    </Modal>
  );
}

/** Estilo de capa: sombra paralela, resplandor exterior, trazo y superposición de color. */
function LayerStyleDialog({ close }: { close: () => void }) {
  const doc = useStore((s) => s.doc);
  const L = doc.layers.find((l) => l.id === doc.activeLayerId);
  const initial = useMemo<LayerEffects>(() => structuredClone(L?.effects ?? {}), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [fx, setFx] = useState<LayerEffects>(() => ({
    dropShadow: { enabled: false, color: [0, 0, 0, 255], opacity: 0.75, angle: 120, distance: 10, size: 10, ...initial.dropShadow },
    outerGlow: { enabled: false, color: [255, 255, 190, 255], opacity: 0.75, size: 12, ...initial.outerGlow },
    stroke: { enabled: false, color: [255, 0, 0, 255], size: 3, ...initial.stroke },
    colorOverlay: { enabled: false, color: [255, 0, 0, 255], opacity: 1, ...initial.colorOverlay },
  }));
  useEffect(() => { if (L) engine.call('setEffects', L.id, fx, false); }, [fx]); // eslint-disable-line react-hooks/exhaustive-deps
  const invalid = !L || L.kind === 'adjustment';
  useEffect(() => { if (invalid) { useStore.getState().toast('Los estilos de capa se aplican a capas de píxeles, texto o forma.'); close(); } }, [invalid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (invalid) return null;
  const upd = <K extends keyof LayerEffects>(k: K, patch: Partial<NonNullable<LayerEffects[K]>>) => setFx((cur) => ({ ...cur, [k]: { ...cur[k]!, ...patch } }));
  // Funciones de ayuda (no componentes) para que los controles no se vuelvan a montar al arrastrar.
  const section = (k: keyof LayerEffects, title: string, children: ReactNode) => (
    <fieldset className="adj-group" key={k}>
      <legend><label><input type="checkbox" checked={!!fx[k]?.enabled} onChange={(e) => upd(k, { enabled: e.target.checked })} /> {title}</label></legend>
      {fx[k]?.enabled && children}
    </fieldset>
  );
  const col = (k: keyof LayerEffects) => (
    <label className="adj-row" key={`${k}-c`}><span>Color</span><input type="color" value={toHex(fx[k]!.color)} onChange={(e) => upd(k, { color: toRgba(e.target.value) })} /></label>
  );
  const rng = (k: keyof LayerEffects, f: string, label: string, min: number, max: number, scale = 1) => {
    const v = (fx[k] as unknown as Record<string, number>)[f] * scale;
    return (
      <label className="adj-row" key={`${k}-${f}`}><span>{label}</span>
        <input type="range" min={min} max={max} value={v} onChange={(e) => upd(k, { [f]: Number(e.target.value) / scale } as never)} />
        <span className="val">{Math.round(v)}</span>
      </label>
    );
  };
  const restore = Object.keys(initial).length ? initial : undefined;
  return (
    <Modal title={`Estilo de capa · ${L.name}`} wide onClose={() => { engine.call('setEffects', L.id, restore, true); close(); }}
      onOk={() => { engine.call('setEffects', L.id, fx, true); close(); }}>
      {section('dropShadow', 'Sombra paralela', [col('dropShadow'), rng('dropShadow', 'opacity', 'Opacidad %', 0, 100, 100), rng('dropShadow', 'angle', 'Ángulo', -180, 180), rng('dropShadow', 'distance', 'Distancia', 0, 200), rng('dropShadow', 'size', 'Tamaño', 0, 100)])}
      {section('outerGlow', 'Resplandor exterior', [col('outerGlow'), rng('outerGlow', 'opacity', 'Opacidad %', 0, 100, 100), rng('outerGlow', 'size', 'Tamaño', 1, 100)])}
      {section('stroke', 'Trazo (exterior)', [col('stroke'), rng('stroke', 'size', 'Tamaño', 1, 50)])}
      {section('colorOverlay', 'Superposición de color', [col('colorOverlay'), rng('colorOverlay', 'opacity', 'Opacidad %', 0, 100, 100)])}
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
    case 'export': return <ExportDialog close={close} />;
    case 'adjust': return <AdjustDialog type={dialog.type} close={close} />;
    case 'filter': return <FilterDialog name={dialog.name} close={close} />;
    case 'feather': return <NumberDialog title="Calar selección" label="Radio de calado (px)" initial={5} min={0.5} max={500} onOk={(v) => engine.call('featherSelection', v)} close={close} />;
    case 'grow': return <NumberDialog title={dialog.dir > 0 ? 'Expandir selección' : 'Contraer selección'} label={`${dialog.dir > 0 ? 'Expandir' : 'Contraer'} (px)`} initial={5} min={1} max={100} onOk={(v) => engine.call('growSelection', v * dialog.dir)} close={close} />;
    case 'fill': return <FillDialog close={close} />;
    case 'layerStyle': return <LayerStyleDialog close={close} />;
    case 'shortcuts': return <ShortcutsDialog close={close} />;
    case 'liquify': return <LiquifyDialog close={close} />;
    case 'generative': return <GenerativeDialog close={close} />;
    case 'about': return <AboutDialog close={close} />;
  }
}
