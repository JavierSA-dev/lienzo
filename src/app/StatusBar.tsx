import { useEffect, useState } from 'react';
import { useStore } from './store';
import { engine } from '../engine/client';

export function StatusBar() {
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const cursor = useStore((s) => s.cursor);
  const perf = useStore((s) => s.perf);
  const busy = useStore((s) => s.busy);
  const renderer = useStore((s) => s.renderer);
  const [zoomText, setZoomText] = useState('');
  useEffect(() => setZoomText(`${Math.round(view.zoom * 1000) / 10}%`), [view.zoom]);

  return (
    <footer className="statusbar">
      {doc.open && (
        <>
          <input
            className="zoom"
            value={zoomText}
            aria-label="Zoom"
            onChange={(e) => setZoomText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key !== 'Enter') return;
              const v = parseFloat(zoomText.replace(',', '.'));
              if (v > 0) engine.call('zoomTo', v / 100);
              (e.target as HTMLInputElement).blur();
            }}
            onBlur={() => setZoomText(`${Math.round(view.zoom * 1000) / 10}%`)}
          />
          <span>{doc.width} × {doc.height} px</span>
          <span>{doc.layers.length} capa{doc.layers.length === 1 ? '' : 's'}</span>
          {cursor && cursor.x >= 0 && cursor.y >= 0 && cursor.x < doc.width && cursor.y < doc.height && <span>X: {cursor.x} Y: {cursor.y}</span>}
        </>
      )}
      <span className="grow" />
      {busy && (
        <>
          <span>{busy.label}</span>
          {busy.progress !== undefined && <div className="progress"><div style={{ width: `${busy.progress * 100}%` }} /></div>}
        </>
      )}
      {perf && <span className="good" title="La interfaz no se bloquea: el trabajo corre en el worker">{perf.label}: {perf.ms < 10 ? perf.ms.toFixed(1) : Math.round(perf.ms)} ms</span>}
      <span title={renderer}>Motor: worker · WebGL2</span>
    </footer>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  );
}
