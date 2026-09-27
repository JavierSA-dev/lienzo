import { runJob, type PoolJob } from './filters';

/**
 * Pool de workers para cálculo intensivo en CPU (redimensionar, filtros,
 * transformar, licuar). Usa todos los núcleos menos uno. Si el navegador no
 * permite workers anidados, calcula en el propio worker del motor.
 */
export class Pool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: PoolJob; resolve: (v: Uint8ClampedArray) => void; reject: (e: unknown) => void }[] = [];
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
        w.onmessage = (e: MessageEvent<{ out: Uint8ClampedArray; error?: string }>) => {
          const cb = this.callbacks.get(w);
          this.callbacks.delete(w);
          if (e.data.error) cb?.reject(new Error(e.data.error)); else cb?.resolve(e.data.out);
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
    const transfer: Transferable[] = [];
    const j = t.job as unknown as Record<string, unknown>;
    for (const key of ['slice', 'src', 'field']) {
      const v = j[key] as ArrayBufferView | undefined;
      // Los SharedArrayBuffer se comparten, no se transfieren.
      if (v && v.buffer instanceof ArrayBuffer && !transfer.includes(v.buffer)) transfer.push(v.buffer);
    }
    w.postMessage(t.job, transfer);
  }

  run(job: PoolJob): Promise<Uint8ClampedArray> {
    this.spawn();
    if (!this.available) return Promise.resolve(runJob(job));
    return new Promise((resolve, reject) => {
      const t = { job, resolve, reject };
      const w = this.idle.pop();
      if (w) this.dispatch(w, t);
      else this.queue.push(t);
    });
  }

  /** Compatibilidad: remuestreo por bandas. */
  resample(job: Omit<Extract<PoolJob, { op: 'resample' }>, 'op'>): Promise<Uint8ClampedArray> {
    return this.run({ op: 'resample', ...job });
  }
}

/** Copia datos a un SharedArrayBuffer (si está disponible) para compartirlos entre workers sin copias. */
export function shareable(data: Uint8ClampedArray): Uint8ClampedArray {
  if (typeof SharedArrayBuffer === 'undefined' || !(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) return data;
  const sab = new SharedArrayBuffer(data.byteLength);
  const out = new Uint8ClampedArray(sab);
  out.set(data);
  return out;
}
