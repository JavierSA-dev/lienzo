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

const SYSTEM = `Eres el asistente de Lienzo, un editor de imágenes profesional (como Photoshop) que funciona en el navegador.
Recibes una miniatura del documento, un resumen (tamaño, capas, selección, estadísticas de tono y color) y la petición del usuario.
Cumple la petición llamando a las herramientas; prefiere ajustes no destructivos (capas de ajuste) y valores moderados y profesionales.
Para "mejorar" una foto, usa las estadísticas: exposición si la mediana (p50) está lejos de ~118, contraste si p98-p2 < 200, sombras/luces si hay recortes, intensidad si la saturación media es baja, temperatura si hay dominante (meanRGB).
Si la petición es ambigua, elige la interpretación más útil y hazla. Si algo no es posible con las herramientas, dilo y propone la alternativa más cercana.
Responde al final con una frase breve, en el idioma del usuario, diciendo qué has hecho. No inventes resultados de herramientas.`;

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

  // Solo cuenta el primer paso de cada petición (no las respuestas de las herramientas).
  const last = messages[messages.length - 1];
  const newTurn = last?.role === 'user' && !(Array.isArray(last.content) && last.content.some((b) => b?.type === 'tool_result'));
  let left = null;
  if (!premium) {
    let q;
    try { q = await quota(id); } catch { return send(res, 503, { error: 'No se puede comprobar la cuota ahora mismo. Inténtalo en un momento.' }); }
    left = q.left;
    // Los pasos de herramientas de una petición ya aceptada no se cortan a medias.
    if (newTurn && q.left <= 0) {
      return send(res, 402, { error: `Has usado las ${DEVICE_LIMIT} peticiones de IA de hoy. ${TRIAL} Mañana tendrás otras ${DEVICE_LIMIT}.`, left: 0, limit: DEVICE_LIMIT }, { 'X-Credits-Left': '0' });
    }
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ASSISTANT_MODEL ?? 'claude-sonnet-4-5', max_tokens: 1500, system: SYSTEM, tools, messages }),
    });
    const j = await r.json();
    if (!r.ok) return send(res, 502, { error: j?.error?.message ?? `Error ${r.status} del modelo.` });
    if (newTurn && !premium) { await spend(id).catch(() => {}); left = Math.max(0, (left ?? DEVICE_LIMIT) - 1); }
    return send(res, 200, { content: j.content, stop_reason: j.stop_reason, left, limit: DEVICE_LIMIT }, { 'X-Credits-Left': premium ? 'ilimitado' : String(left) });
  } catch (e) {
    return send(res, 502, { error: String(e?.message ?? e) });
  }
}
