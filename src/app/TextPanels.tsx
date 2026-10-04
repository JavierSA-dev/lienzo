// Texto: selector de fuentes (sistema, Google Fonts y fuentes del equipo), paneles Carácter y Párrafo
// y el diálogo Deformar texto.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlignLeft, AlignCenter, AlignRight, AlignJustify, Bold, Italic, Underline, Strikethrough, CaseUpper, CaseSensitive, Search } from 'lucide-react';
import { engine } from '../engine/client';
import { useStore, toHex, toRgba } from './store';
import { askLocalFonts } from './localFonts';
import { Modal } from './Dialogs';
import { SYSTEM_FONTS, GOOGLE_FONTS, loadGoogleFont } from '../engine/fonts';
import { WARP_STYLES } from '../engine/text';
import type { LayerInfo, TextParams, TextWarp } from '../engine/types';

/** Aplica cambios al texto que se edita o a la capa de texto activa. */
export function applyText(p: Partial<TextParams>, record = true) {
  const s = useStore.getState();
  const id = s.textEdit?.layerId ?? s.doc.layers.find((l) => l.id === s.doc.activeLayerId && l.kind === 'text')?.id;
  if (id) engine.call('updateText', id, p, record);
}

/** Carga una fuente también en la página (para el cuadro de edición y las vistas previas). */
export function useFont(family: string) {
  useEffect(() => { void loadGoogleFont(family); }, [family]);
}


export function FontPicker({ value, onChange, compact }: { value: string; onChange: (f: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const local = useStore((s) => s.localFonts);
  const ref = useRef<HTMLDivElement>(null);
  useFont(value);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const groups = useMemo(() => {
    const f = (l: string[]) => l.filter((x) => x.toLowerCase().includes(q.toLowerCase()));
    return [['Sistema', f(SYSTEM_FONTS)], ['Google Fonts', f(GOOGLE_FONTS)], ['Tu equipo', f(local)]] as [string, string[]][];
  }, [q, local]);
  const pick = (f: string) => { setOpen(false); setQ(''); void loadGoogleFont(f); onChange(f); };
  return (
    <div className={`font-picker ${compact ? 'compact' : ''}`} ref={ref}>
      <button type="button" className="font-btn" style={{ fontFamily: `"${value}", sans-serif` }} onClick={() => setOpen(!open)} aria-label="Fuente" data-testid="font-picker">{value}</button>
      {open && (
        <div className="font-pop" role="listbox">
          <label className="font-search"><Search size={13} /><input autoFocus value={q} placeholder="Buscar fuente" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { const first = groups.flatMap((g) => g[1])[0]; if (first) pick(first); } if (e.key === 'Escape') setOpen(false); }} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="font-list">
            {groups.map(([g, list]) => list.length > 0 && (
              <div key={g}>
                <div className="font-group">{g}</div>
                {list.map((f) => (
                  <button type="button" key={g + f} role="option" aria-selected={f === value} className={`font-item ${f === value ? 'on' : ''}`}
                    style={g !== 'Google Fonts' ? { fontFamily: `"${f}", sans-serif` } : undefined}
                    onPointerEnter={() => { if (g === 'Google Fonts') void loadGoogleFont(f).then(() => ref.current?.querySelector<HTMLElement>(`[data-font="${f}"]`)?.style.setProperty('font-family', `"${f}", sans-serif`)); }}
                    data-font={f} onClick={() => pick(f)}>{f}</button>
                ))}
              </div>
            ))}
            {!local.length && <button type="button" className="font-item local" onClick={askLocalFonts}>Cargar las fuentes de tu equipo…</button>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Campo numérico: aplica en vivo y guarda en el historial al terminar. */
function Num({ label, value, min, max, step = 1, unit, onLive, onCommit, title }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onLive: (v: number) => void; onCommit: (v: number) => void; title?: string }) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(Math.round(value * 100) / 100)), [value]);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <label className="char-field" title={title ?? label}><span>{label}</span>
      <input type="number" step={step} min={min} max={max} value={txt} aria-label={title ?? label}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') onCommit(clamp(Number(txt) || 0)); }}
        onChange={(e) => { setTxt(e.target.value); if (e.target.value !== '' && !isNaN(Number(e.target.value))) onLive(clamp(Number(e.target.value))); }}
        onBlur={() => onCommit(clamp(Number(txt) || 0))} />{unit && <em>{unit}</em>}
    </label>
  );
}

