import { engine } from '../engine/client';
import { useStore, toRgba, savePrefs, type DialogId } from './store';
import type { AdjustmentType, BlendMode, ShapeKind, ToolId } from '../engine/types';
import { BLEND_MODES, BLEND_GROUPS } from '../engine/types';

const BLEND_LABEL = Object.fromEntries(BLEND_GROUPS.flat().map((b) => [b.id, b.label]));

/**
 * Registro único de comandos: lo usan los menús, los atajos, la paleta de
 * comandos, las acciones grabadas y el asistente. Atajos = los de Photoshop (Windows).
 */
export interface Command {
  id: string;
  label: string;
  /** Combinaciones de teclas; la primera es la que se muestra. */
  keys?: string[];
  needsDoc?: boolean;
  /** Se puede grabar en una acción. */
  rec?: boolean;
  /** Opción activable: el menú muestra una marca cuando está activa. */
  checked?: () => boolean;
  run: () => unknown;
}

const S = () => useStore.getState();
const call = (method: string, ...args: unknown[]) => () => engine.call(method, ...args);
const dlg = (d: DialogId) => () => S().setDialog(d);

// ------------------------------------------------------------------ archivos

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

export async function placeFile(file?: File) {
  const f = file ?? (await pickFile('image/*'));
  if (!f) return;
  await engine.call('placeImage', f.name, await f.arrayBuffer(), f.type || 'image/png', null);
}

function pickFile(accept = OPEN_TYPES): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
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

/** Cerrar una pestaña: si tiene cambios sin guardar, pregunta (como Photoshop). */
export function closeDocAsk(id?: number) {
  const d = S().doc;
  const target = id ?? d.activeDocId;
  const tab = d.docs.find((x) => x.id === target);
  if (!tab) return;
  if (tab.dirty) S().setDialog({ kind: 'confirmClose', docId: target });
  else engine.call('closeDoc', target);
}

export async function savePsd(psb = false): Promise<boolean> {
  const bytes = await engine.call<Uint8Array>('savePsd', psb);
  const ext = psb ? 'psb' : 'psd';
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/vnd.adobe.photoshop' });
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: `${baseName()}.${ext}`, types: [{ description: 'Photoshop', accept: { 'image/vnd.adobe.photoshop': [`.${ext}`] } }] });
      const s = await h.createWritable();
      await s.write(blob);
      await s.close();
      S().toast(`Guardado como ${ext.toUpperCase()}`);
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
    }
  }
  download(blob, `${baseName()}.${ext}`);
  return true;
}

export async function exportImage(type: 'image/png' | 'image/jpeg' | 'image/webp', quality = 0.92) {
  const blob = await engine.call<Blob>('exportImage', type, quality);
  download(blob, `${baseName()}.${type.split('/')[1].replace('jpeg', 'jpg')}`);
}

async function copyToClipboard(merged: boolean, cut = false) {
  const blobPromise = engine.call<Blob | null>('copy', merged, cut);
  try {
    // ClipboardItem acepta una promesa: conserva el gesto del usuario.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise.then((b) => b ?? new Blob()) })]);
  } catch {
    await blobPromise; // se queda en el portapapeles interno
  }
}

// ------------------------------------------------------------------ herramientas

/** Grupos de herramientas con su letra (Mayús+letra recorre el grupo). */
export const TOOL_GROUPS: { key: string; tools: ToolId[] }[] = [
  { key: 'V', tools: ['move'] },
  { key: 'M', tools: ['marquee', 'marqueeEllipse'] },
  { key: 'L', tools: ['lasso', 'polylasso'] },
  { key: 'W', tools: ['wand'] },
  { key: 'C', tools: ['crop'] },
  { key: 'I', tools: ['eyedropper'] },
  { key: 'J', tools: ['spotHeal', 'heal', 'patch', 'redEye'] },
  { key: 'B', tools: ['brush', 'pencil'] },
  { key: 'S', tools: ['clone'] },
  { key: 'Y', tools: ['historyBrush'] },
  { key: 'E', tools: ['eraser'] },
  { key: 'G', tools: ['gradient', 'bucket'] },
  { key: '_R', tools: ['blur', 'sharpen', 'smudge'] },
  { key: 'O', tools: ['dodge', 'burn'] },
  { key: 'P', tools: ['pen'] },
  { key: 'T', tools: ['text'] },
  { key: 'A', tools: ['pathSelect'] },
  { key: 'U', tools: ['shape'] },
  { key: 'H', tools: ['hand', 'rotateView'] },
  { key: 'Z', tools: ['zoom'] },
];

export const TOOL_NAMES: Record<ToolId, string> = {
  move: 'Mover', marquee: 'Marco rectangular', marqueeEllipse: 'Marco elíptico', lasso: 'Lazo', polylasso: 'Lazo poligonal',
  wand: 'Varita mágica', crop: 'Recortar', eyedropper: 'Cuentagotas', brush: 'Pincel', pencil: 'Lápiz', clone: 'Tampón de clonar',
  eraser: 'Borrador', gradient: 'Degradado', bucket: 'Bote de pintura', dodge: 'Sobreexponer', burn: 'Subexponer',
  text: 'Texto horizontal', shape: 'Forma', hand: 'Mano', zoom: 'Zoom',
  spotHeal: 'Pincel corrector puntual', heal: 'Pincel corrector', patch: 'Parche', pen: 'Pluma', pathSelect: 'Selección de trazado',
  blur: 'Desenfocar', sharpen: 'Enfocar', smudge: 'Dedo', historyBrush: 'Pincel de historia', rotateView: 'Rotar vista', redEye: 'Pupilas rojas',
};

export const groupOf = (t: ToolId) => TOOL_GROUPS.find((g) => g.tools.includes(t))!;

