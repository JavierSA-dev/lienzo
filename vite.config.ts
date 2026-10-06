import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// COOP/COEP activan crossOriginIsolated -> SharedArrayBuffer y hilos WASM
// (Photopea no lo tiene activado; nosotros sí, desde el día 1).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  // LibRaw trae su propio worker y su .wasm: se sirve tal cual (sin preempaquetar).
  optimizeDeps: { exclude: ['libraw-wasm'] },
  base: process.env.BASE_PATH ?? '/',
  // Dos páginas: la presentación en la raíz y el editor en /app/.
  build: { target: 'es2022', sourcemap: true, rollupOptions: { input: { main: 'index.html', app: 'app/index.html' } } },
});