/** Paneles Carácter y Párrafo de una capa de texto (en Propiedades). */
export function TextProperties({ L }: { L: LayerInfo }) {
  const t = L.text!;
  const up = (p: Partial<TextParams>, record = true) => engine.call('updateText', L.id, p, record);
  const T = (on: boolean, label: string, icon: React.ReactNode, p: Partial<TextParams>) => (
    <button type="button" className={`icon-btn ${on ? 'on' : ''}`} title={label} aria-label={label} aria-pressed={on} onClick={() => up(p)}>{icon}</button>
  );
  return (
    <div className="text-props">
      <div className="char-row"><FontPicker value={t.font} onChange={(font) => up({ font })} /></div>
      <div className="char-row">
        <Num label="T" title="Tamaño" value={t.size} min={1} max={2000} unit="px" onLive={(size) => up({ size }, false)} onCommit={(size) => up({ size })} />
        <Num label="A" title="Interlineado (× cuerpo)" value={t.lineHeight} min={0.5} max={5} step={0.05} onLive={(lineHeight) => up({ lineHeight }, false)} onCommit={(lineHeight) => up({ lineHeight })} />
        <Num label="VA" title="Seguimiento (milésimas de eme)" value={t.tracking ?? 0} min={-500} max={2000} step={10} onLive={(tracking) => up({ tracking }, false)} onCommit={(tracking) => up({ tracking })} />
      </div>
      <div className="char-row">
        <Num label="↕" title="Escala vertical" value={t.vScale ?? 100} min={10} max={500} unit="%" onLive={(vScale) => up({ vScale }, false)} onCommit={(vScale) => up({ vScale })} />
        <Num label="↔" title="Escala horizontal" value={t.hScale ?? 100} min={10} max={500} unit="%" onLive={(hScale) => up({ hScale }, false)} onCommit={(hScale) => up({ hScale })} />
        <Num label="A↑" title="Desplazamiento vertical" value={t.baselineShift ?? 0} min={-500} max={500} unit="px" onLive={(baselineShift) => up({ baselineShift }, false)} onCommit={(baselineShift) => up({ baselineShift })} />
      </div>
      <div className="char-row">
        <label className="char-field" title="Color"><span>Color</span><input type="color" aria-label="Color del texto" value={toHex(t.color)} onChange={(e) => up({ color: toRgba(e.target.value) })} /></label>
        {T(t.bold, 'Negrita', <Bold size={14} />, { bold: !t.bold })}
        {T(t.italic, 'Cursiva', <Italic size={14} />, { italic: !t.italic })}
        {T(t.caps === 'all', 'Todo mayúsculas', <CaseUpper size={14} />, { caps: t.caps === 'all' ? 'none' : 'all' })}
        {T(t.caps === 'small', 'Versalitas', <CaseSensitive size={14} />, { caps: t.caps === 'small' ? 'none' : 'small' })}
        {T(!!t.underline, 'Subrayado', <Underline size={14} />, { underline: !t.underline })}
        {T(!!t.strike, 'Tachado', <Strikethrough size={14} />, { strike: !t.strike })}
      </div>
      <div className="char-sep">Párrafo</div>
      <div className="char-row">
        {T(t.align === 'left', 'Alinear a la izquierda', <AlignLeft size={14} />, { align: 'left' })}
        {T(t.align === 'center', 'Centrar', <AlignCenter size={14} />, { align: 'center' })}
        {T(t.align === 'right', 'Alinear a la derecha', <AlignRight size={14} />, { align: 'right' })}
        {T(t.align === 'justify', 'Justificar (última línea a la izquierda)', <AlignJustify size={14} />, { align: 'justify' })}
        <button type="button" className="chip" onClick={() => useStore.getState().setDialog({ kind: 'warpText' })} title="Texto > Deformar texto">Deformar…</button>
      </div>
      <div className="char-row">
        <Num label="⇥" title="Sangría izquierda" value={t.indentLeft ?? 0} min={0} max={2000} unit="px" onLive={(indentLeft) => up({ indentLeft }, false)} onCommit={(indentLeft) => up({ indentLeft })} />
        <Num label="⇤" title="Sangría derecha" value={t.indentRight ?? 0} min={0} max={2000} unit="px" onLive={(indentRight) => up({ indentRight }, false)} onCommit={(indentRight) => up({ indentRight })} />
        <Num label="↳" title="Sangría de primera línea" value={t.indentFirst ?? 0} min={-500} max={2000} unit="px" onLive={(indentFirst) => up({ indentFirst }, false)} onCommit={(indentFirst) => up({ indentFirst })} />
      </div>
      <div className="char-row">
        <Num label="¶" title="Espacio después del párrafo" value={t.spaceAfter ?? 0} min={0} max={2000} unit="px" onLive={(spaceAfter) => up({ spaceAfter }, false)} onCommit={(spaceAfter) => up({ spaceAfter })} />
        {t.box
          ? <button type="button" className="chip" onClick={() => up({ box: null, y: t.y + t.size * 0.9 })} title="Convertir en texto de punto">Texto de punto</button>
          : <button type="button" className="chip" onClick={() => up({ box: { w: Math.max(200, t.size * 8), h: Math.max(100, t.size * 4) }, y: t.y - t.size * 0.9, align: t.align === 'justify' ? 'justify' : 'left' })} title="Convertir en texto de párrafo">Texto de párrafo</button>}
      </div>
      {t.box && (
        <div className="char-row">
          <Num label="An" title="Ancho de la caja" value={t.box.w} min={10} max={20000} unit="px" onLive={(w) => up({ box: { ...t.box!, w } }, false)} onCommit={(w) => up({ box: { ...t.box!, w } })} />
          <Num label="Al" title="Alto de la caja" value={t.box.h} min={10} max={20000} unit="px" onLive={(h) => up({ box: { ...t.box!, h } }, false)} onCommit={(h) => up({ box: { ...t.box!, h } })} />
        </div>
      )}
      <label className="adj-row"><span>Texto</span><textarea rows={3} value={t.text} aria-label="Contenido del texto" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => up({ text: e.target.value }, false)} onBlur={(e) => up({ text: e.target.value })} /></label>
    </div>
  );
}

