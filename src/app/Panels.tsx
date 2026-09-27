import { useEffect, useRef, useState } from 'react';
import {
  Eye, EyeOff, Plus, Copy, Trash2, Layers as LayersIcon, CircleDot, SlidersHorizontal, Type, Shapes, Lock, Sparkles,
  Play, Square, Link,
} from 'lucide-react';
import { engine } from '../engine/client';
import { BLEND_GROUPS, type LayerInfo, type AdjustmentType } from '../engine/types';
import { ADJUSTMENT_LABELS } from '../engine/adjust';
import { FONTS } from '../engine/vector';
import { useStore, toHex, toRgba } from './store';
import { AdjustmentEditor } from './Adjustments';
import { startRecording, stopRecording, playAction, deleteAction, renameAction } from './commands';

const BLEND_LABEL = Object.fromEntries(BLEND_GROUPS.flat().map((b) => [b.id, b.label]));

function PanelTabs({ tabs }: { tabs: { label: string; on?: boolean }[] }) {
  return (
    <div className="panel-tabs">
      {tabs.map((t) => (
        <div key={t.label} className={`panel-tab ${t.on ? 'on' : ''}`} title={t.on ? undefined : 'Próximamente'}>{t.label}</div>
      ))}
    </div>
  );
}

const PALETTE = [
  '#000000', '#404040', '#808080', '#bfbfbf', '#ffffff', '#ff0000', '#ff8000', '#ffff00', '#80ff00', '#00ff00', '#00ffff', '#0080ff',
  '#0000ff', '#8000ff', '#ff00ff', '#ff0080', '#7f1d1d', '#7c2d12', '#713f12', '#14532d', '#134e4a', '#1e3a8a', '#4c1d95', '#831843',
];

export function ColorPanel() {
  const fg = useStore((s) => s.fg);
  const bg = useStore((s) => s.bg);
  const setColors = useStore((s) => s.setColors);
  const [hex, setHex] = useState(fg);
  useEffect(() => setHex(fg), [fg]);
  return (
    <section className="panel">
      <PanelTabs tabs={[{ label: 'Color', on: true }, { label: 'Muestras' }]} />
      <div className="panel-body">
        <div className="color-row">
          <label className="color-big" style={{ background: fg }} title="Color frontal">
            <input type="color" value={fg} onChange={(e) => setColors(e.target.value, bg)} />
          </label>
          <input className="hex" value={hex} aria-label="Color frontal en hexadecimal"
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => { setHex(e.target.value); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) setColors(e.target.value.toLowerCase(), bg); }} />
          <label className="color-big small" style={{ background: bg }} title="Color de fondo">
            <input type="color" value={bg} onChange={(e) => setColors(fg, e.target.value)} />
          </label>
        </div>
        <div className="palette">
          {PALETTE.map((c) => <button key={c} style={{ background: c }} title={`${c} · Alt+clic: fondo`} onClick={(e) => (e.altKey ? setColors(fg, c) : setColors(c, bg))} />)}
        </div>
      </div>
    </section>
  );
}