export function selectTool(t: ToolId) {
  const s = S();
  if (s.transform || s.textEdit) return;
  const g = groupOf(t);
  useStore.setState({ groupTool: { ...s.groupTool, [g.key]: t } });
  s.setTool(t);
}

/** Letra: última herramienta usada del grupo. Mayús+letra: la siguiente del grupo. */
function toolKey(key: string, cycle: boolean) {
  const g = TOOL_GROUPS.find((x) => x.key === key)!;
  const s = S();
  if (key === 'U' && cycle && s.tool === 'shape') {
    const kinds: ShapeKind[] = ['rect', 'ellipse', 'polygon', 'line'];
    s.setOpts({ shapeKind: kinds[(kinds.indexOf(s.opts.shapeKind) + 1) % kinds.length] });
    return;
  }
  const last = s.groupTool[key] ?? g.tools[0];
  const next = cycle && g.tools.includes(s.tool) ? g.tools[(g.tools.indexOf(s.tool) + 1) % g.tools.length] : last;
  selectTool(next);
}

const PAINT_TOOLS = new Set<ToolId>(['brush', 'pencil', 'eraser', 'clone', 'dodge', 'burn', 'spotHeal', 'heal', 'blur', 'sharpen', 'smudge', 'historyBrush']);
export const isPaintTool = (t: ToolId) => PAINT_TOOLS.has(t);

// ------------------------------------------------------------------ capas

const active = () => S().doc.layers.find((l) => l.id === S().doc.activeLayerId);

function setBlend(mode: BlendMode) {
  const L = active();
  if (L) engine.call('setLayer', L.id, { blend: mode });
}

function cycleBlend(dir: 1 | -1) {
  const L = active();
  if (!L) return;
  const i = BLEND_MODES.indexOf(L.blend);
  setBlend(BLEND_MODES[(i + dir + BLEND_MODES.length) % BLEND_MODES.length]);
}

const newAdjustment = (type: AdjustmentType) => () => engine.call('newAdjustmentLayer', type);

// ------------------------------------------------------------------ vista

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      // En pantalla completa el navegador deja capturar Ctrl+N, Ctrl+T, Ctrl+W…
      const kb = (navigator as unknown as { keyboard?: { lock?: () => Promise<void> } }).keyboard;
      await kb?.lock?.().catch(() => {});
      S().toast('Pantalla completa: todos los atajos de Photoshop activos (Ctrl+T, Ctrl+N, Ctrl+W…). F o Esc para salir.');
    } else {
      await document.exitFullscreen();
    }
  } catch {
    S().toast('El navegador no permitió la pantalla completa.', 'warn');
  }
}

// ------------------------------------------------------------------ lista

