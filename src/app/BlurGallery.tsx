// Filtro > Galería de desenfoques: Campo, Iris y Cambio de inclinación con controles sobre la vista previa.
import { useEffect, useRef, useState } from 'react';
import { engine } from '../engine/client';
import { useStore } from './store';
import { Modal } from './Dialogs';
import type { BlurGallery } from '../engine/blurgal';

type Preview = { w: number; h: number; k: number; before: Uint8ClampedArray; after: Uint8ClampedArray; frame: { x: number; y: number; w: number; h: number } };
type Drag = { what: 'pin'; i: number } | { what: 'irisC' } | { what: 'irisX' } | { what: 'irisY' } | { what: 'tiltC' } | { what: 'tiltA' } | null;

export const BLUR_KIND_LABELS: Record<BlurGallery['kind'], string> = { field: 'Desenfoque de campo', iris: 'Desenfoque de iris', tilt: 'Cambio de inclinación' };

function defaults(kind: BlurGallery['kind']): BlurGallery {
  const d = useStore.getState().doc, W = d.width, H = d.height, m = Math.min(W, H);
  return {
    kind, blur: Math.round(m * 0.03) + 4,
    pins: [{ x: W / 2, y: H / 2, blur: Math.round(m * 0.03) + 4 }],
    iris: { cx: W / 2, cy: H / 2, rx: W * 0.28, ry: H * 0.28, angle: 0, focus: 0.35 },
    tilt: { cx: W / 2, cy: H / 2, angle: 0, focus: H * 0.08, transition: H * 0.18 },
    bokeh: 0, bokehThreshold: 190,
  };
}