/** Propiedades de la capa activa: ajustes, texto, forma y máscara. */
export function PropertiesPanel() {
  const doc = useStore((s) => s.doc);
  const L = doc.layers.find((l) => l.id === doc.activeLayerId);
  const [open, setOpen] = useState(true);
  if (!doc.open || !L) return null;
  let body: React.ReactNode = null;
  if (L.kind === 'adjustment' && L.adjustment) {
    body = <AdjustmentEditor params={L.adjustment} onChange={(p, commit) => engine.call('setAdjustment', L.id, p, commit)} />;
  } else if (L.kind === 'text' && L.text) {
    const t = L.text;
    const up = (p: object) => engine.call('updateText', L.id, p, true);
    body = (
      <>
        <label className="adj-row"><span>Fuente</span>
          <select value={t.font} onChange={(e) => up({ font: e.target.value })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select>
        </label>
        <label className="adj-row"><span>Tamaño</span><input type="number" className="num" value={t.size} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => up({ size: Number(e.target.value) || 1 })} /></label>
        <label className="adj-row"><span>Interlineado</span><input type="number" step={0.1} className="num" value={t.lineHeight} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => up({ lineHeight: Number(e.target.value) || 1 })} /></label>
        <label className="adj-row"><span>Color</span><input type="color" value={toHex(t.color)} onChange={(e) => up({ color: toRgba(e.target.value) })} /></label>
        <label className="adj-row"><span>Texto</span><textarea rows={3} value={t.text} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => engine.call('updateText', L.id, { text: e.target.value }, false)} onBlur={(e) => up({ text: e.target.value })} /></label>
      </>
    );
  } else if (L.kind === 'shape' && L.shape) {
    const s = L.shape;
    const up = (p: object) => engine.call('updateShape', L.id, p, true);
    body = (
      <>
        <label className="adj-row"><span>Relleno</span>
          <input type="checkbox" checked={!!s.fill} onChange={(e) => up({ fill: e.target.checked ? toRgba(useStore.getState().fg) : null })} />
          {s.fill && <input type="color" value={toHex(s.fill)} onChange={(e) => up({ fill: toRgba(e.target.value) })} />}
        </label>
        <label className="adj-row"><span>Trazo</span>
          <input type="checkbox" checked={!!s.stroke} onChange={(e) => up({ stroke: e.target.checked ? toRgba(useStore.getState().bg) : null })} />
          {s.stroke && <input type="color" value={toHex(s.stroke)} onChange={(e) => up({ stroke: toRgba(e.target.value) })} />}
        </label>
        <label className="adj-row"><span>Grosor</span><input type="number" className="num" value={s.strokeWidth} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => up({ strokeWidth: Math.max(0, Number(e.target.value)) })} /></label>
        {s.shape === 'rect' && <label className="adj-row"><span>Radio</span><input type="number" className="num" value={s.radius} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => up({ radius: Math.max(0, Number(e.target.value)) })} /></label>}
        {s.shape === 'polygon' && <label className="adj-row"><span>Lados</span><input type="number" className="num" value={s.sides} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => up({ sides: Math.max(3, Number(e.target.value)) })} /></label>}
      </>
    );
  }
  const mask = L.hasMask && (
    <div className="mask-props">
      <span className="hint">Máscara {L.maskEnabled ? 'activa' : 'desactivada'} · {doc.editMask ? 'editando máscara' : 'editando píxeles'}</span>
      <div className="row-btns">
        <button className="chip" onClick={() => engine.call('setLayer', L.id, { maskEnabled: !L.maskEnabled })}>{L.maskEnabled ? 'Desactivar' : 'Activar'}</button>
        <button className="chip" onClick={() => engine.call('adjust', 'invert')} disabled={!doc.editMask}>Invertir</button>
        {L.kind === 'pixel' && <button className="chip" onClick={() => engine.call('deleteMask', true)}>Aplicar</button>}
        <button className="chip" onClick={() => engine.call('deleteMask', false)}>Eliminar</button>
      </div>
    </div>
  );
  if (!body && !mask) return null;
  const title = L.kind === 'adjustment' && L.adjustment ? ADJUSTMENT_LABELS[L.adjustment.type] : L.kind === 'text' ? 'Texto' : L.kind === 'shape' ? 'Forma' : 'Máscara';
  return (
    <section className="panel props">
      <div className="panel-tabs"><div className="panel-tab on" onClick={() => setOpen(!open)}>Propiedades · {title}</div></div>
      {open && <div className="panel-body">{body}{mask}</div>}
    </section>
  );
}

export function HistoryPanel() {
  const doc = useStore((s) => s.doc);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.querySelector('.current')?.scrollIntoView({ block: 'nearest' }); }, [doc.historyIndex, doc.history.length]);
  return (
    <section className="panel">
      <PanelTabs tabs={[{ label: 'Historial', on: true }]} />
      <div className="panel-body history" ref={listRef}>
        {!doc.open && <span className="hint">Sin documento</span>}
        {doc.history.map((h, i) => (
          <div key={i} className={`history-item ${i === doc.historyIndex ? 'current' : ''} ${i > doc.historyIndex ? 'future' : ''}`}
            onClick={() => engine.call('jumpHistory', i)}>{h.label}</div>
        ))}
      </div>
    </section>
  );
}

export function ActionsPanel() {
  const actions = useStore((s) => s.actions);
  const recording = useStore((s) => s.recording);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  return (
    <section className="panel">
      <div className="panel-tabs"><div className={`panel-tab ${open ? 'on' : ''}`} data-testid="actions-tab" onClick={() => setOpen(!open)}>Acciones {recording && <span className="rec-dot" />}</div></div>
      {open && (
        <div className="panel-body actions">
          {actions.length === 0 && <span className="hint">Graba una secuencia de comandos (menús o atajos) y repítela con un clic.</span>}
          {actions.map((a, i) => (
            <div key={i} className="action-row">
              {editing === i
                ? <input className="action-name" autoFocus defaultValue={a.name}
                    onBlur={(e) => { renameAction(i, e.target.value.trim() || a.name); setEditing(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
                : <span title={`${a.steps.map((s) => s.id).join(', ')}\nDoble clic para renombrar`} onDoubleClick={() => setEditing(i)}>{a.name} <span className="hint">({a.steps.length})</span></span>}
              <button className="icon-btn" title="Reproducir" onClick={() => playAction(i)}><Play size={13} /></button>
              <button className="icon-btn" title="Eliminar" onClick={() => deleteAction(i)}><Trash2 size={13} /></button>
            </div>
          ))}
          <div className="row-btns">
            {recording
              ? <button className="chip on" onClick={stopRecording}><Square size={12} /> Detener</button>
              : <button className="chip" onClick={() => { startRecording(`Acción ${actions.length + 1}`); setEditing(actions.length); }}><CircleDot size={12} /> Grabar</button>}
          </div>
        </div>
      )}
    </section>
  );
}

function Thumb({ id, mask }: { id: number; mask?: boolean }) {
  const t = useStore((s) => s.thumbs[mask ? -id : id]);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !t) return;
    c.width = t.w; c.height = t.h;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(t.data), t.w, t.h), 0, 0);
  }, [t]);
  return <canvas ref={ref} />;
}

