import {
  Check, X, Bold, Italic, AlignLeft, AlignCenter, AlignRight, AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter,
} from 'lucide-react';
import { useStore, toRgba, type TMode } from './store';
import { pushSpec, pushPuppet, presetPatch } from './transformGeom';
import { identityPatch } from '../engine/meshwarp';
import { WARP_STYLES } from '../engine/text';
import { penFinish } from './Pen';
import { isEmpty as isEmptyPath } from '../engine/path';
import { engine } from '../engine/client';
import { TOOL_NAMES } from './commands';
import { FontPicker } from './TextPanels';
import { BrushPresetPicker, MixerOptions, SymmetryControl } from './BrushPanel';
import { GradientSwatch, GRADIENT_PRESETS } from './GradientEditor';
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
  const puppet = useStore((s) => s.puppet);
  const crop = useStore((s) => s.crop);
  const straighten = useStore((s) => s.straighten);
  const pcrop = useStore((s) => s.pcrop);

  if (puppet) {
    const set = (patch: Partial<typeof puppet>) => { const np = { ...puppet, ...patch }; useStore.setState({ puppet: np }); pushPuppet(np); };
    return (
      <div className="optionsbar" data-testid="puppet-options">
        <span className="opt-tool">Deformación de posición libre</span>
        <label className="opt">Modo
          <select value={puppet.mode} aria-label="Modo" onChange={(e) => set({ mode: e.target.value as typeof puppet.mode })}>
            <option value="rigid">Rígido</option><option value="normal">Normal</option><option value="distort">Distorsionar</option>
          </select>
        </label>
        <label className="opt">Densidad
          <select value={puppet.density} aria-label="Densidad" onChange={(e) => set({ density: Number(e.target.value) as 0 | 1 | 2 })}>
            <option value={0}>Menos puntos</option><option value={1}>Normal</option><option value={2}>Más puntos</option>
          </select>
        </label>
        <Toggle on={puppet.showMesh} label="Mostrar malla" onClick={() => set({ showMesh: !puppet.showMesh })} />
        <button className="chip" title="Quitar todas las chinchetas" onClick={() => set({ pins: [], sel: null })}>Quitar chinchetas</button>
        <span className="hint">Clic: chincheta · arrastrar: deformar · Alt+clic o Supr: quitar</span>
        <span className="grow" />
        <button className="chip" title="Cancelar (Esc)" onClick={() => { engine.call('cancelTransform'); useStore.setState({ puppet: null }); }}><X size={14} /></button>
        <button className="chip on" title="Aplicar (Intro)" onClick={() => { engine.call('commitTransform', 'Deformación de posición libre'); useStore.setState({ puppet: null }); }}><Check size={14} /></button>
      </div>
    );
  }

  if (transform) {
    const m = transform.matrix;
    const sx = Math.hypot(m[0], m[1]) * 100, sy = Math.hypot(m[2], m[3]) * 100, rot = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    const mode = transform.mode ?? 'free';
    const warp = mode === 'warp';
    const setMode = (md: TMode) => {
      const t = useStore.getState().transform!;
      const nt = { ...t, mode: md, warp: md === 'warp' ? (t.warp ?? { ctrl: identityPatch(t.bounds), style: 'none', bend: 50 }) : t.warp };
      useStore.setState({ transform: nt }); pushSpec(nt);
    };
    const setWarp = (style: string, bend: number) => {
      const t = useStore.getState().transform!;
      const nt = { ...t, warp: { ctrl: presetPatch(t.bounds, style, bend), style, bend } };
      useStore.setState({ transform: nt }); pushSpec(nt);
    };
    const MODE_LABEL: Record<TMode, string> = { free: 'Transformación libre', skew: 'Sesgar', distort: 'Distorsionar', perspective: 'Perspectiva', warp: 'Deformar' };
    return (
      <div className="optionsbar" data-testid="transform-options">
        <span className="opt-tool">{MODE_LABEL[mode]}</span>
        {warp ? (
          <>
            <label className="opt">Deformar
              <select value={transform.warp?.style ?? 'none'} aria-label="Estilo de deformación" onChange={(e) => setWarp(e.target.value, transform.warp?.bend ?? 50)}>
                <option value="custom">Personalizado</option>
                {WARP_STYLES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
            {transform.warp && transform.warp.style !== 'custom' && transform.warp.style !== 'none' && (
              <Slider label="Curvatura" value={transform.warp.bend} min={-100} max={100} unit="%" onChange={(v) => setWarp(transform.warp!.style, v)} />
            )}
            <span className="hint">Arrastra las esquinas, los tiradores o el interior de la malla</span>
          </>
        ) : (
          <>
            <span className="opt">An: {sx.toFixed(1)} %</span>
            <span className="opt">Al: {sy.toFixed(1)} %</span>
            <span className="opt">Ángulo: {rot.toFixed(1)}°</span>
            <span className="hint">{mode === 'free' ? 'Ctrl: distorsionar · Ctrl+Mayús (lado): sesgar · Ctrl+Alt+Mayús (esquina): perspectiva · fuera: rotar' : 'Arrastra las asas'}</span>
          </>
        )}
        <span className="grow" />
        <div className="seg" role="group" aria-label="Modo de transformación">
          {(['free', 'skew', 'distort', 'perspective'] as TMode[]).map((md) => (
            <Toggle key={md} on={mode === md} label={MODE_LABEL[md].replace('Transformación libre', 'Libre')} onClick={() => setMode(md)} />
          ))}
        </div>
        <Toggle on={warp} title="Cambiar entre transformación libre y deformar" label="Deformar" onClick={() => setMode(warp ? 'free' : 'warp')} />
        <button className="chip" title="Cancelar (Esc)" onClick={() => { engine.call('cancelTransform'); useStore.setState({ transform: null }); }}><X size={14} /></button>
        <button className="chip on" title="Aplicar (Intro)" onClick={() => { engine.call('commitTransform', MODE_LABEL[mode]); useStore.setState({ transform: null }); }}><Check size={14} /></button>
      </div>
    );
  }

  const painting = ['brush', 'pencil', 'eraser', 'clone', 'dodge', 'burn', 'blur', 'sharpen', 'smudge'].includes(tool);
  const strength = tool === 'blur' || tool === 'sharpen' || tool === 'smudge';
  return (
    <div className="optionsbar">
      <span className="opt-tool">{TOOL_NAMES[tool]}</span>
      {(painting || tool === 'mixer') && (
        <>
          {['brush', 'pencil', 'eraser', 'mixer', 'clone'].includes(tool) && <BrushPresetPicker />}
          <Slider label="Tamaño" value={brush.size} min={1} max={1000} unit="px" onChange={(v) => setBrush({ size: v })} />
          {tool !== 'pencil' && <Slider label="Dureza" value={brush.hardness * 100} min={0} max={100} unit="%" onChange={(v) => setBrush({ hardness: v / 100 })} />}
          <Slider label={tool === 'dodge' || tool === 'burn' ? 'Exposición' : strength ? 'Intensidad' : 'Opacidad'} value={brush.opacity * 100} min={1} max={100} unit="%" onChange={(v) => setBrush({ opacity: v / 100 })} />
          {!strength && <Slider label="Flujo" value={brush.flow * 100} min={1} max={100} unit="%" onChange={(v) => setBrush({ flow: v / 100 })} />}
          {tool === 'mixer' && <MixerOptions />}
          {['brush', 'pencil', 'eraser', 'mixer'].includes(tool) && <Slider label="Suavizado" value={Math.round((brush.smoothing ?? 0) * 100)} min={0} max={100} unit="%" onChange={(v) => setBrush({ smoothing: v / 100 })} />}
          {['brush', 'pencil', 'eraser', 'mixer'].includes(tool) && <SymmetryControl />}
          <Toggle on={brush.pressureSize} label="Presión → tamaño" onClick={() => setBrush({ pressureSize: !brush.pressureSize })} />
          <Toggle on={brush.pressureOpacity} label="Presión → opacidad" onClick={() => setBrush({ pressureOpacity: !brush.pressureOpacity })} />
          {tool === 'clone' && <span className="hint">Alt+clic define el origen</span>}
          {doc.editMask && <span className="hint mask-hint">Pintando en la máscara: negro oculta, blanco muestra</span>}
        </>
      )}
      {(tool === 'spotHeal' || tool === 'heal' || tool === 'remove') && (
        <>
          <Slider label="Tamaño" value={brush.size} min={1} max={1000} unit="px" onChange={(v) => setBrush({ size: v })} />
          <Slider label="Dureza" value={brush.hardness * 100} min={0} max={100} unit="%" onChange={(v) => setBrush({ hardness: v / 100 })} />
          <span className="hint">{tool === 'remove'
            ? 'Pinta sobre lo que quieras quitar (o rodéalo con un trazo) y suelta: se rellena según el contenido'
            : tool === 'spotHeal'
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
      {tool === 'quickSelect' && (
        <>
          <Slider label="Tamaño" value={brush.size} min={1} max={500} unit="px" onChange={(v) => setBrush({ size: v })} />
          <Toggle on={opts.sampleAll} label="Muestrear todas las capas" onClick={() => setOpts({ sampleAll: !opts.sampleAll })} />
          <Toggle on={opts.autoEnhance} label="Mejora automática" title="Ajusta el borde de la selección a la imagen" onClick={() => setOpts({ autoEnhance: !opts.autoEnhance })} />
          <button className="chip" disabled={!doc.open} onClick={() => engine.call('selectSubject')}>Seleccionar sujeto</button>
          <button className="chip" disabled={!doc.selection} onClick={() => useStore.getState().setDialog({ kind: 'refine' })}>Seleccionar y aplicar máscara…</button>
          <span className="hint">Pinta sobre lo que quieres: la selección crece hasta los bordes · Alt: restar</span>
        </>
      )}
      {tool === 'objectSelect' && (
        <>
          <Toggle on={opts.sampleAll} label="Muestrear todas las capas" onClick={() => setOpts({ sampleAll: !opts.sampleAll })} />
          <button className="chip" disabled={!doc.open} onClick={() => engine.call('selectSubject')}>Seleccionar sujeto</button>
          <button className="chip" disabled={!doc.selection} onClick={() => useStore.getState().setDialog({ kind: 'refine' })}>Seleccionar y aplicar máscara…</button>
          <span className="hint">Dibuja un rectángulo alrededor del objeto (IA local) · Mayús: añadir · Alt: restar</span>
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
          <GradientSwatch value={opts.gradient ?? GRADIENT_PRESETS[opts.gradientTransparent ? 1 : 0]} onChange={(g) => setOpts({ gradient: g, gradientTransparent: false })} />
          <Toggle on={opts.gradientTransparency ?? true} label="Transparencia" title="Usar las paradas de opacidad del degradado" onClick={() => setOpts({ gradientTransparency: !(opts.gradientTransparency ?? true) })} />
          <Toggle on={opts.gradientReverse} label="Invertir" onClick={() => setOpts({ gradientReverse: !opts.gradientReverse })} />
          <span className="hint">Mayús: ángulos de 45°</span>
        </>
      )}
      {tool === 'crop' && crop && (
        <>
          <span className="opt">{crop.w} × {crop.h} px</span>
          {!!crop.angle && <span className="opt">Ángulo: {((crop.angle * 180) / Math.PI).toFixed(1)}°</span>}
          <Toggle on={straighten} title="Traza una línea sobre el horizonte o un borde (también Ctrl+arrastrar)" label="Enderezar" onClick={() => useStore.setState({ straighten: !straighten })} />
          <span className="hint">{straighten ? 'Traza una línea que deba quedar recta' : 'Asas: tamaño · fuera del cuadro: girar · Intro aplica · Esc restablece'}</span>
          <span className="grow" />
          <button className="chip" title="Restablecer (Esc)" onClick={() => useStore.setState({ crop: { x: 0, y: 0, w: doc.width, h: doc.height } })}><X size={14} /></button>
          <button className="chip on" onClick={() => { const c = crop; useStore.setState({ crop: null }); void engine.call('crop', c).then(() => { const d = useStore.getState().doc; if (useStore.getState().tool === 'crop') useStore.setState({ crop: { x: 0, y: 0, w: d.width, h: d.height } }); }); }}><Check size={14} /> Recortar</button>
        </>
      )}
      {tool === 'perspectiveCrop' && (
        <>
          <span className="hint">{pcrop ? 'Ajusta las esquinas al plano de la foto · Intro aplica · Esc cancela' : 'Dibuja un cuadro y lleva sus esquinas a las del plano (un cartel, una fachada…)'}</span>
          <span className="grow" />
          {pcrop && <button className="chip" title="Cancelar (Esc)" onClick={() => useStore.setState({ pcrop: null })}><X size={14} /></button>}
          {pcrop && <button className="chip on" onClick={() => { const q = pcrop; useStore.setState({ pcrop: null }); void engine.call('perspectiveCrop', q.flat()); }}><Check size={14} /> Recortar</button>}
        </>
      )}
      {tool === 'text' && (
        <>
          <FontPicker compact value={opts.font} onChange={(f) => { setOpts({ font: f }); applyText({ font: f }); }} />
          <Slider label="" value={opts.fontSize} min={4} max={500} unit="pt" width={80} onChange={(v) => { setOpts({ fontSize: v }); applyText({ size: v }); }} />
          <Toggle on={opts.bold} label={<Bold size={13} />} title="Negrita" onClick={() => { setOpts({ bold: !opts.bold }); applyText({ bold: !opts.bold }); }} />
          <Toggle on={opts.italic} label={<Italic size={13} />} title="Cursiva" onClick={() => { setOpts({ italic: !opts.italic }); applyText({ italic: !opts.italic }); }} />
          {(['left', 'center', 'right'] as const).map((a) => (
            <Toggle key={a} on={opts.align === a} label={a === 'left' ? <AlignLeft size={13} /> : a === 'center' ? <AlignCenter size={13} /> : <AlignRight size={13} />}
              onClick={() => { setOpts({ align: a }); applyText({ align: a }); }} />
          ))}
          <button className="chip" title="Texto > Deformar texto" onClick={() => useStore.getState().setDialog({ kind: 'warpText' })}>Deformar</button>
          <span className="hint">Clic: texto de punto · arrastrar: texto de párrafo · Esc o Ctrl+Intro: aplicar · Carácter y Párrafo en Propiedades</span>
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
