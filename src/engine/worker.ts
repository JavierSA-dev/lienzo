/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from './types';
import { Engine } from './engine';

declare const self: DedicatedWorkerGlobalScope;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);
let engine: Engine | null = null;

// Métodos que la interfaz puede invocar por RPC.
const ALLOWED = new Set([
  'newDoc', 'open', 'closeDoc', 'undo', 'redo', 'jumpHistory',
  'newLayer', 'duplicateLayer', 'deleteLayer', 'selectLayer', 'setLayer', 'moveLayer', 'mergeDown', 'flattenImage',
  'selectAll', 'deselect', 'fill', 'clear', 'resizeImage', 'adjust',
  'setTool', 'setBrush', 'setColors', 'fit', 'exportImage', 'savePsd',
  'stats', 'debugPixel', 'debugStroke', 'debugComposeAll', 'zoomIn', 'zoomOut', 'zoomTo', 'actualPixels',
]);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init':
        engine = new Engine(m.canvas, m.width, m.height, m.dpr, post);
        return;
      case 'resize':
        engine?.resize(m.width, m.height, m.dpr);
        return;
      case 'pointer':
        engine?.pointer(m);
        return;
      case 'wheel':
        engine?.wheel(m.x, m.y, m.dx, m.dy, m.zoom);
        return;
      case 'hover':
        return;
      case 'call': {
        if (!engine || !ALLOWED.has(m.method)) throw new Error(`Método no disponible: ${m.method}`);
        const fn = (engine as unknown as Record<string, (...a: unknown[]) => unknown>)[m.method];
        const value = await fn.apply(engine, m.args);
        const transfer: Transferable[] = value instanceof Uint8Array ? [value.buffer] : [];
        post({ type: 'reply', id: m.id, ok: true, value }, transfer);
        return;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[motor]', err);
    if (m.type === 'call') post({ type: 'reply', id: m.id, ok: false, error: msg });
    else post({ type: 'toast', kind: 'error', text: msg });
  }
};
