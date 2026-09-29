// Gestos táctiles del lienzo, como en Procreate y Photoshop para iPad:
// - un dedo usa la herramienta (con un pequeño margen para distinguirlo de un gesto);
// - dos dedos: pellizcar para hacer zoom y arrastrar para desplazar;
// - toque con dos dedos = deshacer, con tres = rehacer;
// - mantener pulsado con una herramienta de pintura = cuentagotas;
// - si se usa un lápiz, los dedos ya no pintan (rechazo de la palma): solo desplazan y hacen gestos.
import { engine } from '../engine/client';
import { useStore, toHex } from './store';
import { isPaintTool } from './commands';
import type { RGBA } from '../engine/types';

type PE = React.PointerEvent;
interface Handlers {
  down: (e: PE) => void;
  move: (e: PE) => void;
  up: (e: PE) => void;
  /** Rectángulo del área del lienzo (para pasar a coordenadas locales). */
  rect: () => DOMRect;
  /** Punto de pantalla (local) → documento. */
  toDoc: (x: number, y: number) => [number, number];
}

interface Finger { x: number; y: number; x0: number; y0: number }

const MOVE_SLOP = 8;          // px antes de considerar que el dedo se mueve
const HOLD_MS = 500;          // mantener pulsado = cuentagotas
const START_MS = 90;          // margen para detectar un segundo dedo (herramientas que no pintan)
const TAP_MS = 320;           // duración máxima de un toque de deshacer/rehacer

export class TouchGestures {
  private fingers = new Map<number, Finger>();
  private mode: 'idle' | 'pending' | 'single' | 'gesture' | 'pan' | 'held' = 'idle';
  private pending: PE | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private singleId = -1;
  private startTarget: EventTarget | null = null;
  private histAtStart = 0;
  private t0 = 0;
  private maxFingers = 0;
  private moved = false;
  private g: { zoom: number; panX: number; panY: number; mid: [number, number]; dist: number } | null = null;
  private panLast: [number, number] | null = null;
  /** Se ha usado un lápiz: los dedos dejan de pintar. */
  penSeen = false;

  constructor(private h: Handlers) {}

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.h.rect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  /** Devuelve true si el evento lo gestiona el sistema de gestos (no debe seguir al manejador normal). */
  onDown(e: PE): boolean {
    if (e.pointerType === 'pen') { this.penSeen = true; return false; }
    if (e.pointerType !== 'touch') return false;
    e.preventDefault();
    const [x, y] = this.local(e);
    this.fingers.set(e.pointerId, { x, y, x0: x, y0: y });
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* ya no existe */ }
    this.maxFingers = Math.max(this.maxFingers, this.fingers.size);

