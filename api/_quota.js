// Cuota diaria del asistente de IA (versión de pruebas).
//
// Se cuenta por NAVEGADOR (un identificador aleatorio que la app guarda en el navegador y envía en
// la cabecera X-Lienzo-Device) y, como red de seguridad, por IP con un tope mayor (varias personas
// pueden compartir IP en una oficina o en datos móviles; y borrar el navegador no da más usos).
// La dirección MAC no llega nunca a un servidor web, así que no se puede usar.
//
// Almacenamiento, el primero que esté configurado en Vercel:
//   1. Upstash Redis (Storage > Upstash): KV_REST_API_URL + KV_REST_API_TOKEN
//      (o UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Contadores atómicos. Recomendado.
//   2. Vercel Blob (Storage > Blob): BLOB_READ_WRITE_TOKEN. Un archivo pequeño por uso.
//   3. Memoria de la función: solo para desarrollo (se pierde al reiniciarse la instancia).
import crypto from 'node:crypto';

export const DEVICE_LIMIT = Number(process.env.AI_DAILY_LIMIT ?? 10);
export const IP_LIMIT = Number(process.env.AI_DAILY_IP_LIMIT ?? 30);
const SALT = process.env.QUOTA_SALT ?? 'lienzo';

const day = () => new Date().toISOString().slice(0, 10);
const hash = (s) => crypto.createHash('sha256').update(`${SALT}:${s}`).digest('hex').slice(0, 32);

/** Identidad de quien pide: navegador (si envía un id válido) e IP. */
export function who(req) {
  const ip = String(req.headers['x-forwarded-for'] ?? req.headers['x-real-ip'] ?? req.socket?.remoteAddress ?? 'anon').split(',')[0].trim();
  const dev = String(req.headers['x-lienzo-device'] ?? '');
  return { device: /^[a-z0-9-]{16,64}$/i.test(dev) ? hash(`d:${dev}`) : hash(`ip-as-device:${ip}`), ip: hash(`ip:${ip}`) };
}

// ------------------------------------------------------------------ almacenes

// La integración de Vercel puede añadir un prefijo a las variables (p. ej. STORAGE_KV_REST_API_URL).
const envEnding = (...ends) => {
  for (const end of ends) {
    if (process.env[end]) return process.env[end];
    const k = Object.keys(process.env).find((n) => n.endsWith(`_${end}`) && process.env[n]);
    if (k) return process.env[k];
  }
  return undefined;
};
const redisUrl = envEnding('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
const redisToken = envEnding('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');

async function redis(commands) {
  const r = await fetch(`${redisUrl.replace(/\/$/, '')}/pipeline`, {
    method: 'POST', headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`Redis ${r.status}`);
  return (await r.json()).map((x) => x.result);
}

const memory = new Map();

const store = redisUrl && redisToken ? {
  name: 'redis',
  async get(keys) { return (await redis([['MGET', ...keys]]))[0].map((v) => Number(v ?? 0)); },
  async incr(keys) { await redis(keys.flatMap((k) => [['INCR', k], ['EXPIRE', k, 172800]])); },
} : envEnding('BLOB_READ_WRITE_TOKEN') ? {
  name: 'blob',
  async get(keys) {
    const { list } = await import('@vercel/blob');
    return Promise.all(keys.map(async (k) => (await list({ prefix: `${k}/`, limit: 1000, token: envEnding('BLOB_READ_WRITE_TOKEN') })).blobs.length));
  },
  async incr(keys) {
    const { put } = await import('@vercel/blob');
    const access = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
    await Promise.all(keys.map(async (k) => {
      const path = `${k}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
      // El almacén puede ser público o privado: si no acepta uno, se usa el otro (solo guarda un "1").
      const token = envEnding('BLOB_READ_WRITE_TOKEN');
      try { await put(path, '1', { access, addRandomSuffix: false, token }); }
      catch { await put(path, '1', { access: access === 'private' ? 'public' : 'private', addRandomSuffix: false, token }); }
    }));
  },
} : {
  name: 'memory',
  async get(keys) { return keys.map((k) => memory.get(k) ?? 0); },
  async incr(keys) { for (const k of keys) memory.set(k, (memory.get(k) ?? 0) + 1); },
};

export const storeName = store.name;

const keysFor = (id) => [`lienzo-ai/${day()}/d/${id.device}`, `lienzo-ai/${day()}/ip/${id.ip}`];

/** Usos de hoy y cuántos quedan. */
export async function quota(id) {
  const [d, i] = await store.get(keysFor(id));
  const left = Math.max(0, Math.min(DEVICE_LIMIT - d, IP_LIMIT - i));
  return { limit: DEVICE_LIMIT, used: d, left, ipBlocked: i >= IP_LIMIT };
}

export async function spend(id) { await store.incr(keysFor(id)); }
