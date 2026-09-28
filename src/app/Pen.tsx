// Pluma (P) y Selección directa de trazado (A), como en Photoshop.
//
// Pluma: clic = punto de esquina · arrastrar = punto suave (manejadores simétricos) ·
// Alt al arrastrar = rompe la simetría · clic en el primer punto = cerrar ·
// Mayús = ángulos de 45° · Intro/Esc = terminar · Retroceso = quitar el último punto ·
// Ctrl (temporal) = mover anclas y manejadores · Alt+clic en un ancla = convertir punto.
// Ctrl+Intro convierte el trazado en selección.
import { useStore, commitPath } from './store';
import { corner, toSvg, type PathPoint, type VectorPath } from '../engine/path';

type Pt = [number, number];

export type PenDrag = { label: string; moved?: boolean } & (
  | { kind: 'penPoint'; sub: number; idx: number; alt: boolean }
  | { kind: 'anchor'; sub: number; idx: number; start: Pt; orig: PathPoint }
  | { kind: 'handle'; sub: number; idx: number; which: 'in' | 'out'; alt: boolean });

const S = () => useStore.getState();
const clone = (p: VectorPath): VectorPath => p.map((sp) => ({ closed: sp.closed, points: sp.points.map((q) => ({ ...q })) }));
const setPath = (path: VectorPath, extra: Partial<ReturnType<typeof S>> = {}) => useStore.setState({ path, penLocal: true, ...extra });

function hit(p: Pt, tol: number): { sub: number; idx: number; part: 'anchor' | 'in' | 'out' } | null {
  const { path, pathSel } = S();
  // Primero los manejadores visibles (del ancla seleccionada), luego las anclas.
  if (pathSel) {
    const q = path[pathSel.sub]?.points[pathSel.idx];
    if (q) {
      if ((q.ox !== q.x || q.oy !== q.y) && Math.hypot(p[0] - q.ox, p[1] - q.oy) <= tol) return { ...pathSel, part: 'out' };
      if ((q.ix !== q.x || q.iy !== q.y) && Math.hypot(p[0] - q.ix, p[1] - q.iy) <= tol) return { ...pathSel, part: 'in' };
    }
  }
  for (let s = path.length - 1; s >= 0; s--) {
    const pts = path[s].points;
    for (let i = pts.length - 1; i >= 0; i--) if (Math.hypot(p[0] - pts[i].x, p[1] - pts[i].y) <= tol) return { sub: s, idx: i, part: 'anchor' };
  }
  return null;
}

