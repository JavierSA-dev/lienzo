import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './app/styles.css';
import { startI18n } from './app/i18n';

if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype)) {
  document.getElementById('root')!.innerHTML =
    '<p style="padding:24px">Este navegador no soporta OffscreenCanvas. Usa Chrome, Edge, Firefox o Safari 16.4+.</p>';
} else {
  // En inglés se carga antes el diccionario para no ver la interfaz en español un instante.
  void startI18n().finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
}

// PWA: instalable, sin conexión y con aislamiento entre orígenes en hosting estático.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then(() => {
    // Primera visita sin cabeceras COOP/COEP del servidor: recarga una vez cuando el SW controla la página.
    if (!crossOriginIsolated && !sessionStorage.getItem('coi-reload')) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        sessionStorage.setItem('coi-reload', '1');
        location.reload();
      });
    }
  }).catch(() => {});
}

// Abrir archivos desde el sistema operativo con la app instalada ("Abrir con").
const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
lq?.setConsumer(async ({ files }) => {
  const { openFile } = await import('./app/commands');
  for (const h of files) await openFile(await h.getFile());
});
