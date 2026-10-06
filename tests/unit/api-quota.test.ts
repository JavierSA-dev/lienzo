import { describe, it, expect, beforeAll, vi } from 'vitest';

// Respuesta simulada de la API de mensajes.
const anthropic = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 }));

type Res = { statusCode: number; headers: Record<string, string>; body: string; setHeader(k: string, v: string): void; getHeader(k: string): string | undefined; end(b: string): void };
const mkRes = (): Res => ({ statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; }, end(b) { this.body = b; } });
const req = (method: string, device: string, ip: string, body?: unknown) => ({ method, headers: { 'x-lienzo-device': device, 'x-forwarded-for': ip }, body, socket: {} });
const msg = { messages: [{ role: 'user', content: 'hola' }], tools: [] };
// Segundo paso de una petición: el primer resultado de herramientas (es cuando se cobra).
const step2 = { messages: [{ role: 'user', content: 'hola' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'develop', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }], tools: [] };
const step3 = { messages: [...step2.messages, { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'develop', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }], tools: [] };

let handler: (rq: unknown, rs: Res) => Promise<void>;
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.AI_GLOBAL_DAILY_LIMIT = '400';
  delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.BLOB_READ_WRITE_TOKEN;
  vi.stubGlobal('fetch', anthropic);
  handler = (await import('../../api/assistant.js')).default;
});

describe('cuota del asistente (10 al día por navegador)', () => {
  it('GET informa de la cuota', async () => {
    const r = mkRes();
    await handler(req('GET', 'aaaaaaaaaaaaaaaaaaaa', '1.1.1.1'), r);
    const j = JSON.parse(r.body);
    expect([r.statusCode, j.limit, j.left, j.configured]).toEqual([200, 10, 10, true]);
    expect(j.trial).toMatch(/pruebas/);
  });
  it('10 peticiones (con herramientas) y la 11.ª se rechaza con 402', async () => {
    for (let i = 0; i < 10; i++) {
      for (const [b, left] of [[msg, 10 - i], [step2, 9 - i], [step3, 9 - i]] as const) {
        const r = mkRes();
        await handler(req('POST', 'bbbbbbbbbbbbbbbbbbbb', '2.2.2.2', b), r);
        expect(r.statusCode).toBe(200);
        expect(JSON.parse(r.body).left).toBe(left);
      }
    }
    const r = mkRes();
    await handler(req('POST', 'bbbbbbbbbbbbbbbbbbbb', '2.2.2.2', msg), r);
    expect(r.statusCode).toBe(402);
    expect(JSON.parse(r.body).error).toMatch(/10 peticiones de IA de hoy.*pruebas/);
  });
  it('una respuesta solo de texto (no hace nada) no gasta cuota', async () => {
    for (let i = 0; i < 3; i++) { const r = mkRes(); await handler(req('POST', 'cccccccccccccccccccc', '3.3.3.3', msg), r); expect(JSON.parse(r.body).left).toBe(10); }
  });
  it('otro navegador en la misma IP tiene su cuota, hasta el tope de la IP (30)', async () => {
    for (let d = 0; d < 3; d++) for (let i = 0; i < 10; i++) { const r = mkRes(); await handler(req('POST', `dev${d}-xxxxxxxxxxxxxxxx`, '4.4.4.4', step2), r); expect(r.statusCode).toBe(200); }
    const r = mkRes();
    await handler(req('POST', 'otro-navegador-nuevo-123', '4.4.4.4', msg), r);
    expect(r.statusCode).toBe(402);
  });
  it('cambiar el id del navegador en cada petición no da llamadas ilimitadas (tope por IP: 300)', async () => {
    let last = 0;
    for (let i = 0; i < 301; i++) { const r = mkRes(); await handler(req('POST', `rot-${i}-xxxxxxxxxxxxxxxx`, '5.5.5.5', msg), r); last = r.statusCode; if (i < 300) expect(r.statusCode).toBe(200); }
    expect(last).toBe(429);
  });
  it('techo global de llamadas al día para toda la web', async () => {
    let r = mkRes();
    for (let i = 0; i < 60 && r.statusCode !== 429; i++) { r = mkRes(); await handler(req('POST', `glob-${i}-xxxxxxxxxxxxxxx`, `6.6.6.${i}`, msg), r); }
    expect(r.statusCode).toBe(429);
    expect(JSON.parse(r.body).error).toMatch(/límite de uso para todos/);
  });
  it('rechaza bloques que la app no envía (p. ej. documentos o imágenes por URL)', async () => {
    const r = mkRes();
    await handler(req('POST', 'eeeeeeeeeeeeeeeeeeee', '7.7.7.7', { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'x' } }] }], tools: [] }), r);
    expect(r.statusCode).toBe(400);
  });
});
