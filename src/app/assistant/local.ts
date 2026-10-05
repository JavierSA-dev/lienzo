/**
 * Intérprete local del asistente (sin servidor ni coste): entiende peticiones habituales en
 * español e inglés y las convierte en llamadas a las herramientas. Para peticiones libres o
 * complejas se usa el modelo de lenguaje (servicio de IA configurable).
 */
import { parseColor } from './color';

export interface Step { tool: string; args: Record<string, unknown> }
export interface Stats { meanLuma: number; p2: number; p50: number; p98: number; meanSaturation: number; meanRGB: [number, number, number] }

const COLOR_WORDS = 'blanco|blanca|white|negro|negra|black|rojo|roja|red|verde|green|azul|blue|amarillo|amarilla|yellow|naranja|orange|morado|morada|purple|violeta|violet|rosa|pink|gris|gray|grey|cian|cyan|marrón|brown|dorado|dorada|gold|plata|silver';
const colorIn = (s: string) => {
  const hex = s.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i);
  if (hex) return hex[0];
  const m = s.match(new RegExp(`\\b(${COLOR_WORDS})\\b`, 'i'));
  if (!m) return null;
  const w = m[1].toLowerCase().replace(/a$/, (x) => (['blanca', 'negra', 'roja', 'amarilla', 'morada', 'dorada'].includes(m[1].toLowerCase()) ? 'o' : x));
  return parseColor(w) ? w : null;
};
const numIn = (s: string) => { const m = s.match(/(-?\d+(?:[.,]\d+)?)/); return m ? Number(m[1].replace(',', '.')) : null; };
const has = (s: string, re: RegExp) => re.test(s);

/** Mejora automática a partir de las estadísticas de la imagen. */
export function autoEnhance(st: Stats): Record<string, number> {
  const out: Record<string, number> = {};
  const exp = Math.log2(118 / Math.max(8, st.p50));
  if (Math.abs(exp) > 0.15) out.exposure = Math.round(Math.max(-1.5, Math.min(1.5, exp * 0.7)) * 100) / 100;
  const spread = st.p98 - st.p2;
  // El contraste oscurece los tonos bajos: con una imagen oscura se sube poco.
  if (spread < 200) out.contrast = Math.round(Math.min(25, (200 - spread) / 4) * (exp > 0.3 ? 0.4 : 1));
  if (st.p98 > 245) out.highlights = -25;
  if (st.p2 < 12) out.shadows = 25;
  if (st.meanSaturation < 35) out.vibrance = 25;
  // Dominante de color: compensa la temperatura si azul y rojo se separan mucho.
  const [r, , b] = st.meanRGB;
  if (Math.abs(r - b) > 25) out.temp = Math.round(Math.max(-30, Math.min(30, (b - r) / 2)));
  out.clarity = 10;
  out.sharpen = 30;
  return out;
}

