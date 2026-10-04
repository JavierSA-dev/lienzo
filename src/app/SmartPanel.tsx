// Propiedades de un objeto inteligente: contenido, reemplazar, rasterizar y la lista de filtros inteligentes.
import { useState } from 'react';
import { Eye, EyeOff, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { engine } from '../engine/client';
import { replaceSmartFile } from './commands';
import { FILTER_FIELDS } from './Dialogs';
import type { LayerInfo } from '../engine/types';
import type { FilterName } from '../engine/filters';
import type { CameraRaw } from '../engine/camraw';
import { useStore } from './store';

export function SmartProperties({ L }: { L: LayerInfo }) {
  const sm = L.smart!;
  const [open, setOpen] = useState<number | null>(null);
  const m = sm.matrix, scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const set = (i: number, patch: object | null, record = true) => engine.call('setSmartFilter', L.id, i, patch, record);
  return (
    <div className="smart-props">
      <div className="hint">{sm.source ?? 'Contenido incrustado'} · {sm.w} × {sm.h} px · {Math.round(scale * 100)} %</div>
      <div className="row-btns">
        <button className="chip" onClick={() => engine.call('editSmartContents', L.id)}>Editar contenido</button>
        <button className="chip" onClick={() => { void replaceSmartFile(); }}>Reemplazar…</button>
        <button className="chip" onClick={() => engine.call('rasterizeLayer', L.id)}>Rasterizar</button>
      </div>
      <div className="char-sep">Filtros inteligentes</div>
      {!sm.filters.length && <div className="hint">Aplica cualquier filtro del menú Filtro: queda aquí, editable y reversible.</div>}
      <div className="smart-filters" data-testid="smart-filters">
        {[...sm.filters.keys()].reverse().map((i) => {
          const f = sm.filters[i];
          const def = FILTER_FIELDS[f.name as FilterName];
          return (
            <div key={i} className="smart-filter" data-testid="smart-filter">
              <div className="sf-head">
                <button className="icon-btn" title={f.enabled ? 'Ocultar filtro' : 'Mostrar filtro'} aria-label={`${f.enabled ? 'Ocultar' : 'Mostrar'} ${def?.title ?? f.name}`} onClick={() => set(i, { enabled: !f.enabled })}>
                  {f.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
                <button className="sf-name" onClick={() => setOpen(open === i ? null : i)}>
                  {open === i ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {def?.title ?? f.name}
                </button>
                <button className="icon-btn" title="Eliminar filtro inteligente" aria-label={`Eliminar ${def?.title ?? f.name}`} onClick={() => set(i, null)}><Trash2 size={13} /></button>
              </div>
              {open === i && (
                <div className="sf-body">
                  {f.name === 'cameraRaw' && <button className="chip" onClick={() => useStore.getState().setDialog({ kind: 'develop', edit: { layerId: L.id, index: i, cr: f.params.cr as CameraRaw } })}>Editar revelado…</button>}
                  {def?.fields.map(([key, label, min, max, dflt, step]) => {
                    const v = Number(f.params[key] ?? dflt);
                    return (
                      <label className="adj-row" key={key}><span>{label}</span>
                        <input type="range" min={min} max={max} step={step ?? 1} value={v} aria-label={label}
                          onChange={(e) => set(i, { params: { [key]: Number(e.target.value) } }, false)}
                          onPointerUp={(e) => set(i, { params: { [key]: Number((e.target as HTMLInputElement).value) } })} />
                        <span className="val">{Math.round(v * 10) / 10}</span>
                      </label>
                    );
                  })}
                  <label className="adj-row"><span>Opacidad</span>
                    <input type="range" min={0} max={100} value={Math.round((f.opacity ?? 1) * 100)} aria-label="Opacidad del filtro"
                      onChange={(e) => set(i, { opacity: Number(e.target.value) / 100 }, false)}
                      onPointerUp={(e) => set(i, { opacity: Number((e.target as HTMLInputElement).value) / 100 })} />
                    <span className="val">{Math.round((f.opacity ?? 1) * 100)}</span>
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