    if (this.fingers.size === 1) {
      this.t0 = performance.now();
      this.maxFingers = 1;
      this.moved = false;
      const s = useStore.getState();
      // Con lápiz, un dedo desplaza el lienzo.
      if (this.penSeen || s.tool === 'hand') { this.mode = 'pan'; this.panLast = [x, y]; return true; }
      this.mode = 'pending';
      this.pending = e;
      this.singleId = e.pointerId;
      const paint = isPaintTool(s.tool);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.mode !== 'pending') return;
        if (paint) this.hold(); else this.start();
      }, paint ? HOLD_MS : START_MS);
      return true;
    }

    // Segundo (o tercer) dedo: gesto.
    this.clearTimer();
    if (this.mode === 'single') this.abortSingle();
    this.pending = null;
    this.mode = 'gesture';
    this.beginPinch();
    return true;
  }

  onMove(e: PE): boolean {
    if (e.pointerType !== 'touch') return false;
    const f = this.fingers.get(e.pointerId);
    if (!f) return this.mode !== 'idle';
    const [x, y] = this.local(e);
    f.x = x; f.y = y;
    if (Math.hypot(x - f.x0, y - f.y0) > MOVE_SLOP) this.moved = true;
    switch (this.mode) {
      case 'pending':
        if (this.moved) { this.clearTimer(); this.start(); this.h.move(e); }
        return true;
      case 'single':
        if (e.pointerId === this.singleId) this.h.move(e);
        return true;
      case 'gesture': this.pinch(); return true;
      case 'pan': {
        if (this.panLast) {
          const v = useStore.getState().view;
          engine.call('viewTo', v.zoom, v.panX + (x - this.panLast[0]), v.panY + (y - this.panLast[1]));
          useStore.setState({ view: { ...v, panX: v.panX + (x - this.panLast[0]), panY: v.panY + (y - this.panLast[1]) } });
        }
        this.panLast = [x, y];
        return true;
      }
      default: return true;
    }
  }

  onUp(e: PE): boolean {
    if (e.pointerType !== 'touch') return false;
    if (!this.fingers.has(e.pointerId)) return this.mode !== 'idle';
    this.fingers.delete(e.pointerId);
    switch (this.mode) {
      case 'pending':
        // Toque corto: se aplica la herramienta en ese punto (un punto de pincel, un clic…).
        this.clearTimer();
        this.start();
        this.h.up(e);
        break;
      case 'single':
        if (e.pointerId === this.singleId) this.h.up(e);
        break;
      case 'gesture':
        if (this.fingers.size >= 2) this.beginPinch();
        if (this.fingers.size === 0) {
          const quick = performance.now() - this.t0 < TAP_MS + 150 * (this.maxFingers - 2);
          if (quick && !this.moved) {
            if (this.maxFingers === 2) engine.call('undo');
            else if (this.maxFingers >= 3) engine.call('redo');
          }
        }
        break;
      default: break;
    }
    if (this.fingers.size === 0) { this.mode = 'idle'; this.pending = null; this.g = null; this.panLast = null; }
    return true;
  }

  /** Empieza de verdad el uso de la herramienta con el evento del primer dedo. */
  private start() {
    if (!this.pending) return;
    this.histAtStart = useStore.getState().doc.historyIndex;
    this.mode = 'single';
    const ev = this.pending;
    this.pending = null;
    this.startTarget = ev.target;
    this.h.down(ev);
  }

  /** Si ya se había empezado a pintar y llega otro dedo, el trazo se descarta. */
  private abortSingle() {
    const f = this.fingers.get(this.singleId);
    const r = this.h.rect();
    const fake = { pointerId: this.singleId, pointerType: 'touch', button: 0, clientX: (f?.x ?? 0) + r.left, clientY: (f?.y ?? 0) + r.top,
      pressure: 0.5, timeStamp: performance.now(), altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
      target: this.startTarget, currentTarget: this.startTarget, nativeEvent: {}, preventDefault() { /* nada */ }, stopPropagation() { /* nada */ } } as unknown as PE;
    this.h.up(fake);
    const before = this.histAtStart;
    // El trazo tarda un instante en registrarse en el historial.
    setTimeout(() => { if (useStore.getState().doc.historyIndex > before) engine.call('undo'); }, 120);
    this.mode = 'gesture';
  }

  /** Mantener pulsado: cuentagotas (color frontal). */
  private async hold() {
    const e = this.pending;
    if (!e) return;
    this.mode = 'held';
    this.pending = null;
    const [x, y] = this.local(e);
    const [dx, dy] = this.h.toDoc(x, y);
    const c = await engine.call<RGBA | null>('pickColor', dx, dy);
    if (c) {
      const s = useStore.getState();
      s.setColors(toHex(c), s.bg);
      s.toast(`Color: ${toHex(c)}`);
    }
  }

  private two(): [Finger, Finger] | null {
    const fs = [...this.fingers.values()];
    return fs.length >= 2 ? [fs[0], fs[1]] : null;
  }

  /** Pantalla sin la rotación de la vista (que gira alrededor del centro del área). */
  private unrot(x: number, y: number): [number, number] {
    const rot = useStore.getState().view.rot ?? 0;
    if (!rot) return [x, y];
    const r = this.h.rect(), cx = r.width / 2, cy = r.height / 2, c = Math.cos(-rot), s = Math.sin(-rot);
    return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  }

  private beginPinch() {
    const t = this.two();
    if (!t) { this.g = null; return; }
    const v = useStore.getState().view;
    const mid = this.unrot((t[0].x + t[1].x) / 2, (t[0].y + t[1].y) / 2);
    this.g = { zoom: v.zoom, panX: v.panX, panY: v.panY, mid, dist: Math.max(1, Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y)) };
  }

  private pinch() {
    const t = this.two();
    const g = this.g;
    if (!t || !g) return;
    const mid = this.unrot((t[0].x + t[1].x) / 2, (t[0].y + t[1].y) / 2);
    const dist = Math.max(1, Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y));
    const zoom = Math.min(64, Math.max(0.005, g.zoom * (dist / g.dist)));
    // El punto del documento bajo el centro de los dedos se queda bajo ellos.
    const docX = (g.mid[0] - g.panX) / g.zoom, docY = (g.mid[1] - g.panY) / g.zoom;
    const panX = mid[0] - docX * zoom, panY = mid[1] - docY * zoom;
    const v = useStore.getState().view;
    useStore.setState({ view: { ...v, zoom, panX, panY } });
    engine.call('viewTo', zoom, panX, panY);
  }
}
