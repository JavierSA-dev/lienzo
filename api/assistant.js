// Asistente de IA de Lienzo: función de Vercel (también sirve en cualquier Node 18+ con
// `node server/assistant-dev.mjs`). Reenvía la conversación a la API de mensajes de Anthropic
// con las herramientas que define la app y un mensaje de sistema fijo, y limita el uso gratuito.
//
// Variables de entorno:
//   ANTHROPIC_API_KEY   clave de la API (obligatoria)
//   ASSISTANT_MODEL     modelo (claude-sonnet-4-5 por defecto)
//   AI_DAILY_LIMIT      peticiones de IA al día por navegador (10)
//   AI_DAILY_IP_LIMIT   tope diario por IP, por si se borra el navegador (30)
//   PREMIUM_TOKENS      tokens separados por comas con uso ilimitado (usuarios de pago)
//   + el almacén de la cuota: Upstash Redis o Vercel Blob (ver api/_quota.js)
//
// GET /api/assistant devuelve la cuota del navegador que pregunta (para mostrarla en la app).
import { who, quota, spend, storeName, DEVICE_LIMIT } from './_quota.js';

const PREMIUM = new Set((process.env.PREMIUM_TOKENS ?? '').split(',').filter(Boolean));
const TRIAL = `Lienzo está en pruebas: cada navegador tiene ${DEVICE_LIMIT} peticiones de IA al día. Las órdenes sencillas (mejorar, recortar, quitar el fondo…) no cuentan: se hacen en tu equipo.`;

const SYSTEM = `Eres el asistente de Lienzo, un editor de imágenes profesional (como Photoshop) que funciona en el navegador. Haces el trabajo tú: no des instrucciones al usuario para que lo haga él.
Recibes una miniatura del documento, un resumen (tamaño, capas con sus bounds, selección, estadísticas de tono y color) y la petición. Tras cada ronda de herramientas recibes una imagen de cómo ha quedado: compruébala y corrige lo que no esté bien antes de terminar.

Coordenadas: las herramientas usan píxeles del DOCUMENTO, no de la miniatura (la nota de la miniatura dice la escala). Para localizar algo con precisión (un logo, un texto, una cara) usa inspect sobre la zona antes de seleccionar o borrar.

Cómo trabajar bien:
- Fotos: prefiere capas de ajuste y el revelado (develop) con valores moderados. Para "mejorar", usa las estadísticas: exposición si p50 está lejos de ~118, contraste si p98-p2 < 200, sombras/luces si hay recortes, intensidad si la saturación es baja, temperatura si hay dominante.
- Dibujar o crear (un perro, un personaje, un logo, un icono, una ilustración, un fondo): usa draw_svg con un SVG completo y cuidado, como lo haría un buen ilustrador: formas orgánicas con curvas Bézier, 3-5 tonos por color (base, sombra, luz), ojos con brillo, contorno coherente, proporciones correctas y composición centrada. Si no hay documento, draw_svg crea uno.
- Sustituir un texto o logo de una imagen (p. ej. cambiar "MINECRAFT" por "TERRARIA"): 1) inspect para ver sus límites exactos; 2) select rect que lo cubra con un margen pequeño; 3) content_aware_fill para borrarlo; 4) select none; 5) add_text en el MISMO sitio y tamaño (x centrado en el centro del original con align center, y en su línea base, size ≈ alto de las mayúsculas originales × 1,35) imitando el estilo: fuente parecida (Impact, Anton, Bebas Neue, Press Start 2P para píxel…), color y stroke/shadow si el original los tiene. Comprueba el resultado en la imagen y ajústalo.
- Texto tipo logo o titular: fuente con carácter, tamaño grande, stroke y shadow cuando haga falta contraste.
- Si algo no es posible con las herramientas, haz la mejor alternativa con ellas y dilo en una frase.

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

  // Una petición cuenta solo si hace algo: se cobra al llegar el PRIMER resultado de herramientas del turno
  // (las respuestas que solo son texto, como "no puedo hacer eso", no gastan cuota).
  const isToolResult = (m) => m?.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result');
  const last = messages[messages.length - 1];
  const newTurn = last?.role === 'user' && !isToolResult(last);
  let turnStart = messages.length - 1;
  while (turnStart > 0 && !(messages[turnStart]?.role === 'user' && !isToolResult(messages[turnStart]))) turnStart--;
  const firstToolRound = isToolResult(last) && messages.slice(turnStart + 1).filter(isToolResult).length === 1;
  let left = null;
  if (!premium) {
    let q;
    try { q = await quota(id); } catch { return send(res, 503, { error: 'No se puede comprobar la cuota ahora mismo. Inténtalo en un momento.' }); }
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
    if (!premium) {
      await spend(id, firstToolRound).catch(() => {});
      if (firstToolRound) left = Math.max(0, (left ?? DEVICE_LIMIT) - 1);
    }
    return send(res, 200, { content: j.content, stop_reason: j.stop_reason, left, limit: DEVICE_LIMIT }, { 'X-Credits-Left': premium ? 'ilimitado' : String(left) });
  } catch (e) {
    return send(res, 502, { error: String(e?.message ?? e) });
  }
}
