import { useEffect, useRef, useState } from 'react';
import { X as XIcon } from 'lucide-react';
import { engine } from '../engine/client';
import type { Matrix, PointerSample, Rect, ToolId } from '../engine/types';
import { useStore, toRgba } from './store';
import { openFile, placeFile, isPaintTool, closeDocAsk } from './commands';
import { Home } from './Home';
import type { CombineMode } from '../engine/selection';
import { penDown, pathEditDown, penMove, penUp, penFinish, penBackspace, PathOverlay, type PenDrag } from './Pen';
import { isEmpty as isEmptyPath } from '../engine/path';
import { Rulers, GuideLines, hitGuide, snapPoint } from './Rulers';
import { TouchGestures } from './touch';
import { ArtboardLabels } from './Artboards';
import { SelectionBar } from './SelectionBar';
import { useIsMobile } from './Mobile';
import { resolveGradient, GRADIENT_PRESETS } from './GradientEditor';
import { quadOf, localToDoc, docToLocal, dragQuad, pushSpec, patchGrid, CORNER_GROUP, CORNER_TANGENTS, PATCH_CORNERS, puppetMesh, pushPuppet, invertPuppet } from './transformGeom';
import { identityPatch, patchParam, patchWeights } from '../engine/meshwarp';
import type { TransformState } from './store';

const CURSORS: Partial<Record<ToolId, string>> = {
  move: 'move', marquee: 'crosshair', marqueeEllipse: 'crosshair', lasso: 'crosshair', polylasso: 'crosshair',
  wand: 'crosshair', crop: 'crosshair', perspectiveCrop: 'crosshair', eyedropper: 'crosshair', gradient: 'crosshair', bucket: 'crosshair',
  text: 'text', shape: 'crosshair', hand: 'grab', zoom: 'zoom-in', pen: 'crosshair', pathSelect: 'default', patch: 'crosshair', rotateView: 'grab', redEye: 'crosshair', objectSelect: 'crosshair',
};

type Pt = [number, number];

/** Gestos que resuelve la interfaz (vista previa en SVG) y luego envía al motor. */
type UIDrag =
  | { kind: 'marquee'; start: Pt; cur: Pt; mode: CombineMode; ellipse: boolean; moveOffset?: Pt }
  | { kind: 'lasso'; pts: Pt[]; mode: CombineMode }
  | { kind: 'gradient'; start: Pt; cur: Pt }
  | { kind: 'shape'; start: Pt; cur: Pt }
  | { kind: 'crop'; handle: string; start: Pt; orig: Rect & { angle?: number; pivot?: Pt } }
  | { kind: 'straighten'; start: Pt; cur: Pt }
  | { kind: 'pcrop'; handle: number; start: Pt; orig: Pt[] }
  | { kind: 'transform'; handle: string; start: Pt; orig: TParams; origT: TransformState; uv?: { u: number; v: number } }
  | { kind: 'puppet'; pin: number; start: Pt; orig: Pt }
  | { kind: 'brushResize'; x0: number; y0: number; size: number; hardness: number }
  | { kind: 'pen'; g: PenDrag }
  | { kind: 'patchDrag'; start: Pt; cur: Pt }
  | { kind: 'guide'; id: number; dir: 'h' | 'v'; pos: number }
  | { kind: 'rotate'; a0: number; rot0: number }
  | { kind: 'redEye'; start: Pt; cur: Pt }
  | { kind: 'textBox'; start: Pt; cur: Pt }
  | { kind: 'quickSel'; pts: Pt[]; mode: CombineMode }
  | { kind: 'objectSel'; start: Pt; cur: Pt; mode: CombineMode };

/** Parámetros de la transformación libre (en coordenadas de documento). */
interface TParams { tx: number; ty: number; sx: number; sy: number; rot: number }

const modeFrom = (e: { shiftKey: boolean; altKey: boolean }): CombineMode =>
  e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';

function normRect(a: Pt, b: Pt): Rect {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}

export function tMatrix(b: Rect, p: TParams): Matrix {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const c = Math.cos(p.rot), s = Math.sin(p.rot);
  // T(c + t) · R · S · T(-c)
  const a = c * p.sx, bb = s * p.sx, cc = -s * p.sy, d = c * p.sy;
  return [a, bb, cc, d, cx + p.tx - (a * cx + cc * cy), cy + p.ty - (bb * cx + d * cy)];
}