/** Texto > Deformar texto… */
export function WarpTextDialog({ close }: { close: () => void }) {
  const doc = useStore((s) => s.doc);
  const L = doc.layers.find((l) => l.id === doc.activeLayerId && l.kind === 'text');
  const initial = useMemo(() => L?.text?.warp ?? null, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [w, setW] = useState<TextWarp>(initial ?? { style: 'arc', bend: 50, hDist: 0, vDist: 0 });
  const wRef = useRef(w);
  wRef.current = w;
  useEffect(() => { if (!L) { useStore.getState().toast('Selecciona una capa de texto para deformarla.', 'warn'); close(); } }, [L]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (L) engine.call('updateText', L.id, { warp: w }, false); }, [w]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!L) return null;
  const R = (label: string, k: 'bend' | 'hDist' | 'vDist') => (
    <label className="adj-row"><span>{label}</span>
      <input type="range" min={-100} max={100} value={w[k]} aria-label={label} onChange={(e) => { const v = Number(e.target.value); setW((c) => ({ ...c, [k]: v })); }} />
      <input type="number" className="num" min={-100} max={100} value={w[k]} aria-label={`${label} (valor)`} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => { const v = Math.max(-100, Math.min(100, Number(e.target.value) || 0)); setW((c) => ({ ...c, [k]: v })); }} />%
    </label>
  );
  return (
    <Modal title="Deformar texto" onClose={() => { engine.call('updateText', L.id, { warp: initial }, false); engine.call('updateText', L.id, { warp: initial }, true); close(); }}
      onOk={() => { const cur = wRef.current; engine.call('updateText', L.id, { warp: initial }, false); engine.call('updateText', L.id, { warp: cur.style === 'none' ? null : cur }, true); close(); }}>
      <label className="adj-row"><span>Estilo</span>
        <select value={w.style} aria-label="Estilo" onChange={(e) => { const style = e.target.value as TextWarp['style']; setW((c) => ({ ...c, style })); }}>
          {WARP_STYLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {R('Curvar', 'bend')}{R('Distorsión horizontal', 'hDist')}{R('Distorsión vertical', 'vDist')}
    </Modal>
  );
}
