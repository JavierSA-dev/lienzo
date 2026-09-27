import {
  Move, SquareDashed, Lasso, WandSparkles, Crop, Pipette, Bandage, Brush, Stamp, History, Eraser, Blend,
  Droplet, SunDim, PenTool, Type, MousePointer2, RectangleHorizontal, Hand, ZoomIn, ArrowLeftRight, type LucideIcon,
} from 'lucide-react';
import { useStore } from './store';
import type { ToolId } from '../engine/types';

interface ToolDef { id?: ToolId; icon: LucideIcon; label: string; keys: string; group?: boolean }

/** Barra de herramientas con el orden de Photoshop. Las de fases posteriores se ven atenuadas. */
const TOOLS: (ToolDef | '-')[] = [
  { id: 'move', icon: Move, label: 'Mover', keys: 'V', group: true },
  { id: 'marquee', icon: SquareDashed, label: 'Marco rectangular', keys: 'M', group: true },
  { icon: Lasso, label: 'Lazo', keys: 'L', group: true },
  { icon: WandSparkles, label: 'Selección de objetos / rápida / varita', keys: 'W', group: true },
  { icon: Crop, label: 'Recortar', keys: 'C', group: true },
  { id: 'eyedropper', icon: Pipette, label: 'Cuentagotas', keys: 'I', group: true },
  '-',
  { icon: Bandage, label: 'Pincel corrector puntual', keys: 'J', group: true },
  { id: 'brush', icon: Brush, label: 'Pincel', keys: 'B', group: true },
  { icon: Stamp, label: 'Tampón de clonar', keys: 'S', group: true },
  { icon: History, label: 'Pincel de historia', keys: 'Y', group: true },
  { id: 'eraser', icon: Eraser, label: 'Borrador', keys: 'E', group: true },
  { icon: Blend, label: 'Degradado / Bote de pintura', keys: 'G', group: true },
  { icon: Droplet, label: 'Desenfocar / Enfocar / Dedo', keys: '', group: true },
  { icon: SunDim, label: 'Sobreexponer / Subexponer', keys: 'O', group: true },
  '-',
  { icon: PenTool, label: 'Pluma', keys: 'P', group: true },
  { icon: Type, label: 'Texto horizontal', keys: 'T', group: true },
  { icon: MousePointer2, label: 'Selección de trazado', keys: 'A', group: true },
  { icon: RectangleHorizontal, label: 'Rectángulo', keys: 'U', group: true },
  '-',
  { id: 'hand', icon: Hand, label: 'Mano', keys: 'H', group: true },
  { id: 'zoom', icon: ZoomIn, label: 'Zoom', keys: 'Z' },
];

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const fg = useStore((s) => s.fg);
  const bg = useStore((s) => s.bg);
  const setColors = useStore((s) => s.setColors);

  return (
    <aside className="toolbar" aria-label="Herramientas">
      {TOOLS.map((t, i) => {
        if (t === '-') return <div className="tool-sep" key={i} />;
        const Icon = t.icon;
        const soon = !t.id;
        return (
          <button
            key={t.label}
            className={`tool ${t.id === tool ? 'active' : ''} ${soon ? 'soon' : ''}`}
            title={`${t.label}${t.keys ? ` (${t.keys})` : ''}${soon ? ' — próximamente' : ''}`}
            aria-label={t.label}
            aria-pressed={t.id === tool}
            onClick={() => t.id && setTool(t.id)}
          >
            <Icon size={17} strokeWidth={1.6} />
            {t.group && <span className="corner" />}
          </button>
        );
      })}
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
