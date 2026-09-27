import { FilePlus, FolderOpen } from 'lucide-react';
import { engine } from '../engine/client';
import { openFile } from './commands';
import { useStore } from './store';
import { APP_NAME } from './brand';

export const PRESETS = [
  { name: 'Por defecto', w: 1920, h: 1080 },
  { name: 'Instagram cuadrado', w: 1080, h: 1080 },
  { name: 'Historia / Reel', w: 1080, h: 1920 },
  { name: 'Miniatura YouTube', w: 1280, h: 720 },
  { name: 'A4 a 300 ppp', w: 2480, h: 3508 },
  { name: '4K UHD', w: 3840, h: 2160 },
];

export function Home({ dragOver }: { dragOver: boolean }) {
  const setDialog = useStore((s) => s.setDialog);
  const ready = useStore((s) => s.ready);
  return (
    <div className="home" onPointerDown={(e) => e.stopPropagation()}>
      <div className="home-inner">
        <h1>{APP_NAME}</h1>
        <p>Editor de imágenes en el navegador. Tus archivos no salen de tu equipo.</p>
        <div className="home-actions">
          <button className="btn primary" disabled={!ready} onClick={() => setDialog('new')}><FilePlus size={16} /> Proyecto nuevo</button>
          <button className="btn" disabled={!ready} onClick={() => openFile()}><FolderOpen size={16} /> Abrir desde el ordenador</button>
        </div>
        <div className={`drop ${dragOver ? 'over' : ''}`}>
          Suelta aquí un archivo PSD, PNG, JPEG, WebP, GIF o AVIF
        </div>
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.name} className="preset" disabled={!ready} onClick={() => engine.call('newDoc', p.w, p.h, 'white', `${p.name}.psd`)}>
              <b>{p.name}</b>
              <span>{p.w} × {p.h} px</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
