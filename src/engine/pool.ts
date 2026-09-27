import type { BandJob } from './resample';
import { resampleBand } from './resample';

/**
 * Pool de workers para cálculo intensivo en CPU (redimensionar; más adelante filtros).
 * Usa todos los núcleos menos uno. Si el navegador no permite workers anidados,
 * calcula en el propio worker del motor.
 */
export class Pool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: BandJob; resolve: (v: Uint8ClampedArray) => void; reject: (e: unknown) => void }[] = [];
  private callbacks = new Map<Worker, { resolve: (v: Uint8ClampedArray) => void; reject: (e: unknown) => void }>();
  readonly size: number;
  private available = true;

  constructor() {
    const cores = (globalThis.navigator?.hardwareConcurrency as number | undefined) ?? 4;
    this.size = Math.max(1, Math.min(12, cores - 1));
  }

  private spawn() {
    if (this.workers.length || !this.available) return;
    try {
      for (let i = 0; i < this.size; i++) {
        const w = new Worker(new URL('./pool.worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<{ out: Uint8ClampedArray }>) => {
          const cb = this.callbacks.get(w);
          this.callbacks.delete(w);
          cb?.resolve(e.data.out);
          this.release(w);
        };
        w.onerror = (e) => {
          const cb = this.callbacks.get(w);
          this.callbacks.delete(w);
          cb?.reject(e);
          this.release(w);
        };
        this.workers.push(w);
        this.idle.push(w);
      }
    } catch {
      this.available = false;
    }
  }

  private release(w: Worker) {
    const next = this.queue.shift();
    if (next) this.dispatch(w, next);
    else this.idle.push(w);
  }

  private dispatch(w: Worker, t: (typeof this.queue)[number]) {
    this.callbacks.set(w, { resolve: t.resolve, reject: t.reject });
    w.postMessage(t.job, [t.job.slice.buffer]);
  }

  resample(job: BandJob): Promise<Uint8ClampedArray> {
    this.spawn();
    if (!this.available) return Promise.resolve(resampleBand(job));
    return new Promise((resolve, reject) => {
      const t = { job, resolve, reject };
      const w = this.idle.pop();
      if (w) this.dispatch(w, t);
      else this.queue.push(t);
    });
  }
}