export const COMMANDS: Command[] = [
  // Archivo
  { id: 'file.new', label: 'Nuevo…', keys: ['Ctrl+N', 'Ctrl+Alt+N'], run: dlg({ kind: 'new' }) },
  { id: 'file.open', label: 'Abrir…', keys: ['Ctrl+O'], run: () => openFile() },
  { id: 'file.place', label: 'Colocar incrustado…', needsDoc: true, run: () => placeFile() },
  { id: 'file.close', label: 'Cerrar', keys: ['Ctrl+W', 'Ctrl+F4'], needsDoc: true, run: () => closeDocAsk() },
  { id: 'window.nextDoc', label: 'Documento siguiente', keys: ['Ctrl+Tab', 'Ctrl+F6'], needsDoc: true, run: call('cycleDoc', 1) },
  { id: 'window.prevDoc', label: 'Documento anterior', keys: ['Ctrl+Shift+Tab', 'Ctrl+Shift+F6'], needsDoc: true, run: call('cycleDoc', -1) },
  { id: 'file.save', label: 'Guardar (PSD)', keys: ['Ctrl+S'], needsDoc: true, run: () => savePsd() },
  { id: 'file.saveAs', label: 'Guardar como…', keys: ['Ctrl+Shift+S'], needsDoc: true, run: () => savePsd() },
  { id: 'file.saveCopy', label: 'Guardar una copia…', keys: ['Ctrl+Alt+S'], needsDoc: true, run: () => savePsd() },
  { id: 'file.savePsb', label: 'Guardar como PSB (documento grande)', needsDoc: true, run: () => savePsd(true) },
  { id: 'file.quickPng', label: 'Exportación rápida como PNG', needsDoc: true, run: () => exportImage('image/png') },
  { id: 'file.export', label: 'Exportar como…', keys: ['Ctrl+Alt+Shift+W'], needsDoc: true, run: dlg({ kind: 'export' }) },
  { id: 'file.saveForWeb', label: 'Guardar para Web (heredado)…', keys: ['Ctrl+Alt+Shift+S'], needsDoc: true, run: dlg({ kind: 'export' }) },

  // Edición
  { id: 'edit.undo', label: 'Deshacer', keys: ['Ctrl+Z'], needsDoc: true, run: call('undo') },
  { id: 'edit.redo', label: 'Rehacer', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], needsDoc: true, run: call('redo') },
  { id: 'edit.toggleLast', label: 'Alternar último estado', keys: ['Ctrl+Alt+Z'], needsDoc: true, run: call('toggleLastState') },
  { id: 'edit.cut', label: 'Cortar', keys: ['Ctrl+X'], needsDoc: true, run: () => copyToClipboard(false, true) },
  { id: 'edit.copy', label: 'Copiar', keys: ['Ctrl+C'], needsDoc: true, run: () => copyToClipboard(false) },
  { id: 'edit.copyMerged', label: 'Copiar combinado', keys: ['Ctrl+Shift+C'], needsDoc: true, run: () => copyToClipboard(true) },
  { id: 'edit.paste', label: 'Pegar', keys: ['Ctrl+V'], run: () => pasteFromMenu(false) },
  { id: 'edit.pasteInPlace', label: 'Pegar en el mismo sitio', keys: ['Ctrl+Shift+V'], run: () => pasteFromMenu(true) },
  { id: 'edit.contentAware', label: 'Relleno según contenido', needsDoc: true, rec: true, run: call('contentAwareFill') },
  { id: 'edit.fill', label: 'Rellenar…', keys: ['Shift+F5', 'Shift+Backspace'], needsDoc: true, run: dlg({ kind: 'fill' }) },
  { id: 'edit.stroke', label: 'Contornear…', needsDoc: true, run: () => { if (!S().doc.selection) { S().toast('Contornear necesita una selección.', 'warn'); return; } S().setDialog({ kind: 'stroke' }); } },
  { id: 'edit.fillFg', label: 'Rellenar con color frontal', keys: ['Alt+Backspace', 'Alt+Delete'], needsDoc: true, rec: true, run: call('fill', 'fg') },
  { id: 'edit.fillBg', label: 'Rellenar con color de fondo', keys: ['Ctrl+Backspace', 'Ctrl+Delete'], needsDoc: true, rec: true, run: call('fill', 'bg') },
  { id: 'edit.fillFgPreserve', label: 'Rellenar con frontal (conservar transparencia)', keys: ['Alt+Shift+Backspace'], needsDoc: true, rec: true, run: call('fill', 'fg', true) },
  { id: 'edit.fillBgPreserve', label: 'Rellenar con fondo (conservar transparencia)', keys: ['Ctrl+Shift+Backspace'], needsDoc: true, rec: true, run: call('fill', 'bg', true) },
  { id: 'edit.clear', label: 'Borrar', keys: ['Delete', 'Backspace'], needsDoc: true, rec: true, run: () => (S().doc.selection ? engine.call('clear') : undefined) },
  { id: 'edit.freeTransform', label: 'Transformación libre', keys: ['Ctrl+T'], needsDoc: true, run: () => startTransform() },
  { id: 'edit.flipH', label: 'Voltear horizontal', needsDoc: true, rec: true, run: call('transformLayer', 'flipH') },
  { id: 'edit.flipV', label: 'Voltear vertical', needsDoc: true, rec: true, run: call('transformLayer', 'flipV') },
  { id: 'edit.rot90', label: 'Rotar 90° en sentido horario', needsDoc: true, rec: true, run: call('transformLayer', 'rot90') },
  { id: 'edit.rot-90', label: 'Rotar 90° en sentido antihorario', needsDoc: true, rec: true, run: call('transformLayer', 'rot-90') },
  { id: 'edit.rot180', label: 'Rotar 180°', needsDoc: true, rec: true, run: call('transformLayer', 'rot180') },
  { id: 'edit.shortcuts', label: 'Métodos abreviados de teclado…', keys: ['Ctrl+Alt+Shift+K'], run: dlg({ kind: 'shortcuts' }) },

  // Imagen
  { id: 'image.brightness', label: 'Brillo/Contraste…', needsDoc: true, run: dlg({ kind: 'adjust', type: 'brightness' }) },
  { id: 'image.levels', label: 'Niveles…', keys: ['Ctrl+L'], needsDoc: true, run: dlg({ kind: 'adjust', type: 'levels' }) },
  { id: 'image.curves', label: 'Curvas…', keys: ['Ctrl+M'], needsDoc: true, run: dlg({ kind: 'adjust', type: 'curves' }) },
  { id: 'image.exposure', label: 'Exposición…', needsDoc: true, run: dlg({ kind: 'adjust', type: 'exposure' }) },
  { id: 'image.vibrance', label: 'Intensidad…', needsDoc: true, run: dlg({ kind: 'adjust', type: 'vibrance' }) },
  { id: 'image.hueSat', label: 'Tono/Saturación…', keys: ['Ctrl+U'], needsDoc: true, run: dlg({ kind: 'adjust', type: 'hueSat' }) },
  { id: 'image.colorBalance', label: 'Equilibrio de color…', keys: ['Ctrl+B'], needsDoc: true, run: dlg({ kind: 'adjust', type: 'colorBalance' }) },
  { id: 'image.blackWhite', label: 'Blanco y negro…', keys: ['Ctrl+Alt+Shift+B'], needsDoc: true, run: dlg({ kind: 'adjust', type: 'blackWhite' }) },
  { id: 'image.invert', label: 'Invertir', keys: ['Ctrl+I'], needsDoc: true, rec: true, run: call('adjust', 'invert') },
  { id: 'image.posterize', label: 'Posterizar…', needsDoc: true, run: dlg({ kind: 'adjust', type: 'posterize' }) },
  { id: 'image.threshold', label: 'Umbral…', needsDoc: true, run: dlg({ kind: 'adjust', type: 'threshold' }) },
  { id: 'image.gradientMap', label: 'Mapa de degradado…', needsDoc: true, run: dlg({ kind: 'adjust', type: 'gradientMap' }) },
  { id: 'image.photoFilter', label: 'Filtro de fotografía…', needsDoc: true, run: dlg({ kind: 'adjust', type: 'photoFilter' }) },
  { id: 'image.channelMixer', label: 'Mezclador de canales…', needsDoc: true, run: dlg({ kind: 'adjust', type: 'channelMixer' }) },
  { id: 'image.selectiveColor', label: 'Corrección selectiva…', needsDoc: true, run: dlg({ kind: 'adjust', type: 'selectiveColor' }) },
  { id: 'image.desaturate', label: 'Desaturar', keys: ['Ctrl+Shift+U'], needsDoc: true, rec: true, run: call('adjust', 'desaturate') },
  { id: 'image.autoTone', label: 'Tono automático', keys: ['Ctrl+Shift+L'], needsDoc: true, rec: true, run: call('adjust', 'autoTone') },
  { id: 'image.autoContrast', label: 'Contraste automático', keys: ['Ctrl+Alt+Shift+L'], needsDoc: true, rec: true, run: call('adjust', 'autoContrast') },
  { id: 'image.autoColor', label: 'Color automático', keys: ['Ctrl+Shift+B'], needsDoc: true, rec: true, run: call('adjust', 'autoTone') },
  { id: 'image.applyImage', label: 'Aplicar imagen…', needsDoc: true, run: dlg({ kind: 'applyImage' }) },
  { id: 'image.size', label: 'Tamaño de imagen…', keys: ['Ctrl+Alt+I'], needsDoc: true, run: dlg({ kind: 'imageSize' }) },
  { id: 'image.canvasSize', label: 'Tamaño de lienzo…', keys: ['Ctrl+Alt+C'], needsDoc: true, run: dlg({ kind: 'canvasSize' }) },
  { id: 'image.rot180', label: 'Rotación de imagen 180°', needsDoc: true, rec: true, run: call('rotateCanvas', 180) },
  { id: 'image.rot90', label: 'Rotación de imagen 90° AC', needsDoc: true, rec: true, run: call('rotateCanvas', 90) },
  { id: 'image.rot-90', label: 'Rotación de imagen 90° ACD', needsDoc: true, rec: true, run: call('rotateCanvas', -90) },
  { id: 'image.flipH', label: 'Voltear lienzo horizontal', needsDoc: true, rec: true, run: call('flipCanvas', true) },
  { id: 'image.flipV', label: 'Voltear lienzo vertical', needsDoc: true, rec: true, run: call('flipCanvas', false) },
  { id: 'image.crop', label: 'Recortar a la selección', needsDoc: true, rec: true, run: call('cropToSelection') },

  // Capa
  { id: 'layer.newDialog', label: 'Capa…', keys: ['Ctrl+Shift+N'], needsDoc: true, run: dlg({ kind: 'newLayer' }) },
  { id: 'layer.new', label: 'Nueva capa', keys: ['Ctrl+Alt+Shift+N'], needsDoc: true, rec: true, run: call('newLayer') },
  { id: 'layer.viaCopy', label: 'Capa vía copiar', keys: ['Ctrl+J'], needsDoc: true, rec: true, run: call('layerVia', false) },
  { id: 'layer.viaCut', label: 'Capa vía cortar', keys: ['Ctrl+Shift+J'], needsDoc: true, rec: true, run: call('layerVia', true) },
  { id: 'layer.selectAll', label: 'Seleccionar todas las capas', keys: ['Ctrl+Alt+A'], needsDoc: true, run: call('selectAllLayers') },
  { id: 'layer.align.left', label: 'Bordes izquierdos', needsDoc: true, rec: true, run: call('alignLayers', 'left') },
  { id: 'layer.align.hcenter', label: 'Centros horizontales', needsDoc: true, rec: true, run: call('alignLayers', 'hcenter') },
  { id: 'layer.align.right', label: 'Bordes derechos', needsDoc: true, rec: true, run: call('alignLayers', 'right') },
  { id: 'layer.align.top', label: 'Bordes superiores', needsDoc: true, rec: true, run: call('alignLayers', 'top') },
  { id: 'layer.align.vcenter', label: 'Centros verticales', needsDoc: true, rec: true, run: call('alignLayers', 'vcenter') },
  { id: 'layer.align.bottom', label: 'Bordes inferiores', needsDoc: true, rec: true, run: call('alignLayers', 'bottom') },
  { id: 'layer.dist.hcenter', label: 'Centros horizontales', needsDoc: true, rec: true, run: call('distributeLayers', 'hcenter') },
  { id: 'layer.dist.vcenter', label: 'Centros verticales', needsDoc: true, rec: true, run: call('distributeLayers', 'vcenter') },
  { id: 'layer.duplicate', label: 'Duplicar capa', needsDoc: true, rec: true, run: call('duplicateLayer') },
  { id: 'layer.delete', label: 'Eliminar capa', needsDoc: true, rec: true, run: call('deleteLayer') },
  { id: 'layer.adj.brightness', label: 'Brillo/Contraste', needsDoc: true, rec: true, run: newAdjustment('brightness') },
  { id: 'layer.adj.levels', label: 'Niveles', needsDoc: true, rec: true, run: newAdjustment('levels') },
  { id: 'layer.adj.curves', label: 'Curvas', needsDoc: true, rec: true, run: newAdjustment('curves') },
  { id: 'layer.adj.exposure', label: 'Exposición', needsDoc: true, rec: true, run: newAdjustment('exposure') },
  { id: 'layer.adj.vibrance', label: 'Intensidad', needsDoc: true, rec: true, run: newAdjustment('vibrance') },
  { id: 'layer.adj.hueSat', label: 'Tono/Saturación', needsDoc: true, rec: true, run: newAdjustment('hueSat') },
  { id: 'layer.adj.colorBalance', label: 'Equilibrio de color', needsDoc: true, rec: true, run: newAdjustment('colorBalance') },
  { id: 'layer.adj.blackWhite', label: 'Blanco y negro', needsDoc: true, rec: true, run: newAdjustment('blackWhite') },
  { id: 'layer.adj.invert', label: 'Invertir', needsDoc: true, rec: true, run: newAdjustment('invert') },
  { id: 'layer.adj.posterize', label: 'Posterizar', needsDoc: true, rec: true, run: newAdjustment('posterize') },
  { id: 'layer.adj.threshold', label: 'Umbral', needsDoc: true, rec: true, run: newAdjustment('threshold') },
  { id: 'layer.adj.gradientMap', label: 'Mapa de degradado', needsDoc: true, rec: true, run: newAdjustment('gradientMap') },
  { id: 'layer.adj.photoFilter', label: 'Filtro de fotografía', needsDoc: true, rec: true, run: newAdjustment('photoFilter') },
  { id: 'layer.adj.channelMixer', label: 'Mezclador de canales', needsDoc: true, rec: true, run: newAdjustment('channelMixer') },
  { id: 'layer.adj.selectiveColor', label: 'Corrección selectiva', needsDoc: true, rec: true, run: newAdjustment('selectiveColor') },
  { id: 'layer.fill.solid', label: 'Capa de relleno: color sólido', needsDoc: true, rec: true, run: newAdjustment('solidColor') },
  { id: 'layer.style', label: 'Estilo de capa…', needsDoc: true, run: dlg({ kind: 'layerStyle' }) },
  { id: 'layer.mask.reveal', label: 'Máscara: mostrar todo', needsDoc: true, rec: true, run: call('addMask', 'reveal') },
  { id: 'layer.mask.hide', label: 'Máscara: ocultar todo', needsDoc: true, rec: true, run: call('addMask', 'hide') },
  { id: 'layer.mask.selection', label: 'Máscara: mostrar selección', needsDoc: true, rec: true, run: call('addMask', 'selection') },
  { id: 'layer.mask.apply', label: 'Aplicar máscara', needsDoc: true, rec: true, run: call('deleteMask', true) },
  { id: 'layer.mask.delete', label: 'Eliminar máscara', needsDoc: true, rec: true, run: call('deleteMask', false) },
  { id: 'layer.rasterize', label: 'Rasterizar capa', needsDoc: true, rec: true, run: call('rasterizeLayer') },
  { id: 'layer.group', label: 'Agrupar capas', keys: ['Ctrl+G'], needsDoc: true, rec: true, run: call('groupLayers') },
  { id: 'layer.ungroup', label: 'Desagrupar capas', keys: ['Ctrl+Shift+G'], needsDoc: true, rec: true, run: call('ungroupLayers') },
  { id: 'layer.newGroup', label: 'Nuevo grupo', needsDoc: true, rec: true, run: call('groupLayers', true) },
  { id: 'layer.clip', label: 'Crear/liberar máscara de recorte', keys: ['Ctrl+Alt+G'], needsDoc: true, rec: true, run: call('toggleClip') },
  { id: 'layer.front', label: 'Traer al frente', keys: ['Ctrl+Shift+]'], needsDoc: true, rec: true, run: call('arrange', 'top') },
  { id: 'layer.forward', label: 'Hacia delante', keys: ['Ctrl+]'], needsDoc: true, rec: true, run: call('arrange', 'up') },
  { id: 'layer.backward', label: 'Hacia atrás', keys: ['Ctrl+['], needsDoc: true, rec: true, run: call('arrange', 'down') },
  { id: 'layer.back', label: 'Enviar detrás', keys: ['Ctrl+Shift+['], needsDoc: true, rec: true, run: call('arrange', 'bottom') },
  { id: 'layer.selectUp', label: 'Seleccionar capa superior', keys: ['Alt+]'], needsDoc: true, run: call('selectLayerRelative', 'up') },
  { id: 'layer.selectDown', label: 'Seleccionar capa inferior', keys: ['Alt+['], needsDoc: true, run: call('selectLayerRelative', 'down') },
  { id: 'layer.selectTop', label: 'Seleccionar capa superior del todo', keys: ['Alt+.'], needsDoc: true, run: call('selectLayerRelative', 'top') },
  { id: 'layer.selectBottom', label: 'Seleccionar capa inferior del todo', keys: ['Alt+,'], needsDoc: true, run: call('selectLayerRelative', 'bottom') },
  { id: 'layer.hide', label: 'Ocultar/mostrar capa', keys: ['Ctrl+,'], needsDoc: true, rec: true, run: () => { const L = active(); if (L) engine.call('setLayer', L.id, { visible: !L.visible }); } },
  { id: 'layer.lockAlpha', label: 'Bloquear píxeles transparentes', keys: ['/'], needsDoc: true, rec: true, run: () => { const L = active(); if (L) engine.call('setLayer', L.id, { lockAlpha: !L.lockAlpha }); } },
  { id: 'layer.mergeDown', label: 'Combinar hacia abajo', keys: ['Ctrl+E'], needsDoc: true, rec: true, run: call('mergeDown') },
  { id: 'layer.mergeVisible', label: 'Combinar visibles', keys: ['Ctrl+Shift+E'], needsDoc: true, rec: true, run: call('mergeVisible') },
  { id: 'layer.stamp', label: 'Estampar visibles', keys: ['Ctrl+Alt+Shift+E'], needsDoc: true, rec: true, run: call('stampVisible') },
  { id: 'layer.flatten', label: 'Acoplar imagen', needsDoc: true, rec: true, run: call('flattenImage') },
  { id: 'layer.blendNext', label: 'Siguiente modo de fusión', keys: ['Shift+='], needsDoc: true, run: () => cycleBlend(1) },
  { id: 'layer.blendPrev', label: 'Modo de fusión anterior', keys: ['Shift+-'], needsDoc: true, run: () => cycleBlend(-1) },

  // Texto
  { id: 'type.tool', label: 'Herramienta Texto horizontal', run: () => selectTool('text') },

  // Selección
  { id: 'select.all', label: 'Todo', keys: ['Ctrl+A'], needsDoc: true, rec: true, run: call('selectAll') },
  { id: 'select.none', label: 'Deseleccionar', keys: ['Ctrl+D'], needsDoc: true, rec: true, run: call('deselect') },
  { id: 'select.reselect', label: 'Volver a seleccionar', keys: ['Ctrl+Shift+D'], needsDoc: true, rec: true, run: call('reselect') },
  { id: 'select.invert', label: 'Invertir', keys: ['Ctrl+Shift+I', 'Shift+F7'], needsDoc: true, rec: true, run: call('invertSelection') },
  { id: 'select.subject', label: 'Sujeto (IA local)', needsDoc: true, run: call('selectSubject') },
  { id: 'select.quickMask', label: 'Editar en modo Máscara rápida', keys: ['Q'], needsDoc: true, checked: () => S().doc.quickMask, run: call('toggleQuickMask') },
  { id: 'select.save', label: 'Guardar selección', needsDoc: true, rec: true, run: call('saveSelection') },
  { id: 'select.luminosity', label: 'Cargar luminosidad como selección', keys: ['Ctrl+Alt+2'], needsDoc: true, rec: true, run: call('loadChannelSelection', 0) },
  { id: 'select.feather', label: 'Calar…', keys: ['Shift+F6'], needsDoc: true, run: dlg({ kind: 'feather' }) },
  { id: 'select.expand', label: 'Expandir…', needsDoc: true, run: dlg({ kind: 'grow', dir: 1 }) },
  { id: 'select.contract', label: 'Contraer…', needsDoc: true, run: dlg({ kind: 'grow', dir: -1 }) },
  { id: 'select.fromLayer', label: 'Cargar transparencia de la capa', needsDoc: true, rec: true, run: () => { const L = active(); if (L) engine.call('loadSelectionFromLayer', L.id, false); } },

  // Filtro
  { id: 'filter.last', label: 'Último filtro', keys: ['Ctrl+Alt+F'], needsDoc: true, run: call('repeatFilter') },
  { id: 'filter.gaussianBlur', label: 'Desenfoque gaussiano…', needsDoc: true, run: dlg({ kind: 'filter', name: 'gaussianBlur' }) },
  { id: 'filter.boxBlur', label: 'Desenfoque de cuadro…', needsDoc: true, run: dlg({ kind: 'filter', name: 'boxBlur' }) },
  { id: 'filter.motionBlur', label: 'Desenfoque de movimiento…', needsDoc: true, run: dlg({ kind: 'filter', name: 'motionBlur' }) },
  { id: 'filter.unsharpMask', label: 'Máscara de enfoque…', needsDoc: true, run: dlg({ kind: 'filter', name: 'unsharpMask' }) },
  { id: 'filter.sharpen', label: 'Enfocar', needsDoc: true, rec: true, run: call('applyFilter', 'sharpen', {}) },
  { id: 'filter.addNoise', label: 'Añadir ruido…', needsDoc: true, run: dlg({ kind: 'filter', name: 'addNoise' }) },
  { id: 'filter.median', label: 'Mediana…', needsDoc: true, run: dlg({ kind: 'filter', name: 'median' }) },
  { id: 'filter.mosaic', label: 'Mosaico…', needsDoc: true, run: dlg({ kind: 'filter', name: 'mosaic' }) },
  { id: 'filter.highPass', label: 'Paso alto…', needsDoc: true, run: dlg({ kind: 'filter', name: 'highPass' }) },
  { id: 'filter.findEdges', label: 'Hallar bordes', needsDoc: true, rec: true, run: call('applyFilter', 'findEdges', {}) },
  { id: 'filter.emboss', label: 'Relieve…', needsDoc: true, run: dlg({ kind: 'filter', name: 'emboss' }) },
  { id: 'filter.clouds', label: 'Nubes', needsDoc: true, rec: true, run: call('applyFilter', 'clouds', {}) },
  { id: 'filter.liquify', label: 'Licuar…', keys: ['Ctrl+Shift+X'], needsDoc: true, run: dlg({ kind: 'liquify' }) },
  { id: 'ai.removeBg', label: 'Quitar fondo (IA local)', needsDoc: true, rec: true, run: call('removeBackground') },
  { id: 'ai.generative', label: 'Relleno generativo…', needsDoc: true, run: dlg({ kind: 'generative' }) },

  // Vista
  { id: 'view.zoomIn', label: 'Acercar', keys: ['Ctrl+=', 'Ctrl+Shift+='], needsDoc: true, run: call('zoomIn') },
  { id: 'view.zoomOut', label: 'Alejar', keys: ['Ctrl+-'], needsDoc: true, run: call('zoomOut') },
  { id: 'view.fit', label: 'Encajar en pantalla', keys: ['Ctrl+0'], needsDoc: true, run: call('fit', false) },
  { id: 'view.actual', label: '100 %', keys: ['Ctrl+1', 'Ctrl+Alt+0'], needsDoc: true, run: call('actualPixels') },
  { id: 'view.extras', label: 'Extras (bordes de selección)', keys: ['Ctrl+H'], run: () => { const v = !document.body.classList.toggle('hide-extras'); S().toast(v ? 'Extras visibles' : 'Extras ocultos'); } },
  { id: 'view.grid', label: 'Cuadrícula', keys: ["Ctrl+'"], run: () => document.body.classList.toggle('show-grid') },
  { id: 'view.rulers', label: 'Reglas', keys: ['Ctrl+R'], checked: () => S().opts.rulers, run: () => S().setOpts({ rulers: !S().opts.rulers }) },
  { id: 'view.guides', label: 'Mostrar guías', keys: ['Ctrl+;'], checked: () => S().opts.guides, run: () => S().setOpts({ guides: !S().opts.guides }) },
  { id: 'view.snap', label: 'Ajustar', keys: ['Ctrl+Shift+;'], checked: () => S().opts.snap, run: () => S().setOpts({ snap: !S().opts.snap }) },
  { id: 'view.lockGuides', label: 'Bloquear guías', keys: ['Ctrl+Alt+;'], checked: () => S().opts.lockGuides, run: () => S().setOpts({ lockGuides: !S().opts.lockGuides }) },
  { id: 'view.newGuide', label: 'Nueva guía…', needsDoc: true, run: dlg({ kind: 'newGuide' }) },
  { id: 'view.clearGuides', label: 'Borrar guías', needsDoc: true, run: call('clearGuides') },
  { id: 'view.panels', label: 'Ocultar paneles', keys: ['Tab'], run: () => useStore.setState({ panelsHidden: !S().panelsHidden }) },
  { id: 'view.fullscreen', label: 'Modo de pantalla completa', keys: ['F'], run: () => toggleFullscreen() },
  { id: 'view.mobileUi', label: 'Interfaz táctil (móvil)', checked: () => S().layout === 'mobile', run: () => {
    const layout = S().layout === 'mobile' ? 'desktop' : 'mobile';
    useStore.setState({ layout, sheet: null });
    savePrefs('layout', layout);
  } },

  // Ayuda
  { id: 'help.shortcuts', label: 'Atajos de teclado', keys: ['F1'], run: dlg({ kind: 'shortcuts' }) },
  { id: 'help.about', label: 'Acerca de', run: dlg({ kind: 'about' }) },

  // Pincel y color
  { id: 'brush.smaller', label: 'Reducir tamaño del pincel', keys: ['['], run: () => S().setBrush({ size: brushStep(S().brush.size, -1) }) },
  { id: 'brush.bigger', label: 'Aumentar tamaño del pincel', keys: [']'], run: () => S().setBrush({ size: brushStep(S().brush.size, 1) }) },
  { id: 'brush.softer', label: 'Reducir dureza', keys: ['Shift+['], run: () => S().setBrush({ hardness: Math.round((S().brush.hardness - 0.25) * 4) / 4 }) },
  { id: 'brush.harder', label: 'Aumentar dureza', keys: ['Shift+]'], run: () => S().setBrush({ hardness: Math.round((S().brush.hardness + 0.25) * 4) / 4 }) },
  { id: 'color.default', label: 'Colores por defecto', keys: ['D'], run: () => S().setColors('#000000', '#ffffff') },
  { id: 'color.swap', label: 'Intercambiar colores', keys: ['X'], run: () => S().setColors(S().bg, S().fg) },
  { id: 'mask.toggleEdit', label: 'Editar máscara / píxeles', keys: ['Ctrl+\\'], needsDoc: true, run: () => engine.call('setEditMask', !S().doc.editMask) },
];

