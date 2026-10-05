/**
 * Herramientas del asistente: lo que puede hacer en el documento. Las mismas definiciones
 * sirven al modelo de lenguaje (esquema JSON, formato de uso de herramientas) y al intérprete local.
 */
import { engine } from '../../engine/client';
import { CAMERA_RAW_DEFAULTS } from '../../engine/camraw';
import { defaultAdjustment } from '../../engine/adjust';
import type { AdjustmentType, AdjustmentParams } from '../../engine/types';
import { useStore, toRgba } from '../store';
import { commandById, COMMANDS, download } from '../commands';
import { parseColor } from './color';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (a: Record<string, unknown>) => Promise<string>;
}

const S = () => useStore.getState();
const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() && isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const N = (description: string, minimum?: number, maximum?: number) => ({ type: 'number', description, ...(minimum != null ? { minimum } : {}), ...(maximum != null ? { maximum } : {}) });

export { parseColor };

const doc = () => S().doc;
const need = () => { if (!doc().open) throw new Error('No hay ningún documento abierto.'); };

/**
 * Capa sobre la que aplicar un revelado o un filtro: la activa si tiene píxeles; si es de ajuste,
 * texto o forma, la capa de píxeles (u objeto inteligente) más alta por debajo de ella.
 */
async function pixelTarget(): Promise<string> {
  const d = doc();
  const ls = d.layers;
  const i = ls.findIndex((l) => l.id === d.activeLayerId);
  const ok = (k: string) => k === 'pixel' || k === 'smart';
  if (i >= 0 && ok(ls[i].kind)) return ls[i].name;
  const below = ls.slice(0, Math.max(0, i)).reverse().find((l) => ok(l.kind) && l.visible) ?? [...ls].reverse().find((l) => ok(l.kind));
  if (!below) throw new Error('No hay ninguna capa de píxeles a la que aplicarlo.');
  await engine.call('selectLayer', below.id);
  return below.name;
}

/** Lanza un error si la operación no dejó ningún paso en el historial (el motor la rechazó). */
async function changed<T>(fn: () => Promise<T>, what: string): Promise<T> {
  const before = S().doc.historyIndex, len = S().doc.history.length;
  const r = await fn();
  await new Promise((res) => setTimeout(res, 30));
  const st = S().doc;
  if (st.historyIndex === before && st.history.length === len) throw new Error(`No se pudo aplicar ${what}.`);
  return r;
}

const ADJ_TYPES: AdjustmentType[] = ['brightness', 'levels', 'curves', 'exposure', 'vibrance', 'hueSat', 'colorBalance', 'blackWhite', 'photoFilter', 'channelMixer', 'invert', 'posterize', 'threshold', 'gradientMap', 'selectiveColor', 'solidColor'];
const FILTERS = ['gaussianBlur', 'boxBlur', 'motionBlur', 'unsharpMask', 'sharpen', 'addNoise', 'mosaic', 'highPass', 'findEdges', 'emboss', 'median', 'reduceNoise', 'dustScratches', 'clouds'];

/** Comandos de menú que el modelo puede usar tal cual (los grabables en acciones). */
export const MENU_COMMANDS = () => COMMANDS.filter((c) => c.rec).map((c) => `${c.id} (${c.label})`);