function snap45(from: Pt, p: Pt): Pt {
  const dx = p[0] - from[0], dy = p[1] - from[1];
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
  return [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
}

/** Clic con la pluma. Devuelve el arrastre que empieza (o null). */
export function penDown(p: Pt, e: { altKey: boolean; shiftKey: boolean }, zoom: number): PenDrag | null {
  const tol = 7 / zoom;
  const s = S();
  const path = clone(s.path);
  const d = s.penDrawing;
  const h = hit(p, tol);

  // Alt+clic en un ancla: convertir punto (suave -> esquina; esquina -> arrastrar manejadores nuevos).
  if (e.altKey && h?.part === 'anchor' && !(d === h.sub && h.idx === 0 && path[d].points.length > 1)) {
    const q = path[h.sub].points[h.idx];
    const smooth = q.ix !== q.x || q.iy !== q.y || q.ox !== q.x || q.oy !== q.y;
    if (smooth) { Object.assign(q, corner(q.x, q.y)); setPath(path, { pathSel: { sub: h.sub, idx: h.idx } }); commitPath('Convertir punto'); return null; }
    setPath(path, { pathSel: { sub: h.sub, idx: h.idx } });
    return { kind: 'penPoint', sub: h.sub, idx: h.idx, alt: false, label: 'Convertir punto' };
  }

  if (d != null && path[d] && !path[d].closed) {
    const sp = path[d];
    // Clic en el primer punto: cerrar.
    if (sp.points.length >= 2 && h?.sub === d && h.idx === 0 && h.part === 'anchor') {
      sp.closed = true;
      setPath(path, { penDrawing: null, pathSel: { sub: d, idx: 0 } });
      return { kind: 'penPoint', sub: d, idx: 0, alt: e.altKey, label: 'Cerrar trazado' };
    }
    const last = sp.points[sp.points.length - 1];
    const q = e.shiftKey ? snap45([last.x, last.y], p) : p;
    sp.points.push(corner(q[0], q[1]));
    setPath(path, { pathSel: { sub: d, idx: sp.points.length - 1 } });
    return { kind: 'penPoint', sub: d, idx: sp.points.length - 1, alt: false, label: 'Nuevo punto de ancla' };
  }
  // Clic en un punto existente sin estar dibujando: seleccionarlo (y poder moverlo).
  if (h) {
    useStore.setState({ pathSel: { sub: h.sub, idx: h.idx } });
    return pathEditDown(p, e, zoom);
  }
  path.push({ points: [corner(p[0], p[1])], closed: false });
  setPath(path, { penDrawing: path.length - 1, pathSel: { sub: path.length - 1, idx: 0 } });
  return { kind: 'penPoint', sub: path.length - 1, idx: 0, alt: false, label: 'Nuevo punto de ancla' };
}

/** Selección directa: arrastrar anclas o manejadores. */
export function pathEditDown(p: Pt, e: { altKey: boolean }, zoom: number): PenDrag | null {
  const h = hit(p, 7 / zoom);
  if (!h) { useStore.setState({ pathSel: null }); return null; }
  useStore.setState({ pathSel: { sub: h.sub, idx: h.idx } });
  const q = S().path[h.sub].points[h.idx];
  useStore.setState({ penLocal: true });
  if (h.part === 'anchor') return { kind: 'anchor', sub: h.sub, idx: h.idx, start: p, orig: { ...q }, label: 'Arrastrar punto de ancla' };
  return { kind: 'handle', sub: h.sub, idx: h.idx, which: h.part, alt: e.altKey, label: 'Arrastrar manejador' };
}

export function penMove(g: PenDrag, p: Pt, e: { altKey: boolean; shiftKey: boolean }, zoom: number) {
  g.moved = true;
  const path = clone(S().path);
  const q = path[g.sub]?.points[g.idx];
  if (!q) return;
  if (g.kind === 'penPoint') {
    // Arrastrar tras el clic: manejador de salida bajo el cursor, el de entrada simétrico.
    if (Math.hypot(p[0] - q.x, p[1] - q.y) * zoom < 2) { q.ox = q.x; q.oy = q.y; q.ix = q.x; q.iy = q.y; }
    else {
      const t = e.shiftKey ? snap45([q.x, q.y], p) : p;
      q.ox = t[0]; q.oy = t[1];
      if (!(e.altKey || g.alt)) { q.ix = 2 * q.x - t[0]; q.iy = 2 * q.y - t[1]; }
    }
  } else if (g.kind === 'anchor') {
    const dx = p[0] - g.start[0], dy = p[1] - g.start[1];
    const o = g.orig;
    Object.assign(q, { x: o.x + dx, y: o.y + dy, ix: o.ix + dx, iy: o.iy + dy, ox: o.ox + dx, oy: o.oy + dy });
  } else {
    const smooth = !(e.altKey || g.alt);
    if (g.which === 'out') {
      q.ox = p[0]; q.oy = p[1];
      if (smooth) { const l = Math.hypot(q.ix - q.x, q.iy - q.y), a = Math.atan2(q.y - p[1], q.x - p[0]); if (l > 0) { q.ix = q.x + Math.cos(a) * l; q.iy = q.y + Math.sin(a) * l; } }
    } else {
      q.ix = p[0]; q.iy = p[1];
      if (smooth) { const l = Math.hypot(q.ox - q.x, q.oy - q.y), a = Math.atan2(q.y - p[1], q.x - p[0]); if (l > 0) { q.ox = q.x + Math.cos(a) * l; q.oy = q.y + Math.sin(a) * l; } }
    }
  }
  setPath(path);
}

/** Al soltar: la edición pasa al historial (un arrastre sin movimiento no cuenta). */
export function penUp(g: PenDrag) {
  if (g.kind !== 'penPoint' && !g.moved) { useStore.setState({ penLocal: false }); return; }
  commitPath(g.label);
}

/** Intro / Esc: termina el subtrazado en curso. */
export function penFinish(): boolean {
  if (S().penDrawing == null) return false;
  const before = S().path;
  const path = before.filter((sp) => sp.points.length >= 2 || sp.closed);
  useStore.setState({ path, penDrawing: null });
  if (path.length !== before.length) commitPath('Eliminar punto de ancla');
  return true;
}

/** Retroceso: quita el último punto (dibujando) o el ancla seleccionada. */
export function penBackspace(): boolean {
  const s = S();
  const path = clone(s.path);
  if (s.penDrawing != null && path[s.penDrawing]) {
    const sp = path[s.penDrawing];
    sp.points.pop();
    if (!sp.points.length) { path.splice(s.penDrawing, 1); setPath(path, { penDrawing: null, pathSel: null }); }
    else setPath(path, { pathSel: { sub: s.penDrawing, idx: sp.points.length - 1 } });
    commitPath('Eliminar punto de ancla');
    return true;
  }
  if (s.pathSel && path[s.pathSel.sub]) {
    const sp = path[s.pathSel.sub];
    sp.points.splice(s.pathSel.idx, 1);
    if (sp.points.length < 2) path.splice(s.pathSel.sub, 1);
    setPath(path, { pathSel: null });
    commitPath('Eliminar punto de ancla');
    return true;
  }
  if (path.length) { setPath([], { pathSel: null }); commitPath('Eliminar trazado'); return true; }
  return false;
}

/** Dibujo del trazado sobre el lienzo (SVG en coordenadas de pantalla). */
export function PathOverlay({ X, Y, hover }: { X: (x: number) => number; Y: (y: number) => number; hover: Pt | null }) {
  const path = useStore((s) => s.path);
  const sel = useStore((s) => s.pathSel);
  const drawing = useStore((s) => s.penDrawing);
  const tool = useStore((s) => s.tool);
  if (!path.length) return null;
  const showPoints = tool === 'pen' || tool === 'pathSelect';
  const d = toSvg(path, (x, y) => [X(x), Y(y)]);
  const rubber = drawing != null && hover && path[drawing]?.points.length
    ? (() => {
      const pts = path[drawing].points, last = pts[pts.length - 1];
      return <path className="path-rubber" d={`M${X(last.x)} ${Y(last.y)}C${X(last.ox)} ${Y(last.oy)} ${X(hover[0])} ${Y(hover[1])} ${X(hover[0])} ${Y(hover[1])}`} />;
    })() : null;
  const handles = (sub: number, idx: number) => {
    const q = path[sub]?.points[idx];
    if (!q) return null;
    return (
      <g key={`h${sub}-${idx}`}>
        {(q.ix !== q.x || q.iy !== q.y) && <><line className="path-handle" x1={X(q.x)} y1={Y(q.y)} x2={X(q.ix)} y2={Y(q.iy)} /><circle className="path-knob" cx={X(q.ix)} cy={Y(q.iy)} r={3.5} /></>}
        {(q.ox !== q.x || q.oy !== q.y) && <><line className="path-handle" x1={X(q.x)} y1={Y(q.y)} x2={X(q.ox)} y2={Y(q.oy)} /><circle className="path-knob" cx={X(q.ox)} cy={Y(q.oy)} r={3.5} /></>}
      </g>
    );
  };
  return (
    <g className="pen-overlay">
      <path className="path-line" d={d} data-testid="work-path" />
      {rubber}
      {showPoints && path.map((sp, s) => sp.points.map((q, i) => {
        const on = sel?.sub === s && sel.idx === i;
        return <rect key={`${s}-${i}`} className={`path-anchor ${on ? 'on' : ''}`} x={X(q.x) - 3.5} y={Y(q.y) - 3.5} width={7} height={7} />;
      }))}
      {showPoints && sel && handles(sel.sub, sel.idx)}
      {showPoints && drawing != null && path[drawing] && sel?.idx !== path[drawing].points.length - 1 && handles(drawing, path[drawing].points.length - 1)}
    </g>
  );
}