/** Pasos de tamaño de pincel parecidos a Photoshop: finos en tamaños pequeños. */
function brushStep(size: number, dir: 1 | -1) {
  const step = size < 10 ? 1 : size < 50 ? 5 : size < 100 ? 10 : size < 200 ? 25 : size < 500 ? 50 : 100;
  return Math.max(1, size + dir * step);
}

// Herramientas: letra y Mayús+letra.
// R: Rotar vista (en Photoshop comparte grupo con la Mano pero tiene su propia letra).
COMMANDS.push({ id: 'tool.R', label: 'Rotar vista', keys: ['R'], run: () => selectTool('rotateView') });
for (const g of TOOL_GROUPS) {
  if (g.key.startsWith('_')) continue; // grupo sin atajo (como Desenfocar/Enfocar/Dedo en Photoshop)
  COMMANDS.push({ id: `tool.${g.key}`, label: g.tools.map((t) => TOOL_NAMES[t]).join(' / '), keys: [g.key], run: () => toolKey(g.key, false) });
  if (g.tools.length > 1 || g.key === 'U') COMMANDS.push({ id: `tool.${g.key}.cycle`, label: `Siguiente en el grupo (${TOOL_NAMES[g.tools[0]]}…)`, keys: [`Shift+${g.key}`], run: () => toolKey(g.key, true) });
}

