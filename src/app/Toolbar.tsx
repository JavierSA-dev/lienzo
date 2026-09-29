import { useEffect, useRef, useState } from 'react';
import {
  Move, SquareDashed, Circle, Lasso, Spline, WandSparkles, Crop, Pipette, Bandage, Brush, Pencil, Stamp, History, Eraser, Blend,
  PaintBucket, Droplet, Sun, Moon, PenTool, Type, MousePointer2, Shapes, Hand, ZoomIn, ArrowLeftRight, Triangle, Pointer, Puzzle, RotateCw, Eye, type LucideIcon,
} from 'lucide-react';
import { useStore } from './store';
import { engine } from '../engine/client';
import { TOOL_GROUPS, TOOL_NAMES, selectTool, groupOf } from './commands';
import type { ToolId } from '../engine/types';

const ICONS: Record<ToolId, LucideIcon> = {
  move: Move, marquee: SquareDashed, marqueeEllipse: Circle, lasso: Lasso, polylasso: Spline, wand: WandSparkles,
  crop: Crop, eyedropper: Pipette, brush: Brush, pencil: Pencil, clone: Stamp, eraser: Eraser, gradient: Blend,
  bucket: PaintBucket, dodge: Sun, burn: Moon, text: Type, shape: Shapes, hand: Hand, zoom: ZoomIn,
  spotHeal: Bandage, heal: Bandage, patch: Puzzle, pen: PenTool, pathSelect: MousePointer2, blur: Droplet, sharpen: Triangle, smudge: Pointer, historyBrush: History, rotateView: RotateCw, redEye: Eye,
};

/** Orden de la barra de Photoshop; los grupos sin herramienta aún se ven atenuados. */
const LAYOUT: (string | { soon: string; icon: LucideIcon; key: string } | '-')[] = [
  'V', 'M', 'L', 'W', 'C', 'I', '-',
  'J', 'B', 'S', 'Y', 'E', 'G',
  '_R', 'O', '-',
  'P', 'T', 'A', 'U', '-',
  'H', 'Z',
];

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const groupTool = useStore((s) => s.groupTool);
  const fg = useStore((s) => s.fg);
  const bg = useStore((s) => s.bg);
  const setColors = useStore((s) => s.setColors);
  const [flyout, setFlyout] = useState<{ key: string; top: number } | null>(null);
  const ref = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!flyout) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setFlyout(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [flyout]);

  return (
    <aside className="toolbar" aria-label="Herramientas" ref={ref}>
      {LAYOUT.map((item, i) => {
        if (item === '-') return <div className="tool-sep" key={i} />;
        if (typeof item !== 'string') {
          const Icon = item.icon;
          return (
            <button key={i} className="tool soon" title={`${item.soon}${item.key ? ` (${item.key})` : ''} — próximamente`} aria-label={item.soon}>
              <Icon size={17} strokeWidth={1.6} /><span className="corner" />
            </button>
          );
        }
        const g = TOOL_GROUPS.find((x) => x.key === item)!;
        const current = g.tools.includes(tool) ? tool : groupTool[g.key] ?? g.tools[0];
        const Icon = ICONS[current];
        const active = g.tools.includes(tool);
        const openFly = (el: HTMLElement) => g.tools.length > 1 && setFlyout({ key: g.key, top: el.offsetTop });
        return (
          <button
            key={g.key}
            className={`tool ${active ? 'active' : ''}`}
            title={g.key.startsWith('_') ? TOOL_NAMES[current] : `${TOOL_NAMES[current]} (${g.key})${g.tools.length > 1 ? ` · Mayús+${g.key} alterna` : ''}`}
            aria-label={TOOL_NAMES[current]}
            aria-pressed={active}
            data-tool={current}
            onPointerDown={(e) => {
              const el = e.currentTarget;
              timer.current = setTimeout(() => openFly(el), 400);
            }}
            onPointerUp={() => { if (timer.current) clearTimeout(timer.current); }}
            onClick={() => selectTool(current)}
            onContextMenu={(e) => { e.preventDefault(); openFly(e.currentTarget); }}
          >
            <Icon size={17} strokeWidth={1.6} />
            {g.tools.length > 1 && <span className="corner" />}
          </button>
        );
      })}
      {flyout && (
        <div className="tool-flyout" style={{ top: flyout.top }}>
          {TOOL_GROUPS.find((g) => g.key === flyout.key)!.tools.map((t) => {
            const Icon = ICONS[t];
            return (
              <button key={t} className={`menu-item ${t === tool ? 'current' : ''}`} onClick={() => { selectTool(t); setFlyout(null); }}>
                <span className="fly-label"><Icon size={15} /> {TOOL_NAMES[t]}</span><span className="keys">{groupOf(t).key.startsWith('_') ? '' : groupOf(t).key}</span>
              </button>
            );
          })}
        </div>
      )}
      <QuickMaskButton />
      <div className="swatches">
        <button className="swatch fg" style={{ background: fg }} title="Color frontal (clic: selector de color)" onClick={() => useStore.getState().setDialog({ kind: 'colorPicker', which: 'fg' })} />
        <button className="swatch bg" style={{ background: bg }} title="Color de fondo (clic: selector de color)" onClick={() => useStore.getState().setDialog({ kind: 'colorPicker', which: 'bg' })} />
        <button className="swap-btn" title="Intercambiar (X)" onClick={() => setColors(bg, fg)}>
          <ArrowLeftRight size={10} />
        </button>
        <button className="reset-btn" title="Colores por defecto (D)" onClick={() => setColors('#000000', '#ffffff')}>
          <svg width="11" height="11" viewBox="0 0 11 11"><rect x="0.5" y="0.5" width="6" height="6" fill="#000" stroke="#aaa" /><rect x="4.5" y="4.5" width="6" height="6" fill="#fff" stroke="#aaa" /></svg>
        </button>
      </div>
    </aside>
  );
}



/** Botón de Máscara rápida (Q) bajo las herramientas, como en Photoshop. */
function QuickMaskButton() {
  const on = useStore((s) => s.doc.quickMask);
  const open = useStore((s) => s.doc.open);
  return (
    <button className={`tool qm-btn ${on ? 'active' : ''}`} disabled={!open} title="Editar en modo Máscara rápida (Q)" aria-label="Máscara rápida" aria-pressed={on}
      onClick={() => engine.call('toggleQuickMask')} data-testid="quick-mask">
      <svg width="17" height="17" viewBox="0 0 18 18"><rect x="2" y="3" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="9" cy="9" r="3.3" fill={on ? '#e55' : 'currentColor'} /></svg>
    </button>
  );
}
