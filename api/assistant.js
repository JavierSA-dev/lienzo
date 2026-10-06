// Asistente de IA de Lienzo: función de Vercel (también sirve en cualquier Node 18+ con
// `node server/assistant-dev.mjs`). Reenvía la conversación a la API de mensajes de Anthropic
// con las herramientas que define la app y un mensaje de sistema fijo, y limita el uso gratuito.
//
// Variables de entorno:
//   ANTHROPIC_API_KEY   clave de la API (obligatoria)
//   ASSISTANT_MODEL     modelo (claude-sonnet-4-5 por defecto)
//   AI_DAILY_LIMIT      peticiones de IA al día por navegador (10)
//   AI_DAILY_IP_LIMIT   tope diario por IP, por si se borra el navegador (30)
//   AI_DAILY_RAW_LIMIT / AI_DAILY_RAW_IP_LIMIT  llamadas al modelo al día por navegador (120) y por IP (300)
//   AI_GLOBAL_DAILY_LIMIT  llamadas al modelo al día en toda la web (600): techo de gasto
//   PREMIUM_TOKENS      tokens separados por comas con uso ilimitado (usuarios de pago)
//   + el almacén de la cuota: Upstash Redis o Vercel Blob (ver api/_quota.js)
//
// GET /api/assistant devuelve la cuota del navegador que pregunta (para mostrarla en la app).
import { who, quota, spend, spendGlobal, storeName, DEVICE_LIMIT } from './_quota.js';

const PREMIUM = new Set((process.env.PREMIUM_TOKENS ?? '').split(',').filter(Boolean));
const TRIAL = `El asistente de IA está en pruebas y en desarrollo (irá mejorando): cada navegador tiene ${DEVICE_LIMIT} peticiones de IA al día. Las órdenes sencillas (mejorar, recortar, quitar el fondo…) no cuentan: se hacen en tu equipo.`;

