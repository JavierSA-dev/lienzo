import type { FromWorker, PointerMsg, ToWorker } from './types';
import EngineWorker from './worker?worker';

type Listener = (m: FromWorker) => void;

/**
 * Proxy del motor en el hilo principal. No toca píxeles: sólo envía comandos
 * y eventos de entrada al worker, y recibe estado para la interfaz.
 */
export class EngineClient {
  private worker: Worker;
  private seq = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();

  constructor() {
    this.worker = new EngineWorker();
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'reply') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error));
        return;
      }
      for (const l of this.listeners) l(m);
    };
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  send(m: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }

  attach(canvas: HTMLCanvasElement, width: number, height: number, dpr: number) {
    const off = canvas.transferControlToOffscreen();
    this.send({ type: 'init', canvas: off, width, height, dpr }, [off]);
  }

  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const transfer = args.filter((a): a is ArrayBuffer => a instanceof ArrayBuffer);
      this.send({ type: 'call', id, method, args }, transfer);
    });
  }

  pointer(m: Omit<PointerMsg, 'type'>) {
    this.send({ type: 'pointer', ...m });
  }
}

export const engine = new EngineClient();

// Acceso para pruebas automáticas y benchmarks.
(globalThis as unknown as { __lienzo: EngineClient }).__lienzo = engine;
