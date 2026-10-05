// Editor de degradado: valores preestablecidos, paradas de color y de opacidad, suavidad.
import { useRef, useState } from 'react';
import { Modal } from './Dialogs';
import { useStore, toRgba } from './store';
import type { GradientDef, RGBA, Stops } from '../engine/types';

const hex = (c: RGBA) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

export const GRADIENT_PRESETS: GradientDef[] = [
  { name: 'Frontal a fondo', stops: [{ t: 0, c: 'fg' }, { t: 1, c: 'bg' }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }], smooth: 1 },
  { name: 'Frontal a transparente', stops: [{ t: 0, c: 'fg' }, { t: 1, c: 'fg' }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 0 }], smooth: 1 },
  { name: 'Negro, blanco', stops: [{ t: 0, c: [0, 0, 0, 255] }, { t: 1, c: [255, 255, 255, 255] }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }], smooth: 1 },
  { name: 'Espectro', stops: [[255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 0, 0]].map((c, i) => ({ t: i / 6, c: [...c, 255] as RGBA })), alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }], smooth: 1 },
  { name: 'Cromado', stops: [{ t: 0, c: [41, 137, 204, 255] }, { t: 0.5, c: [255, 255, 255, 255] }, { t: 0.52, c: [144, 106, 0, 255] }, { t: 0.64, c: [217, 159, 0, 255] }, { t: 1, c: [255, 255, 255, 255] }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }], smooth: 1 },
  { name: 'Cobre', stops: [{ t: 0, c: [151, 70, 26, 255] }, { t: 0.3, c: [251, 216, 197, 255] }, { t: 0.83, c: [108, 46, 22, 255] }, { t: 1, c: [239, 219, 205, 255] }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }], smooth: 1 },
  { name: 'Violeta, naranja', stops: [{ t: 0, c: [41, 10, 89, 255] }, { t: 1, c: [255, 124, 0, 255] }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }], smooth: 1 },
  { name: 'Atardecer', stops: [{ t: 0, c: [26, 35, 126, 255] }, { t: 0.45, c: [233, 30, 99, 255] }, { t: 0.75, c: [255, 152, 0, 255] }, { t: 1, c: [255, 235, 59, 255] }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }], smooth: 1 },
  { name: 'Arco iris transparente', stops: [[255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255]].map((c, i) => ({ t: 0.1 + i * 0.16, c: [...c, 255] as RGBA })), alpha: [{ t: 0, a: 0 }, { t: 0.1, a: 1 }, { t: 0.9, a: 1 }, { t: 1, a: 0 }], smooth: 1 },
];

/** Resuelve frontal/fondo y ordena las paradas (lo que necesita el motor). */
export function resolveGradient(g: GradientDef, fg: string, bg: string, transparency = true): Stops {
  const col = (c: GradientDef['stops'][number]['c']): RGBA => (c === 'fg' ? toRgba(fg) : c === 'bg' ? toRgba(bg) : c);
  const c = [...g.stops].sort((a, b) => a.t - b.t).map((s) => { const v = col(s.c); return [s.t, v[0], v[1], v[2]] as [number, number, number, number]; });
  const a = transparency ? [...g.alpha].sort((x, y) => x.t - y.t).map((s) => [s.t, s.a] as [number, number]) : [[0, 1], [1, 1]] as [number, number][];
  return { c, a, smooth: g.smooth };
}

export function gradientCss(g: GradientDef, fg: string, bg: string): string {
  const s = resolveGradient(g, fg, bg);
  // Muestras cada 5 % (incluye opacidad) para la vista previa.
  const parts: string[] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const seg = <T extends number[]>(arr: T[]): [T, T, number] => { for (let k = 0; k < arr.length - 1; k++) if (t <= arr[k + 1][0]) { const sp = arr[k + 1][0] - arr[k][0]; return [arr[k], arr[k + 1], sp ? (t - arr[k][0]) / sp : 0]; } return t < arr[0][0] ? [arr[0], arr[0], 0] : [arr[arr.length - 1], arr[arr.length - 1], 0]; };
    const [c0, c1, u] = seg(s.c), [a0, a1, v] = seg(s.a);
    parts.push(`rgba(${Math.round(c0[1] + (c1[1] - c0[1]) * u)},${Math.round(c0[2] + (c1[2] - c0[2]) * u)},${Math.round(c0[3] + (c1[3] - c0[3]) * u)},${(a0[1] + (a1[1] - a0[1]) * v).toFixed(3)}) ${t * 100}%`);
  }
  return `linear-gradient(90deg, ${parts.join(',')}), repeating-conic-gradient(#999 0 25%, #666 0 50%) 0 0 / 10px 10px`;
}

