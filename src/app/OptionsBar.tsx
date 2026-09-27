import { useStore } from './store';
import { engine } from '../engine/client';

function Slider(props: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  const { label, value, min, max, step = 1, unit = '', onChange } = props;
  return (
    <label className="opt">
      {label}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <input
        className="num"
        type="number"
        min={min}
        max={max}
        value={Math.round(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {unit}
    </label>
  );
}

const TOOL_NAMES: Record<string, string> = {
  move: 'Mover', marquee: 'Marco rectangular', brush: 'Pincel', eraser: 'Borrador',
  eyedropper: 'Cuentagotas', hand: 'Mano', zoom: 'Zoom',
};

export function OptionsBar() {
  const tool = useStore((s) => s.tool);
  const brush = useStore((s) => s.brush);
  const setBrush = useStore((s) => s.setBrush);
  const doc = useStore((s) => s.doc);

  const painting = tool === 'brush' || tool === 'eraser';
  return (
    <div className="optionsbar">
      <span className="opt-tool">{TOOL_NAMES[tool]}</span>
      {painting && (
        <>
          <Slider label="Tamaño" value={brush.size} min={1} max={1000} unit="px" onChange={(v) => setBrush({ size: v })} />
          <Slider label="Dureza" value={brush.hardness * 100} min={0} max={100} unit="%" onChange={(v) => setBrush({ hardness: v / 100 })} />
          <Slider label="Opacidad" value={brush.opacity * 100} min={1} max={100} unit="%" onChange={(v) => setBrush({ opacity: v / 100 })} />
          <Slider label="Flujo" value={brush.flow * 100} min={1} max={100} unit="%" onChange={(v) => setBrush({ flow: v / 100 })} />
          <button className={`chip ${brush.pressureSize ? 'on' : ''}`} title="La presión del lápiz controla el tamaño" onClick={() => setBrush({ pressureSize: !brush.pressureSize })}>Presión → tamaño</button>
          <button className={`chip ${brush.pressureOpacity ? 'on' : ''}`} title="La presión del lápiz controla la opacidad" onClick={() => setBrush({ pressureOpacity: !brush.pressureOpacity })}>Presión → opacidad</button>
        </>
      )}
      {tool === 'move' && <span className="hint">Arrastra para mover la capa activa · Mayús restringe el eje</span>}
      {tool === 'marquee' && <span className="hint">Mayús: cuadrado · Alt: desde el centro · Ctrl+D deselecciona</span>}
      {tool === 'eyedropper' && <span className="hint">Clic: color frontal · Alt+clic: color de fondo</span>}
      {(tool === 'hand' || tool === 'zoom') && (
        <>
          <button className="chip" disabled={!doc.open} onClick={() => engine.call('actualPixels')}>100 %</button>
          <button className="chip" disabled={!doc.open} onClick={() => engine.call('fit', false)}>Encajar en pantalla</button>
          {tool === 'zoom' && <span className="hint">Clic acerca · Alt+clic aleja · Ctrl+rueda en cualquier herramienta</span>}
        </>
      )}
    </div>
  );
}
