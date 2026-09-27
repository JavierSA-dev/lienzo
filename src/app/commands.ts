import { engine } from '../engine/client';
import { useStore, toRgba } from './store';
import type { ToolId } from '../engine/types';

/**
 * Registro único de comandos: lo usan los menús, los atajos y, más adelante,
 * la paleta de comandos, las acciones grabadas y el asistente de IA.
 */
export interface Command {
  id: string;
  label: string;
  keys?: string;          // p. ej. "Ctrl+Shift+N"
  needsDoc?: boolean;
  run: () => unknown;
}

const S = () => useStore.getState();
const hasSel = () => !!S().doc.selection;

const OPEN_TYPES = '.psd,.psb,.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif';

export async function openFile(file?: File) {
  const f = file ?? (await pickFile());
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    const r = await engine.call<{ layers: number; ms: number }>('open', f.name, buf, f.type);
    S().toast(`${f.name}: ${r.layers} capa${r.layers === 1 ? '' : 's'} en ${Math.round(r.ms)} ms`);
  } catch (e) {
    S().toast(`No se pudo abrir ${f.name}: ${(e as Error).message}`, 'error');
  }
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = OPEN_TYPES;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const baseName = () => S().doc.name.replace(/\.[^.]+$/, '') || 'imagen';

export async function savePsd() {
  const bytes = await engine.call<Uint8Array>('savePsd');
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/vnd.adobe.photoshop' });
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: `${baseName()}.psd`, types: [{ description: 'Photoshop', accept: { 'image/vnd.adobe.photoshop': ['.psd'] } }] });
      const s = await h.createWritable();
      await s.write(blob);
      await s.close();
      S().toast('Guardado como PSD');
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  download(blob, `${baseName()}.psd`);
}

export async function exportImage(type: 'image/png' | 'image/jpeg' | 'image/webp', quality = 0.92) {
  const blob = await engine.call<Blob>('exportImage', type, quality);
  download(blob, `${baseName()}.${type.split('/')[1].replace('jpeg', 'jpg')}`);
}

const tool = (t: ToolId) => () => S().setTool(t);
const call = (method: string, ...args: unknown[]) => () => engine.call(method, ...args);

