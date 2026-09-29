// Reglas (Ctrl+R) y guías, como Photoshop: se arrastra desde una regla para crear una guía,
// con Mover se recoloca y soltándola fuera del documento se elimina.
import { useState, type ReactNode } from 'react';
import { engine } from '../engine/client';
import { useStore } from './store';

export const RULER = 20;
/** Altura de la barra de pestañas (la regla horizontal va justo debajo). */
export const TABS_H = 26;

/** Paso de las marcas según el zoom: la marca principal ocupa al menos ~60 px en pantalla. */
function steps(zoom: number) {
  const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  const major = nice.find((n) => n * zoom >= 60) ?? 20000;
  const minor = major % 5 === 0 ? major / 5 : major / 2;
  return { major, minor };
}

/** Ajusta un punto (coordenadas de documento) a guías y bordes/centro del documento. */
export function snapPoint(p: [number, number]): [number, number] {
  const { opts, doc, view } = useStore.getState();
  if (!opts.snap || !doc.open) return p;
  const tol = 8 / view.zoom;
  const xs = [0, doc.width / 2, doc.width], ys = [0, doc.height / 2, doc.height];
  if (opts.guides) for (const g of doc.guides) (g.dir === 'v' ? xs : ys).push(g.pos);
  const near = (v: number, list: number[]) => { let best = v, bd = tol; for (const t of list) { const d = Math.abs(t - v); if (d <= bd) { bd = d; best = t; } } return best; };
  return [near(p[0], xs), near(p[1], ys)];
}

export function Rulers({ width, height }: { width: number; height: number }) {
  const view = useStore((s) => s.view);
  const cursor = useStore((s) => s.cursor);
  const [drag, setDrag] = useState<{ dir: 'h' | 'v'; pos: number } | null>(null);
  const { major, minor } = steps(view.zoom);
  const Z = view.zoom;
  const toDoc = (sx: number, sy: number) => [(sx - view.panX) / Z, (sy - view.panY) / Z];

  const ticks = (len: number, pan: number, horizontal: boolean) => {
    const out: ReactNode[] = [];
    const start = Math.floor(-pan / Z / minor) * minor, end = (len - pan) / Z;
    for (let v = start; v <= end; v += minor) {
      const s = pan + v * Z;
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      const L = isMajor ? RULER : RULER * 0.35;
      out.push(horizontal
        ? <line key={v} x1={s} x2={s} y1={RULER} y2={RULER - L} />
        : <line key={v} y1={s} y2={s} x1={RULER} x2={RULER - L} />);
      if (isMajor) {
        out.push(horizontal
          ? <text key={`t${v}`} x={s + 2} y={9}>{Math.round(v)}</text>
          : <text key={`t${v}`} x={9} y={s + 2} transform={`rotate(-90 9 ${s + 2})`}>{Math.round(v)}</text>);
      }
    }
    return out;
  };

  const start = (dir: 'h' | 'v') => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const [x, y] = toDoc(e.clientX - r.left, e.clientY - r.top);
    setDrag({ dir, pos: dir === 'h' ? y : x });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const [x, y] = toDoc(e.clientX - r.left, e.clientY - r.top);
    setDrag({ ...drag, pos: Math.round(drag.dir === 'h' ? y : x) });
  };
  const up = (e: React.PointerEvent) => {
    if (!drag) return;
    const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const inside = e.clientX - r.left > RULER && e.clientY - r.top > TABS_H + RULER && e.clientX < r.right && e.clientY < r.bottom;
    if (inside) engine.call('addGuide', drag.dir, drag.pos);
    setDrag(null);
  };

  return (
    <>
      <svg className="ruler ruler-h" width={width} height={RULER} data-testid="ruler-h"
        onPointerDown={start('h')} onPointerMove={move} onPointerUp={up}>
        <rect width={width} height={RULER} className="ruler-bg" />
        <g className="ruler-ticks">{ticks(width, view.panX, true)}</g>
        {cursor && <line className="ruler-cursor" x1={view.panX + (cursor.x + 0.5) * Z} x2={view.panX + (cursor.x + 0.5) * Z} y1={0} y2={RULER} />}
      </svg>
      <svg className="ruler ruler-v" width={RULER} height={height} data-testid="ruler-v"
        onPointerDown={start('v')} onPointerMove={move} onPointerUp={up}>
        <rect width={RULER} height={height} className="ruler-bg" />
        <g className="ruler-ticks">{ticks(height, view.panY, false)}</g>
        {cursor && <line className="ruler-cursor" y1={view.panY + (cursor.y + 0.5) * Z} y2={view.panY + (cursor.y + 0.5) * Z} x1={0} x2={RULER} />}
      </svg>
      <div className="ruler-corner" />
      {drag && (
        <svg className="guide-preview" width={width} height={height}>
          {drag.dir === 'h'
            ? <line className="guide" x1={0} x2={width} y1={view.panY + drag.pos * Z} y2={view.panY + drag.pos * Z} />
            : <line className="guide" y1={0} y2={height} x1={view.panX + drag.pos * Z} x2={view.panX + drag.pos * Z} />}
        </svg>
      )}
    </>
  );
}

/** Líneas de guía sobre el lienzo (dentro del SVG de superposiciones). */
export function GuideLines({ width, height, moving }: { width: number; height: number; moving?: { id: number; pos: number } | null }) {
  const guides = useStore((s) => s.doc.guides);
  const show = useStore((s) => s.opts.guides);
  const view = useStore((s) => s.view);
  if (!show || !guides.length) return null;
  return (
    <g className="guides">
      {guides.map((g) => {
        const pos = moving?.id === g.id ? moving.pos : g.pos;
        return g.dir === 'h'
          ? <line key={g.id} className="guide" x1={0} x2={width} y1={view.panY + pos * view.zoom} y2={view.panY + pos * view.zoom} />
          : <line key={g.id} className="guide" y1={0} y2={height} x1={view.panX + pos * view.zoom} x2={view.panX + pos * view.zoom} />;
      })}
    </g>
  );
}

/** Guía bajo el puntero (para moverla con la herramienta Mover). */
export function hitGuide(sx: number, sy: number): { id: number; dir: 'h' | 'v' } | null {
  const { doc, opts, view } = useStore.getState();
  if (!opts.guides || opts.lockGuides) return null;
  for (const g of doc.guides) {
    const s = g.dir === 'h' ? view.panY + g.pos * view.zoom : view.panX + g.pos * view.zoom;
    if (Math.abs((g.dir === 'h' ? sy : sx) - s) <= 4) return { id: g.id, dir: g.dir };
  }
  return null;
}