function Row({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="dv-slider">
      <span className="dv-label">{label}</span>
      <input type="number" className="dv-num" aria-label={`${label} (valor)`} value={Math.round(value * 10) / 10} min={min} max={max} step={step}
        onKeyDown={(e) => e.stopPropagation()} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function BlurGalleryDialog({ close, kind }: { close: () => void; kind: BlurGallery['kind'] }) {
  const [g, setG] = useState<BlurGallery>(() => defaults(kind));
  const [pv, setPv] = useState<Preview | null>(null);
  const [sel, setSel] = useState(0);
  const [showFx, setShowFx] = useState(true);
  const cv = useRef<HTMLCanvasElement>(null), svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag>(null);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    const t = setTimeout(() => { void engine.call<Preview | null>('blurGalleryPreview', g, 820).then((r) => { if (id === seq.current && r) setPv(r); }); }, 40);
    return () => clearTimeout(t);
  }, [g]);

  useEffect(() => {
    const c = cv.current;
    if (!c || !pv) return;
    c.width = pv.w; c.height = pv.h;
    const img = new ImageData(pv.w, pv.h);
    img.data.set(showFx ? pv.after : pv.before);
    c.getContext('2d')!.putImageData(img, 0, 0);
  }, [pv, showFx]);

  // Coordenadas: documento ↔ vista previa.
  const k = pv?.k ?? 1, fx = pv?.frame.x ?? 0, fy = pv?.frame.y ?? 0;
  const P = (x: number, y: number): [number, number] => [(x - fx) * k, (y - fy) * k];
  const toDoc = (e: React.PointerEvent): [number, number] => {
    // La vista previa se encaja (contain): se usa la matriz del SVG para pasar a sus coordenadas.
    const el = svg.current!, m = el.getScreenCTM();
    const pt = el.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const q = m ? pt.matrixTransform(m.inverse()) : pt;
    return [fx + q.x / k, fy + q.y / k];
  };

  const onDown = (e: React.PointerEvent) => {
    const t = (e.target as Element).getAttribute('data-h');
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (t?.startsWith('pin')) {
      const i = Number(t.slice(3));
      if (e.altKey && g.pins.length > 1) { setG((o) => ({ ...o, pins: o.pins.filter((_, j) => j !== i) })); setSel(0); return; }
      setSel(i); drag.current = { what: 'pin', i }; return;
    }
    if (t) { drag.current = { what: t } as Drag; return; }
    if (g.kind === 'field') {
      // Clic en la imagen: chincheta nueva con el desenfoque actual.
      const [x, y] = toDoc(e);
      setG((o) => ({ ...o, pins: [...o.pins, { x, y, blur: o.pins[sel]?.blur ?? o.blur }] }));
      setSel(g.pins.length); drag.current = { what: 'pin', i: g.pins.length };
    } else if (g.kind === 'iris') { drag.current = { what: 'irisC' }; } else { drag.current = { what: 'tiltC' }; }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [x, y] = toDoc(e);
    setG((o) => {
      switch (d.what) {
        case 'pin': return { ...o, pins: o.pins.map((p, i) => (i === d.i ? { ...p, x, y } : p)) };
        case 'irisC': return { ...o, iris: { ...o.iris, cx: x, cy: y } };
        case 'irisX': { const a = o.iris.angle, dx = x - o.iris.cx, dy = y - o.iris.cy; return { ...o, iris: { ...o.iris, rx: Math.max(4, Math.abs(dx * Math.cos(a) + dy * Math.sin(a))) } }; }
        case 'irisY': { const a = o.iris.angle, dx = x - o.iris.cx, dy = y - o.iris.cy; return { ...o, iris: { ...o.iris, ry: Math.max(4, Math.abs(-dx * Math.sin(a) + dy * Math.cos(a))) } }; }
        case 'tiltC': return { ...o, tilt: { ...o.tilt, cx: x, cy: y } };
        case 'tiltA': return { ...o, tilt: { ...o.tilt, angle: Math.atan2(y - o.tilt.cy, x - o.tilt.cx) } };
      }
      return o;
    });
  };
  const onUp = () => { drag.current = null; };

  const ok = () => { engine.call('applyFilter', 'blurGallery', { gal: { ...g, scale: 1 } }); close(); };
  const setKind = (kd: BlurGallery['kind']) => setG((o) => ({ ...o, kind: kd }));

  // Controles sobre la vista previa.
  let overlay: React.ReactNode = null;
  if (pv) {
    if (g.kind === 'field') {
      overlay = g.pins.map((p, i) => { const [x, y] = P(p.x, p.y); return <g key={i}><circle data-h={`pin${i}`} className={`bg-pin ${i === sel ? 'on' : ''}`} cx={x} cy={y} r={9} /><circle cx={x} cy={y} r={3} className="bg-dot" /></g>; });
    } else if (g.kind === 'iris') {
      const { cx, cy, rx, ry, angle, focus } = g.iris, [x, y] = P(cx, cy), deg = (angle * 180) / Math.PI;
      const ex = P(cx + rx * Math.cos(angle), cy + rx * Math.sin(angle)), ey = P(cx - ry * Math.sin(angle), cy + ry * Math.cos(angle));
      overlay = (
        <g>
          <ellipse className="bg-line" cx={x} cy={y} rx={rx * k} ry={ry * k} transform={`rotate(${deg} ${x} ${y})`} />
          <ellipse className="bg-line dashed" cx={x} cy={y} rx={rx * k * focus} ry={ry * k * focus} transform={`rotate(${deg} ${x} ${y})`} />
          <circle data-h="irisC" className="bg-pin on" cx={x} cy={y} r={9} />
          <rect data-h="irisX" className="bg-handle" x={ex[0] - 5} y={ex[1] - 5} width={10} height={10} />
          <rect data-h="irisY" className="bg-handle" x={ey[0] - 5} y={ey[1] - 5} width={10} height={10} />
        </g>
      );
    } else {
      const { cx, cy, angle, focus, transition } = g.tilt, [x, y] = P(cx, cy), L = Math.hypot(pv.w, pv.h);
      const ux = Math.cos(angle), uy = Math.sin(angle), nx = -uy, ny = ux;
      const line = (off: number, cls: string) => <line className={cls} x1={x - ux * L + nx * off * k} y1={y - uy * L + ny * off * k} x2={x + ux * L + nx * off * k} y2={y + uy * L + ny * off * k} />;
      const a = P(cx + ux * 60 / k, cy + uy * 60 / k);
      overlay = (
        <g>
          {line(focus, 'bg-line')}{line(-focus, 'bg-line')}
          {line(focus + transition, 'bg-line dashed')}{line(-focus - transition, 'bg-line dashed')}
          <circle data-h="tiltC" className="bg-pin on" cx={x} cy={y} r={9} />
          <circle data-h="tiltA" className="bg-handle" cx={a[0]} cy={a[1]} r={6} />
        </g>
      );
    }
  }

  return (
    <Modal title="Galería de desenfoques" wide onClose={close} onOk={ok}>
      <div className="develop bgal" data-testid="blur-gallery">
        <div className="dv-view">
          <div className="bg-stage">
            <canvas ref={cv} data-testid="blur-preview" />
            {pv && (
              <svg ref={svg} className="bg-overlay" viewBox={`0 0 ${pv.w} ${pv.h}`} preserveAspectRatio="xMidYMid meet"
                onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
                {overlay}
              </svg>
            )}
          </div>
          <div className="dv-viewbar">
            <label className="check-row"><input type="checkbox" checked={showFx} onChange={(e) => setShowFx(e.target.checked)} /> Previsualizar</label>
            <span className="hint">{g.kind === 'field' ? 'Clic: chincheta · arrastrar: mover · Alt+clic: quitar' : g.kind === 'iris' ? 'Arrastra el centro y las asas de la elipse' : 'Arrastra el centro; el punto gira la banda'}</span>
          </div>
        </div>
        <div className="dv-panel">
          <div className="seg dv-tabs">
            {(['field', 'iris', 'tilt'] as const).map((kd) => <button type="button" key={kd} className={`chip ${g.kind === kd ? 'on' : ''}`} onClick={() => setKind(kd)}>{BLUR_KIND_LABELS[kd].replace('Desenfoque de ', '').replace(/^./, (c) => c.toUpperCase())}</button>)}
          </div>
          <div className="dv-scroll">
            {g.kind === 'field'
              ? <Row label="Desenfoque" value={g.pins[sel]?.blur ?? g.blur} min={0} max={500} onChange={(v) => setG((o) => ({ ...o, blur: Math.max(o.blur, v), pins: o.pins.map((p, i) => (i === sel ? { ...p, blur: v } : p)) }))} />
              : <Row label="Desenfoque" value={g.blur} min={0} max={500} onChange={(v) => setG((o) => ({ ...o, blur: v }))} />}
            {g.kind === 'iris' && <>
              <Row label="Zona enfocada (%)" value={Math.round(g.iris.focus * 100)} min={0} max={95} onChange={(v) => setG((o) => ({ ...o, iris: { ...o.iris, focus: v / 100 } }))} />
              <Row label="Ángulo (°)" value={Math.round((g.iris.angle * 180) / Math.PI)} min={-90} max={90} onChange={(v) => setG((o) => ({ ...o, iris: { ...o.iris, angle: (v * Math.PI) / 180 } }))} />
            </>}
            {g.kind === 'tilt' && <>
              <Row label="Zona enfocada (px)" value={g.tilt.focus} min={0} max={4000} onChange={(v) => setG((o) => ({ ...o, tilt: { ...o.tilt, focus: v } }))} />
              <Row label="Transición (px)" value={g.tilt.transition} min={1} max={4000} onChange={(v) => setG((o) => ({ ...o, tilt: { ...o.tilt, transition: v } }))} />
              <Row label="Ángulo (°)" value={Math.round((g.tilt.angle * 180) / Math.PI)} min={-180} max={180} onChange={(v) => setG((o) => ({ ...o, tilt: { ...o.tilt, angle: (v * Math.PI) / 180 } }))} />
            </>}
            <div className="dv-sub">Efectos</div>
            <Row label="Bokeh de luz" value={g.bokeh} min={0} max={100} onChange={(v) => setG((o) => ({ ...o, bokeh: v }))} />
            <Row label="Rango de luces" value={g.bokehThreshold} min={0} max={255} onChange={(v) => setG((o) => ({ ...o, bokehThreshold: v }))} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
