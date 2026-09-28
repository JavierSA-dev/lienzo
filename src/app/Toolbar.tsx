import { useEffect, useRef, useState } from 'react';
import {
  Move, SquareDashed, Circle, Lasso, Spline, WandSparkles, Crop, Pipette, Bandage, Brush, Pencil, Stamp, History, Eraser, Blend,
  PaintBucket, Droplet, Sun, Moon, PenTool, Type, MousePointer2, Shapes, Hand, ZoomIn, ArrowLeftRight, Triangle, Pointer, Puzzle, type LucideIcon,
} from 'lucide-react';
import { useStore } from './store';
import { TOOL_GROUPS, TOOL_NAMES, selectTool, groupOf } from './commands';
import type { ToolId } from '../engine/types';

const ICONS: Record<ToolId, LucideIcon> = {
  move: Move, marquee: SquareDashed, marqueeEllipse: Circle, lasso: Lasso, polylasso: Spline, wand: WandSparkles,
  crop: Crop, eyedropper: Pipette, brush: Brush, pencil: Pencil, clone: Stamp, eraser: Eraser, gradient: Blend,
  bucket: PaintBucket, dodge: Sun, burn: Moon, text: Type, shape: Shapes, hand: Hand, zoom: ZoomIn,
  spotHeal: Bandage, heal: Bandage, patch: Puzzle, pen: PenTool, pathSelect: MousePointer2, blur: Droplet, sharpen: Triangle, smudge: Pointer,
};

/** Orden de la barra de Photoshop; los grupos sin herramienta aún se ven atenuados. */
const LAYOUT: (string | { soon: string; icon: LucideIcon; key: string } | '-')[] = [
  'V', 'M', 'L', 'W', 'C', 'I', '-',
  'J', 'B', 'S', { soon: 'Pincel de historia', icon: History, key: 'Y' }, 'E', 'G',
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
      <div className="swatches">
        <label className="swatch fg" style={{ background: fg }} title="Color frontal">
          <input type="color" value={fg} onChange={(e) => setColors(e.target.value, bg)} />
        </label>
        <label className="swatch bg" style={{ background: bg }} title="Color de fondo">
          <input type="color" value={bg} onChange={(e) => setColors(fg, e.target.value)} />
        </label>
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


