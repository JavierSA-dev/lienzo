import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { engine } from '../engine/client';
import type { PointerSample } from '../engine/types';
import { useStore } from './store';
import { openFile } from './commands';
import { Home } from './Home';

const CURSORS: Record<string, string> = {
  move: 'move', marquee: 'crosshair', eyedropper: 'crosshair', hand: 'grab', zoom: 'zoom-in',
  brush: 'none', eraser: 'none',
};

export function CanvasArea() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const brushSize = useStore((s) => s.brush.size);

  // Transfiere el canvas al worker una sola vez y le avisa de cada cambio de tamaño.
  useEffect(() => {
    const el = wrap.current!, cv = canvasRef.current!;
    const r = el.getBoundingClientRect();
    rectRef.current = r;
    if (!cv.dataset.attached) {
      cv.dataset.attached = '1';
      engine.attach(cv, r.width, r.height, window.devicePixelRatio || 1);
    }
    const ro = new ResizeObserver(() => {
      const rr = el.getBoundingClientRect();
      rectRef.current = rr;
      engine.send({ type: 'resize', width: rr.width, height: rr.height, dpr: window.devicePixelRatio || 1 });
    });
    ro.observe(el);
    // Rueda: Ctrl/Alt (o pellizco en trackpad) = zoom; sin modificador = desplazar.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rr = rectRef.current ?? el.getBoundingClientRect();
      const scale = e.deltaMode === 1 ? 16 : 1;
      engine.send({
        type: 'wheel', x: e.clientX - rr.left, y: e.clientY - rr.top,
        dx: (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * scale,
        dy: (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * scale,
        zoom: e.ctrlKey || e.metaKey || e.altKey,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener('wheel', onWheel); };
  }, []);

  const sample = (e: PointerEvent | React.PointerEvent): PointerSample => {
    const r = rectRef.current!;
    const pressure = e.pointerType === 'mouse' ? 1 : e.pressure || 0.5;
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: pressure, t: e.timeStamp };
  };

  const mods = (e: React.PointerEvent) => ({ alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });

  const onDown = (e: React.PointerEvent) => {
    if (!doc.open || (e.button !== 0 && e.button !== 1)) return;
    e.preventDefault();
    rectRef.current = wrap.current!.getBoundingClientRect();
    (e.target as Element).setPointerCapture(e.pointerId);
    if (tool === 'hand' || e.button === 1) setGrabbing(true);
    engine.pointer({ phase: 'down', points: [sample(e)], button: e.button, ...mods(e) });
  };

  const onMove = (e: React.PointerEvent) => {
    const s = sample(e);
    setHover({ x: s.x, y: s.y });
    const v = useStore.getState().view;
    useStore.setState({ cursor: { x: Math.floor((s.x - v.panX) / v.zoom), y: Math.floor((s.y - v.panY) / v.zoom) } });
    if (!(e.target as Element).hasPointerCapture?.(e.pointerId)) return;
    // Eventos agrupados por el navegador: todos los puntos reales del lápiz, no sólo 1 por frame.
    const native = e.nativeEvent;
    const list = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const points = list.length ? list.map(sample) : [s];
    engine.pointer({ phase: 'move', points, button: e.button === -1 ? 0 : e.button, ...mods(e) });
  };

  const onUp = (e: React.PointerEvent) => {
    if (!(e.target as Element).hasPointerCapture?.(e.pointerId)) return;
    (e.target as Element).releasePointerCapture(e.pointerId);
    setGrabbing(false);
    engine.pointer({ phase: 'up', points: [sample(e)], button: e.button, ...mods(e) });
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  };

  const sel = doc.selection;
  const painting = tool === 'brush' || tool === 'eraser';
  const r = Math.max(1, (brushSize / 2) * view.zoom);
  const cursor = grabbing ? 'grabbing' : CURSORS[tool];

  return (
    <main
      className="canvas-area"
      ref={wrap}
      style={{ cursor: doc.open ? cursor : 'default' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => { setHover(null); useStore.setState({ cursor: null }); }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="canvas-area"
    >
      <canvas ref={canvasRef} />
      <svg className="overlay" width="100%" height="100%">
        {sel && (
          <g transform={`translate(${view.panX} ${view.panY})`}>
            <rect className="ants-under" x={sel.x * view.zoom + 0.5} y={sel.y * view.zoom + 0.5} width={sel.w * view.zoom} height={sel.h * view.zoom} />
            <rect className="ants" x={sel.x * view.zoom + 0.5} y={sel.y * view.zoom + 0.5} width={sel.w * view.zoom} height={sel.h * view.zoom} />
          </g>
        )}
        {painting && hover && doc.open && (
          <g>
            <circle className="brush-cursor" cx={hover.x} cy={hover.y} r={r} />
            {r < 4 && <path className="brush-cursor" d={`M${hover.x - 6} ${hover.y}h12M${hover.x} ${hover.y - 6}v12`} />}
          </g>
        )}
      </svg>
      {doc.open && (
        <div className="doc-tabs" onPointerDown={(e) => e.stopPropagation()}>
          <div className="doc-tab">
            <span>{doc.name} @ {Math.round(view.zoom * 1000) / 10}%</span>
            <button title="Cerrar" onClick={() => engine.call('closeDoc')}><X size={13} /></button>
          </div>
        </div>
      )}
      {!doc.open && <Home dragOver={dragOver} />}
      {doc.open && dragOver && <div className="drop-veil">Suelta para abrir</div>}
    </main>
  );
}