// Modos de fusión con Mayús+Alt+letra (como Photoshop).
const BLEND_KEYS: [string, BlendMode][] = [
  ['N', 'normal'], ['I', 'dissolve'], ['K', 'darken'], ['M', 'multiply'], ['B', 'color-burn'], ['A', 'linear-burn'],
  ['G', 'lighten'], ['S', 'screen'], ['D', 'color-dodge'], ['W', 'linear-dodge'], ['O', 'overlay'], ['F', 'soft-light'],
  ['H', 'hard-light'], ['V', 'vivid-light'], ['J', 'linear-light'], ['Z', 'pin-light'], ['L', 'hard-mix'],
  ['E', 'difference'], ['X', 'exclusion'], ['U', 'hue'], ['T', 'saturation'], ['C', 'color'], ['Y', 'luminosity'],
];
for (const [k, mode] of BLEND_KEYS) {
  COMMANDS.push({ id: `blend.${mode}`, label: `Modo de fusión: ${BLEND_LABEL[mode]}`, keys: [`Alt+Shift+${k}`], needsDoc: true, rec: true, run: () => setBlend(mode) });
}

export const commandById = Object.fromEntries(COMMANDS.map((c) => [c.id, c])) as Record<string, Command>;

// ------------------------------------------------------------------ transformación y pegado

