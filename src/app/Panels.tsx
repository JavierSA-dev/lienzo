import { useEffect, useRef, useState } from 'react';
import {
  Eye, EyeOff, Plus, Copy, Trash2, Layers as LayersIcon, CircleDot, SlidersHorizontal, Type, Shapes, Lock, Sparkles,
  Play, Square, Link, Folder, FolderOpen, ChevronRight, ChevronDown, CornerLeftDown, FolderPlus, PaintBucket, SquareDashed, Spline,
} from 'lucide-react';
import { toSvg, type VectorPath } from '../engine/path';
import { engine } from '../engine/client';
import { BLEND_GROUPS, PASS_THROUGH, type LayerInfo, type AdjustmentType } from '../engine/types';
import { ADJUSTMENT_LABELS } from '../engine/adjust';
import { FONTS } from '../engine/vector';
import { useStore, toHex, toRgba } from './store';
import { AdjustmentEditor } from './Adjustments';
import { startRecording, stopRecording, playAction, deleteAction, renameAction } from './commands';

const BLEND_LABEL = Object.fromEntries([...BLEND_GROUPS.flat(), PASS_THROUGH].map((b) => [b.id, b.label]));

function PanelTabs({ tabs }: { tabs: { label: string; on?: boolean; onClick?: () => void }[] }) {
  return (
    <div className="panel-tabs" role="tablist">
      {tabs.map((t) => (
        <div key={t.label} role="tab" aria-selected={!!t.on} className={`panel-tab ${t.on ? 'on' : ''} ${t.onClick || t.on ? '' : 'soon'}`}
          title={t.on || t.onClick ? undefined : 'Próximamente'} onClick={t.onClick} data-testid={`tab-${t.label}`}>{t.label}</div>
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
                ? <input className="action-name" autoFocus onFocus={(e) => e.target.select()} defaultValue={a.name}
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

const KIND_ICON = { adjustment: SlidersHorizontal, text: Type, shape: Shapes, group: Folder };

type DropPos = 'above' | 'below' | 'inside';

function LayerRow({ layer, active, selected, editMask, depth, isBase }: { layer: LayerInfo; active: boolean; selected: boolean; editMask: boolean; depth: number; isBase: boolean }) {
  const [editing, setEditing] = useState(false);
  const [drop, setDrop] = useState<DropPos | null>(null);
  const group = layer.kind === 'group';
  const KindIcon = layer.kind !== 'pixel' && !group ? KIND_ICON[layer.kind] : null;
  const fx = layer.effects && Object.values(layer.effects).some((e) => e?.enabled);
  return (
    <div
      className={`layer ${active ? 'active' : ''} ${selected && !active ? 'selected' : ''} ${layer.visible ? '' : 'hidden'} ${drop ? `drop-${drop}` : ''} ${layer.clipped ? 'clipped' : ''}`}
      onClick={(e) => {
        if (e.altKey) engine.call('toggleClip', layer.id);
        else engine.call('selectLayer', layer.id, false, e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'replace');
      }}
      title={group ? undefined : 'Alt+clic: crear o liberar máscara de recorte'}
      draggable={!editing}
      onDragStart={(e) => { e.dataTransfer.setData('text/x-layer-id', String(layer.id)); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/x-layer-id')) return;
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const f = (e.clientY - r.top) / r.height;
        setDrop(group && f > 0.3 && f < 0.7 ? 'inside' : f < 0.5 ? 'above' : 'below');
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/x-layer-id'));
        const pos = drop ?? 'above';
        setDrop(null);
        if (from && from !== layer.id) engine.call('moveLayerTo', from, layer.id, pos);
      }}
      onDoubleClick={() => { if (layer.kind === 'pixel' || layer.kind === 'text' || layer.kind === 'shape') useStore.getState().setDialog({ kind: 'layerStyle' }); }}
      data-testid="layer-row"
      data-layer-id={layer.id}
    >
      <button
        className="eye"
        title={layer.visible ? 'Ocultar capa (Alt+clic: sólo esta)' : 'Mostrar capa'}
        onClick={(e) => { e.stopPropagation(); if (e.altKey) engine.call('soloLayer', layer.id); else engine.call('setLayer', layer.id, { visible: !layer.visible }); }}
      >
        {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      {depth > 0 && <span className="indent" style={{ width: depth * 14 }} />}
      {group ? (
        <button className="twisty" title={layer.collapsed ? 'Desplegar grupo' : 'Plegar grupo'}
          onClick={(e) => { e.stopPropagation(); engine.call('setCollapsed', layer.id, !layer.collapsed); }}>
          {layer.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : layer.clipped ? <CornerLeftDown size={12} className="clip-arrow" /> : null}
      <div className="thumbs">
        <div
          className={`thumb ${active && !editMask ? 'target' : ''} ${group ? 'group' : ''}`}
          title="Ctrl+clic: cargar como selección"
          onClick={(e) => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); engine.call('loadSelectionFromLayer', layer.id, false, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace'); } }}
        >
          {layer.kind === 'adjustment' ? <SlidersHorizontal size={16} /> : group ? (layer.collapsed ? <Folder size={17} /> : <FolderOpen size={17} />) : <Thumb id={layer.id} />}
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
          ) : <span className={isBase ? 'clip-base' : ''}>{layer.name}</span>}
        </div>
        <div className="meta">
          {[layer.blend !== 'normal' && layer.blend !== 'pass-through' ? BLEND_LABEL[layer.blend] : '', layer.opacity < 1 ? `${Math.round(layer.opacity * 100)} %` : ''].filter(Boolean).join(' · ')}
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
  const [tab, setTab] = useState<'layers' | 'paths'>('layers');
  if (tab === 'paths') return <PathsPanel onTab={setTab} />;
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  // Árbol visible de arriba a abajo (los grupos plegados ocultan su contenido).
  const rows: { l: LayerInfo; depth: number; isBase: boolean }[] = [];
  const walk = (pid: number | null, depth: number) => {
    const kids = doc.layers.filter((l) => l.parent === pid);
    for (let i = kids.length - 1; i >= 0; i--) {
      const l = kids[i];
      rows.push({ l, depth, isBase: !l.clipped && !!kids[i + 1]?.clipped });
      if (l.kind === 'group' && !l.collapsed) walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  return (
    <section className="panel grow">
      <PanelTabs tabs={[{ label: 'Capas', on: true }, { label: 'Canales' }, { label: 'Trazados', onClick: () => setTab('paths') }]} />
      {doc.open && active ? (
        <>
          <div className="layer-controls">
            <select value={active.blend} aria-label="Modo de fusión" onChange={(e) => engine.call('setLayers', doc.selectedLayerIds, { blend: e.target.value })}>
              {active.kind === 'group' && <option value={PASS_THROUGH.id}>{PASS_THROUGH.label}</option>}
              {BLEND_GROUPS.map((g, gi) => <optgroup key={gi} label="──────────">{g.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</optgroup>)}
            </select>
            <ScrubPercent label="Opac.:" value={active.opacity}
              onLive={(v) => engine.call('setLayers', doc.selectedLayerIds, { opacity: v }, false)}
              onCommit={(v) => engine.call('setLayers', doc.selectedLayerIds, { opacity: v }, true)} />
          </div>
          <div className="layer-locks">
            <span className="hint">Bloquear:</span>
            <button className={`icon-btn ${active.lockAlpha ? 'on' : ''}`} title="Bloquear píxeles transparentes (/)" onClick={() => engine.call('setLayer', active.id, { lockAlpha: !active.lockAlpha })}>
              <svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="6" height="6" fill="currentColor" /><rect x="7" y="7" width="6" height="6" fill="currentColor" /><rect x="1" y="1" width="12" height="12" fill="none" stroke="currentColor" /></svg>
            </button>
          </div>
          <div className="layers" role="list">
            {rows.map(({ l, depth, isBase }) => (
              <LayerRow key={l.id} layer={l} depth={depth} isBase={isBase} active={l.id === doc.activeLayerId} selected={doc.selectedLayerIds.includes(l.id)} editMask={doc.editMask} />
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
            <button className="icon-btn" title="Nuevo grupo (Ctrl+G agrupa la capa activa)" onClick={() => engine.call('groupLayers', true)}><FolderPlus size={15} /></button>
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

/** Miniatura de un trazado ajustada al documento. */
function PathThumb({ path, w, h }: { path: VectorPath; w: number; h: number }) {
  const k = Math.min(40 / Math.max(1, w), 30 / Math.max(1, h));
  const ox = (40 - w * k) / 2, oy = (30 - h * k) / 2;
  return (
    <svg width="40" height="30" className="path-thumb">
      <rect x={ox} y={oy} width={w * k} height={h * k} fill="#fff" />
      <path d={toSvg(path, (x, y) => [ox + x * k, oy + y * k])} fill="#666" fillRule="evenodd" stroke="#333" strokeWidth={0.5} />
    </svg>
  );
}

export function PathsPanel({ onTab }: { onTab: (t: 'layers' | 'paths') => void }) {
  const doc = useStore((s) => s.doc);
  const [editing, setEditing] = useState<number | null>(null);
  const active = doc.paths.find((p) => p.id === doc.activePathId);
  const act = (m: string, ...a: unknown[]) => { if (active) engine.call(m, active.path, ...a); };
  return (
    <section className="panel grow">
      <PanelTabs tabs={[{ label: 'Capas', onClick: () => onTab('layers') }, { label: 'Canales' }, { label: 'Trazados', on: true }]} />
      <div className="layers paths" role="list" onClick={(e) => { if (e.target === e.currentTarget) engine.call('setActivePath', null); }}>
        {!doc.paths.length && <div className="panel-body hint">Dibuja con la pluma (P) o convierte una selección en trazado.</div>}
        {[...doc.paths].map((p) => (
          <div key={p.id} className={`layer path-row ${p.id === doc.activePathId ? 'active' : ''}`} data-testid="path-row"
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey) { engine.call('selectPath', p.path, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace', 0); return; }
              engine.call('setActivePath', p.id);
            }}
            onDoubleClick={() => setEditing(p.id)}>
            <PathThumb path={p.path} w={doc.width} h={doc.height} />
            <div className="layer-text">
              {editing === p.id
                ? <input className="action-name" autoFocus onFocus={(e) => e.target.select()} defaultValue={p.work ? `Trazado ${doc.paths.filter((q) => !q.work).length + 1}` : p.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => { setEditing(null); if (e.target.value.trim()) { if (p.work) engine.call('savePath', p.id, e.target.value.trim()); else engine.call('renamePath', p.id, e.target.value); } }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }} />
                : <div className={`name ${p.work ? 'work-path' : ''}`} title={p.work ? 'Doble clic para guardarlo' : 'Doble clic para cambiar el nombre · Ctrl+clic: cargar como selección'}>{p.name}</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="panel-foot">
        <button className="icon-btn" title="Rellenar trazado con el color frontal" disabled={!active} onClick={() => act('fillPath')}><PaintBucket size={15} /></button>
        <button className="icon-btn" title="Contornear trazado con el pincel" disabled={!active} onClick={() => act('strokePath')}><CircleDot size={15} /></button>
        <button className="icon-btn" title="Cargar el trazado como selección (Ctrl+Intro)" disabled={!active} onClick={() => act('selectPath', 'replace', 0)}><SquareDashed size={15} /></button>
        <button className="icon-btn" title="Hacer trazado de trabajo desde la selección" disabled={!doc.selection} onClick={() => engine.call('workPathFromSelection', 2)}><Spline size={15} /></button>
        <button className="icon-btn" title="Crear trazado nuevo" onClick={() => engine.call('savePath')}><Plus size={16} /></button>
        <button className="icon-btn" title="Eliminar trazado" disabled={!active} onClick={() => active && engine.call('deletePath', active.id)}><Trash2 size={15} /></button>
      </div>
    </section>
  );
}
