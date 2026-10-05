// Servidor local del asistente para desarrollo:  ANTHROPIC_API_KEY=... node server/assistant-dev.mjs
// y en Lienzo, Asistente > Ajustes > dirección http://localhost:8788/api/assistant
import http from 'node:http';
import handler from '../api/assistant.js';

const PORT = Number(process.env.PORT ?? 8788);
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN ?? '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-Credits-Left');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  return handler(req, res);
}).listen(PORT, () => console.log(`Asistente en http://localhost:${PORT}/api/assistant`));
