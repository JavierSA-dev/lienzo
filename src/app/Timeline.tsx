// Ventana > Línea de tiempo: animación de cuadros (como Photoshop) y exportación a GIF.
import { useEffect, useRef, useState } from 'react';
import { ChevronsLeft, ChevronLeft, ChevronRight, Play, Square, Copy, Trash2, Repeat, Waypoints, X } from 'lucide-react';
import { engine } from '../engine/client';
import { useStore } from './store';
import { Modal } from './Dialogs';
import { download } from './commands';
import { makeZip } from './zip';

type Thumb = { w: number; h: number; data: Uint8ClampedArray };

const DELAYS: [number, string][] = [[0, 'Sin retardo'], [100, '0,1 s'], [200, '0,2 s'], [500, '0,5 s'], [1000, '1,0 s'], [2000, '2,0 s'], [5000, '5,0 s'], [10000, '10,0 s']];
const delayLabel = (ms: number) => DELAYS.find((d) => d[0] === ms)?.[1] ?? `${(ms / 1000).toFixed(2).replace('.', ',')} s`;

function FrameThumb({ t }: { t: Thumb | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !t) return;
    c.width = t.w; c.height = t.h;
    c.getContext('2d')!.putImageData(new ImageData(t.data as Uint8ClampedArray<ArrayBuffer>, t.w, t.h), 0, 0);
  }, [t]);
  return <canvas ref={ref} />;
}

export function Timeline() {
  const open = useStore((s) => s.timelineOpen);
  const doc = useStore((s) => s.doc);
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [playing, setPlaying] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const play = useRef<{ timer: number; stop: boolean } | null>(null);
  const frames = doc.frames ?? [];
  const active = doc.activeFrame ?? 0;

  // Miniaturas: poco después de cada cambio (no mientras se reproduce).
  useEffect(() => {
    if (!open || !doc.open || playing || !frames.length) return;
    const t = setTimeout(() => { engine.call<Thumb[]>('timelineThumbs', 56).then(setThumbs); }, 300);
    return () => clearTimeout(t);
  }, [open, doc, playing, frames.length]);

  const stop = () => { if (play.current) { play.current.stop = true; clearTimeout(play.current.timer); play.current = null; } setPlaying(false); };
  useEffect(() => () => stop(), []);
  useEffect(() => { if (!open || !doc.open) stop(); }, [open, doc.open]);

  const start = () => {
    if (frames.length < 2) return;
    stop();
    const p = { timer: 0, stop: false };
    play.current = p;
    setPlaying(true);
    let i = active, loops = 0;
    const loop = doc.loop ?? 0;
    const step = async () => {
      if (p.stop) return;
      const st = useStore.getState().doc;
      const fr = st.frames ?? [];
      const delay = Math.max(16, fr[i]?.delay ?? 100);
      p.timer = window.setTimeout(async () => {
        if (p.stop) return;
        i++;
        if (i >= fr.length) { i = 0; loops++; if (loop && loops >= loop) { stop(); return; } }
        await engine.call('timelineSelect', i);
        step();
      }, delay);
    };
    void engine.call('timelineSelect', i).then(step);
  };

  if (!open) return null;
  return (
    <section className="timeline" data-testid="timeline" aria-label="Línea de tiempo">
      <header className="timeline-head">
        <span className="timeline-title">Línea de tiempo</span>
        <button type="button" className="icon-btn" title="Cerrar" aria-label="Cerrar línea de tiempo" onClick={() => { stop(); useStore.setState({ timelineOpen: false }); }}><X size={14} /></button>
      </header>
      {!doc.open ? <div className="timeline-empty hint">Abre un documento.</div> : !frames.length ? (
        <div className="timeline-empty">
          <button type="button" className="btn primary" onClick={() => engine.call('timelineCreate')}>Crear animación de cuadros</button>
        </div>
      ) : (
        <>
          <div className="timeline-frames" role="listbox" aria-label="Cuadros">
            {frames.map((f, i) => (
              <div key={i} role="option" aria-selected={i === active} className={`frame ${i === active ? 'on' : ''}`} data-testid="frame"
                onClick={() => { if (!playing) engine.call('timelineSelect', i); }}>
                <span className="frame-n">{i + 1}</span>
                <div className="frame-thumb"><FrameThumb t={thumbs[i]} /></div>
                <button type="button" className="frame-delay" data-testid="frame-delay" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === i ? null : i); }}>{delayLabel(f.delay)} ▾</button>
                {menuFor === i && (
                  <div className="frame-menu" onClick={(e) => e.stopPropagation()}>
                    {DELAYS.map(([ms, l]) => <button type="button" key={ms} onClick={() => { engine.call('timelineDelay', i, ms); setMenuFor(null); }}>{l}</button>)}
                    <label className="frame-other">Otro
                      <input type="number" min={0} step={0.05} defaultValue={f.delay / 1000} aria-label="Retardo en segundos"
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { engine.call('timelineDelay', i, Math.max(0, Number((e.target as HTMLInputElement).value) || 0) * 1000); setMenuFor(null); } }} /> s
                    </label>
                    <button type="button" onClick={() => { engine.call('timelineDelay', 'all', f.delay); setMenuFor(null); }}>Aplicar a todos</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <footer className="timeline-foot">
            <label className="timeline-loop" title="Opciones de repetición"><Repeat size={13} />
              <select value={doc.loop ?? 0} aria-label="Repetición" onChange={(e) => engine.call('timelineLoop', Number(e.target.value))}>
                <option value={1}>Una vez</option><option value={3}>3 veces</option><option value={0}>Infinito</option>
              </select>
            </label>
            <button type="button" className="icon-btn" title="Seleccionar primer cuadro" aria-label="Primer cuadro" onClick={() => engine.call('timelineSelect', 0)}><ChevronsLeft size={15} /></button>
            <button type="button" className="icon-btn" title="Cuadro anterior" aria-label="Cuadro anterior" onClick={() => engine.call('timelineSelect', (active - 1 + frames.length) % frames.length)}><ChevronLeft size={15} /></button>
            {playing
              ? <button type="button" className="icon-btn" title="Detener" aria-label="Detener" onClick={stop}><Square size={14} /></button>
              : <button type="button" className="icon-btn" title="Reproducir" aria-label="Reproducir" disabled={frames.length < 2} onClick={start}><Play size={15} /></button>}
            <button type="button" className="icon-btn" title="Cuadro siguiente" aria-label="Cuadro siguiente" onClick={() => engine.call('timelineSelect', (active + 1) % frames.length)}><ChevronRight size={15} /></button>
            <span className="sep" />
            <button type="button" className="icon-btn" title="Interpolar cuadros de animación" aria-label="Interpolar" disabled={active >= frames.length - 1} onClick={() => useStore.getState().setDialog({ kind: 'tween' })}><Waypoints size={15} /></button>
            <button type="button" className="icon-btn" title="Duplicar cuadros seleccionados" aria-label="Duplicar cuadro" onClick={() => engine.call('timelineAdd')}><Copy size={15} /></button>
            <button type="button" className="icon-btn" title="Eliminar cuadros seleccionados" aria-label="Eliminar cuadro" onClick={() => engine.call('timelineDelete')}><Trash2 size={15} /></button>
            <span className="grow" />
            <button type="button" className="btn" onClick={() => useStore.getState().setDialog({ kind: 'exportAnim' })}>Exportar GIF…</button>
          </footer>
        </>
      )}
    </section>
  );
}

