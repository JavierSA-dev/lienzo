import {
  Check, X, Bold, Italic, AlignLeft, AlignCenter, AlignRight, AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter,
} from 'lucide-react';
import { useStore, toRgba } from './store';
import { penFinish } from './Pen';
import { isEmpty as isEmptyPath } from '../engine/path';
import { engine } from '../engine/client';
import { TOOL_NAMES } from './commands';
import { FONTS } from '../engine/vector';
import type { ShapeKind } from '../engine/types';
import type { GradientType } from '../engine/ops';

function Slider(props: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; width?: number }) {
  const { label, value, min, max, step = 1, unit = '', onChange, width } = props;
  return (
    <label className="opt">
      {label}
      <input type="range" min={min} max={max} step={step} value={value} style={width ? { width } : undefined} onChange={(e) => onChange(Number(e.target.value))} />
      <input className="num" type="number" min={min} max={max} value={Math.round(value)} onChange={(e) => onChange(Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()} />
      {unit}
    </label>
  );
}

const Toggle = ({ on, label, title, onClick }: { on: boolean; label: React.ReactNode; title?: string; onClick: () => void }) => (
  <button className={`chip ${on ? 'on' : ''}`} title={title} onClick={onClick}>{label}</button>
);

const SELECT_MODES = <span className="hint">Mayús: añadir · Alt: restar · Mayús+Alt: intersecar</span>;

export function OptionsBar() {
  const tool = useStore((s) => s.tool);
  const brush = useStore((s) => s.brush);
  const setBrush = useStore((s) => s.setBrush);
  const opts = useStore((s) => s.opts);
  const setOpts = useStore((s) => s.setOpts);
  const doc = useStore((s) => s.doc);
  const transform = useStore((s) => s.transform);
  const crop = useStore((s) => s.crop);

  if (transform) {
    const m = transform.matrix;
    const sx = Math.hypot(m[0], m[1]) * 100, sy = Math.hypot(m[2], m[3]) * 100, rot = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    return (
      <div className="optionsbar">
        <span className="opt-tool">Transformación libre</span>
        <span className="opt">An: {sx.toFixed(1)} %</span>
        <span className="opt">Al: {sy.toFixed(1)} %</span>
        <span className="opt">Ángulo: {rot.toFixed(1)}°</span>
        <span className="hint">Esquinas mantienen proporción (Mayús libera) · Alt: desde el centro · fuera de la caja: rotar (Mayús: 15°)</span>
        <span className="grow" />
        <button className="chip" title="Cancelar (Esc)" onClick={() => { engine.call('cancelTransform'); useStore.setState({ transform: null }); }}><X size={14} /></button>
        <button className="chip on" title="Aplicar (Intro)" onClick={() => { engine.call('commitTransform'); useStore.setState({ transform: null }); }}><Check size={14} /></button>
      </div>
    );
  }

  const painting = ['brush', 'pencil', 'eraser', 'clone', 'dodge', 'burn', 'blur', 'sharpen', 'smudge'].includes(tool);
  const strength = tool === 'blur' || tool === 'sharpen' || tool === 'smudge';
  return (
    <div className="optionsbar">
      <span className="opt-tool">{TOOL_NAMES[tool]}</span>
      {painting && (
        <>
          <Slider label="Tamaño" value={brush.size} min={1} max={1000} unit="px" onChange={(v) => setBrush({ size: v })} />
          {tool !== 'pencil' && <Slider label="Dureza" value={brush.hardness * 100} min={0} max={100} unit="%" onChange={(v) => setBrush({ hardness: v / 100 })} />}
          <Slider label={tool === 'dodge' || tool === 'burn' ? 'Exposición' : strength ? 'Intensidad' : 'Opacidad'} value={brush.opacity * 100} min={1} max={100} unit="%" onChange={(v) => setBrush({ opacity: v / 100 })} />
          {!strength && <Slider label="Flujo" value={brush.flow * 100} min={1} max={100} unit="%" onChange={(v) => setBrush({ flow: v / 100 })} />}
          <Toggle on={brush.pressureSize} label="Presión → tamaño" onClick={() => setBrush({ pressureSize: !brush.pressureSize })} />
          <Toggle on={brush.pressureOpacity} label="Presión → opacidad" onClick={() => setBrush({ pressureOpacity: !brush.pressureOpacity })} />
          {tool === 'clone' && <span className="hint">Alt+clic define el origen</span>}
          {doc.editMask && <span className="hint mask-hint">Pintando en la máscara: negro oculta, blanco muestra</span>}
        </>
      )}
      {(tool === 'spotHeal' || tool === 'heal') && (
        <>
          <Slider label="Tamaño" value={brush.size} min={1} max={1000} unit="px" onChange={(v) => setBrush({ size: v })} />
          <Slider label="Dureza" value={brush.hardness * 100} min={0} max={100} unit="%" onChange={(v) => setBrush({ hardness: v / 100 })} />
          <span className="hint">{tool === 'spotHeal'
            ? 'Tipo: según el contenido · pinta sobre la imperfección y suelta'
            : 'Alt+clic define el origen · la textura se adapta al color y la luz del destino'}</span>
        </>
      )}
      {(tool === 'pen' || tool === 'pathSelect') && <PathActions />}
      {tool === 'rotateView' && <RotateOptions />}
      {tool === 'redEye' && (
        <>
          <Slider label="Tamaño de pupila" value={opts.pupilSize} min={1} max={100} unit="%" width={90} onChange={(v) => setOpts({ pupilSize: v })} />
          <Slider label="Cantidad de oscurecimiento" value={opts.darkenAmount} min={1} max={100} unit="%" width={90} onChange={(v) => setOpts({ darkenAmount: v })} />
          <span className="hint">Clic en el ojo o arrastra un rectángulo alrededor</span>
        </>
      )}
      {tool === 'patch' && <span className="hint">Parche · Origen: rodea la zona a corregir y arrástrala hasta una zona limpia (Mayús añade, Alt resta)</span>}
      {tool === 'move' && (
        <>
          <Toggle on={opts.autoSelect} label="Selección automática" title="Clic sobre el lienzo selecciona la capa (Ctrl+clic hace lo mismo)" onClick={() => setOpts({ autoSelect: !opts.autoSelect })} />
          <AlignButtons />
          <span className="hint">Flechas: 1 px · Mayús+flechas: 10 px · Mayús al arrastrar: eje fijo</span>
        </>
      )}
      {(tool === 'marquee' || tool === 'marqueeEllipse') && (
        <>
          <Slider label="Calar" value={opts.feather} min={0} max={250} unit="px" width={80} onChange={(v) => setOpts({ feather: v })} />
          {SELECT_MODES}
        </>
      )}
      {(tool === 'lasso' || tool === 'polylasso') && (
        <>
          {SELECT_MODES}
          {tool === 'polylasso' && <span className="hint">Doble clic o Intro cierra · Retroceso quita el último punto</span>}
        </>
      )}
      {(tool === 'wand' || tool === 'bucket') && (
        <>
          <Slider label="Tolerancia" value={opts.wandTolerance} min={0} max={255} width={90} onChange={(v) => setOpts({ wandTolerance: v })} />
          <Toggle on={opts.contiguous} label="Contiguo" onClick={() => setOpts({ contiguous: !opts.contiguous })} />
          <Toggle on={opts.sampleAll} label="Muestrear todas las capas" onClick={() => setOpts({ sampleAll: !opts.sampleAll })} />
          {tool === 'wand' && SELECT_MODES}
        </>
      )}
      {tool === 'gradient' && (
        <>
          <select className="sel" value={opts.gradientType} onChange={(e) => setOpts({ gradientType: e.target.value as GradientType })}>
            <option value="linear">Lineal</option><option value="radial">Radial</option><option value="angle">Angular</option>
            <option value="reflected">Reflejado</option><option value="diamond">Diamante</option>
          </select>
          <Toggle on={opts.gradientTransparent} label="Frontal a transparente" onClick={() => setOpts({ gradientTransparent: !opts.gradientTransparent })} />
          <Toggle on={opts.gradientReverse} label="Invertir" onClick={() => setOpts({ gradientReverse: !opts.gradientReverse })} />
          <span className="hint">Mayús: ángulos de 45°</span>
        </>
      )}
      {tool === 'crop' && crop && (
        <>
          <span className="opt">{crop.w} × {crop.h} px</span>
          <span className="hint">Arrastra las asas · Intro aplica · Esc restablece (no destructivo: el contenido fuera se conserva)</span>
          <span className="grow" />
          <button className="chip on" onClick={() => { engine.call('crop', crop); useStore.setState({ crop: null }); }}><Check size={14} /> Recortar</button>
        </>
      )}
      {tool === 'text' && (
        <>
          <select className="sel" value={opts.font} onChange={(e) => { setOpts({ font: e.target.value }); applyText({ font: e.target.value }); }}>
            {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </select>
          <Slider label="" value={opts.fontSize} min={4} max={500} unit="pt" width={80} onChange={(v) => { setOpts({ fontSize: v }); applyText({ size: v }); }} />
          <Toggle on={opts.bold} label={<Bold size={13} />} title="Negrita" onClick={() => { setOpts({ bold: !opts.bold }); applyText({ bold: !opts.bold }); }} />
          <Toggle on={opts.italic} label={<Italic size={13} />} title="Cursiva" onClick={() => { setOpts({ italic: !opts.italic }); applyText({ italic: !opts.italic }); }} />
          {(['left', 'center', 'right'] as const).map((a) => (
            <Toggle key={a} on={opts.align === a} label={a === 'left' ? <AlignLeft size={13} /> : a === 'center' ? <AlignCenter size={13} /> : <AlignRight size={13} />}
              onClick={() => { setOpts({ align: a }); applyText({ align: a }); }} />
          ))}
          <span className="hint">Clic: texto nuevo · clic en un texto: editar · Esc o Ctrl+Intro: aplicar</span>
        </>
      )}
      {tool === 'shape' && (
        <>
          <select className="sel" value={opts.shapeKind} onChange={(e) => setOpts({ shapeKind: e.target.value as ShapeKind })}>
            <option value="rect">Rectángulo</option><option value="ellipse">Elipse</option><option value="polygon">Polígono</option><option value="line">Línea</option>
          </select>
          {opts.shapeKind !== 'line' && <Toggle on={opts.shapeFill} label="Relleno (frontal)" onClick={() => setOpts({ shapeFill: !opts.shapeFill })} />}
          {opts.shapeKind !== 'line' && <Toggle on={opts.shapeStroke} label="Trazo (fondo)" onClick={() => setOpts({ shapeStroke: !opts.shapeStroke })} />}
          <Slider label="Grosor" value={opts.strokeWidth} min={1} max={100} unit="px" width={70} onChange={(v) => setOpts({ strokeWidth: v })} />
          {opts.shapeKind === 'rect' && <Slider label="Radio" value={opts.cornerRadius} min={0} max={300} unit="px" width={70} onChange={(v) => setOpts({ cornerRadius: v })} />}
          {opts.shapeKind === 'polygon' && <Slider label="Lados" value={opts.sides} min={3} max={20} width={60} onChange={(v) => setOpts({ sides: v })} />}
          <span className="hint">Mayús: proporción · Mayús+U: siguiente forma</span>
        </>
      )}
      {tool === 'eyedropper' && <span className="hint">Clic: color frontal · Alt+clic: color de fondo</span>}
      {(tool === 'hand' || tool === 'zoom') && (
        <>
          <button className="chip" disabled={!doc.open} onClick={() => engine.call('actualPixels')}>100 %</button>
          <button className="chip" disabled={!doc.open} onClick={() => engine.call('fit', false)}>Encajar en pantalla</button>
          {tool === 'zoom' && <span className="hint">Clic acerca · Alt+clic aleja · Ctrl/Alt+rueda en cualquier herramienta</span>}
        </>
      )}
    </div>
  );
}

/** Cambia el texto que se está editando (o el de la capa de texto activa). */
function applyText(p: Record<string, unknown>) {
  const s = useStore.getState();
  const id = s.textEdit?.layerId ?? s.doc.layers.find((l) => l.id === s.doc.activeLayerId && l.kind === 'text')?.id;
  if (id) engine.call('updateText', id, p, true);
}

/** Pluma: "Hacer" selección, forma, rellenar o contornear, como la barra de Photoshop. */
function PathActions() {
  const path = useStore((s) => s.path);
  const fg = useStore((s) => s.fg);
  const empty = isEmptyPath(path);
  const run = (m: string, ...a: unknown[]) => { penFinish(); engine.call(m, useStore.getState().path, ...a); };
  return (
    <>
      <span className="hint">Hacer:</span>
      <button className="chip" disabled={empty} title="Ctrl+Intro" onClick={() => run('selectPath', 'replace', useStore.getState().opts.feather)}>Selección</button>
      <button className="chip" disabled={empty} onClick={() => run('shapeFromPath', toRgba(fg))}>Forma</button>
      <button className="chip" disabled={empty} onClick={() => run('fillPath')}>Rellenar trazado</button>
      <button className="chip" disabled={empty} title="Con el pincel y el color frontal" onClick={() => run('strokePath')}>Contornear</button>
      <button className="chip" disabled={!path.length} onClick={() => { const id = useStore.getState().doc.activePathId; useStore.setState({ penDrawing: null, pathSel: null }); if (id != null) engine.call('deletePath', id); }}>Eliminar trazado</button>
      <span className="hint">Clic: esquina · arrastrar: curva · Alt: romper manejador · clic en el primer punto: cerrar · Ctrl: mover puntos</span>
    </>
  );
}

/** Alinear y distribuir (herramienta Mover), como la barra de Photoshop. */
function AlignButtons() {
  const n = useStore((s) => s.doc.selectedLayerIds.length);
  const hasSel = useStore((s) => !!s.doc.selection);
  const ref = n > 1 ? 'las capas seleccionadas' : hasSel ? 'la selección' : 'el lienzo';
  const A = (mode: string, Icon: typeof AlignLeft, label: string) => (
    <button className="icon-btn" title={`${label} (respecto a ${ref})`} aria-label={label} onClick={() => engine.call('alignLayers', mode)}><Icon size={15} /></button>
  );
  return (
    <span className="align-btns">
      {A('left', AlignStartVertical, 'Alinear bordes izquierdos')}
      {A('hcenter', AlignCenterVertical, 'Alinear centros horizontales')}
      {A('right', AlignEndVertical, 'Alinear bordes derechos')}
      {A('top', AlignStartHorizontal, 'Alinear bordes superiores')}
      {A('vcenter', AlignCenterHorizontal, 'Alinear centros verticales')}
      {A('bottom', AlignEndHorizontal, 'Alinear bordes inferiores')}
      {n >= 3 && <>
        <button className="icon-btn" title="Distribuir centros horizontales" aria-label="Distribuir en horizontal" onClick={() => engine.call('distributeLayers', 'hcenter')}><AlignHorizontalDistributeCenter size={15} /></button>
        <button className="icon-btn" title="Distribuir centros verticales" aria-label="Distribuir en vertical" onClick={() => engine.call('distributeLayers', 'vcenter')}><AlignVerticalDistributeCenter size={15} /></button>
      </>}
    </span>
  );
}

function RotateOptions() {
  const rot = useStore((s) => s.view.rot ?? 0);
  const deg = Math.round((rot * 180) / Math.PI);
  return (
    <>
      <label className="opt">Ángulo de rotación:
        <input className="num" type="number" value={deg} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => engine.call('setRotation', ((Number(e.target.value) || 0) * Math.PI) / 180)} />°
      </label>
      <button className="chip" onClick={() => engine.call('setRotation', 0)}>Restablecer vista</button>
      <span className="hint">Arrastra para girar el lienzo · Mayús: pasos de 15° · Esc: restablecer</span>
    </>
  );
}
