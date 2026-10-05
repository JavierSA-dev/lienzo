/**
 * Idioma de la interfaz. La interfaz está escrita en español; en inglés, un observador traduce
 * los textos del DOM (nodos de texto y atributos title, placeholder y aria-label) con un
 * diccionario y unos patrones para los textos con números o nombres. Lo que el usuario escribe
 * (nombres de capa, textos, documentos) va marcado con translate="no" y no se toca.
 */
export type Lang = 'es' | 'en';

const KEY = 'lienzo.lang';

export function getLang(): Lang {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'es' || q === 'en') return q;
    const s = localStorage.getItem(KEY);
    if (s === 'es' || s === 'en') return s;
  } catch { /* sin almacenamiento */ }
  return (navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function setLang(l: Lang) {
  try { localStorage.setItem(KEY, l); } catch { /* sin almacenamiento */ }
  const u = new URL(location.href);
  u.searchParams.delete('lang');
  location.replace(u.toString());
}

let DICT: Record<string, string> | null = null;

/** Textos con partes variables (números, nombres): [patrón, traducción]. */
const PATTERNS: [RegExp, string | ((...m: string[]) => string)][] = [
  [/^(\d+) capas?$/, (_m, n) => `${n} layer${n === '1' ? '' : 's'}`],
  [/^(.+): (\d+) capas? en (\d+) ms$/, (_m, f, n, ms) => `${f}: ${n} layer${n === '1' ? '' : 's'} in ${ms} ms`],
  [/^Exportado (.+)$/, 'Exported $1'],
  [/^(\d+) archivos en un ZIP$/, '$1 files in a ZIP'],
  [/^(\d+) archivos?$/, (_m, n) => `${n} file${n === '1' ? '' : 's'}`],
  [/^Ningún archivo$/, 'No files'],
  [/^Lote: (\d+) de (\d+) archivos procesados(.*)$/, (_m, a, b, rest) => `Batch: ${a} of ${b} files processed${rest.replace(/\((\d+) con errores\)/, '($1 with errors)')}`],
  [/^Acción "(.+)" ejecutada \((\d+) pasos\)$/, 'Action "$1" played ($2 steps)'],
  [/^\((\d+)\)$/, '($1)'],
  [/^(.+) \((\d+) pasos\)$/, '$1 ($2 steps)'],
  [/^GIF animado de (\d+) cuadros$/, 'Animated GIF with $1 frames'],
  [/^(\d+) cuadros en un ZIP$/, '$1 frames in a ZIP'],
  [/^(\d+) cuadros\.$/, '$1 frames.'],
  [/^Abriendo (.+)…$/, 'Opening $1…'],
  [/^Revelando (.+)…$/, 'Developing $1…'],
  [/^No se pudo abrir (.+?): (.+)$/, 'Could not open $1: $2'],
  [/^Tamaño de impresión: (.+)$/, 'Print size: $1'],
  [/^Calidad: (\d+)$/, 'Quality: $1'],
  [/^Selector de color \(color frontal\)$/, 'Color Picker (Foreground Color)'],
  [/^Selector de color \(color de fondo\)$/, 'Color Picker (Background Color)'],
  [/^Cuadro (\d+)$/, 'Frame $1'],
  [/^(\d+) %$/, '$1%'],
  [/^(.*) @ ([\d.]+%) \((.+)\)(\*?)$/, (_m, n, z, mode, dirty) => `${n} @ ${z} (${DICT![mode] ?? mode})${dirty}`],
  [/^Sin título-(\d+)$/, 'Untitled-$1'],
];

/** Nombres de capa: solo se traducen los que pone el programa (Capa 1, Fondo, Grupo 2…). */
export function trName(name: string): string {
  if (!DICT) return name;
  const m = name.match(/^(Capa|Grupo|Fondo|Mesa de trabajo|Forma|Texto)( \d+)?((?: copia)*)( \d+)?$/);
  if (!m) return DICT[name] && /^(Brillo\/Contraste|Niveles|Curvas|Exposición|Intensidad|Tono\/Saturación|Equilibrio de color|Blanco y negro|Filtro de fotografía|Mezclador de canales|Consulta de colores|Invertir|Posterizar|Umbral|Mapa de degradado|Corrección selectiva|Relleno de color|Color sólido)( \d+)?$/.test(name) ? DICT[name] : name;
  const base = ({ Capa: 'Layer', Grupo: 'Group', Fondo: 'Background', 'Mesa de trabajo': 'Artboard', Forma: 'Shape', Texto: 'Type' } as Record<string, string>)[m[1]];
  return `${base}${m[2] ?? ''}${(m[3] ?? '').replace(/ copia/g, ' copy')}${m[4] ?? ''}`;
}

function ellipsis(s: string): string | null {
  for (const end of ['…', '...', ':']) {
    if (s.endsWith(end)) { const b = DICT![s.slice(0, -end.length).trimEnd()]; if (b) return b + end; }
  }
  return null;
}

const KEYS: Record<string, string> = { 'Mayús': 'Shift', Retroceso: 'Backspace', Intro: 'Enter', Supr: 'Del', Espacio: 'Space', Inicio: 'Home', Fin: 'End', RePág: 'PgUp', AvPág: 'PgDn' };
const keys = (s: string) => s.replace(/(Mayús|Retroceso|Intro|Supr|Espacio|RePág|AvPág)/g, (k) => KEYS[k]);
const ALIGN: Record<string, string> = { 'bordes izquierdos': 'left edges', 'bordes derechos': 'right edges', 'bordes superiores': 'top edges', 'bordes inferiores': 'bottom edges', 'centros horizontales': 'horizontal centers', 'centros verticales': 'vertical centers' };

/** Traduce un texto completo (sin espacios alrededor). */
export function tr(s: string, depth = 0): string {
  if (!DICT || !s) return s;
  const d = DICT[s] ?? ellipsis(s);
  if (d) return d;
  // Atajos: Ctrl+Mayús+S → Ctrl+Shift+S
  if (/^(?:[\wÁ-úñ]+\+)+\S+$/.test(s) || /^(Mayús|Retroceso|Intro|Supr|Espacio)$/.test(s)) return keys(s);
  for (const [re, to] of PATTERNS) {
    const m = s.match(re);
    if (m) return typeof to === 'string' ? s.replace(re, to) : to(...(m as unknown as string[]));
  }
  if (depth > 3) return s;
  const sub = (x: string) => tr(x, depth + 1);
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^Siguiente en el grupo \((.+?)(…?)\)$/))) return `Next in group (${sub(m[1])}${m[2]})`;
  if ((m = s.match(/^(.+) \(([^()]{1,24})\)$/)) && (DICT[m[1]] || ellipsis(m[1]))) return `${sub(m[1])} (${m[2] === 'valor' ? 'value' : DICT[m[2]] ?? ellipsis(m[2]) ?? keys(m[2])})`;
  if ((m = s.match(/^Mayús\+(.+) alterna$/))) return `Shift+${m[1]} cycles`;
  if ((m = s.match(/^Activar (.+)$/))) return `Enable ${sub(m[1])}`;
  if ((m = s.match(/^El navegador reserva (.+?) \(funciona en pantalla completa\)\. Alternativa: (.+)$/))) return `The browser reserves ${keys(m[1])} (works in full screen). Alternative: ${keys(m[2])}`;
  if ((m = s.match(/^Alinear (.+) \(respecto a (?:el |la )?(lienzo|selección)\)$/))) return `Align ${ALIGN[m[1]] ?? m[1]} (to ${m[2] === 'lienzo' ? 'canvas' : 'selection'})`;
  if ((m = s.match(/^(.+) \((\d+) hilos?\)$/))) return `${sub(m[1])} (${m[2]} thread${m[2] === '1' ? '' : 's'})`;
  if (s.startsWith('· ')) return '· ' + sub(s.slice(2));
  // "Etiqueta: valor", "A · B · C" o "A / B" por partes.
  for (const sep of [' · ', ' / ', ' | ', ': ', ' → ']) {
    if (s.includes(sep)) {
      const parts = s.split(sep);
      const t = parts.map((p) => sub(p));
      if (t.some((x, i) => x !== parts[i])) return t.join(sep);
    }
  }
  return s;
}