const SYSTEM = `Eres el asistente de Lienzo, un editor de imágenes profesional (como Photoshop) que funciona en el navegador. Haces el trabajo tú: no des instrucciones al usuario para que lo haga él.
Recibes una miniatura del documento, un resumen (tamaño, capas con sus bounds, selección, estadísticas de tono y color) y la petición. Tras cada ronda de herramientas recibes una imagen de cómo ha quedado: compruébala y corrige lo que no esté bien antes de terminar.

Coordenadas: las herramientas usan píxeles del DOCUMENTO, nunca los de la imagen que ves. Todas las imágenes llevan una cuadrícula rosa con las coordenadas del documento rotuladas en amarillo (x en el borde superior, y en el izquierdo): lee las posiciones con ella. Para localizar algo con precisión (un logo, un texto, una cara) usa inspect sobre esa zona: devuelve una ampliación con una cuadrícula más fina. Antes de seleccionar, comprueba que el recuadro cubre lo que quieres según la cuadrícula.

Cómo trabajar bien:
- Fotos: prefiere capas de ajuste y el revelado (develop) con valores moderados. Para "mejorar", usa las estadísticas: exposición si p50 está lejos de ~118, contraste si p98-p2 < 200, sombras/luces si hay recortes, intensidad si la saturación es baja, temperatura si hay dominante.
- Dibujar o crear (un perro, un personaje, un logo, un icono, una ilustración, un fondo): usa draw_svg con un SVG completo y cuidado, como lo haría un buen ilustrador: formas orgánicas con curvas Bézier, 3-5 tonos por color (base, sombra, luz), ojos con brillo, contorno coherente, proporciones correctas y composición centrada. Si no hay documento, draw_svg crea uno.
- Si hay una SELECCIÓN activa (selection en el resumen y una segunda imagen con la zona ampliada), la petición se refiere a lo seleccionado salvo que diga otra cosa, y NO quites la selección antes de actuar: eliminar algo → content_aware_fill; cambiar su color → recolor; más claro/oscuro, contraste, saturación → adjustment_layer (la selección se usa como máscara); desenfocar o pixelar → filter; sustituirlo por otra cosa (p. ej. "cambia el sombrero por una gorra") → content_aware_fill y después draw_svg con x, y, width, height de la selección.
- Sustituir un texto o logo de una imagen (p. ej. cambiar "MINECRAFT" por "TERRARIA"): 1) inspect para ver sus límites exactos; 2) select rect que lo cubra con un margen pequeño; 3) content_aware_fill para borrarlo; 4) select none; 5) redibújalo con draw_svg en el MISMO recuadro (x, y, width, height del original) imitando el estilo: un <text> con text-anchor="middle", textLength igual al ancho útil y lengthAdjust="spacingAndGlyphs" para que ocupe lo mismo, font-family con fuentes del sistema ("Impact, 'Arial Black', sans-serif" para letras gruesas; monospace para estilo píxel), relleno con linearGradient si el original tiene degradado, stroke oscuro y paint-order="stroke", y un falso 3D/sombra con 2-6 copias desplazadas en un tono más oscuro debajo. Para un texto plano basta add_text (x en el centro con align center, y en la línea base, size ≈ alto de las mayúsculas × 1,35). Comprueba el resultado y ajústalo si no encaja.
- Texto tipo logo o titular: fuente con carácter, tamaño grande, stroke y shadow cuando haga falta contraste.
- Si algo no es posible con las herramientas, haz la mejor alternativa con ellas y dilo en una frase. Si un paso sale mal, deshazlo (undo) y cambia de enfoque; no repitas lo mismo más de una vez.

Responde al final con una o dos frases, en el idioma del usuario, diciendo qué has hecho. Sin Markdown complejo: como mucho **negrita**. No inventes resultados de herramientas.`;

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const send = (res, status, body, headers = {}) => {
  res.statusCode = status;
  for (const [k, v] of Object.entries({ 'Content-Type': 'application/json; charset=utf-8', ...headers })) res.setHeader(k, v);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

export default async function handler(req, res) {
  if (!res.getHeader('Cross-Origin-Resource-Policy')) res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  const id = who(req);
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
  const premium = !!token && PREMIUM.has(token);

  if (req.method === 'GET') {
    try {
      const q = await quota(id);
      return send(res, 200, { configured: !!process.env.ANTHROPIC_API_KEY, premium, ...q, trial: TRIAL, store: storeName });
    } catch (e) { return send(res, 200, { configured: !!process.env.ANTHROPIC_API_KEY, premium, limit: DEVICE_LIMIT, left: null, trial: TRIAL, error: String(e?.message ?? e) }); }
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Usa POST.' });
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, { error: 'El asistente no está configurado en este servidor (falta ANTHROPIC_API_KEY).' });
  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: 'JSON no válido.' }); }
  const { messages, tools } = body ?? {};
  if (!Array.isArray(messages) || !messages.length || messages.length > 40 || !Array.isArray(tools) || tools.length > 40) return send(res, 400, { error: 'Petición no válida.' });
  if (JSON.stringify(body).length > 1_500_000) return send(res, 413, { error: 'Petición demasiado grande.' });
  // Solo texto, imágenes y bloques de herramientas; como mucho 4 imágenes por mensaje.
  const okBlock = (b) => b && ['text', 'image', 'tool_use', 'tool_result'].includes(b.type) && (b.type !== 'image' || b.source?.type === 'base64');
  const imgs = (c) => (Array.isArray(c) ? c.reduce((n, b) => n + (b?.type === 'image' ? 1 : b?.type === 'tool_result' ? imgs(b.content) : 0), 0) : 0);
  if (!messages.every((m) => ['user', 'assistant'].includes(m?.role) && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.every(okBlock))) && imgs(m.content) <= 4)) {
    return send(res, 400, { error: 'Petición no válida.' });
  }

  // Una petición cuenta solo si hace algo: se cobra al llegar el PRIMER resultado de herramientas del turno
  // (las respuestas que solo son texto, como "no puedo hacer eso", no gastan cuota).
  const isToolResult = (m) => m?.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result');
  const last = messages[messages.length - 1];
  const newTurn = last?.role === 'user' && !isToolResult(last);
  let turnStart = messages.length - 1;
  while (turnStart > 0 && !(messages[turnStart]?.role === 'user' && !isToolResult(messages[turnStart]))) turnStart--;
  const firstToolRound = isToolResult(last) && messages.slice(turnStart + 1).filter(isToolResult).length === 1;
  let left = null;
  let q;
  try { q = await quota(id); } catch { return send(res, 503, { error: 'No se puede comprobar la cuota ahora mismo. Inténtalo en un momento.' }); }
  if (q.globalBlocked) return send(res, 429, { error: `La IA de pruebas ha llegado hoy a su límite de uso para todos (estamos en pruebas). Vuelve mañana; mientras, las órdenes sencillas siguen funcionando.`, left: q.left, limit: DEVICE_LIMIT });
  if (!premium) {
    left = q.left;
    // Los pasos de herramientas de una petición ya aceptada no se cortan a medias.
    if (q.rawBlocked) return send(res, 429, { error: 'Demasiadas peticiones por hoy desde este navegador. Vuelve mañana.', left: q.left, limit: DEVICE_LIMIT });
    if (newTurn && q.left <= 0) {
      return send(res, 402, { error: `Has usado las ${DEVICE_LIMIT} peticiones de IA de hoy. ${TRIAL} Mañana tendrás otras ${DEVICE_LIMIT}.`, left: 0, limit: DEVICE_LIMIT }, { 'X-Credits-Left': '0' });
    }
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ASSISTANT_MODEL ?? 'claude-sonnet-4-5', max_tokens: Number(process.env.ASSISTANT_MAX_TOKENS ?? 12000), system: SYSTEM, tools, messages }),
    });
    const j = await r.json();
    if (!r.ok) return send(res, 502, { error: j?.error?.message ?? `Error ${r.status} del modelo.` });
    if (premium) await spendGlobal(id).catch(() => {});
    else {
      await spend(id, firstToolRound).catch(() => {});
      if (firstToolRound) left = Math.max(0, (left ?? DEVICE_LIMIT) - 1);
    }
    return send(res, 200, { content: j.content, stop_reason: j.stop_reason, left, limit: DEVICE_LIMIT }, { 'X-Credits-Left': premium ? 'ilimitado' : String(left) });
  } catch (e) {
    return send(res, 502, { error: String(e?.message ?? e) });
  }
}
