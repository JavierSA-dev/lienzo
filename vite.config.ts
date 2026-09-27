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
  base: process.env.BASE_PATH ?? '/',
  build: { target: 'es2022', sourcemap: true },
});