const KIND_ICON = { adjustment: SlidersHorizontal, text: Type, shape: Shapes };

function LayerRow({ layer, active, editMask, index, onDragIndex }: { layer: LayerInfo; active: boolean; editMask: boolean; index: number; onDragIndex: (from: number, to: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [drop, setDrop] = useState<'above' | 'below' | null>(null);
  const KindIcon = layer.kind !== 'pixel' ? KIND_ICON[layer.kind] : null;
  const fx = layer.effects && Object.values(layer.effects).some((e) => e?.enabled);
  return (
    <div
      className={`layer ${active ? 'active' : ''} ${layer.visible ? '' : 'hidden'} ${drop ? `drop-${drop}` : ''}`}
      onClick={() => engine.call('selectLayer', layer.id, false)}
      draggable={!editing}
      onDragStart={(e) => { e.dataTransfer.setData('text/x-layer-index', String(index)); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/x-layer-index')) return;
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setDrop(e.clientY < r.top + r.height / 2 ? 'above' : 'below');
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/x-layer-index'));
        let to = drop === 'above' ? index + 1 : index;
        if (from < to) to -= 1;
        setDrop(null);
        onDragIndex(from, to);
      }}
      onDoubleClick={() => { if (layer.kind === 'pixel' || layer.kind === 'text' || layer.kind === 'shape') useStore.getState().setDialog({ kind: 'layerStyle' }); }}
      data-testid="layer-row"
    >
      <button
        className="eye"
        title={layer.visible ? 'Ocultar capa (Alt+clic: sólo esta)' : 'Mostrar capa'}
        onClick={(e) => { e.stopPropagation(); if (e.altKey) engine.call('soloLayer', layer.id); else engine.call('setLayer', layer.id, { visible: !layer.visible }); }}
      >
        {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      <div className="thumbs">
        <div
          className={`thumb ${active && !editMask ? 'target' : ''}`}
          title="Ctrl+clic: cargar como selección"
          onClick={(e) => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); engine.call('loadSelectionFromLayer', layer.id, false, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace'); } }}
        >
          {layer.kind === 'adjustment' ? <SlidersHorizontal size={16} /> : <Thumb id={layer.id} />}
        </div>
        {layer.hasMask && (
          <>
            <Link size={10} className="mask-link" />
            <div
              className={`thumb mask ${active && editMask ? 'target' : ''} ${layer.maskEnabled ? '' : 'disabled'}`}
              title="Clic: editar máscara · Mayús+clic: activar/desactivar · Ctrl+clic: cargar como selección"
              onClick={(e) => {
                e.stopPropagation();
                if (e.shiftKey) engine.call('setLayer', layer.id, { maskEnabled: !layer.maskEnabled });
                else if (e.ctrlKey || e.metaKey) engine.call('loadSelectionFromLayer', layer.id, true);
                else engine.call('selectLayer', layer.id, true);
              }}
            >
              <Thumb id={layer.id} mask />
            </div>
          </>
        )}
      </div>
      <div className="layer-text">
        <div className="name" onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}>
          {KindIcon && <KindIcon size={11} className="kind" />}
          {editing ? (
            <input autoFocus defaultValue={layer.name} onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false); e.stopPropagation(); }}
              onBlur={(e) => { setEditing(false); if (e.target.value.trim()) engine.call('setLayer', layer.id, { name: e.target.value.trim() }); }} />
          ) : layer.name}
        </div>
        <div className="meta">
          {[layer.blend !== 'normal' ? BLEND_LABEL[layer.blend] : '', layer.opacity < 1 ? `${Math.round(layer.opacity * 100)} %` : ''].filter(Boolean).join(' · ')}
          {layer.lockAlpha && <Lock size={10} />}
          {fx && <span className="fx" title="Estilos de capa (doble clic para editar)">fx</span>}
        </div>
      </div>
    </div>
  );
}