export const TOOLS: ToolDef[] = [
  {
    name: 'develop',
    description: 'Revelado fotográfico global de la capa activa (o la selección), como Camera Raw. Valores de -100 a 100 salvo exposure (-5..5 EV). Úsalo para mejorar fotos: luz, contraste, color, nitidez, viñeta.',
    input_schema: { type: 'object', properties: {
      exposure: N('EV', -5, 5), contrast: N('', -100, 100), highlights: N('', -100, 100), shadows: N('', -100, 100), whites: N('', -100, 100), blacks: N('', -100, 100),
      temp: N('temperatura (+ cálido)', -100, 100), tint: N('matiz (+ magenta)', -100, 100), vibrance: N('', -100, 100), saturation: N('', -100, 100),
      texture: N('', -100, 100), clarity: N('', -100, 100), dehaze: N('', -100, 100), vignette: N('negativo oscurece bordes', -100, 100), grain: N('', 0, 100),
      sharpen: N('0..150', 0, 150), noise: N('reducción de ruido 0..100', 0, 100),
    } },
    run: async (a) => {
      need();
      const keys = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'vibrance', 'saturation', 'texture', 'clarity', 'dehaze', 'vignette', 'grain', 'sharpen', 'noise'];
      const cr: Record<string, unknown> = { ...CAMERA_RAW_DEFAULTS, hsl: [...CAMERA_RAW_DEFAULTS.hsl], frame: { x: 0, y: 0, w: doc().width, h: doc().height }, scale: 1 };
      const used: string[] = [];
      const ES: Record<string, string> = { exposure: 'exposición', contrast: 'contraste', highlights: 'iluminaciones', shadows: 'sombras', whites: 'blancos', blacks: 'negros', temp: 'temperatura', tint: 'matiz', vibrance: 'intensidad', saturation: 'saturación', texture: 'textura', clarity: 'claridad', dehaze: 'neblina', vignette: 'viñeta', grain: 'grano', sharpen: 'enfoque', noise: 'ruido' };
      for (const k of keys) if (a[k] != null) {
        const v = clamp(num(a[k]), k === 'exposure' ? -5 : k === 'sharpen' ? 0 : -100, k === 'exposure' ? 5 : k === 'sharpen' ? 150 : 100);
        cr[k] = v;
        used.push(`${ES[k]} ${v > 0 ? '+' : ''}${String(Math.round(v * 100) / 100).replace('.', ',')}`);
      }
      if (!used.length) return 'Sin cambios: no se indicó ningún ajuste.';
      const target = await pixelTarget();
      await changed(() => engine.call('applyFilter', 'cameraRaw', { cr }), 'el revelado');
      return `Revelado aplicado (${used.join(', ')}) en «${target}».`;
    },
  },
  {
    name: 'adjustment_layer',
    description: 'Crea una capa de ajuste NO destructiva encima de la capa activa. Tipos y parámetros: brightness{brightness -150..150, contrast -50..100}; levels{inBlack 0..253, inWhite 2..255, gamma 0.1..9.99}; curves{points:[[in,out],...] 0..255}; exposure{exposure -20..20, offset, gamma}; vibrance{vibrance, saturation -100..100}; hueSat{hue -180..180, saturation -100..100, lightness -100..100, colorize bool}; colorBalance{shadows,midtones,highlights: [cian-rojo, magenta-verde, amarillo-azul] -100..100}; blackWhite{}; photoFilter{color "#hex", density 0..100}; invert{}; posterize{levels 2..255}; threshold{level 1..255}; gradientMap{from "#hex", to "#hex"}; solidColor{color "#hex"}.',
    input_schema: { type: 'object', properties: { type: { type: 'string', enum: ADJ_TYPES }, params: { type: 'object' } }, required: ['type'] },
    run: async (a) => {
      need();
      const type = a.type as AdjustmentType;
      if (!ADJ_TYPES.includes(type)) throw new Error(`Tipo de ajuste desconocido: ${String(a.type)}`);
      const p = { ...(a.params as Record<string, unknown> ?? {}) };
      for (const k of ['color', 'from', 'to']) if (p[k] != null) { const c = parseColor(p[k]); if (c) p[k] = c; else delete p[k]; }
      const params = { ...defaultAdjustment(type, toRgba(S().fg), toRgba(S().bg)), ...p, type } as AdjustmentParams;
      await engine.call('newAdjustmentLayer', type, params);
      return `Capa de ajuste ${type} creada.`;
    },
  },
  {
    name: 'filter',
    description: `Aplica un filtro a la capa activa (o la selección). Nombres: ${FILTERS.join(', ')}. Parámetros según el filtro: radius (px; desenfoques, enfoque, paso alto, mediana), amount (%; enfoque y ruido), threshold, angle y distance (desenfoque de movimiento), cell (mosaico, px), strength (reducir ruido 0..10).`,
    input_schema: { type: 'object', properties: { name: { type: 'string', enum: FILTERS }, radius: N('px'), amount: N('%'), threshold: N(''), angle: N('°'), distance: N('px'), cell: N('px'), strength: N('0..10') }, required: ['name'] },
    run: async (a) => {
      need();
      const name = String(a.name);
      if (!FILTERS.includes(name)) throw new Error(`Filtro desconocido: ${name}`);
      const params: Record<string, number> = {};
      for (const k of ['radius', 'amount', 'threshold', 'angle', 'distance', 'cell', 'strength']) if (a[k] != null) params[k] = num(a[k]);
      const target = await pixelTarget();
      await changed(() => engine.call('applyFilter', name, params), `el filtro ${name}`);
      return `Filtro ${name} aplicado en «${target}».`;
    },
  },
  {
    name: 'auto',
    description: 'Correcciones automáticas de un clic: autoTone, autoContrast, autoColor, desaturate, invert.',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['autoTone', 'autoContrast', 'autoColor', 'desaturate', 'invert'] } }, required: ['kind'] },
    run: async (a) => {
      need();
      const id = `image.${String(a.kind)}`;
      const c = commandById[id];
      if (!c) throw new Error(`Corrección desconocida: ${String(a.kind)}`);
      await pixelTarget();
      await changed(async () => c.run(), c.label);
      return `${c.label} aplicado.`;
    },
  },
  {
    name: 'resize_image',
    description: 'Cambia el tamaño de la imagen (remuestrea). Da width y/o height en px o percent; se conserva la proporción si falta uno.',
    input_schema: { type: 'object', properties: { width: N('px'), height: N('px'), percent: N('%') } },
    run: async (a) => {
      need();
      const { width: W, height: H } = doc();
      let w = num(a.width), h = num(a.height);
      if (a.percent != null) { w = W * num(a.percent) / 100; h = H * num(a.percent) / 100; }
      if (w && !h) h = (w * H) / W;
      if (h && !w) w = (h * W) / H;
      if (!w || !h) throw new Error('Indica un tamaño.');
      w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
      await engine.call('resizeImage', w, h, 'auto', 0);
      return `Imagen a ${w} × ${h} px.`;
    },
  },
  {
    name: 'crop',
    description: 'Recorta el documento. Con ratio ("16:9", "1:1", "4:5", "9:16"…) recorta centrado al mayor rectángulo de esa proporción; o da x, y, width, height en px.',
    input_schema: { type: 'object', properties: { ratio: { type: 'string' }, x: N('px'), y: N('px'), width: N('px'), height: N('px') } },
    run: async (a) => {
      need();
      const { width: W, height: H } = doc();
      let r = { x: num(a.x), y: num(a.y), w: num(a.width, W), h: num(a.height, H) };
      if (typeof a.ratio === 'string' && /^\s*\d+(\.\d+)?\s*[:x/]\s*\d+(\.\d+)?\s*$/.test(a.ratio)) {
        const [p, q] = a.ratio.split(/[:x/]/).map(Number), k = p / q;
        const w = Math.min(W, H * k), h = w / k;
        r = { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w: Math.round(w), h: Math.round(h) };
      }
      r.x = clamp(Math.round(r.x), 0, W - 1); r.y = clamp(Math.round(r.y), 0, H - 1);
      r.w = clamp(Math.round(r.w), 1, W - r.x); r.h = clamp(Math.round(r.h), 1, H - r.y);
      await engine.call('crop', r);
      return `Recortado a ${r.w} × ${r.h} px.`;
    },
  },
  {
    name: 'rotate_flip',
    description: 'Gira el lienzo (degrees: 90, -90, 180 o cualquier ángulo) o lo voltea (flip: "horizontal" | "vertical").',
    input_schema: { type: 'object', properties: { degrees: N('° (positivo = horario)'), flip: { type: 'string', enum: ['horizontal', 'vertical'] } } },
    run: async (a) => {
      need();
      if (a.flip) { await engine.call('flipCanvas', a.flip === 'horizontal'); return `Volteado en ${String(a.flip)}.`; }
      const d = num(a.degrees);
      if (d === 90 || d === -90 || d === 180) await engine.call('rotateCanvas', d);
      else if (d) await engine.call('rotateArbitrary', d);
      return `Girado ${d}°.`;
    },
  },
  {
    name: 'select',
    description: 'Selección: what = "subject" (sujeto principal con IA local), "all", "none", "invert", o "rect"/"ellipse" con x, y, width, height en px.',
    input_schema: { type: 'object', properties: { what: { type: 'string', enum: ['subject', 'all', 'none', 'invert', 'rect', 'ellipse'] }, x: N('px'), y: N('px'), width: N('px'), height: N('px'), feather: N('px') }, required: ['what'] },
    run: async (a) => {
      need();
      switch (a.what) {
        case 'subject': await engine.call('selectSubject'); return doc().selection ? 'Sujeto seleccionado.' : 'Selección del sujeto lanzada.';
        case 'all': await engine.call('selectAll'); return 'Todo seleccionado.';
        case 'none': await engine.call('deselect'); return 'Selección quitada.';
        case 'invert': await engine.call('invertSelection'); return 'Selección invertida.';
        default: {
          const r = { x: num(a.x), y: num(a.y), w: num(a.width, doc().width), h: num(a.height, doc().height) };
          await engine.call('selectShape', r, a.what === 'ellipse' ? 'ellipse' : 'rect', 'replace', num(a.feather));
          return 'Zona seleccionada.';
        }
      }
    },
  },
  {
    name: 'remove_background',
    description: 'Quita el fondo de la capa activa con IA local (deja el sujeto con una máscara).',
    input_schema: { type: 'object', properties: {} },
    run: async () => { need(); await engine.call('removeBackground'); return 'Fondo quitado.'; },
  },
  {
    name: 'content_aware_fill',
    description: 'Rellena la selección actual según el contenido (borra objetos). Requiere una selección.',
    input_schema: { type: 'object', properties: {} },
    run: async () => { need(); if (!doc().selection) throw new Error('Hace falta una selección.'); await engine.call('contentAwareFill'); return 'Zona rellenada según el contenido.'; },
  },
  {
    name: 'add_text',
    description: 'Añade una capa de texto. position: "top", "center", "bottom" (centrado) o x/y en px (línea base). size en px (por defecto ~8 % del alto). color "#hex" o nombre.',
    input_schema: { type: 'object', properties: { text: { type: 'string' }, position: { type: 'string', enum: ['top', 'center', 'bottom'] }, x: N('px'), y: N('px'), size: N('px'), color: { type: 'string' }, font: { type: 'string' }, bold: { type: 'boolean' } }, required: ['text'] },
    run: async (a) => {
      need();
      const { width: W, height: H } = doc();
      const size = Math.max(6, Math.round(num(a.size, Math.max(12, H * 0.08))));
      const pos = String(a.position ?? (a.x == null && a.y == null ? 'center' : ''));
      const centered = !!pos;
      const x = centered ? W / 2 : num(a.x, W * 0.05);
      const y = pos === 'top' ? size * 1.4 : pos === 'bottom' ? H - size * 0.6 : pos === 'center' ? H / 2 + size * 0.35 : num(a.y, H / 2);
      const color = parseColor(a.color) ?? toRgba(S().fg);
      await engine.call('createText', { text: String(a.text), x, y, size, color, font: typeof a.font === 'string' ? a.font : 'Arial', bold: !!a.bold, align: centered ? 'center' : 'left' });
      return `Texto «${String(a.text)}» añadido.`;
    },
  },
  {
    name: 'add_shape',
    description: 'Añade una capa de forma vectorial: shape "rect" | "ellipse" | "line" | "polygon", x, y, width, height en px, color de relleno, radius (esquinas).',
    input_schema: { type: 'object', properties: { shape: { type: 'string', enum: ['rect', 'ellipse', 'line', 'polygon'] }, x: N('px'), y: N('px'), width: N('px'), height: N('px'), color: { type: 'string' }, radius: N('px') }, required: ['shape'] },
    run: async (a) => {
      need();
      const { width: W, height: H } = doc();
      const fill = parseColor(a.color) ?? toRgba(S().fg);
      await engine.call('createShape', { shape: a.shape, x: num(a.x, W * 0.25), y: num(a.y, H * 0.25), w: num(a.width, W * 0.5), h: num(a.height, H * 0.5), fill, radius: num(a.radius) });
      return `Forma ${String(a.shape)} añadida.`;
    },
  },
  {
    name: 'layer',
    description: 'Operaciones de capa: action "select" (activa la capa con id o name; las demás herramientas actúan sobre la capa activa), "new" (capa vacía), "duplicate", "fill" (rellena con color; respeta la selección), "opacity" (value 0..100), "hide", "show", "merge_visible", "flatten".',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['select', 'new', 'duplicate', 'fill', 'opacity', 'hide', 'show', 'merge_visible', 'flatten'] }, id: N('id de capa'), name: { type: 'string' }, color: { type: 'string' }, value: N('') }, required: ['action'] },
    run: async (a) => {
      need();
      const L = doc().layers.find((l) => l.id === doc().activeLayerId);
      switch (a.action) {
        case 'select': {
          const ls = doc().layers;
          const t = ls.find((l) => l.id === num(a.id, -1)) ?? ls.find((l) => typeof a.name === 'string' && l.name.toLowerCase() === a.name.toLowerCase()) ?? ls.find((l) => typeof a.name === 'string' && l.name.toLowerCase().includes(a.name.toLowerCase()));
          if (!t) throw new Error('No encuentro esa capa.');
          await engine.call('selectLayer', t.id);
          return `Capa activa: ${t.name}.`;
        }
        case 'new': await engine.call('newLayer'); return 'Capa nueva.';
        case 'duplicate': await engine.call('duplicateLayer'); return 'Capa duplicada.';
        case 'fill': { const c = parseColor(a.color) ?? toRgba(S().fg); await engine.call('fill', c); return 'Capa rellenada.'; }
        case 'opacity': if (L) await engine.call('setLayer', L.id, { opacity: clamp(num(a.value, 100), 0, 100) / 100 }); return `Opacidad ${num(a.value, 100)} %.`;
        case 'hide': case 'show': if (L) await engine.call('setLayer', L.id, { visible: a.action === 'show' }); return a.action === 'show' ? 'Capa visible.' : 'Capa oculta.';
        case 'merge_visible': await engine.call('mergeVisible'); return 'Capas visibles combinadas.';
        case 'flatten': await commandById['layer.flatten']?.run(); return 'Imagen acoplada.';
      }
      throw new Error(`Acción de capa desconocida: ${String(a.action)}`);
    },
  },
  {
    name: 'color_mode',
    description: 'Cambia el modo de color del documento: "rgb", "gray" (escala de grises) o "cmyk" (imprenta).',
    input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['rgb', 'gray', 'cmyk'] } }, required: ['mode'] },
    run: async (a) => { need(); await commandById[`image.mode.${String(a.mode)}`]?.run(); return `Modo ${String(a.mode)}.`; },
  },
  {
    name: 'export',
    description: 'Descarga el documento: format "png" | "jpeg" | "webp" | "gif" | "tiff" | "pdf" | "svg"; quality 1..100 (JPEG/WebP).',
    input_schema: { type: 'object', properties: { format: { type: 'string', enum: ['png', 'jpeg', 'webp', 'gif', 'tiff', 'pdf', 'svg'] }, quality: N('', 1, 100) }, required: ['format'] },
    run: async (a) => {
      need();
      const mime: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', tiff: 'image/tiff', pdf: 'application/pdf', svg: 'image/svg+xml' };
      const t = mime[String(a.format)] ?? 'image/png';
      const [f] = await engine.call<{ name: string; blob: Blob }[]>('exportSet', t, clamp(num(a.quality, 90), 1, 100) / 100, [1], 'document', {});
      download(f.blob, f.name);
      return `Exportado ${f.name}.`;
    },
  },
  {
    name: 'menu_command',
    description: 'Ejecuta un comando de menú por su id (los que no tienen herramienta propia). Ejemplos: image.flipH, layer.newGroup, select.invert, layer.mask.reveal, layer.smart.convert, filter.findEdges.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async (a) => {
      const c = commandById[String(a.id)];
      if (!c) throw new Error(`Comando desconocido: ${String(a.id)}`);
      if (c.needsDoc) need();
      await c.run();
      return `${c.label}: hecho.`;
    },
  },
  {
    name: 'undo',
    description: 'Deshace el último paso (steps = cuántos).',
    input_schema: { type: 'object', properties: { steps: N('', 1, 50) } },
    run: async (a) => { for (let i = 0; i < clamp(num(a.steps, 1), 1, 50); i++) await engine.call('undo'); return 'Deshecho.'; },
  },
];

export const toolByName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Definiciones para la API de mensajes (sin la función). */
export const toolSchemas = () => TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