export async function startTransform() {
  const s = S();
  if (s.transform) return;
  const r = await engine.call<{ bounds: { x: number; y: number; w: number; h: number } } | null>('beginTransform');
  if (!r) { s.toast('No hay contenido que transformar en esta capa.', 'warn'); return; }
  useStore.setState({ transform: { bounds: r.bounds, matrix: [1, 0, 0, 1, 0, 0] } });
}

let pasteInPlace = false;
function pasteFromMenu(inPlace: boolean) {
  pasteInPlace = inPlace;
  // Desde el menú no hay evento "paste": se intenta leer el portapapeles del sistema.
  (async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) { await engine.call('paste', await (await it.getType(type)).arrayBuffer(), inPlace); return; }
      }
    } catch { /* sin permiso: portapapeles interno */ }
    await engine.call('paste', null, inPlace);
  })();
}

/** Evento "paste" del navegador (Ctrl+V): imagen del sistema o portapapeles interno. */
export function onPasteEvent(e: ClipboardEvent) {
  const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  e.preventDefault();
  if (!S().doc.open) { if (file) openFile(file); return; }
  if (file) file.arrayBuffer().then((b) => engine.call('paste', b, pasteInPlace));
  else engine.call('paste', null, pasteInPlace);
  pasteInPlace = false;
}
export function markPasteInPlace(v: boolean) { pasteInPlace = v; }