function trText(v: string): string {
  const t = v.trim();
  if (!t || !/[a-záéíóúñ]/i.test(t)) return v;
  const r = tr(t);
  return r === t ? v : v.replace(t, r);
}

const ATTRS = ['title', 'placeholder', 'aria-label'];
const skip = (el: Element | null) => !!el && (!!el.closest('[translate="no"], [contenteditable="true"], textarea, script, style'));

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) { fixText(root as Text); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (skip(el)) return;
  fixAttrs(el);
  const it = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) fixText(n as Text);
    else fixAttrs(n as Element);
  }
}

function fixText(n: Text) {
  if (skip(n.parentElement)) return;
  const v = n.nodeValue ?? '';
  const t = trText(v);
  if (t !== v) n.nodeValue = t;
}

function fixAttrs(el: Element) {
  if (el.closest('[translate="no"]')) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v) { const t = trText(v); if (t !== v) el.setAttribute(a, t); }
  }
  if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit') && el.value) {
    const t = trText(el.value); if (t !== el.value) el.value = t;
  }
}

/** Arranca la traducción del DOM si el idioma es inglés. */
export async function startI18n() {
  const lang = getLang();
  document.documentElement.lang = lang;
  if (lang !== 'en') return;
  DICT = (await import('./en')).EN;
  walk(document.body);
  document.title = tr(document.title);
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'characterData') fixText(m.target as Text);
      else if (m.type === 'attributes') fixAttrs(m.target as Element);
      else m.addedNodes.forEach(walk);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