const apply = (m: Matrix, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function CanvasArea() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const [ui, setUiState] = useState<UIDrag | null>(null);
  // Espejo síncrono: un clic muy rápido suelta el botón antes de que React vuelva a pintar.
  const uiRef = useRef<UIDrag | null>(null);
  const setUi = (v: UIDrag | null) => { uiRef.current = v; setUiState(v); };
  const [poly, setPoly] = useState<{ pts: Pt[]; mode: CombineMode } | null>(null);
  const [tparams, setTparams] = useState<TParams>({ tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 });
  const [caps, setCaps] = useState(false);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [overGuide, setOverGuide] = useState<'h' | 'v' | null>(null);
  const showRulers = useStore((s) => s.opts.rulers);
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const brushSize = useStore((s) => s.brush.size);
  const opts = useStore((s) => s.opts);
  const selectionPath = useStore((s) => s.selectionPath);
  const transform = useStore((s) => s.transform);
  const textEdit = useStore((s) => s.textEdit);
  const mobile = useIsMobile();
  const crop = useStore((s) => s.crop);
  const fg = useStore((s) => s.fg);

  // ---------------------------------------------------------------- canvas + motor
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
      setArea({ w: rr.width, h: rr.height });
      engine.send({ type: 'resize', width: rr.width, height: rr.height, dpr: window.devicePixelRatio || 1 });
    });
    ro.observe(el);
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

  // Al elegir Recortar, el cuadro abarca todo el lienzo (como Photoshop).
  useEffect(() => {
    if (tool === 'crop' && doc.open && !crop) useStore.setState({ crop: { x: 0, y: 0, w: doc.width, h: doc.height } });
    if (tool !== 'crop' && crop) useStore.setState({ crop: null, straighten: false });
    if (tool !== 'perspectiveCrop' && useStore.getState().pcrop) useStore.setState({ pcrop: null });
    if (tool !== 'polylasso' && poly) setPoly(null);
  }, [tool, doc.open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cada documento tiene su propio trazado de trabajo.
  useEffect(() => { useStore.setState({ penDrawing: null, pathSel: null }); }, [doc.name, doc.open]);

  // Reinicia los parámetros al empezar una transformación.
  useEffect(() => { if (transform) setTparams({ tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 }); }, [transform?.bounds.x, transform?.bounds.y, transform?.bounds.w, !!transform]); // eslint-disable-line react-hooks/exhaustive-deps

  // Teclas propias del lienzo: Enter/Esc/Retroceso para lazo poligonal, recorte y transformación.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.dialog || s.textEdit) return;
      if (e.key === 'CapsLock' || e.getModifierState) setCaps(e.getModifierState?.('CapsLock') ?? false);
      if (e.type === 'keydown' && e.key === 'Escape' && s.tool === 'rotateView' && s.view.rot) {
        e.preventDefault(); e.stopImmediatePropagation(); engine.call('setRotation', 0); return;
      }
      if (e.type === 'keydown' && !s.transform) {
        // Pluma: Ctrl+Intro = selección; Intro/Esc terminan; Retroceso borra puntos.
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !isEmptyPath(s.path)) {
          e.preventDefault(); e.stopImmediatePropagation(); penFinish();
          engine.call('selectPath', useStore.getState().path, 'replace', 0); return;
        }
        if ((e.key === 'Enter' || e.key === 'Escape') && penFinish()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (e.key === 'Escape' && (s.tool === 'pen' || s.tool === 'pathSelect') && s.doc.activePathId != null) {
          e.preventDefault(); e.stopImmediatePropagation(); engine.call('setActivePath', null); return;
        }
        if ((e.key === 'Backspace' || e.key === 'Delete') && (s.tool === 'pen' || s.tool === 'pathSelect') && penBackspace()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      }
      if (poly && e.type === 'keydown') {
        if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); finishPoly(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setPoly(null); }
        else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); e.stopImmediatePropagation(); setPoly((p) => (p && p.pts.length > 1 ? { ...p, pts: p.pts.slice(0, -1) } : null)); }
        return;
      }
      if (s.puppet && e.type === 'keydown') {
        if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); commitPuppet(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancelPuppet(); }
        else if ((e.key === 'Backspace' || e.key === 'Delete') && s.puppet.sel != null) {
          e.preventDefault(); e.stopImmediatePropagation();
          const np = { ...s.puppet, pins: s.puppet.pins.filter((_, i) => i !== s.puppet!.sel), sel: null };
          useStore.setState({ puppet: np }); pushPuppet(np);
        }
        return;
      }
      if (s.transform && e.type === 'keydown') {
        if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); commitTransform(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancelTransform(); }
        else if (e.key.startsWith('Arrow')) {
          e.preventDefault(); e.stopImmediatePropagation();
          const n = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0, dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
          updateT({ ...tparamsRef.current, tx: tparamsRef.current.tx + dx, ty: tparamsRef.current.ty + dy });
        }
        return;
      }
      if (s.pcrop && s.tool === 'perspectiveCrop' && e.type === 'keydown') {
        if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); applyPerspectiveCrop(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); useStore.setState({ pcrop: null }); }
        return;
      }
      if (s.crop && s.tool === 'crop' && e.type === 'keydown') {
        if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); applyCrop(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); const d = s.doc; useStore.setState({ crop: { x: 0, y: 0, w: d.width, h: d.height } }); }
      }
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', key, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', key, true); };
  });

  // Gestos táctiles: llaman siempre a los manejadores más recientes.
  const latest = useRef({ onDown: (_e: React.PointerEvent) => {}, onMove: (_e: React.PointerEvent) => {}, onUp: (_e: React.PointerEvent) => {}, toDoc: (x: number, y: number): Pt => [x, y] });
  const touch = useRef<TouchGestures>(null as unknown as TouchGestures);
  if (!touch.current) touch.current = new TouchGestures({
    down: (e) => latest.current.onDown(e), move: (e) => latest.current.onMove(e), up: (e) => latest.current.onUp(e),
    rect: () => (rectRef.current = wrap.current!.getBoundingClientRect()), toDoc: (x, y) => latest.current.toDoc(x, y),
  });

  const tparamsRef = useRef(tparams);
  tparamsRef.current = tparams;

  // ---------------------------------------------------------------- utilidades
  const sample = (e: PointerEvent | React.PointerEvent): PointerSample => {
    const r = rectRef.current!;
    const pressure = e.pointerType === 'mouse' ? 1 : e.pressure || 0.5;
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: pressure, t: e.timeStamp };
  };
  const rot = view.rot ?? 0;
  const toDoc = (x: number, y: number): Pt => {
    if (rot) {
      // La vista gira alrededor del centro del área: se deshace el giro antes de pasar a documento.
      const r = rectRef.current, cx = (r?.width ?? 0) / 2, cy = (r?.height ?? 0) / 2, c = Math.cos(-rot), sn = Math.sin(-rot);
      [x, y] = [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c];
    }
    return [(x - view.panX) / view.zoom, (y - view.panY) / view.zoom];
  };
  const docPt = (e: React.PointerEvent): Pt => { const s = sample(e); return toDoc(s.x, s.y); };
  const mods = (e: React.PointerEvent) => ({ alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });

  function finishPoly() {
    if (poly && poly.pts.length >= 3) engine.call('selectPolygon', poly.pts, poly.mode, 'Lazo poligonal');
    setPoly(null);
  }

  function updateT(p: TParams) {
    const t = useStore.getState().transform;
    if (!t) return;
    setTparams(p);
    const m = tMatrix(t.bounds, p);
    const nt = { ...t, matrix: m };
    useStore.setState({ transform: nt });
    pushSpec(nt);
  }

  function setT(nt: TransformState) {
    useStore.setState({ transform: nt });
    pushSpec(nt);
  }

  function applyCrop() {
    const c = useStore.getState().crop;
    if (!c) return;
    useStore.setState({ crop: null });
    void engine.call('crop', c).then(() => {
      if (useStore.getState().tool === 'crop') { const d = useStore.getState().doc; useStore.setState({ crop: { x: 0, y: 0, w: d.width, h: d.height } }); }
    });
  }
  function applyPerspectiveCrop() {
    const q = useStore.getState().pcrop;
    if (!q) return;
    useStore.setState({ pcrop: null });
    void engine.call('perspectiveCrop', q.flat());
  }

  function commitPuppet() {
    engine.call('commitTransform', 'Deformación de posición libre');
    useStore.setState({ puppet: null });
  }
  function cancelPuppet() {
    engine.call('cancelTransform');
    useStore.setState({ puppet: null });
  }

  function commitTransform() {
    const md = useStore.getState().transform?.mode ?? 'free';
    engine.call('commitTransform', { free: 'Transformación libre', skew: 'Sesgar', distort: 'Distorsionar', perspective: 'Perspectiva', warp: 'Deformar' }[md]);
    useStore.setState({ transform: null });
  }
  function cancelTransform() {
    engine.call('cancelTransform');
    useStore.setState({ transform: null });
  }

  async function commitText() {
    const te = useStore.getState().textEdit;
    if (!te || te.layerId == null) { useStore.setState({ textEdit: null }); return; }
    useStore.setState({ textEdit: null });
    if (!te.text.trim()) { await engine.call('deleteLayer', te.layerId); return; }
    await engine.call('updateText', te.layerId, { text: te.text }, true);
  }

  // ---------------------------------------------------------------- puntero
  // Puntero que está usando la herramienta. Con un toque corto el "down" se reproduce cuando el dedo
  // ya se ha levantado y la captura ya no es posible: se sigue por su identificador.
  const downPointer = useRef<number | null>(null);
  const capture = (e: React.PointerEvent) => {
    downPointer.current = e.pointerId;
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* el puntero ya no está activo */ }
  };
  const owns = (e: React.PointerEvent) => downPointer.current === e.pointerId || !!(e.target as Element)?.hasPointerCapture?.(e.pointerId);
  const onDown = async (e: React.PointerEvent) => {
    if (!doc.open) return;
    const s = useStore.getState();
    if (s.textEdit && tool !== 'text') await commitText();
    rectRef.current = wrap.current!.getBoundingClientRect();
    const raw = docPt(e);
    // Ajuste magnético a guías y bordes para herramientas de dibujo y selección.
    const p: Pt = ['marquee', 'marqueeEllipse', 'shape', 'crop', 'pen', 'gradient'].includes(tool) ? snapPoint(raw) : raw;

    // Alt + botón derecho: tamaño (horizontal) y dureza (vertical) del pincel, como Photoshop.
    if (e.button === 2 && e.altKey && isPaintTool(tool)) {
      e.preventDefault();
      capture(e);
      setUi({ kind: 'brushResize', x0: e.clientX, y0: e.clientY, size: s.brush.size, hardness: s.brush.hardness });
      return;
    }
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    capture(e);

    // Mover guías con la herramienta Mover (soltar fuera del documento la elimina).
    if (tool === 'move' && e.button === 0 && !s.transform) {
      const sp = sample(e), hg = hitGuide(sp.x, sp.y);
      if (hg) { setUi({ kind: 'guide', id: hg.id, dir: hg.dir, pos: hg.dir === 'h' ? p[1] : p[0] }); return; }
    }

    // Transformación libre activa: asas.
    if (s.transform && e.button === 0) {
      const h = (e.target as Element).getAttribute?.('data-handle') ?? hitTransform(p);
      if (h) {
        let uv: { u: number; v: number } | undefined;
        if (h === 'warpIn') { const l = docToLocal(s.transform)(p[0], p[1]); const r = patchParam(s.transform.warp?.ctrl ?? identityPatch(s.transform.bounds), l); uv = { u: r.u, v: r.v }; }
        setUi({ kind: 'transform', handle: h, start: p, orig: { ...tparams }, origT: s.transform, uv });
        return;
      }
      return;
    }

    // Deformación de posición libre: añadir, elegir, mover o quitar (Alt) chinchetas.
    if (s.puppet && e.button === 0) {
      const pu = s.puppet, z = s.view.zoom;
      const hit = pu.pins.findIndex((pin) => Math.hypot((pin.q[0] - p[0]) * z, (pin.q[1] - p[1]) * z) < 9);
      if (hit >= 0 && e.altKey) {
        const np = { ...pu, pins: pu.pins.filter((_, i) => i !== hit), sel: null };
        useStore.setState({ puppet: np }); pushPuppet(np); return;
      }
      if (hit >= 0) { useStore.setState({ puppet: { ...pu, sel: hit } }); setUi({ kind: 'puppet', pin: hit, start: p, orig: pu.pins[hit].q }); return; }
      if (e.altKey) return;
      // Una chincheta nueva se clava en el punto original bajo el cursor (la malla inversa).
      const src = pu.pins.length ? invertPuppet(pu, p) : p;
      const b = pu.bounds;
      if (src[0] < b.x - 2 || src[1] < b.y - 2 || src[0] > b.x + b.w + 2 || src[1] > b.y + b.h + 2) return;
      const np = { ...pu, pins: [...pu.pins, { p: src, q: p }], sel: pu.pins.length };
      useStore.setState({ puppet: np });
      setUi({ kind: 'puppet', pin: np.pins.length - 1, start: p, orig: p });
      return;
    }

    if (tool === 'hand' || e.button === 1) setGrabbing(true);
    const uiTool = e.button === 0 && !(e.ctrlKey && tool !== 'move' && tool !== 'pathSelect');
    if (uiTool) {
      switch (tool) {
        case 'marquee':
        case 'marqueeEllipse':
          setUi({ kind: 'marquee', start: p, cur: p, mode: modeFrom(e), ellipse: tool === 'marqueeEllipse' });
          return;
        case 'lasso':
          setUi({ kind: 'lasso', pts: [p], mode: modeFrom(e) });
          return;
        case 'polylasso': {
          if (!poly) { setPoly({ pts: [p], mode: modeFrom(e) }); return; }
          const [x0, y0] = poly.pts[0];
          const near = Math.hypot((p[0] - x0) * view.zoom, (p[1] - y0) * view.zoom) < 8;
          if (near && poly.pts.length >= 3) { finishPoly(); return; }
          setPoly({ ...poly, pts: [...poly.pts, p] });
          return;
        }
        case 'rotateView': {
          const sp = sample(e), r = rectRef.current!;
          setUi({ kind: 'rotate', a0: Math.atan2(sp.y - r.height / 2, sp.x - r.width / 2), rot0: rot });
          return;
        }
        case 'patch': {
          // Dentro de la selección: arrastrar hacia el origen. Fuera: dibujar la zona (como el Lazo).
          const inside = s.doc.selection && !e.shiftKey && !e.altKey && (await engine.call<number>('selectionValueAt', p[0], p[1])) > 0;
          if (inside) setUi({ kind: 'patchDrag', start: p, cur: p });
          else setUi({ kind: 'lasso', pts: [p], mode: modeFrom(e) });
          return;
        }
        case 'pen': {
          const g = penDown(p, e, view.zoom);
          if (g) setUi({ kind: 'pen', g });
          return;
        }
        case 'pathSelect': {
          const g = pathEditDown(p, e, view.zoom);
          if (g) setUi({ kind: 'pen', g });
          return;
        }
        case 'wand':
          engine.call('magicWand', p[0], p[1], s.opts.wandTolerance, s.opts.contiguous, s.opts.sampleAll, modeFrom(e));
          return;
        case 'redEye':
          setUi({ kind: 'redEye', start: p, cur: p });
          return;
        case 'quickSelect':
          setUi({ kind: 'quickSel', pts: [p], mode: e.altKey ? 'subtract' : 'add' });
          return;
        case 'objectSelect':
          setUi({ kind: 'objectSel', start: p, cur: p, mode: modeFrom(e) });
          return;
        case 'bucket':
          engine.call('bucketFill', p[0], p[1], s.opts.wandTolerance, s.opts.contiguous, s.opts.sampleAll);
          return;
        case 'gradient':
          setUi({ kind: 'gradient', start: p, cur: p });
          return;
        case 'shape':
          setUi({ kind: 'shape', start: p, cur: p });
          return;
        case 'crop': {
          const c = s.crop ?? { x: 0, y: 0, w: doc.width, h: doc.height };
          // Enderezar: botón de la barra de opciones o Ctrl+arrastrar (como Photoshop).
          if (s.straighten || e.ctrlKey || e.metaKey) { setUi({ kind: 'straighten', start: raw, cur: raw }); return; }
          const lp = cropLocal(c, p);
          let h = (e.target as Element).getAttribute?.('data-handle') ?? (inside(lp, c) ? 'move' : null);
          if (!h) {
            // Fuera del cuadro: cerca, gira (como Photoshop); lejos, dibuja un cuadro nuevo.
            const dx = Math.max(c.x - lp[0], 0, lp[0] - c.x - c.w), dy = Math.max(c.y - lp[1], 0, lp[1] - c.y - c.h);
            h = Math.hypot(dx, dy) * view.zoom < 60 ? 'rotate' : 'new';
          }
          setUi({ kind: 'crop', handle: h, start: p, orig: h === 'new' ? { x: p[0], y: p[1], w: 0, h: 0 } : c });
          return;
        }
        case 'perspectiveCrop': {
          const h = (e.target as Element).getAttribute?.('data-handle');
          const pc = s.pcrop;
          if (pc && h?.startsWith('pc')) { setUi({ kind: 'pcrop', handle: Number(h.slice(2)), start: p, orig: pc }); return; }
          if (pc && inPoly(pc, p)) { setUi({ kind: 'pcrop', handle: -1, start: p, orig: pc }); return; }
          useStore.setState({ pcrop: [p, p, p, p] });
          setUi({ kind: 'pcrop', handle: -2, start: p, orig: [p, p, p, p] });
          return;
        }
        case 'text': {
          if (s.textEdit) { await commitText(); return; }
          // Clic: editar el texto de debajo o crear texto de punto; arrastrar: caja de párrafo (se decide al soltar).
          setUi({ kind: 'textBox', start: p, cur: p });
          return;
        }
      }
    }
    engine.pointer({ phase: 'down', points: [sample(e)], button: e.button, ...mods(e) });
  };

  const onMove = (e: React.PointerEvent) => {
    const s = sample(e);
    setHover({ x: s.x, y: s.y });
    setCaps(e.getModifierState?.('CapsLock') ?? false);
    const v = useStore.getState().view;
    useStore.setState({ cursor: { x: Math.floor((s.x - v.panX) / v.zoom), y: Math.floor((s.y - v.panY) / v.zoom) } });
    const raw = toDoc(s.x, s.y);
    const cu = uiRef.current;
    const p: Pt = cu && ['marquee', 'shape', 'crop', 'pen', 'gradient'].includes(cu.kind) && !(cu.kind === 'crop' && cu.handle === 'move') ? snapPoint(raw) : raw;
    if (!ui && tool === 'move') { const hg = hitGuide(s.x, s.y); setOverGuide(hg ? hg.dir : null); }
    if (uiRef.current) {
      moveUi(uiRef.current, p, e);
      return;
    }
    if (!owns(e)) return;
    const native = e.nativeEvent;
    const list = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const points = list.length ? list.map(sample) : [s];
    engine.pointer({ phase: 'move', points, button: e.button === -1 ? 0 : e.button, ...mods(e) });
  };

  function moveUi(g: UIDrag, p: Pt, e: React.PointerEvent) {
    switch (g.kind) {
      case 'marquee': {
        let cur = p;
        if (e.shiftKey && g.mode === 'replace') {
          const d = Math.max(Math.abs(p[0] - g.start[0]), Math.abs(p[1] - g.start[1]));
          cur = [g.start[0] + Math.sign(p[0] - g.start[0] || 1) * d, g.start[1] + Math.sign(p[1] - g.start[1] || 1) * d];
        }
        setUi({ ...g, cur });
        return;
      }
      case 'lasso': setUi({ ...g, pts: [...g.pts, p] }); return;
      case 'gradient': {
        let cur = p;
        if (e.shiftKey) {
          const dx = p[0] - g.start[0], dy = p[1] - g.start[1];
          const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
          cur = [g.start[0] + Math.cos(a) * len, g.start[1] + Math.sin(a) * len];
        }
        setUi({ ...g, cur });
        return;
      }
      case 'shape': {
        let cur = p;
        if (e.shiftKey) {
          const d = Math.max(Math.abs(p[0] - g.start[0]), Math.abs(p[1] - g.start[1]));
          cur = [g.start[0] + Math.sign(p[0] - g.start[0] || 1) * d, g.start[1] + Math.sign(p[1] - g.start[1] || 1) * d];
        }
        setUi({ ...g, cur });
        return;
      }
      case 'crop': {
        const o = g.orig;
        if (g.handle === 'rotate') {
          // Girar el cuadro alrededor de su centro (el pivote pasa a ser el centro).
          const c0 = cropCenter(o);
          let a = (o.angle ?? 0) + Math.atan2(p[1] - c0[1], p[0] - c0[0]) - Math.atan2(g.start[1] - c0[1], g.start[0] - c0[0]);
          if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
          useStore.setState({ crop: { x: c0[0] - o.w / 2, y: c0[1] - o.h / 2, w: o.w, h: o.h, angle: a, pivot: c0 } });
          return;
        }
        const ls = cropLocal(o, g.start), lp = cropLocal(o, p);
        const dx = lp[0] - ls[0], dy = lp[1] - ls[1];
        let r: Rect;
        if (g.handle === 'new') r = normRect(g.start, p);
        else if (g.handle === 'move') r = { ...o, x: o.x + dx, y: o.y + dy };
        else {
          let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
          if (g.handle.includes('w')) x0 += dx;
          if (g.handle.includes('e')) x1 += dx;
          if (g.handle.includes('n')) y0 += dy;
          if (g.handle.includes('s')) y1 += dy;
          r = normRect([x0, y0], [x1, y1]);
        }
        const keep = g.handle === 'new' ? {} : { angle: o.angle, pivot: o.pivot };
        useStore.setState({ crop: { x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)), ...keep } });
        return;
      }
      case 'straighten': setUi({ ...g, cur: p }); return;
      case 'pcrop': {
        const o = g.orig, dx = p[0] - g.start[0], dy = p[1] - g.start[1];
        let q: Pt[];
        if (g.handle === -2) q = [g.start, [p[0], g.start[1]], p, [g.start[0], p[1]]];
        else if (g.handle === -1) q = o.map(([x, y]) => [x + dx, y + dy] as Pt);
        else q = o.map((c, i) => (i === g.handle ? [c[0] + dx, c[1] + dy] as Pt : c));
        useStore.setState({ pcrop: q });
        return;
      }
      case 'transform': moveTransform(g, p, e); return;
      case 'puppet': {
        const pu = useStore.getState().puppet;
        if (!pu) return;
        const q: Pt = [g.orig[0] + p[0] - g.start[0], g.orig[1] + p[1] - g.start[1]];
        const np = { ...pu, pins: pu.pins.map((pin, i) => (i === g.pin ? { ...pin, q } : pin)) };
        useStore.setState({ puppet: np });
        pushPuppet(np);
        return;
      }
      case 'pen': penMove(g.g, p, e, useStore.getState().view.zoom); return;
      case 'patchDrag': case 'redEye': case 'textBox': case 'objectSel': setUi({ ...g, cur: p }); return;
      case 'quickSel': {
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) * useStore.getState().view.zoom > 3) setUi({ ...g, pts: [...g.pts, p] });
        return;
      }
      case 'guide': setUi({ ...g, pos: Math.round(g.dir === 'h' ? p[1] : p[0]) }); return;
      case 'rotate': {
        const r = rectRef.current!, sp = sample(e), a = Math.atan2(sp.y - r.height / 2, sp.x - r.width / 2);
        let v = g.rot0 + a - g.a0;
        if (e.shiftKey) v = Math.round(v / (Math.PI / 12)) * (Math.PI / 12);
        engine.call('setRotation', v);
        return;
      }
      case 'brushResize': {
        const s = useStore.getState();
        s.setBrush({ size: Math.max(1, g.size + (e.clientX - g.x0)), hardness: Math.min(1, Math.max(0, g.hardness - (e.clientY - g.y0) / 200)) });
        return;
      }
    }
  }

  function moveTransform(g: Extract<UIDrag, { kind: 'transform' }>, p: Pt, e: React.PointerEvent) {
    const t = useStore.getState().transform!;
    const b = t.bounds, o = g.orig, T0 = g.origT;
    const toL = docToLocal(T0), l0 = toL(g.start[0], g.start[1]), l1 = toL(p[0], p[1]);
    const dl: Pt = [l1[0] - l0[0], l1[1] - l0[1]];
    // Deformar: puntos de control (las esquinas arrastran sus tiradores) o el interior del parche.
    if (T0.mode === 'warp' && (g.handle.startsWith('w') && g.handle.length > 1 && /^w\d+$/.test(g.handle) || g.handle === 'warpIn')) {
      const ctrl = (T0.warp?.ctrl ?? identityPatch(b)).map((c) => [...c] as Pt);
      if (g.handle === 'warpIn' && g.uv) {
        // Las esquinas quedan fijas; el resto se mueve lo mínimo para que el punto siga al cursor.
        const w = patchWeights(g.uv.u, g.uv.v).map((x, i) => (PATCH_CORNERS.includes(i) ? 0 : x));
        const s2 = w.reduce((a, x) => a + x * x, 0) || 1;
        for (let i = 0; i < 16; i++) { ctrl[i][0] += (w[i] / s2) * dl[0]; ctrl[i][1] += (w[i] / s2) * dl[1]; }
      } else {
        const i = Number(g.handle.slice(1));
        for (const k of CORNER_GROUP[i] ?? [i]) { ctrl[k][0] += dl[0]; ctrl[k][1] += dl[1]; }
      }
      setT({ ...t, warp: { ctrl, style: 'custom', bend: T0.warp?.bend ?? 0 } });
      return;
    }
    // Sesgar / distorsionar / perspectiva (por modo o con Ctrl, Ctrl+Mayús, Ctrl+Alt+Mayús, como Photoshop).
    if (g.handle !== 'move' && g.handle !== 'rotate') {
      const corner = g.handle.length === 2, ctrl = e.ctrlKey || e.metaKey;
      const qm = T0.mode === 'skew' || T0.mode === 'distort' || T0.mode === 'perspective' ? T0.mode
        : ctrl ? (corner && e.shiftKey && e.altKey ? 'perspective' : !corner && e.shiftKey ? 'skew' : 'distort') : null;
      if (qm) {
        const q = dragQuad(quadOf(T0), g.handle, dl, qm);
        if (q) setT({ ...t, quad: q });
        return;
      }
    }
    const cx = b.x + b.w / 2 + o.tx, cy = b.y + b.h / 2 + o.ty;
    if (g.handle === 'move') { updateT({ ...o, tx: o.tx + p[0] - g.start[0], ty: o.ty + p[1] - g.start[1] }); return; }
    if (g.handle === 'rotate') {
      const a0 = Math.atan2(g.start[1] - cy, g.start[0] - cx), a1 = Math.atan2(p[1] - cy, p[0] - cx);
      let rot = o.rot + a1 - a0;
      if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
      updateT({ ...o, rot });
      return;
    }
    // Escalado: se trabaja en el sistema local (sin rotación) de la caja.
    const c = Math.cos(-o.rot), s = Math.sin(-o.rot);
    const loc = (q: Pt): Pt => [(q[0] - cx) * c - (q[1] - cy) * s, (q[0] - cx) * s + (q[1] - cy) * c];
    const [lx, ly] = loc(p), [sx0, sy0] = loc(g.start);
    const hw = (b.w / 2) * o.sx, hh = (b.h / 2) * o.sy;
    const h = g.handle;
    const fromCenter = e.altKey;
    let nw = hw * 2, nh = hh * 2;
    if (h.includes('e')) nw = (hw + (lx - sx0)) * (fromCenter ? 2 : 1) + (fromCenter ? 0 : hw);
    if (h.includes('w')) nw = (hw - (lx - sx0)) * (fromCenter ? 2 : 1) + (fromCenter ? 0 : hw);
    if (h.includes('s')) nh = (hh + (ly - sy0)) * (fromCenter ? 2 : 1) + (fromCenter ? 0 : hh);
    if (h.includes('n')) nh = (hh - (ly - sy0)) * (fromCenter ? 2 : 1) + (fromCenter ? 0 : hh);
    const corner = h.length === 2;
    // Photoshop CC: las esquinas mantienen la proporción; Mayús lo desactiva.
    if (corner && !e.shiftKey) {
      const k = Math.max(Math.abs(nw) / (hw * 2), Math.abs(nh) / (hh * 2));
      nw = hw * 2 * k * Math.sign(nw || 1); nh = hh * 2 * k * Math.sign(nh || 1);
    }
    const nsx = (nw / b.w), nsy = (nh / b.h);
    // Desplaza el centro para que el lado opuesto quede fijo (salvo Alt).
    let dcx = 0, dcy = 0;
    if (!fromCenter) {
      if (h.includes('e')) dcx = (nw / 2 - hw);
      if (h.includes('w')) dcx = -(nw / 2 - hw);
      if (h.includes('s')) dcy = (nh / 2 - hh);
      if (h.includes('n')) dcy = -(nh / 2 - hh);
    }
    const cr = Math.cos(o.rot), sr = Math.sin(o.rot);
    updateT({ ...o, sx: nsx, sy: nsy, tx: o.tx + dcx * cr - dcy * sr, ty: o.ty + dcx * sr + dcy * cr });
  }

  function hitTransform(p: Pt): string | null {
    const t = useStore.getState().transform;
    if (!t) return null;
    if (t.mode === 'warp') {
      const l = docToLocal(t)(p[0], p[1]), r = patchParam(t.warp?.ctrl ?? identityPatch(t.bounds), l);
      return r.d * useStore.getState().view.zoom < 6 ? 'warpIn' : null;
    }
    const q = quadOf(t).map(([x, y]) => apply(t.matrix, x, y));
    if (inPoly(q, p)) return 'move';
    return t.mode && t.mode !== 'free' ? null : 'rotate';
  }

  const onUp = async (e: React.PointerEvent) => {
    if (!owns(e)) return;
    downPointer.current = null;
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
    setGrabbing(false);
    const g = uiRef.current;
    if (g) {
      setUi(null);
      const s = useStore.getState();
      switch (g.kind) {
        case 'straighten': {
          const dx = g.cur[0] - g.start[0], dy = g.cur[1] - g.start[1];
          if (Math.hypot(dx, dy) * s.view.zoom < 4) return;
          // La línea queda horizontal (o vertical si está más cerca de serlo).
          let a = Math.atan2(dy, dx);
          a -= Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
          const W = s.doc.width, H = s.doc.height, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
          const k = Math.min(W / (W * c + H * sn), H / (W * sn + H * c));
          const w = Math.floor(W * k), h = Math.floor(H * k);
          useStore.setState({ crop: { x: W / 2 - w / 2, y: H / 2 - h / 2, w, h, angle: a, pivot: [W / 2, H / 2] }, straighten: false });
          return;
        }
        case 'marquee': {
          let r = normRect(g.start, g.cur);
          if (e.altKey && g.mode === 'replace') r = { x: g.start[0] - r.w, y: g.start[1] - r.h, w: r.w * 2, h: r.h * 2 };
          if (r.w < 1 || r.h < 1) { if (g.mode === 'replace') engine.call('deselect'); return; }
          engine.call('selectShape', r, g.ellipse ? 'ellipse' : 'rect', g.mode, s.opts.feather);
          return;
        }
        case 'lasso':
          if (g.pts.length >= 3) engine.call('selectPolygon', g.pts, g.mode, 'Lazo');
          else if (g.mode === 'replace') engine.call('deselect');
          return;
        case 'gradient':
          if (Math.hypot(g.cur[0] - g.start[0], g.cur[1] - g.start[1]) >= 1) {
            engine.call('applyGradient', g.start, g.cur, s.opts.gradientType, s.opts.gradientTransparent, s.opts.gradientReverse,
              resolveGradient(s.opts.gradient ?? GRADIENT_PRESETS[s.opts.gradientTransparent ? 1 : 0], s.fg, s.bg, s.opts.gradientTransparency ?? true));
          }
          return;
        case 'shape': {
          const o = s.opts;
          const line = o.shapeKind === 'line';
          const r = line ? { x: g.start[0], y: g.start[1], w: g.cur[0] - g.start[0], h: g.cur[1] - g.start[1] } : normRect(g.start, g.cur);
          if (Math.abs(r.w) < 2 && Math.abs(r.h) < 2) return;
          const color = toRgba(s.fg);
          await engine.call('createShape', {
            shape: o.shapeKind, ...r,
            fill: line || !o.shapeFill ? null : color,
            stroke: line || o.shapeStroke ? (line ? color : toRgba(s.bg)) : null,
            strokeWidth: o.strokeWidth, radius: o.cornerRadius, sides: o.sides,
          });
          return;
        }
        case 'pen': penUp(g.g); return;
        case 'guide': engine.call('moveGuide', g.id, g.pos); return;
        case 'quickSel': {
          // Puntos intermedios para que el trazo no deje huecos.
          const r = s.brush.size / 2, pts: Pt[] = [g.pts[0]];
          for (let i = 1; i < g.pts.length; i++) {
            const [ax, ay] = g.pts[i - 1], [bx, by] = g.pts[i], n = Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, r * 0.5));
            for (let k = 1; k <= n; k++) pts.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
          }
          engine.call('quickSelect', pts, r, g.mode, s.opts.sampleAll, s.opts.autoEnhance);
          return;
        }
        case 'objectSel': {
          const r = normRect(g.start, g.cur);
          if (r.w * s.view.zoom < 6 || r.h * s.view.zoom < 6) { engine.call('selectSubject'); return; }
          engine.call('objectSelect', r, g.mode, s.opts.sampleAll);
          return;
        }
        case 'textBox': {
          const o = s.opts, r = normRect(g.start, g.cur), z = s.view.zoom;
          const box = r.w * z >= 10 && r.h * z >= 10 ? { w: Math.round(r.w), h: Math.round(r.h) } : null;
          if (!box) {
            const hit = await engine.call<number | null>('hitText', g.start[0], g.start[1]);
            if (hit) {
              const L = useStore.getState().doc.layers.find((l) => l.id === hit)!;
              engine.call('selectLayer', hit);
              useStore.setState({ textEdit: { layerId: hit, x: L.text!.x, y: L.text!.y, text: L.text!.text } });
              return;
            }
          }
          const at = box ? { x: Math.round(r.x), y: Math.round(r.y) } : { x: g.start[0], y: g.start[1] };
          const id = await engine.call<number>('createText', { text: '', ...at, box, font: o.font, size: o.fontSize, bold: o.bold, italic: o.italic, align: o.align, color: toRgba(s.fg) });
          useStore.setState({ textEdit: { layerId: id, x: at.x, y: at.y, text: '' } });
          return;
        }
        case 'redEye': {
          const o = useStore.getState().opts;
          engine.call('redEye', g.start[0], g.start[1], g.cur[0], g.cur[1], o.pupilSize, o.darkenAmount);
          return;
        }
        case 'patchDrag': {
          const dx = Math.round(g.cur[0] - g.start[0]), dy = Math.round(g.cur[1] - g.start[1]);
          if (dx || dy) engine.call('patchSelection', dx, dy);
          return;
        }
        default: return;
      }
    }
    engine.pointer({ phase: 'up', points: [sample(e)], button: e.button, ...mods(e) });
  };

  latest.current = { onDown: (e) => { void onDown(e); }, onMove, onUp: (e) => { void onUp(e); }, toDoc };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (!f) return;
    // Con un documento abierto, una imagen se coloca como capa (como Photoshop); un PSD se abre.
    if (doc.open && !/\.(psd|psb)$/i.test(f.name)) placeFile(f); else openFile(f);
  };

  // ---------------------------------------------------------------- dibujo de superposiciones
  const Z = view.zoom;
  const X = (x: number) => view.panX + x * Z, Y = (y: number) => view.panY + y * Z;
  const painting = isPaintTool(tool);
  const r = Math.max(1, (brushSize / 2) * Z);
  const cursor = ui?.kind === 'guide' || overGuide ? ((ui?.kind === 'guide' ? ui.dir : overGuide) === 'h' ? 'row-resize' : 'col-resize') : grabbing ? 'grabbing' : painting ? (caps ? 'crosshair' : 'none') : CURSORS[tool] ?? 'default';

  let preview: React.ReactNode = null;
  if (ui?.kind === 'marquee') {
    const rr = normRect(ui.start, ui.cur);
    preview = ui.ellipse
      ? <ellipse className="ants" cx={X(rr.x + rr.w / 2)} cy={Y(rr.y + rr.h / 2)} rx={(rr.w / 2) * Z} ry={(rr.h / 2) * Z} />
      : <rect className="ants" x={X(rr.x)} y={Y(rr.y)} width={rr.w * Z} height={rr.h * Z} />;
  } else if (ui?.kind === 'quickSel') {
    preview = <polyline className="quicksel-trail" points={ui.pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ')} strokeWidth={Math.max(2, brushSize * Z)} />;
  } else if (ui?.kind === 'objectSel') {
    const rr = normRect(ui.start, ui.cur);
    preview = <rect className="ants" x={X(rr.x)} y={Y(rr.y)} width={rr.w * Z} height={rr.h * Z} />;
  } else if (ui?.kind === 'textBox') {
    const rr = normRect(ui.start, ui.cur);
    preview = <rect className="redeye-box" x={X(rr.x)} y={Y(rr.y)} width={rr.w * Z} height={rr.h * Z} />;
  } else if (ui?.kind === 'redEye') {
    const rr = normRect(ui.start, ui.cur);
    preview = <rect className="redeye-box" x={X(rr.x)} y={Y(rr.y)} width={rr.w * Z} height={rr.h * Z} />;
  } else if (ui?.kind === 'lasso') {
    preview = <polyline className="ants" points={ui.pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ')} />;
  } else if (ui?.kind === 'gradient') {
    preview = <g><line className="guide-line" x1={X(ui.start[0])} y1={Y(ui.start[1])} x2={X(ui.cur[0])} y2={Y(ui.cur[1])} /><circle className="guide-dot" cx={X(ui.start[0])} cy={Y(ui.start[1])} r={3} /></g>;
  } else if (ui?.kind === 'shape') {
    const k = opts.shapeKind;
    const rr = normRect(ui.start, ui.cur);
    preview = k === 'line'
      ? <line className="shape-preview" x1={X(ui.start[0])} y1={Y(ui.start[1])} x2={X(ui.cur[0])} y2={Y(ui.cur[1])} stroke={fg} strokeWidth={Math.max(1, opts.strokeWidth * Z)} />
      : k === 'ellipse'
        ? <ellipse className="shape-preview" cx={X(rr.x + rr.w / 2)} cy={Y(rr.y + rr.h / 2)} rx={(rr.w / 2) * Z} ry={(rr.h / 2) * Z} fill={opts.shapeFill ? fg : 'none'} />
        : <rect className="shape-preview" x={X(rr.x)} y={Y(rr.y)} width={rr.w * Z} height={rr.h * Z} rx={opts.cornerRadius * Z} fill={opts.shapeFill ? fg : 'none'} />;
  }

  const polyPreview = poly && (
    <polyline className="ants" points={[...poly.pts, ...(hover ? [toDoc(hover.x, hover.y)] : [])].map(([x, y]) => `${X(x)},${Y(y)}`).join(' ')} />
  );

  const pcrop = useStore((st) => st.pcrop);
  const symmetry = useStore((st) => st.symmetry);
  const cropOverlay = crop && tool === 'crop' && doc.open && (() => {
    const cx = X(crop.x), cy = Y(crop.y), cw = crop.w * Z, ch = crop.h * Z;
    const handles: [string, number, number][] = [
      ['nw', cx, cy], ['n', cx + cw / 2, cy], ['ne', cx + cw, cy], ['e', cx + cw, cy + ch / 2],
      ['se', cx + cw, cy + ch], ['s', cx + cw / 2, cy + ch], ['sw', cx, cy + ch], ['w', cx, cy + ch / 2],
    ];
    const rotT = crop.angle && crop.pivot ? `rotate(${(crop.angle * 180) / Math.PI} ${X(crop.pivot[0])} ${Y(crop.pivot[1])})` : undefined;
    return (
      <g transform={rotT} data-testid="crop-overlay">
        <path className="crop-shade" fillRule="evenodd" d={`M-10000 -10000H20000V20000H-10000Z M${cx} ${cy}h${cw}v${ch}h${-cw}Z`} />
        <rect className="crop-box" x={cx} y={cy} width={cw} height={ch} />
        <path className="crop-thirds" d={`M${cx + cw / 3} ${cy}v${ch}M${cx + (2 * cw) / 3} ${cy}v${ch}M${cx} ${cy + ch / 3}h${cw}M${cx} ${cy + (2 * ch) / 3}h${cw}`} />
        {handles.map(([h, hx, hy]) => <rect key={h} data-handle={h} className="handle" x={hx - 5} y={hy - 5} width={10} height={10} style={{ cursor: `${h}-resize` }} />)}
      </g>
    );
  })();
  const straightenLine = ui?.kind === 'straighten' && (
    <line className="straighten-line" x1={X(ui.start[0])} y1={Y(ui.start[1])} x2={X(ui.cur[0])} y2={Y(ui.cur[1])} />
  );
  const pcropOverlay = pcrop && tool === 'perspectiveCrop' && doc.open && (() => {
    const P = (q: Pt) => `${X(q[0])},${Y(q[1])}`;
    // Rejilla en perspectiva (tercios) para alinear con el plano de la foto.
    const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const grid: string[] = [];
    for (const t of [1 / 3, 2 / 3]) {
      grid.push(`M${P(lerp(pcrop[0], pcrop[1], t))}L${P(lerp(pcrop[3], pcrop[2], t))}`);
      grid.push(`M${P(lerp(pcrop[0], pcrop[3], t))}L${P(lerp(pcrop[1], pcrop[2], t))}`);
    }
    return (
      <g data-testid="pcrop-overlay">
        <path className="crop-shade" fillRule="evenodd" d={`M-10000 -10000H20000V20000H-10000Z M${pcrop.map(P).join('L')}Z`} />
        <polygon className="crop-box" points={pcrop.map(P).join(' ')} />
        <path className="crop-thirds" d={grid.join('')} />
        {pcrop.map((q, i) => <rect key={i} data-handle={`pc${i}`} className="handle" x={X(q[0]) - 5} y={Y(q[1]) - 5} width={10} height={10} />)}
      </g>
    );
  })();

  const transformOverlay = transform && (() => {
    const P = (q: Pt) => `${X(q[0])},${Y(q[1])}`;
    if (transform.mode === 'warp') {
      const L = localToDoc(transform), ctrl = transform.warp?.ctrl ?? identityPatch(transform.bounds);
      const C = ctrl.map(([x, y]) => L(x, y));
      return (
        <g>
          {patchGrid(transform).map((line, i) => <polyline key={i} className={i < 2 || i > 5 ? 'warp-edge' : 'warp-grid'} points={line.map(P).join(' ')} />)}
          {CORNER_TANGENTS.map(([a, b]) => <line key={`${a}-${b}`} className="warp-tangent" x1={X(C[a][0])} y1={Y(C[a][1])} x2={X(C[b][0])} y2={Y(C[b][1])} />)}
          {C.map((q, i) => PATCH_CORNERS.includes(i)
            ? <rect key={i} data-handle={`w${i}`} className="handle" x={X(q[0]) - 5} y={Y(q[1]) - 5} width={10} height={10} />
            : [5, 6, 9, 10].includes(i) ? null
              : <circle key={i} data-handle={`w${i}`} className="handle warp-pt" cx={X(q[0])} cy={Y(q[1])} r={4.5} />)}
        </g>
      );
    }
    const q = quadOf(transform).map(([x, y]) => apply(transform.matrix, x, y));
    const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const pts: Record<string, Pt> = { nw: q[0], n: mid(q[0], q[1]), ne: q[1], e: mid(q[1], q[2]), se: q[2], s: mid(q[3], q[2]), sw: q[3], w: mid(q[0], q[3]) };
    return (
      <g>
        <polygon className="transform-box" points={q.map(P).join(' ')} data-handle="move" />
        {Object.entries(pts).map(([h, c]) => (
          <rect key={h} data-handle={h} className="handle" x={X(c[0]) - 5} y={Y(c[1]) - 5} width={10} height={10} style={{ cursor: transform.mode && transform.mode !== 'free' ? 'default' : `${h}-resize` }} />
        ))}
      </g>
    );
  })();

  const puppet = useStore((s) => s.puppet);
  const puppetOverlay = puppet && (() => {
    const P = (q: Pt) => `${X(q[0])},${Y(q[1])}`;
    let mesh: React.ReactElement | null = null;
    if (puppet.showMesh) {
      const m = puppetMesh(puppet), C1 = m.cols + 1, at = (i: number, j: number): Pt => [m.pts[(j * C1 + i) * 2], m.pts[(j * C1 + i) * 2 + 1]];
      const lines: string[] = [];
      for (let j = 0; j <= m.rows; j++) { const a: Pt[] = []; for (let i = 0; i <= m.cols; i++) a.push(at(i, j)); lines.push(a.map(P).join(' ')); }
      for (let i = 0; i <= m.cols; i++) { const a: Pt[] = []; for (let j = 0; j <= m.rows; j++) a.push(at(i, j)); lines.push(a.map(P).join(' ')); }
      mesh = <g className="puppet-mesh">{lines.map((l, i) => <polyline key={i} points={l} />)}</g>;
    }
    return (
      <g data-testid="puppet-overlay">
        {mesh}
        {puppet.pins.map((pin, i) => <circle key={i} className={`puppet-pin ${puppet.sel === i ? 'on' : ''}`} cx={X(pin.q[0])} cy={Y(pin.q[1])} r={6} />)}
      </g>
    );
  })();

  const grid = doc.open && (
    <g className="grid">
      <rect x={X(0)} y={Y(0)} width={doc.width * Z} height={doc.height * Z} fill="url(#grid)" />
      <defs>
        <pattern id="grid" width={Math.max(4, gridStep(doc.width) * Z)} height={Math.max(4, gridStep(doc.width) * Z)} patternUnits="userSpaceOnUse" x={X(0)} y={Y(0)}>
          <path d={`M${Math.max(4, gridStep(doc.width) * Z)} 0V${Math.max(4, gridStep(doc.width) * Z)}H0`} fill="none" stroke="#6af" strokeOpacity="0.45" strokeWidth="1" />
        </pattern>
      </defs>
    </g>
  );

  return (
    <main
      className="canvas-area"
      ref={wrap}
      style={{ cursor: doc.open ? cursor : 'default' }}
      onPointerDown={(e) => { if (!doc.open || !touch.current.onDown(e)) onDown(e); }}
      onPointerMove={(e) => { if (!touch.current.onMove(e)) onMove(e); }}
      onPointerUp={(e) => { if (e.pointerType === 'touch') setHover(null); if (!touch.current.onUp(e)) onUp(e); }}
      onPointerCancel={(e) => { if (!touch.current.onUp(e)) onUp(e); }}
      onDoubleClick={() => { if (poly) finishPoly(); if (transform) commitTransform(); }}
      onPointerLeave={() => { setHover(null); useStore.setState({ cursor: null }); }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="canvas-area"
    >
      <canvas ref={canvasRef} />
      {doc.open && doc.selection && !ui && !transform && !textEdit && !mobile && !rot && !['crop', 'perspectiveCrop', 'pen'].includes(tool) && (
        <SelectionBar sel={doc.selection} X={X} Y={Y} area={area} />
      )}
      <svg className="overlay" width="100%" height="100%">
        <g transform={rot ? `rotate(${(rot * 180) / Math.PI} ${area.w / 2} ${area.h / 2})` : undefined}>
        {grid}
        {selectionPath && ui?.kind === 'patchDrag' && (
          <g className="selection-edges" transform={`translate(${view.panX + (ui.cur[0] - ui.start[0]) * Z} ${view.panY + (ui.cur[1] - ui.start[1]) * Z}) scale(${Z})`}>
            <path className="ants" d={selectionPath} vectorEffect="non-scaling-stroke" />
          </g>
        )}
        {selectionPath && (
          <g className="selection-edges" transform={`translate(${view.panX} ${view.panY}) scale(${Z})`}>
            <path className="ants-under" d={selectionPath} vectorEffect="non-scaling-stroke" />
            <path className="ants" d={selectionPath} vectorEffect="non-scaling-stroke" />
          </g>
        )}
        <ArtboardLabels X={X} Y={Y} />
        <GuideLines width={area.w} height={area.h} moving={ui?.kind === 'guide' ? ui : null} />
        {preview}
        {polyPreview}
        <PathOverlay X={X} Y={Y} hover={hover && (tool === 'pen') ? toDoc(hover.x, hover.y) : null} />
        {cropOverlay}
        {symmetry && ['brush', 'pencil', 'eraser', 'mixer'].includes(tool) && doc.open && (() => {
          // Ejes de la simetría (como la ruta de simetría de Photoshop).
          const n = symmetry.type === 'radial' || symmetry.type === 'mandala' ? symmetry.segments : symmetry.type === 'dual' ? 2 : 1;
          const base = (symmetry.angle * Math.PI) / 180 + (symmetry.type === 'vertical' || symmetry.type === 'dual' ? Math.PI / 2 : symmetry.type === 'diagonal' ? Math.PI / 4 : 0);
          const L = Math.hypot(doc.width, doc.height);
          const lines = [];
          for (let k = 0; k < n; k++) {
            const a = base + (Math.PI * k) / n;
            const radial = symmetry.type === 'radial';
            const x0 = radial ? symmetry.cx : symmetry.cx - Math.cos(a) * L, y0 = radial ? symmetry.cy : symmetry.cy - Math.sin(a) * L;
            lines.push(<line key={k} className="sym-axis" x1={X(x0)} y1={Y(y0)} x2={X(symmetry.cx + Math.cos(radial ? a * 2 : a) * L)} y2={Y(symmetry.cy + Math.sin(radial ? a * 2 : a) * L)} />);
          }
          return <g data-testid="symmetry-axes">{lines}<circle className="sym-center" cx={X(symmetry.cx)} cy={Y(symmetry.cy)} r={4} /></g>;
        })()}
        {pcropOverlay}
        {straightenLine}
        {transformOverlay}
        {puppetOverlay}
        </g>
        {painting && hover && doc.open && !ui && !transform && (
          caps
            ? null
            : <g>
              <circle className="brush-cursor" cx={hover.x} cy={hover.y} r={r} />
              {r < 4 && <path className="brush-cursor" d={`M${hover.x - 6} ${hover.y}h12M${hover.x} ${hover.y - 6}v12`} />}
            </g>
        )}
      </svg>
      {textEdit && (rot
        ? <div className="rot-wrap" style={{ transform: `rotate(${rot}rad)`, transformOrigin: `${area.w / 2}px ${area.h / 2}px` }}><TextEditor /></div>
        : <TextEditor />)}
      {doc.open && showRulers && <Rulers width={area.w} height={area.h} />}
      {doc.open && (
        <div className="doc-tabs" role="tablist" onPointerDown={(e) => e.stopPropagation()}>
          {doc.docs.map((t) => {
            const on = t.id === doc.activeDocId;
            return (
              <div key={t.id} role="tab" aria-selected={on} className={`doc-tab ${on ? 'on' : ''}`} data-testid="doc-tab"
                title={on ? undefined : 'Clic: cambiar a este documento · suelta aquí una capa para copiarla'}
                onClick={() => engine.call('switchDoc', t.id)}
                onAuxClick={(e) => { if (e.button === 1) closeDocAsk(t.id); }}
                onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-layer-id') && !on) e.preventDefault(); }}
                onDrop={(e) => { const id = Number(e.dataTransfer.getData('text/x-layer-id')); if (id && !on) engine.call('copyLayerToDoc', t.id, id); }}>
                <span>{t.name}{on ? ` @ ${Math.round(view.zoom * 1000) / 10}% (${doc.quickMask ? 'Máscara rápida' : doc.editMask ? 'Máscara de capa' : doc.viewChannel ? ['', 'Rojo', 'Verde', 'Azul'][doc.viewChannel] : 'RGB/8'})` : ''}{t.dirty ? '*' : ''}</span>
                <button title="Cerrar (Ctrl+F4)" onClick={(e) => { e.stopPropagation(); closeDocAsk(t.id); }}><XIcon size={13} /></button>
              </div>
            );
          })}
        </div>
      )}
      {!doc.open && <Home dragOver={dragOver} />}
      {doc.open && dragOver && <div className="drop-veil">Suelta para colocar como capa (PSD: abrir)</div>}
    </main>
  );
}

function gridStep(w: number) {
  const target = w / 16;
  const steps = [8, 16, 25, 32, 50, 64, 100, 128, 200, 256, 500, 1000];
  return steps.find((s) => s >= target) ?? 1000;
}

function inside(p: Pt, r: Rect) {
  return p[0] >= r.x && p[1] >= r.y && p[0] <= r.x + r.w && p[1] <= r.y + r.h;
}

function inPoly(q: Pt[], p: Pt) {
  let c = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    if ((q[i][1] > p[1]) !== (q[j][1] > p[1]) && p[0] < ((q[j][0] - q[i][0]) * (p[1] - q[i][1])) / (q[j][1] - q[i][1]) + q[i][0]) c = !c;
  }
  return c;
}

/** Cuadro de edición de texto sobre el lienzo (el texto real se ve renderizado debajo). */
/** Termina la edición de texto en curso (Esc, Ctrl+Intro o el botón OK de la interfaz móvil). */
export function finishTextEdit() {
  const cur = useStore.getState().textEdit;
  useStore.setState({ textEdit: null });
  if (!cur || cur.layerId == null) return;
  if (!cur.text.trim()) engine.call('deleteLayer', cur.layerId);
  else engine.call('updateText', cur.layerId, { text: cur.text }, true);
}

function TextEditor() {
  const te = useStore((s) => s.textEdit)!;
  const view = useStore((s) => s.view);
  const layer = useStore((s) => s.doc.layers.find((l) => l.id === te.layerId));
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const t = layer?.text;
  if (!t) return null;
  const size = t.size * view.zoom;
  const lines = te.text.split('\n');
  const longest = Math.max(4, ...lines.map((l) => l.length));
  const box = t.box;
  const left = view.panX + te.x * view.zoom, top = box ? view.panY + t.y * view.zoom : view.panY + te.y * view.zoom - size * 0.95;
  const common: React.CSSProperties = {
    fontSize: size, lineHeight: `${size * t.lineHeight}px`, fontFamily: `"${t.font}", sans-serif`, fontWeight: t.bold ? 700 : 400,
    fontStyle: t.italic ? 'italic' : 'normal', textAlign: t.align === 'justify' ? 'justify' : t.align,
    letterSpacing: `${((t.tracking ?? 0) / 1000) * size}px`, textTransform: t.caps === 'all' ? 'uppercase' : 'none', fontVariantCaps: t.caps === 'small' ? 'small-caps' : 'normal',
    textDecoration: [t.underline ? 'underline' : '', t.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none',
  };
  return (
    <textarea
      ref={ref}
      className={`text-edit ${box ? 'box' : ''}`}
      value={te.text}
      spellCheck={false}
      style={box
        ? { ...common, left, top, width: box.w * view.zoom, height: box.h * view.zoom, whiteSpace: 'pre-wrap' }
        : {
          ...common,
          left: t.align === 'left' || t.align === 'justify' ? left : t.align === 'center' ? left - (longest * size * 0.3) : left - longest * size * 0.6,
          top, width: `${longest * 0.62 + 1}em`, height: `${lines.length * t.lineHeight + 0.3}em`,
        }}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        useStore.setState({ textEdit: { ...te, text: e.target.value } });
        if (te.layerId != null) engine.call('updateText', te.layerId, { text: e.target.value }, false);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          finishTextEdit();
        }
      }}
    />
  );
}

/** Punto del documento en el espacio (sin girar) del cuadro de recorte. */
function cropLocal(c: Rect & { angle?: number; pivot?: Pt }, p: Pt): Pt {
  if (!c.angle || !c.pivot) return p;
  const [px, py] = c.pivot, co = Math.cos(-c.angle), si = Math.sin(-c.angle);
  return [px + (p[0] - px) * co - (p[1] - py) * si, py + (p[0] - px) * si + (p[1] - py) * co];
}

/** Centro del cuadro de recorte en coordenadas de documento. */
function cropCenter(c: Rect & { angle?: number; pivot?: Pt }): Pt {
  const lc: Pt = [c.x + c.w / 2, c.y + c.h / 2];
  if (!c.angle || !c.pivot) return lc;
  const [px, py] = c.pivot, co = Math.cos(c.angle), si = Math.sin(c.angle);
  return [px + (lc[0] - px) * co - (lc[1] - py) * si, py + (lc[0] - px) * si + (lc[1] - py) * co];
}