// ------------------------------------------------------------------ teclado

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function formatKeys(keys?: string | string[]) {
  const k = Array.isArray(keys) ? keys[0] : keys;
  if (!k) return '';
  if (isMac) return k.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧');
  return k.replace(/Shift\+/g, 'Mayús+').replace(/Backspace/g, 'Retroceso').replace(/Delete/g, 'Supr');
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Equal: '=', NumpadAdd: '=', Minus: '-', NumpadSubtract: '-', Slash: '/', NumpadDivide: '/',
  Backslash: '\\', Comma: ',', Period: '.', Quote: "'", Semicolon: ';', Backspace: 'Backspace', Delete: 'Delete',
  Tab: 'Tab', Space: 'Space', Escape: 'Escape', Enter: 'Enter', NumpadEnter: 'Enter',
};

/** Convierte un evento de teclado en la forma "Ctrl+Shift+N" (independiente de la distribución). */
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
  const p = keys.split('+');
  const key = keys.endsWith('+') ? '+' : p[p.length - 1];
  const mods = ['Ctrl', 'Alt', 'Shift'].filter((m) => p.slice(0, -1).includes(m));
  return [...mods, key === '+' ? '=' : key].join('+');
};

const BY_COMBO = new Map<string, Command>();
for (const c of COMMANDS) for (const k of c.keys ?? []) if (!BY_COMBO.has(normalize(k))) BY_COMBO.set(normalize(k), c);

