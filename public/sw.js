/*
 * Service worker de Lienzo:
 *  1. Funciona sin conexión (red primero, caché como respaldo).
 *  2. Añade COOP/COEP a las respuestas: activa crossOriginIsolated (SharedArrayBuffer,
 *     WebAssembly con hilos) aunque el alojamiento no permita cabeceras (p. ej. GitHub Pages).
 */
const CACHE = 'lienzo-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let res;
    try {
      res = await fetch(req);
    } catch {
      const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      if (req.mode === 'navigate') { const index = await cache.match('./'); if (index) return index; }
      throw new Error('Sin conexión');
    }
    if (!res.ok || res.status === 206) return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    cache.put(req, out.clone()).catch(() => {});
    return out;
  })());
});
