// Proxy de relleno generativo con créditos por usuario.
//
//   OPENAI_API_KEY=sk-...  node server/generative-proxy.mjs
//   UPSTREAM=mock          node server/generative-proxy.mjs   (sin IA real: devuelve un degradado, para probar)
//
// Variables:
//   PORT            puerto (8787)
//   FREE_CREDITS    generaciones gratis por día y usuario (5)
//   ALLOW_ORIGIN    origen permitido para CORS (*)
//   PREMIUM_TOKENS  lista separada por comas de tokens con créditos ilimitados (usuarios de pago)
//
// La app envía POST multipart (image, mask, prompt) y recibe image/png.
// En producción: guarda los créditos en una base de datos (Redis, Postgres) y
// autentica con cuentas reales; aquí se guardan en memoria para empezar.
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.PORT ?? 8787);
const FREE = Number(process.env.FREE_CREDITS ?? 5);
const ORIGIN = process.env.ALLOW_ORIGIN ?? '*';
const PREMIUM = new Set((process.env.PREMIUM_TOKENS ?? '').split(',').filter(Boolean));
const UPSTREAM = process.env.UPSTREAM ?? 'openai';
const usage = new Map(); // clave -> { day, count }

function creditsLeft(key) {
  const day = new Date().toISOString().slice(0, 10);
  const u = usage.get(key);
  if (!u || u.day !== day) return FREE;
  return FREE - u.count;
}
function spend(key) {
  const day = new Date().toISOString().slice(0, 10);
  const u = usage.get(key);
  usage.set(key, !u || u.day !== day ? { day, count: 1 } : { day, count: u.count + 1 });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

/** Imagen de prueba: PNG sin comprimir generado a mano (degradado). */
function mockPng(w = 256, h = 256) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = 40 + (x * 180) / w; raw[o + 1] = 120; raw[o + 2] = 200 - (y * 150) / h; raw[o + 3] = 255;
    }
  }
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function openaiEdit(body, contentType) {
  // Reenvía el multipart tal cual a la API de edición de imágenes, añadiendo el modelo.
  const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  const out = new FormData();
  out.append('model', process.env.OPENAI_MODEL ?? 'gpt-image-1');
  out.append('image', form.get('image'), 'image.png');
  out.append('mask', form.get('mask'), 'mask.png');
  out.append('prompt', form.get('prompt') || 'rellena la zona de forma coherente con el resto de la imagen');
  const r = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: out,
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return Buffer.from(j.data[0].b64_json, 'base64');
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-Credits-Left');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
  const key = token || req.socket.remoteAddress;
  const premium = PREMIUM.has(token);
  if (!premium && creditsLeft(key) <= 0) {
    res.writeHead(402, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Sin créditos para hoy. Hazte Premium para generar sin límite.');
  }
  try {
    const body = await readBody(req);
    const png = UPSTREAM === 'mock' ? mockPng() : await openaiEdit(body, req.headers['content-type']);
    if (!premium) spend(key);
    res.writeHead(200, { 'Content-Type': 'image/png', 'X-Credits-Left': premium ? 'ilimitado' : String(creditsLeft(key)) });
    res.end(png);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(e.message ?? e));
  }
}).listen(PORT, () => console.log(`Relleno generativo en http://localhost:${PORT} (${UPSTREAM}, ${FREE} créditos/día)`));