export function commandForEvent(e: KeyboardEvent): Command | undefined {
  return BY_COMBO.get(comboOf(e));
}

/**
 * Combinaciones que Chrome/Edge se reservan en una pestaña normal: sólo llegan a la
 * página en pantalla completa (API Keyboard Lock). Se muestran con su alternativa.
 */
export const BROWSER_RESERVED = new Set(['Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+N', 'Ctrl+W', 'Ctrl+T', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+W', 'Ctrl+1', 'Ctrl+2', 'Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+C']);

// ------------------------------------------------------------------ opacidad con números

let digitBuf = '', digitTime = 0;

/**
 * 1-9, 0: opacidad (10 %…100 %). Dos cifras rápidas = valor exacto ("4","5" = 45 %).
 * Mayús+cifras = flujo. Con herramientas que no pintan cambia la opacidad de la capa.
 */
let digitShift = false;
export function handleDigit(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const m = /^(Digit|Numpad)(\d)$/.exec(e.code);
  if (!m) return false;
  const now = performance.now();
  const d = m[2];
  let value: number;
  // Dos cifras rápidas (p. ej. 4 y 5 → 45 %) solo si ambas llevan o no llevan Mayús.
  if (now - digitTime < 500 && digitBuf.length === 1 && digitShift === e.shiftKey) {
    value = Number(digitBuf + d) / 100;
    digitBuf = '';
  } else {
    digitBuf = d;
    value = d === '0' ? 1 : Number(d) / 10;
  }
  digitTime = now;
  digitShift = e.shiftKey;
  const s = S();
  if (isPaintTool(s.tool)) {
    if (e.shiftKey) s.setBrush({ flow: Math.max(0.01, value) });
    else s.setBrush({ opacity: Math.max(0.01, value) });
  } else {
    const L = active();
    if (L && !e.shiftKey) engine.call('setLayer', L.id, { opacity: value });
  }
  return true;
}

// ------------------------------------------------------------------ acciones (grabar/reproducir)

export function runCommand(c: Command) {
  const s = S();
  if (c.needsDoc && !s.doc.open) return;
  if (s.recording && c.rec) {
    const actions = [...s.actions];
    const cur = actions[actions.length - 1];
    if (cur) { cur.steps = [...cur.steps, { id: c.id }]; useStore.setState({ actions }); savePrefs('actions', { list: actions }); }
  }
  return c.run();
}

export function startRecording(name: string) {
  const actions = [...S().actions, { name, steps: [] }];
  useStore.setState({ actions, recording: true });
  savePrefs('actions', { list: actions });
}

export function stopRecording() {
  useStore.setState({ recording: false });
  savePrefs('actions', { list: S().actions });
}

export async function playAction(index: number) {
  const a = S().actions[index];
  if (!a) return;
  for (const step of a.steps) {
    const c = commandById[step.id];
    if (c) await c.run();
  }
  S().toast(`Acción "${a.name}" ejecutada (${a.steps.length} pasos)`);
}

export function renameAction(index: number, name: string) {
  const actions = S().actions.map((a, i) => (i === index ? { ...a, name } : a));
  useStore.setState({ actions });
  savePrefs('actions', { list: actions });
}

export function deleteAction(index: number) {
  const actions = S().actions.filter((_, i) => i !== index);
  useStore.setState({ actions });
  savePrefs('actions', { list: actions });
}

export { toRgba };
