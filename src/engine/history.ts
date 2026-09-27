import { TILE_BYTES, type EditorDocument, type PixelLayer } from './document';

/**
 * Historial por deltas: cada paso guarda sólo lo que cambió.
 * - Pasos de píxeles: los tiles afectados (se intercambian al deshacer/rehacer).
 * - Pasos estructurales: funciones undo/redo.
 */
export interface HistoryEntry {
  label: string;
  bytes: number;
  undo(doc: EditorDocument): void;
  redo(doc: EditorDocument): void;
}

/** Guarda el estado previo de tiles de una capa antes de modificarlos. */
export class TilePatch implements HistoryEntry {
  label: string;
  layerId: number;
  /** Contenido "del otro estado": al aplicar se intercambia con el actual. */
  saved = new Map<number, Uint8ClampedArray | null>();
  bytes = 0;

  constructor(label: string, layer: PixelLayer) {
    this.label = label;
    this.layerId = layer.id;
  }

  /** Llamar ANTES de modificar el tile k por primera vez en este paso. */
  capture(layer: PixelLayer, k: number) {
    if (this.saved.has(k)) return;
    const t = layer.getTile(k);
    this.saved.set(k, t ? t.slice() : null);
    if (t) this.bytes += TILE_BYTES;
  }

  has(k: number) {
    return this.saved.has(k);
  }

  private swap(doc: EditorDocument) {
    const layer = doc.layer(this.layerId);
    if (!layer) return;
    for (const [k, other] of this.saved) {
      const cur = layer.getTile(k) ?? null;
      layer.setTile(k, other);
      this.saved.set(k, cur);
    }
  }

  undo(doc: EditorDocument) { this.swap(doc); }
  redo(doc: EditorDocument) { this.swap(doc); }
}

export class FnEntry implements HistoryEntry {
  label: string;
  bytes: number;
  undo: (doc: EditorDocument) => void;
  redo: (doc: EditorDocument) => void;
  constructor(label: string, undo: (d: EditorDocument) => void, redo: (d: EditorDocument) => void, bytes = 0) {
    this.label = label;
    this.undo = undo;
    this.redo = redo;
    this.bytes = bytes;
  }
}

/** Varios pasos agrupados en uno (p. ej. redimensionar todas las capas). */
export class GroupEntry implements HistoryEntry {
  label: string;
  entries: HistoryEntry[];
  constructor(label: string, entries: HistoryEntry[]) {
    this.label = label;
    this.entries = entries;
  }
  get bytes() { return this.entries.reduce((a, e) => a + e.bytes, 0); }
  undo(doc: EditorDocument) { for (let i = this.entries.length - 1; i >= 0; i--) this.entries[i].undo(doc); }
  redo(doc: EditorDocument) { for (const e of this.entries) e.redo(doc); }
}

export class History {
  entries: HistoryEntry[] = [];
  /** Número de pasos aplicados (0 = estado inicial). */
  index = 0;
  maxSteps = 50;
  maxBytes = 1024 * 1024 * 1024; // 1 GB

  push(e: HistoryEntry) {
    this.entries.length = this.index; // descarta los pasos rehacer
    this.entries.push(e);
    this.index = this.entries.length;
    let total = this.entries.reduce((a, x) => a + x.bytes, 0);
    while (this.entries.length > 1 && (this.entries.length > this.maxSteps || total > this.maxBytes)) {
      total -= this.entries[0].bytes;
      this.entries.shift();
      this.index--;
    }
  }

  canUndo() { return this.index > 0; }
  canRedo() { return this.index < this.entries.length; }

  undo(doc: EditorDocument): boolean {
    if (!this.canUndo()) return false;
    this.entries[--this.index].undo(doc);
    return true;
  }

  redo(doc: EditorDocument): boolean {
    if (!this.canRedo()) return false;
    this.entries[this.index++].redo(doc);
    return true;
  }

  /** Salta a un estado del panel Historial (0 = apertura). */
  jump(doc: EditorDocument, target: number) {
    while (this.index > target && this.undo(doc));
    while (this.index < target && this.redo(doc));
  }

  clear() {
    this.entries = [];
    this.index = 0;
  }
}