/** Muestra del degradado (botón) que abre el editor. */
export function GradientSwatch({ value, onChange, title = 'Editar degradado' }: { value: GradientDef; onChange: (g: GradientDef) => void; title?: string }) {
  const fg = useStore((s) => s.fg), bg = useStore((s) => s.bg);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="grad-swatch" title={title} aria-label={title} style={{ background: gradientCss(value, fg, bg) }} onClick={() => setOpen(true)} />
      {open && <GradientEditor value={value} onClose={() => setOpen(false)} onOk={(g) => { onChange(g); setOpen(false); }} />}
    </>
  );
}

export function GradientEditor({ value, onOk, onClose }: { value: GradientDef; onOk: (g: GradientDef) => void; onClose: () => void }) {
  const fg = useStore((s) => s.fg), bg = useStore((s) => s.bg);
  const user = useStore((s) => s.userGradients);
  const [g, setG] = useState<GradientDef>(() => structuredClone(value));
  const [sel, setSel] = useState<{ kind: 'c' | 'a'; i: number }>({ kind: 'c', i: 0 });
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: 'c' | 'a'; i: number } | null>(null);
  const tAt = (clientX: number) => { const r = bar.current!.getBoundingClientRect(); return Math.max(0, Math.min(1, (clientX - r.left) / r.width)); };
  const move = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const t = Math.round(tAt(e.clientX) * 1000) / 1000;
    setG((o) => d.kind === 'c' ? { ...o, name: 'Personalizado', stops: o.stops.map((s, i) => (i === d.i ? { ...s, t } : s)) } : { ...o, name: 'Personalizado', alpha: o.alpha.map((s, i) => (i === d.i ? { ...s, t } : s)) });
  };
  const add = (kind: 'c' | 'a', e: React.PointerEvent) => {
    if ((e.target as Element).closest('.gstop')) return;
    const t = tAt(e.clientX);
    if (kind === 'c') { setG((o) => ({ ...o, name: 'Personalizado', stops: [...o.stops, { t, c: o.stops[sel.kind === 'c' ? sel.i : 0]?.c ?? 'fg' }] })); setSel({ kind: 'c', i: g.stops.length }); }
    else { setG((o) => ({ ...o, name: 'Personalizado', alpha: [...o.alpha, { t, a: 1 }] })); setSel({ kind: 'a', i: g.alpha.length }); }
  };
  const remove = () => setG((o) => {
    if (sel.kind === 'c' && o.stops.length > 2) { setSel({ kind: 'c', i: 0 }); return { ...o, stops: o.stops.filter((_, i) => i !== sel.i) }; }
    if (sel.kind === 'a' && o.alpha.length > 2) { setSel({ kind: 'a', i: 0 }); return { ...o, alpha: o.alpha.filter((_, i) => i !== sel.i) }; }
    return o;
  });
  const cur = sel.kind === 'c' ? g.stops[sel.i] : g.alpha[sel.i];
  const curColor = sel.kind === 'c' && cur ? ((cur as GradientDef['stops'][number]).c === 'fg' ? fg : (cur as GradientDef['stops'][number]).c === 'bg' ? bg : hex((cur as GradientDef['stops'][number]).c as RGBA)) : '#000000';
  const savePreset = () => {
    const name = `Degradado ${user.length + 1}`;
    const list = [...user, { ...g, name }];
    useStore.setState({ userGradients: list });
    try { localStorage.setItem('lienzo.gradients', JSON.stringify(list)); } catch { /* sin almacenamiento */ }
    setG({ ...g, name });
  };
  return (
    <Modal title="Editor de degradado" wide onClose={onClose} onOk={() => onOk(g)}>
      <div className="grad-editor" data-testid="gradient-editor">
        <div className="grad-presets">
          {[...GRADIENT_PRESETS, ...user].map((p) => (
            <button type="button" key={p.name} title={p.name} aria-label={p.name} className={`grad-swatch ${g.name === p.name ? 'on' : ''}`} style={{ background: gradientCss(p, fg, bg) }} onClick={() => { setG(structuredClone(p)); setSel({ kind: 'c', i: 0 }); }} />
          ))}
        </div>
        <label className="field">Nombre<input value={g.name} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setG({ ...g, name: e.target.value })} /></label>
        <div className="grad-bar-wrap" onPointerMove={move} onPointerUp={() => { drag.current = null; }}>
          <div className="grad-track top" onPointerDown={(e) => add('a', e)} title="Clic: nueva parada de opacidad">
            {g.alpha.map((s, i) => <span key={i} className={`gstop a ${sel.kind === 'a' && sel.i === i ? 'on' : ''}`} style={{ left: `${s.t * 100}%`, background: `rgba(255,255,255,${s.a})` }}
              onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget.parentElement!.parentElement as HTMLElement).setPointerCapture(e.pointerId); setSel({ kind: 'a', i }); drag.current = { kind: 'a', i }; }} />)}
          </div>
          <div ref={bar} className="grad-bar" data-testid="gradient-bar" style={{ background: gradientCss(g, fg, bg) }} />
          <div className="grad-track bottom" onPointerDown={(e) => add('c', e)} title="Clic: nueva parada de color">
            {g.stops.map((s, i) => <span key={i} className={`gstop c ${sel.kind === 'c' && sel.i === i ? 'on' : ''}`} style={{ left: `${s.t * 100}%`, background: s.c === 'fg' ? fg : s.c === 'bg' ? bg : hex(s.c as RGBA) }}
              onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget.parentElement!.parentElement as HTMLElement).setPointerCapture(e.pointerId); setSel({ kind: 'c', i }); drag.current = { kind: 'c', i }; }} />)}
          </div>
        </div>
        {cur && (
          <div className="row-tools">
            {sel.kind === 'c'
              ? <>
                <label>Color <input type="color" aria-label="Color de la parada" value={curColor} onChange={(e) => setG((o) => ({ ...o, name: 'Personalizado', stops: o.stops.map((s, i) => (i === sel.i ? { ...s, c: toRgba(e.target.value) } : s)) }))} /></label>
                <button type="button" className="chip" onClick={() => setG((o) => ({ ...o, stops: o.stops.map((s, i) => (i === sel.i ? { ...s, c: 'fg' } : s)) }))}>Frontal</button>
                <button type="button" className="chip" onClick={() => setG((o) => ({ ...o, stops: o.stops.map((s, i) => (i === sel.i ? { ...s, c: 'bg' } : s)) }))}>Fondo</button>
              </>
              : <label>Opacidad <input type="number" className="num" min={0} max={100} aria-label="Opacidad de la parada" value={Math.round((cur as { a: number }).a * 100)} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setG((o) => ({ ...o, alpha: o.alpha.map((s, i) => (i === sel.i ? { ...s, a: Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100 } : s)) }))} />%</label>}
            <label>Posición <input type="number" className="num" min={0} max={100} aria-label="Posición de la parada" value={Math.round(cur.t * 100)} onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => { const t = Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100; setG((o) => sel.kind === 'c' ? { ...o, stops: o.stops.map((s, i) => (i === sel.i ? { ...s, t } : s)) } : { ...o, alpha: o.alpha.map((s, i) => (i === sel.i ? { ...s, t } : s)) }); }} />%</label>
            <button type="button" className="chip" onClick={remove} disabled={(sel.kind === 'c' ? g.stops.length : g.alpha.length) <= 2}>Eliminar parada</button>
          </div>
        )}
        <label className="field sfield">Suavidad <b>{Math.round(g.smooth * 100)} %</b><input type="range" min={0} max={100} value={Math.round(g.smooth * 100)} aria-label="Suavidad" onChange={(e) => setG({ ...g, smooth: Number(e.target.value) / 100 })} /></label>
        <div className="row-btns"><button type="button" className="chip" onClick={savePreset}>Guardar como valor preestablecido</button></div>
      </div>
    </Modal>
  );
}