/** Divide una petición en órdenes ("…, luego …", "… y …"). */
function clauses(text: string): string[] {
  // Los textos entre comillas no se parten.
  const q: string[] = [];
  const t = text.replace(/["“«][^"”»]*["”»]/g, (m) => `\u0001${q.push(m) - 1}\u0001`);
  const verbs = '(?:pon|ponle|añade|quita|sube|baja|aumenta|reduce|haz|aplica|recorta|gira|rota|exporta|descarga|convierte|cambia|selecciona|elimina|borra|dale|mejora|desenfoca|enfoca|voltea|add|remove|make|apply|crop|rotate|export|convert|select|increase|decrease|blur|sharpen|flip|enhance|resize|redimensiona)';
  return t
    .split(new RegExp(`\\s*(?:[,;]|\\.\\s|\\by luego\\b|\\bluego\\b|\\bdespués\\b|\\band then\\b|\\bthen\\b|\\b(?:y|and)\\b(?=\\s+${verbs}\\b))\\s*`, 'i'))
    .map((c) => c.replace(/\u0001(\d+)\u0001/g, (_m, i) => q[Number(i)]).trim())
    .filter(Boolean);
}

function one(c: string, st: Stats | null): Step[] | null {
  const s = c.toLowerCase();
  const n = numIn(s.replace(/\d+\s*[:x×]\s*\d+/, ''));
  const less = has(s, /\b(menos|baja|reduce|disminuye|quita(?! el fondo)|bajar|reducir|less|lower|decrease|reduce|darker|oscur)/);
  // --- IA y selección
  if (has(s, /(quita|elimina|borra|remove|delete|erase).*(fondo|background)|(fondo|background).*(transparente|transparent)/)) return [{ tool: 'remove_background', args: {} }];
  if (has(s, /(selecciona|select).*(sujeto|persona|subject|person|objeto principal)/)) return [{ tool: 'select', args: { what: 'subject' } }];
  if (has(s, /(deselecciona|quita la selección|deselect|select none)/)) return [{ tool: 'select', args: { what: 'none' } }];
  if (has(s, /(invierte|invert).*(selección|selection)/)) return [{ tool: 'select', args: { what: 'invert' } }];
  if (has(s, /(selecciona todo|select all)/)) return [{ tool: 'select', args: { what: 'all' } }];
  if (has(s, /(rellena|fill).*(según el contenido|content.?aware)|(borra|elimina|quita|remove).*(objeto|lo seleccionado|selección|selected|object)/)) return [{ tool: 'content_aware_fill', args: {} }];
  // --- deshacer
  if (has(s, /^(deshaz|deshacer|undo)\b/)) return [{ tool: 'undo', args: { steps: n && n > 0 && n < 50 ? n : 1 } }];
  // --- exportar
  const fmt = s.match(/\b(png|jpe?g|webp|gif|tiff?|pdf|svg)\b/);
  if (fmt && has(s, /(exporta|descarga|guarda|export|download|save)/)) return [{ tool: 'export', args: { format: fmt[1].replace('jpg', 'jpeg').replace('tif', 'tiff').replace('tifff', 'tiff'), quality: n && n <= 100 ? n : 90 } }];
  // --- texto
  const quoted = c.match(/["“«']([^"”»']+)["”»']/);
  if (quoted && has(s, /(texto|text|título|titulo|title|escribe|write|pon|añade|add|rótulo)/)) {
    const position = has(s, /(arriba|superior|top)/) ? 'top' : has(s, /(abajo|inferior|bottom)/) ? 'bottom' : 'center';
    return [{ tool: 'add_text', args: { text: quoted[1], position, ...(colorIn(s.replace(quoted[0].toLowerCase(), '')) ? { color: colorIn(s.replace(quoted[0].toLowerCase(), '')) } : {}), bold: has(s, /(negrita|bold)/) } }];
  }
  // --- formas
  const shp = s.match(/(círculo|circulo|elipse|circle|ellipse|rectángulo|rectangulo|cuadrado|rectangle|square|línea|linea|line|polígono|poligono|hexágono|hexagono|polygon|hexagon)/);
  if (shp && has(s, /(dibuja|añade|pon|crea|draw|add|create|insert)/)) {
    const kind = /c[ií]rculo|elipse|circle|ellipse/.test(shp[1]) ? 'ellipse' : /l[ií]nea|line/.test(shp[1]) ? 'line' : /pol|hex/.test(shp[1]) ? 'polygon' : 'rect';
    return [{ tool: 'add_shape', args: { shape: kind, ...(colorIn(s) ? { color: colorIn(s) } : {}) } }];
  }
  // --- capas
  if (has(s, /(nueva capa|capa nueva|new layer|add a layer)/)) return [{ tool: 'layer', args: { action: 'new' } }];
  if (has(s, /(duplica|duplicate).*(capa|layer)/)) return [{ tool: 'layer', args: { action: 'duplicate' } }];
  if (has(s, /(acopla|flatten)/)) return [{ tool: 'layer', args: { action: 'flatten' } }];
  if (has(s, /(rellena|pinta todo|fill)\b/) && colorIn(s)) return [{ tool: 'layer', args: { action: 'fill', color: colorIn(s) } }];
  if (has(s, /(opacidad|opacity)/) && n != null) return [{ tool: 'layer', args: { action: 'opacity', value: n } }];
  // --- modo de color
  if (has(s, /(escala de grises|grayscale|greyscale|modo gris)/)) return [{ tool: 'color_mode', args: { mode: 'gray' } }];
  if (has(s, /\bcmyk\b|(para|for) (imprenta|imprimir|print)/)) return [{ tool: 'color_mode', args: { mode: 'cmyk' } }];
  if (has(s, /(modo|mode)\s*rgb/)) return [{ tool: 'color_mode', args: { mode: 'rgb' } }];
  // --- geometría
  const ratio = s.match(/(\d+(?:[.,]\d+)?)\s*[:x×]\s*(\d+(?:[.,]\d+)?)/);
  if (has(s, /(recorta|recortar|crop|reencuadra)/)) {
    if (ratio && Number(ratio[1]) <= 32 && Number(ratio[2]) <= 32) return [{ tool: 'crop', args: { ratio: `${ratio[1]}:${ratio[2]}` } }];
    if (has(s, /(cuadrad|square|instagram)/)) return [{ tool: 'crop', args: { ratio: '1:1' } }];
    if (has(s, /(panorámic|panoramic|widescreen|youtube|16.9)/)) return [{ tool: 'crop', args: { ratio: '16:9' } }];
    if (has(s, /(historia|story|stories|reel|tiktok|vertical)/)) return [{ tool: 'crop', args: { ratio: '9:16' } }];
    if (has(s, /(retrato|portrait)/)) return [{ tool: 'crop', args: { ratio: '4:5' } }];
  }
  if (has(s, /(redimensiona|cambia el tamaño|tamaño de imagen|resize|scale|escala|reduce el tamaño|amplía|amplia|enlarge)/) && (n != null || ratio)) {
    if (ratio && Number(ratio[1]) > 32) return [{ tool: 'resize_image', args: { width: Number(ratio[1]), height: Number(ratio[2]) } }];
    if (has(s, /%|por ciento|percent/)) return [{ tool: 'resize_image', args: { percent: n } }];
    if (has(s, /(alto|altura|height)/)) return [{ tool: 'resize_image', args: { height: n } }];
    return [{ tool: 'resize_image', args: { width: n } }];
  }
  if (has(s, /(voltea|refleja|espejo|flip|mirror)/)) return [{ tool: 'rotate_flip', args: { flip: has(s, /vertical/) ? 'vertical' : 'horizontal' } }];
  if (has(s, /(gira|rota|rotate|turn)/)) {
    let deg = n ?? 90;
    if (has(s, /(izquierda|antihorario|left|counter)/)) deg = -Math.abs(deg);
    if (has(s, /(180|media vuelta|upside)/)) deg = 180;
    return [{ tool: 'rotate_flip', args: { degrees: deg } }];
  }
  // --- looks
  if (has(s, /(blanco y negro|b\/n|b&n|black and white|black & white|b&w|monocrom)/)) return [{ tool: 'adjustment_layer', args: { type: 'blackWhite' } }];
  if (has(s, /(sepia|vintage|retro|antigu|old photo)/)) return [{ tool: 'adjustment_layer', args: { type: 'photoFilter', params: { color: '#ac7a33', density: 55, preserveLuminosity: true } } }, { tool: 'develop', args: { saturation: -35, grain: 20, vignette: -25, contrast: -10 } }];
  if (has(s, /(cine|cinematic|película|teal|naranja y turquesa)/)) return [{ tool: 'adjustment_layer', args: { type: 'colorBalance', params: { shadows: [-15, 0, 20], midtones: [0, 0, 0], highlights: [15, 0, -15] } } }, { tool: 'develop', args: { contrast: 15, vignette: -15 } }];
  if (has(s, /(negativo|invierte|invert)/)) return [{ tool: 'auto', args: { kind: 'invert' } }];
  if (has(s, /(desatura|desaturate|sin color|quita el color)/)) return [{ tool: 'auto', args: { kind: 'desaturate' } }];
  if (has(s, /(posteriza|posterize)/)) return [{ tool: 'adjustment_layer', args: { type: 'posterize', params: { levels: n && n >= 2 ? n : 6 } } }];
  if (has(s, /(umbral|threshold)/)) return [{ tool: 'adjustment_layer', args: { type: 'threshold', params: { level: n ?? 128 } } }];
  // --- correcciones automáticas y revelado
  if (has(s, /(tono automático|auto ?tone)/)) return [{ tool: 'auto', args: { kind: 'autoTone' } }];
  if (has(s, /(contraste automático|auto ?contrast)/)) return [{ tool: 'auto', args: { kind: 'autoContrast' } }];
  if (has(s, /(color automático|auto ?color|corrige el color|white balance|balance de blancos)/)) return [{ tool: 'auto', args: { kind: 'autoColor' } }];
  if (has(s, /(mejora|mejorar|mejórala|arregla|optimiza|retoca|enhance|improve|fix|auto)/) && has(s, /(foto|imagen|photo|image|picture|automátic|auto|^mejora|^enhance|^improve|^arregla|^retoca|^fix)/)) {
    return [{ tool: 'develop', args: st ? autoEnhance(st) : { contrast: 15, vibrance: 20, clarity: 10, sharpen: 30 } }];
  }
  const dev: Record<string, number> = {};
  const amt = (base: number, scale = 1) => (n != null && Math.abs(n) <= 100 ? Math.abs(n) * scale : base) * (less ? -1 : 1);
  if (has(s, /(brillo|luz|luminosidad|brightness|exposici|exposure|aclara|más clara|más claro|brighter|lighten|oscurec|darken|darker)/)) {
    const darker = has(s, /(oscurec|darken|darker|menos luz|menos brillo|baja)/);
    const v = n != null && Math.abs(n) <= 100 ? Math.abs(n) / 40 : 0.5;
    dev.exposure = Math.round((darker ? -v : v) * 100) / 100;
  }
  if (has(s, /(contraste|contrast)/)) dev.contrast = amt(25);
  if (has(s, /(saturaci|saturat|más color|colores vivos|vivid|vibrant|intensidad|vibrance|colorido)/)) { dev.vibrance = amt(30); if (!less) dev.saturation = 10; else dev.saturation = amt(30); }
  if (has(s, /(cálid|calid|warm|caliente)/)) dev.temp = amt(25);
  if (has(s, /(frí[ao]|fria|frio|cool|cold)/)) dev.temp = -Math.abs(amt(25));
  if (has(s, /(sombras|shadows)/)) dev.shadows = amt(35);
  if (has(s, /(luces|iluminaciones|highlights|cielo quemado)/)) dev.highlights = less || has(s, /(recupera|recover)/) ? -Math.abs(amt(35)) : amt(35);
  if (has(s, /(claridad|clarity|detalle|detail)/)) dev.clarity = amt(25);
  if (has(s, /(neblina|bruma|haze|dehaze)/)) dev.dehaze = has(s, /(añade|add|más)/) && !has(s, /(quita|remove|elimina)/) ? -25 : 30;
  if (has(s, /(viñeta|vignette)/)) dev.vignette = less ? 20 : -Math.abs(amt(30));
  if (has(s, /(grano|grain)/)) dev.grain = Math.abs(amt(25));
  if (has(s, /(ruido|noise|denoise)/) && has(s, /(reduce|quita|elimina|menos|remove|reduce|denoise|limpia)/)) dev.noise = n != null && n <= 100 ? n : 40;
  if (has(s, /(enfoca|nitidez|sharpen|sharper|más nítid|mas nitid|crisp)/) && !has(s, /desenfoc/)) dev.sharpen = n != null && n <= 150 ? n : 60;
  if (Object.keys(dev).length) return [{ tool: 'develop', args: dev }];
  if (has(s, /(desenfoca|difumina|blur|desenfoque)/)) {
    if (has(s, /(movimiento|motion)/)) return [{ tool: 'filter', args: { name: 'motionBlur', distance: n ?? 20, angle: 0 } }];
    return [{ tool: 'filter', args: { name: 'gaussianBlur', radius: n ?? 8 } }];
  }
  if (has(s, /(pixela|pixelate|mosaico|mosaic)/)) return [{ tool: 'filter', args: { name: 'mosaic', cell: n ?? 16 } }];
  if (has(s, /(añade ruido|add noise)/)) return [{ tool: 'filter', args: { name: 'addNoise', amount: n ?? 10 } }];
  if (has(s, /(relieve|emboss)/)) return [{ tool: 'filter', args: { name: 'emboss' } }];
  if (has(s, /(bordes|edges)/) && has(s, /(halla|busca|find|detect)/)) return [{ tool: 'filter', args: { name: 'findEdges' } }];
  return null;
}

/** Plan de pasos para una petición, o null si no se entiende. */
export function planLocal(text: string, stats: Stats | null): Step[] | null {
  const out: Step[] = [];
  for (const c of clauses(text)) {
    const r = one(c, stats);
    if (!r) return null;
    out.push(...r);
  }
  return out.length ? out : null;
}