function ScrubPercent({ label, value, onLive, onCommit }: { label: string; value: number; onLive: (v: number) => void; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(Math.round(value * 100)));
  useEffect(() => setText(String(Math.round(value * 100))), [value]);
  const start = (e: React.PointerEvent) => {
    const x0 = e.clientX, v0 = value;
    let last = v0;
    const move = (ev: PointerEvent) => { last = Math.min(1, Math.max(0, v0 + (ev.clientX - x0) / 200)); onLive(last); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onCommit(last); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <label className="opt">
      <span className="scrub" onPointerDown={start}>{label}</span>
      <input className="num" type="number" min={0} max={100} value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onCommit(Math.min(1, Math.max(0, Number(text) / 100)))}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />%
    </label>
  );
}

const ADJ_MENU: AdjustmentType[] = ['solidColor', 'brightness', 'levels', 'curves', 'exposure', 'vibrance', 'hueSat', 'colorBalance', 'blackWhite', 'invert', 'posterize', 'threshold', 'gradientMap'];

export function LayersPanel() {
  const doc = useStore((s) => s.doc);
  const [adjOpen, setAdjOpen] = useState(false);
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  const rows = [...doc.layers].map((l, i) => ({ l, i })).reverse();
  return (
    <section className="panel grow">
      <PanelTabs tabs={[{ label: 'Capas', on: true }, { label: 'Canales' }, { label: 'Trazados' }]} />
      {doc.open && active ? (
        <>
          <div className="layer-controls">
            <select value={active.blend} aria-label="Modo de fusión" onChange={(e) => engine.call('setLayer', active.id, { blend: e.target.value })}>
              {BLEND_GROUPS.map((g, gi) => <optgroup key={gi} label="──────────">{g.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</optgroup>)}
            </select>
            <ScrubPercent label="Opac.:" value={active.opacity}
              onLive={(v) => engine.call('setLayer', active.id, { opacity: v }, false)}
              onCommit={(v) => engine.call('setLayer', active.id, { opacity: v }, true)} />
          </div>
          <div className="layer-locks">
            <span className="hint">Bloquear:</span>
            <button className={`icon-btn ${active.lockAlpha ? 'on' : ''}`} title="Bloquear píxeles transparentes (/)" onClick={() => engine.call('setLayer', active.id, { lockAlpha: !active.lockAlpha })}>
              <svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="6" height="6" fill="currentColor" /><rect x="7" y="7" width="6" height="6" fill="currentColor" /><rect x="1" y="1" width="12" height="12" fill="none" stroke="currentColor" /></svg>
            </button>
          </div>
          <div className="layers" role="list">
            {rows.map(({ l, i }) => (
              <LayerRow key={l.id} layer={l} index={i} active={l.id === doc.activeLayerId} editMask={doc.editMask}
                onDragIndex={(from, to) => engine.call('moveLayer', doc.layers[from].id, to)} />
            ))}
          </div>
          <div className="panel-foot">
            <button className="icon-btn" title="Estilo de capa" onClick={() => useStore.getState().setDialog({ kind: 'layerStyle' })}><Sparkles size={15} /></button>
            <button className="icon-btn" title="Añadir máscara de capa (con selección: mostrar selección)" onClick={() => engine.call('addMask', doc.selection ? 'selection' : 'reveal')}>
              <svg width="15" height="15" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" /><circle cx="8" cy="8" r="3.2" fill="currentColor" /></svg>
            </button>
            <div className="menu-root">
              <button className="icon-btn" title="Nueva capa de relleno o ajuste" onClick={() => setAdjOpen(!adjOpen)}>
                <svg width="15" height="15" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" /><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" /></svg>
              </button>
              {adjOpen && (
                <div className="menu-pop up" onPointerLeave={() => setAdjOpen(false)}>
                  {ADJ_MENU.map((t) => (
                    <button key={t} className="menu-item" onClick={() => { setAdjOpen(false); engine.call('newAdjustmentLayer', t); }}>
                      <span>{ADJUSTMENT_LABELS[t]}{t === 'solidColor' ? ' (relleno)' : ''}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="icon-btn" title="Nueva capa (Ctrl+Mayús+N)" onClick={() => engine.call('newLayer')}><Plus size={16} /></button>
            <button className="icon-btn" title="Duplicar capa" onClick={() => engine.call('duplicateLayer')}><Copy size={15} /></button>
            <button className="icon-btn" title="Eliminar capa" disabled={doc.layers.length <= 1} onClick={() => engine.call('deleteLayer')}><Trash2 size={15} /></button>
          </div>
        </>
      ) : (
        <div className="panel-body hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><LayersIcon size={14} /> Abre o crea un documento</div>
      )}
    </section>
  );
}
