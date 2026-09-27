import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Plus, Copy, Trash2, Layers as LayersIcon } from 'lucide-react';
import { engine } from '../engine/client';
import { BLEND_GROUPS, type LayerInfo } from '../engine/types';

const BLEND_LABEL = Object.fromEntries(BLEND_GROUPS.flat().map((b) => [b.id, b.label]));
import { useStore } from './store';

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
      <PanelTabs tabs={[{ label: 'Color', on: true }, { label: 'Muestras' }, { label: 'Degradados' }]} />
      <div className="panel-body">
        <div className="color-row">
          <label className="color-big" style={{ background: fg }} title="Color frontal">
            <input type="color" value={fg} onChange={(e) => setColors(e.target.value, bg)} />
          </label>
          <input
            className="hex"
            value={hex}
            onChange={(e) => {
              setHex(e.target.value);
              if (/^#[0-9a-f]{6}$/i.test(e.target.value)) setColors(e.target.value.toLowerCase(), bg);
            }}
            aria-label="Color frontal en hexadecimal"
          />
        </div>
        <div className="palette">
          {PALETTE.map((c) => (
            <button key={c} style={{ background: c }} title={c} onClick={(e) => (e.altKey ? setColors(fg, c) : setColors(c, bg))} />
          ))}
        </div>
      </div>
    </section>
  );
}

export function HistoryPanel() {
  const doc = useStore((s) => s.doc);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }, [doc.historyIndex, doc.history.length]);
  return (
    <section className="panel">
      <PanelTabs tabs={[{ label: 'Historial', on: true }, { label: 'Propiedades' }, { label: 'Ajustes' }]} />
      <div className="panel-body history" ref={listRef}>
        {!doc.open && <span className="hint">Sin documento</span>}
        {doc.history.map((h, i) => (
          <div
            key={i}
            className={`history-item ${i === doc.historyIndex ? 'current' : ''} ${i > doc.historyIndex ? 'future' : ''}`}
            onClick={() => engine.call('jumpHistory', i)}
          >
            {h.label}
          </div>
        ))}
      </div>
    </section>
  );
}

function Thumb({ id }: { id: number }) {
  const t = useStore((s) => s.thumbs[id]);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !t) return;
    c.width = t.w; c.height = t.h;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(t.data), t.w, t.h), 0, 0);
  }, [t]);
  return <div className="thumb"><canvas ref={ref} /></div>;
}

function LayerRow({ layer, active, index, onDragIndex }: { layer: LayerInfo; active: boolean; index: number; onDragIndex: (from: number, to: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [drop, setDrop] = useState<'above' | 'below' | null>(null);
  return (
    <div
      className={`layer ${active ? 'active' : ''} ${layer.visible ? '' : 'hidden'} ${drop ? `drop-${drop}` : ''}`}
      onClick={() => engine.call('selectLayer', layer.id)}
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
        // La lista está invertida (arriba = índice mayor).
        let to = drop === 'above' ? index + 1 : index;
        if (from < to) to -= 1;
        setDrop(null);
        onDragIndex(from, to);
      }}
      data-testid="layer-row"
    >
      <button
        className="eye"
        title={layer.visible ? 'Ocultar capa' : 'Mostrar capa'}
        onClick={(e) => { e.stopPropagation(); engine.call('setLayer', layer.id, { visible: !layer.visible }); }}
      >
        {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      <Thumb id={layer.id} />
      <div>
        <div className="name" onDoubleClick={() => setEditing(true)}>
          {editing ? (
            <input
              autoFocus
              defaultValue={layer.name}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditing(false);
                e.stopPropagation();
              }}
              onBlur={(e) => { setEditing(false); if (e.target.value.trim()) engine.call('setLayer', layer.id, { name: e.target.value.trim() }); }}
            />
          ) : layer.name}
        </div>
        {(layer.blend !== 'normal' || layer.opacity < 1) && (
          <div className="meta">{[layer.blend !== 'normal' ? BLEND_LABEL[layer.blend] : '', layer.opacity < 1 ? `${Math.round(layer.opacity * 100)} %` : ''].filter(Boolean).join(' · ')}</div>
        )}
      </div>
    </div>
  );
}

/** Número que se ajusta arrastrando la etiqueta, como en Photoshop. */
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
      <input
        className="num"
        type="number"
        min={0}
        max={100}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onCommit(Math.min(1, Math.max(0, Number(text) / 100)))}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
      />%
    </label>
  );
}

export function LayersPanel() {
  const doc = useStore((s) => s.doc);
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  const rows = [...doc.layers].map((l, i) => ({ l, i })).reverse();
  return (
    <section className="panel grow">
      <PanelTabs tabs={[{ label: 'Capas', on: true }, { label: 'Canales' }, { label: 'Trazados' }]} />
      {doc.open && active ? (
        <>
          <div className="layer-controls">
            <select
              value={active.blend}
              aria-label="Modo de fusión"
              onChange={(e) => engine.call('setLayer', active.id, { blend: e.target.value })}
            >
              {BLEND_GROUPS.map((g, gi) => (
                <optgroup key={gi} label="──────────">
                  {g.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                </optgroup>
              ))}
            </select>
            <ScrubPercent
              label="Opac.:"
              value={active.opacity}
              onLive={(v) => engine.call('setLayer', active.id, { opacity: v }, false)}
              onCommit={(v) => engine.call('setLayer', active.id, { opacity: v }, true)}
            />
          </div>
          <div className="layers" role="list">
            {rows.map(({ l, i }) => (
              <LayerRow key={l.id} layer={l} index={i} active={l.id === doc.activeLayerId} onDragIndex={(from, to) => engine.call('moveLayer', doc.layers[from].id, to)} />
            ))}
          </div>
          <div className="panel-foot">
            <button className="icon-btn" title="Nueva capa (Ctrl+Mayús+N)" onClick={() => engine.call('newLayer')}><Plus size={16} /></button>
            <button className="icon-btn" title="Duplicar capa (Ctrl+J)" onClick={() => engine.call('duplicateLayer')}><Copy size={15} /></button>
            <button className="icon-btn" title="Eliminar capa" disabled={doc.layers.length <= 1} onClick={() => engine.call('deleteLayer')}><Trash2 size={15} /></button>
          </div>
        </>
      ) : (
        <div className="panel-body hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><LayersIcon size={14} /> Abre o crea un documento</div>
      )}
    </section>
  );
}
