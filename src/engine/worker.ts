/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from './types';
import { Engine } from './engine';

declare const self: DedicatedWorkerGlobalScope;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);
let engine: Engine | null = null;

// Métodos que la interfaz puede invocar por RPC.
const ALLOWED = new Set([
  'newDoc', 'open', 'placeImage', 'closeDoc', 'undo', 'redo', 'jumpHistory', 'toggleLastState',
  'newLayer', 'layerVia', 'duplicateLayer', 'deleteLayer', 'selectLayer', 'selectLayerRelative', 'setLayer', 'soloLayer',
  'moveLayer', 'moveLayerTo', 'arrange', 'groupLayers', 'ungroupLayers', 'toggleClip', 'setCollapsed', 'mergeDown', 'mergeVisible', 'stampVisible', 'flattenImage', 'rasterizeLayer',
  'newAdjustmentLayer', 'setAdjustment', 'addMask', 'deleteMask', 'setEditMask', 'loadSelectionFromLayer',
  'selectAll', 'deselect', 'reselect', 'invertSelection', 'selectShape', 'selectPolygon', 'magicWand',
  'featherSelection', 'growSelection', 'moveSelectionBy', 'fill', 'clear', 'copy', 'paste',
  'resizeImage', 'canvasSize', 'crop', 'cropToSelection', 'rotateCanvas', 'flipCanvas', 'applyAdjustment', 'adjust',
  'applyFilter', 'repeatFilter', 'endPreview', 'restorePreview', 'commitFilterPreview', 'applyGradient', 'bucketFill', 'createText', 'updateText', 'hitText',
  'createShape', 'updateShape', 'setEffects', 'beginTransform', 'updateTransform', 'cancelTransform', 'commitTransform',
  'transformLayer', 'liquifySource', 'applyLiquify', 'removeBackground', 'contentAwareFill', 'selectPath', 'shapeFromPath', 'fillPath', 'strokePath', 'selectSubject', 'generativeInput', 'placeGenerated',
  'setTool', 'setBrush', 'setColors', 'setAutoSelect', 'moveLayerBy', 'fit', 'exportImage', 'savePsd',
  'zoomIn', 'zoomOut', 'zoomTo', 'zoomAtPoint', 'actualPixels',
  'stats', 'debugPixel', 'debugLayerPixel', 'debugSelection', 'debugStroke', 'debugComposeAll', 'debugFlushEffects',
]);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init':
        engine = new Engine(m.canvas, m.width, m.height, m.dpr, post, new URL(import.meta.env.BASE_URL, self.location.origin).href);
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
        const transfer: Transferable[] = value instanceof Uint8Array && value.buffer instanceof ArrayBuffer ? [value.buffer]
          : value && typeof value === 'object' && 'data' in value && (value as { data: unknown }).data instanceof Uint8ClampedArray ? [((value as { data: Uint8ClampedArray }).data.buffer as ArrayBuffer)] : [];
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
