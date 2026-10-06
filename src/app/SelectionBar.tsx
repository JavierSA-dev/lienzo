// Barra contextual de la selección: aparece bajo lo seleccionado y permite pedir cambios a la IA
// solo en esa zona ("elimínalo", "ponlo rojo"…), además de las acciones habituales.
import { useEffect, useState } from 'react';
import { Sparkles, Eraser, Contrast, SquareDashed, X as XIcon, EyeOff, ArrowRight } from 'lucide-react';
import { useStore } from './store';
import { commandById, runCommand } from './commands';
import { toolByName } from './assistant/tools';
import type { Rect } from '../engine/types';

const run = (id: string) => { const c = commandById[id]; if (c) runCommand(c); };

export function askAssistant(text: string) {
  useStore.setState({ assistantOpen: true, assistantAsk: { text, n: Date.now() } });
}

/** sel: límites de la selección en px de documento; X/Y pasan a coordenadas de la vista. */
export function SelectionBar({ sel, X, Y, area }: { sel: Rect; X: (x: number) => number; Y: (y: number) => number; area: { w: number; h: number } }) {
  const [text, setText] = useState('');
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const assistantOpen = useStore((s) => s.assistantOpen);
  // Una selección nueva vuelve a mostrar la barra.
  const key = `${sel.x},${sel.y},${sel.w},${sel.h}`;
  useEffect(() => { setHidden(false); }, [key]);
  // Al pinchar en el lienzo (otra selección, pintar…) la barra se aparta hasta que cambie la selección.
  useEffect(() => {
    const area = document.querySelector('[data-testid="canvas-area"]');
    const down = (e: Event) => { if (!(e.target as Element | null)?.closest?.('.selbar')) setHidden(true); };
    area?.addEventListener('pointerdown', down, true);
    return () => area?.removeEventListener('pointerdown', down, true);
  }, []);
  // Con Mayús/Alt/Ctrl pulsadas se está modificando la selección: la barra se aparta para no estorbar.
  const [mods, setMods] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => setMods(e.shiftKey || e.altKey || e.ctrlKey || e.metaKey);
    const off = () => setMods(false);
    window.addEventListener('keydown', on, true); window.addEventListener('keyup', on, true); window.addEventListener('blur', off);
    return () => { window.removeEventListener('keydown', on, true); window.removeEventListener('keyup', on, true); window.removeEventListener('blur', off); };
  }, []);
  if (hidden) return null;
  const W = 470, H = 40;
  const cx = X(sel.x + sel.w / 2);
  let top = Y(sel.y + sel.h) + 14;
  if (top + H > area.h - 8) top = Math.max(8, Y(sel.y) - H - 14);
  if (top + H > area.h - 8 || top < 8) top = area.h - H - 12;
  // Si el asistente está abierto (abajo a la derecha), la barra no se mete debajo.
  const right = assistantOpen && area.w > W + 400 ? area.w - 372 : area.w - 8;
  const left = Math.max(8, Math.min(right - W, cx - W / 2));
  const submit = () => { const t = text.trim(); if (!t) return; setText(''); askAssistant(t); };
  const remove = async () => {
    setBusy(true);
    try { await toolByName.content_aware_fill.run({}); } catch (e) { useStore.getState().toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className={`selbar ${mods && !focused ? 'off' : ''}`} data-testid="selbar" style={{ left, top, width: W }} role="toolbar" aria-label="Acciones de la selección"
      onPointerDown={stop} onPointerUp={stop} onPointerMove={stop} onDoubleClick={stop} onWheel={stop}>
      <form className="selbar-ask" onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Sparkles size={14} className="selbar-spark" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Pide un cambio en la selección…" aria-label="Petición a la IA sobre la selección"
          data-testid="selbar-input" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') (e.target as HTMLInputElement).blur(); }} />
        <button type="submit" className="selbar-go" title="Generar" aria-label="Generar" disabled={!text.trim()} data-testid="selbar-go"><ArrowRight size={14} /></button>
      </form>
      <span className="selbar-sep" />
      <button type="button" className="icon-btn" title="Eliminar lo seleccionado (rellenar según el contenido)" aria-label="Eliminar lo seleccionado" disabled={busy} onClick={() => void remove()} data-testid="selbar-remove"><Eraser size={15} /></button>
      <button type="button" className="icon-btn" title="Invertir selección" aria-label="Invertir selección" onClick={() => run('select.invert')}><Contrast size={15} /></button>
      <button type="button" className="icon-btn" title="Crear máscara a partir de la selección" aria-label="Crear máscara" onClick={() => run('layer.mask.selection')}><SquareDashed size={15} /></button>
      <button type="button" className="icon-btn" title="Deseleccionar" aria-label="Deseleccionar" onClick={() => run('select.none')}><XIcon size={15} /></button>
      <button type="button" className="icon-btn" title="Ocultar la barra" aria-label="Ocultar la barra" onClick={() => setHidden(true)}><EyeOff size={14} /></button>
    </div>
  );
}
