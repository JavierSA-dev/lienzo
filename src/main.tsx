import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './app/styles.css';

if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype)) {
  document.getElementById('root')!.innerHTML =
    '<p style="padding:24px">Este navegador no soporta OffscreenCanvas. Usa Chrome, Edge, Firefox o Safari 16.4+.</p>';
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