/** Interpolar: cuadros intermedios entre el actual y el siguiente. */
export function TweenDialog({ close }: { close: () => void }) {
  const [n, setN] = useState(5);
  return (
    <Modal title="Interpolar" onClose={close} onOk={() => { engine.call('timelineTween', n); close(); }}>
      <label className="field">Cuadros que añadir<input type="number" min={1} max={100} value={n} aria-label="Cuadros que añadir" autoFocus onChange={(e) => setN(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} /></label>
      <span className="hint">Se interpolan la posición, la opacidad y la visibilidad de las capas hasta el cuadro siguiente.</span>
    </Modal>
  );
}

/** Archivo > Exportar > Exportar animación. */
export function ExportAnimDialog({ close }: { close: () => void }) {
  const [fmt, setFmt] = useState<'gif' | 'png'>('gif');
  const [colors, setColors] = useState(256);
  const [dither, setDither] = useState(true);
  const [scale, setScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const frames = useStore((s) => s.doc.frames?.length ?? 0);
  const go = async () => {
    setBusy(true);
    try {
      const files = await engine.call<{ name: string; blob: Blob }[]>('timelineExport', { colors, dither, scale, format: fmt });
      if (files.length === 1) download(files[0].blob, files[0].name);
      else if (files.length) download(await makeZip(files), files[0].name.replace(/_\d+\.png$/, '.zip'));
      useStore.getState().toast(fmt === 'gif' ? `GIF animado de ${Math.max(1, frames)} cuadros` : `${files.length} cuadros en un ZIP`);
      close();
    } finally { setBusy(false); }
  };
  return (
    <Modal title="Exportar animación" okLabel={busy ? 'Exportando…' : 'Exportar'} onClose={close} onOk={() => { if (!busy) void go(); }}>
      <label className="field">Formato
        <select value={fmt} aria-label="Formato de animación" onChange={(e) => setFmt(e.target.value as 'gif' | 'png')}>
          <option value="gif">GIF animado</option><option value="png">Secuencia PNG (ZIP)</option>
        </select>
      </label>
      {fmt === 'gif' && (
        <>
          <label className="field">Colores
            <select value={colors} aria-label="Colores" onChange={(e) => setColors(Number(e.target.value))}>
              {[256, 128, 64, 32, 16, 8].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="field">Tramado<span><input type="checkbox" checked={dither} onChange={(e) => setDither(e.target.checked)} /> Difusión</span></label>
        </>
      )}
      <label className="field">Tamaño
        <select value={scale} aria-label="Tamaño" onChange={(e) => setScale(Number(e.target.value))}>
          <option value={0.25}>25 %</option><option value={0.5}>50 %</option><option value={1}>100 %</option><option value={2}>200 %</option>
        </select>
      </label>
      <span className="hint">{frames ? `${frames} cuadros.` : 'Sin línea de tiempo: se exporta un solo cuadro.'}</span>
    </Modal>
  );
}