export const COMMANDS: Command[] = [
  // Archivo
  { id: 'file.new', label: 'Nuevo…', keys: 'Alt+N', run: () => S().setDialog('new') },
  { id: 'file.open', label: 'Abrir…', keys: 'Ctrl+O', run: () => openFile() },
  { id: 'file.save', label: 'Guardar como PSD', keys: 'Ctrl+S', needsDoc: true, run: savePsd },
  { id: 'file.quickPng', label: 'Exportación rápida como PNG', keys: 'Ctrl+Shift+Alt+S', needsDoc: true, run: () => exportImage('image/png') },
  { id: 'file.export', label: 'Exportar como…', keys: 'Ctrl+Alt+Shift+W', needsDoc: true, run: () => S().setDialog('export') },
  { id: 'file.close', label: 'Cerrar', keys: 'Alt+W', needsDoc: true, run: call('closeDoc') },
  // Edición
  { id: 'edit.undo', label: 'Deshacer', keys: 'Ctrl+Z', needsDoc: true, run: call('undo') },
  { id: 'edit.redo', label: 'Rehacer', keys: 'Ctrl+Shift+Z', needsDoc: true, run: call('redo') },
  { id: 'edit.fillFg', label: 'Rellenar con color frontal', keys: 'Alt+Backspace', needsDoc: true, run: call('fill', 'fg') },
  { id: 'edit.fillBg', label: 'Rellenar con color de fondo', keys: 'Ctrl+Backspace', needsDoc: true, run: call('fill', 'bg') },
  { id: 'edit.clear', label: 'Borrar', keys: 'Delete', needsDoc: true, run: () => (hasSel() ? engine.call('clear') : undefined) },
  // Imagen
  { id: 'image.size', label: 'Tamaño de imagen…', keys: 'Ctrl+Alt+I', needsDoc: true, run: () => S().setDialog('imageSize') },
  { id: 'image.brightness', label: 'Brillo/Contraste…', needsDoc: true, run: () => S().setDialog('brightness') },
  { id: 'image.invert', label: 'Invertir', keys: 'Ctrl+I', needsDoc: true, run: call('adjust', 'invert') },
  { id: 'image.desaturate', label: 'Desaturar', keys: 'Ctrl+Shift+U', needsDoc: true, run: call('adjust', 'desaturate') },
  // Capa
  { id: 'layer.new', label: 'Nueva capa', keys: 'Ctrl+Shift+N', needsDoc: true, run: call('newLayer') },
  { id: 'layer.duplicate', label: 'Duplicar capa', keys: 'Ctrl+J', needsDoc: true, run: call('duplicateLayer') },
  { id: 'layer.delete', label: 'Eliminar capa', needsDoc: true, run: call('deleteLayer') },
  { id: 'layer.mergeDown', label: 'Combinar hacia abajo', keys: 'Ctrl+E', needsDoc: true, run: call('mergeDown') },
  { id: 'layer.flatten', label: 'Acoplar imagen', needsDoc: true, run: call('flattenImage') },
  // Selección
  { id: 'select.all', label: 'Todo', keys: 'Ctrl+A', needsDoc: true, run: call('selectAll') },
  { id: 'select.none', label: 'Deseleccionar', keys: 'Ctrl+D', needsDoc: true, run: call('deselect') },
  // Vista
  { id: 'view.zoomIn', label: 'Acercar', keys: 'Ctrl++', needsDoc: true, run: call('zoomIn') },
  { id: 'view.zoomOut', label: 'Alejar', keys: 'Ctrl+-', needsDoc: true, run: call('zoomOut') },
  { id: 'view.fit', label: 'Encajar en pantalla', keys: 'Ctrl+0', needsDoc: true, run: call('fit', false) },
  { id: 'view.actual', label: '100 %', keys: 'Ctrl+1', needsDoc: true, run: call('actualPixels') },
  { id: 'view.panels', label: 'Mostrar/ocultar paneles', keys: 'Tab', run: () => useStore.setState({ panelsHidden: !S().panelsHidden }) },
  // Herramientas
  { id: 'tool.move', label: 'Mover', keys: 'V', run: tool('move') },
  { id: 'tool.marquee', label: 'Marco rectangular', keys: 'M', run: tool('marquee') },
  { id: 'tool.eyedropper', label: 'Cuentagotas', keys: 'I', run: tool('eyedropper') },
  { id: 'tool.brush', label: 'Pincel', keys: 'B', run: tool('brush') },
  { id: 'tool.eraser', label: 'Borrador', keys: 'E', run: tool('eraser') },
  { id: 'tool.hand', label: 'Mano', keys: 'H', run: tool('hand') },
  { id: 'tool.zoom', label: 'Zoom', keys: 'Z', run: tool('zoom') },
  // Pincel y color
  { id: 'brush.smaller', label: 'Reducir pincel', keys: '[', run: () => S().setBrush({ size: S().brush.size * 0.9 - 1 }) },
  { id: 'brush.bigger', label: 'Aumentar pincel', keys: ']', run: () => S().setBrush({ size: S().brush.size * 1.1 + 1 }) },
  { id: 'brush.softer', label: 'Reducir dureza', keys: 'Shift+[', run: () => S().setBrush({ hardness: S().brush.hardness - 0.25 }) },
  { id: 'brush.harder', label: 'Aumentar dureza', keys: 'Shift+]', run: () => S().setBrush({ hardness: S().brush.hardness + 0.25 }) },
  { id: 'color.default', label: 'Colores por defecto', keys: 'D', run: () => S().setColors('#000000', '#ffffff') },
  { id: 'color.swap', label: 'Intercambiar colores', keys: 'X', run: () => S().setColors(S().bg, S().fg) },
];

export const commandById = Object.fromEntries(COMMANDS.map((c) => [c.id, c])) as Record<string, Command>;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function formatKeys(keys?: string) {
  if (!keys) return '';
  return isMac ? keys.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧') : keys;
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Equal: '+', NumpadAdd: '+', Minus: '-', NumpadSubtract: '-',
  Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Space: 'Space', Escape: 'Escape',
};

/** Convierte un evento de teclado en la forma "Ctrl+Shift+N". */
export function comboOf(e: KeyboardEvent): string {
  let k = CODE_KEYS[e.code];
  if (!k) {
    if (e.code.startsWith('Key')) k = e.code.slice(3);
    else if (e.code.startsWith('Digit')) k = e.code.slice(5);
    else if (e.code.startsWith('Numpad') && /\d$/.test(e.code)) k = e.code.slice(6);
    else k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}

const normalize = (keys: string) => {
  const p = keys.split('+').filter(Boolean);
  const key = keys.endsWith('++') ? '+' : p[p.length - 1];
  const mods = ['Ctrl', 'Alt', 'Shift'].filter((m) => p.includes(m));
  return [...mods, key].join('+');
};

const BY_COMBO = new Map(COMMANDS.filter((c) => c.keys).map((c) => [normalize(c.keys!), c]));

export function commandForEvent(e: KeyboardEvent): Command | undefined {
  return BY_COMBO.get(comboOf(e));
}

/** Números 1-0 ajustan la opacidad de la herramienta, como en Photoshop. */
export function opacityFromDigit(e: KeyboardEvent): number | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  const m = /^Digit(\d)$/.exec(e.code);
  if (!m) return null;
  const d = Number(m[1]);
  return d === 0 ? 1 : d / 10;
}

export { toRgba };
