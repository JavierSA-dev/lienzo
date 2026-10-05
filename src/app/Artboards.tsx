// Mesas de trabajo (varias piezas en un documento: post, historia, miniatura…) y Exportar como con varios tamaños.
import { useState } from 'react';
import { engine } from '../engine/client';
import { useStore, toHex, toRgba } from './store';
import { Modal } from './Dialogs';
import { download } from './commands';
import { makeZip } from './zip';
import type { LayerInfo, RGBA } from '../engine/types';

/** Medidas habituales en redes sociales, web e impresión. */
export const SIZES: [string, number, number][] = [
  ['Instagram publicación (1:1)', 1080, 1080], ['Instagram vertical (4:5)', 1080, 1350], ['Historia / Reel / TikTok', 1080, 1920],
  ['Miniatura de YouTube', 1280, 720], ['Banner de YouTube', 2560, 1440], ['Portada de Facebook', 820, 312], ['Publicación de Facebook', 1200, 630],
  ['Publicación de X', 1600, 900], ['Cabecera de X', 1500, 500], ['Banner de LinkedIn', 1584, 396], ['Publicación de LinkedIn', 1200, 627],
  ['Pin de Pinterest', 1000, 1500], ['Full HD', 1920, 1080], ['Móvil', 1170, 2532], ['A4 a 300 ppp', 2480, 3508],
];

const BG_OPTS: [string, RGBA | null][] = [['Blanco', [255, 255, 255, 255]], ['Negro', [0, 0, 0, 255]], ['Transparente', null]];

export function NewArtboardDialog({ close }: { close: () => void }) {
  const [i, setI] = useState(0);
  const [w, setW] = useState(SIZES[0][1]), [h, setH] = useState(SIZES[0][2]);
  const [name, setName] = useState('');
  const [bg, setBg] = useState(0);
  return (
    <Modal title="Nueva mesa de trabajo" okLabel="Crear" onClose={close} onOk={() => { engine.call('newArtboard', { w, h, name: name.trim() || undefined, bg: BG_OPTS[bg][1] }); close(); }}>
      <label className="field">Medida
        <select value={i} aria-label="Medida" onChange={(e) => { const k = Number(e.target.value); setI(k); if (k >= 0) { setW(SIZES[k][1]); setH(SIZES[k][2]); if (!name) setName(''); } }}>
          {SIZES.map(([n, sw, sh], k) => <option key={n} value={k}>{n} · {sw} × {sh}</option>)}
          <option value={-1}>Personalizada</option>
        </select>
      </label>
      <label className="field">Nombre<input value={name} placeholder={i >= 0 ? SIZES[i][0] : 'Mesa de trabajo'} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">Anchura (px)<input type="number" min={1} max={30000} value={w} onChange={(e) => { setI(-1); setW(Math.max(1, Number(e.target.value) || 1)); }} /></label>
      <label className="field">Altura (px)<input type="number" min={1} max={30000} value={h} onChange={(e) => { setI(-1); setH(Math.max(1, Number(e.target.value) || 1)); }} /></label>
      <label className="field">Fondo
        <select value={bg} onChange={(e) => setBg(Number(e.target.value))}>{BG_OPTS.map(([n], k) => <option key={n} value={k}>{n}</option>)}</select>
      </label>
      <span className="hint">Se coloca a la derecha de las demás; el lienzo crece si hace falta. Exportar como… genera un archivo por mesa.</span>
    </Modal>
  );
}

export function ArtboardProperties({ L }: { L: LayerInfo }) {
  const a = L.artboard!;
  const set = (p: object) => engine.call('setArtboard', L.id, p);
  const num = (label: string, key: 'x' | 'y' | 'w' | 'h') => (
    <label className="char-field"><span>{label}</span>
      <input type="number" value={a[key]} aria-label={label} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') set({ [key]: Number((e.target as HTMLInputElement).value) }); }}
        onBlur={(e) => { const v = Number(e.target.value); if (v !== a[key]) set({ [key]: v }); }} />
    </label>
  );
  const match = SIZES.findIndex(([, w, h]) => w === a.w && h === a.h);
  return (
    <div className="text-props">
      <label className="adj-row"><span>Medida</span>
        <select value={match} aria-label="Medida de la mesa" onChange={(e) => { const k = Number(e.target.value); if (k >= 0) set({ w: SIZES[k][1], h: SIZES[k][2] }); }}>
          {match < 0 && <option value={-1}>Personalizada</option>}
          {SIZES.map(([n, w, h], k) => <option key={n} value={k}>{n} · {w} × {h}</option>)}
        </select>
      </label>
      <div className="char-row">{num('An', 'w')}{num('Al', 'h')}{num('X', 'x')}{num('Y', 'y')}</div>
      <div className="char-row">
        <span className="hint">Fondo:</span>
        {BG_OPTS.map(([n, c]) => <button key={n} className={`chip ${JSON.stringify(a.bg) === JSON.stringify(c) ? 'on' : ''}`} onClick={() => set({ bg: c })}>{n}</button>)}
        <input type="color" aria-label="Color de fondo de la mesa" value={a.bg ? toHex(a.bg) : '#ffffff'} onChange={(e) => set({ bg: toRgba(e.target.value) })} />
      </div>
    </div>
  );
}

/** Nombres de las mesas de trabajo sobre el lienzo (como Photoshop). */
export function ArtboardLabels({ X, Y }: { X: (x: number) => number; Y: (y: number) => number }) {
  const layers = useStore((s) => s.doc.layers);
  const active = useStore((s) => s.doc.activeLayerId);
  const abs = layers.filter((l) => l.artboard && l.visible);
  if (!abs.length) return null;
  return (
    <g className="artboard-labels">
      {abs.map((l) => (
        <g key={l.id}>
          <rect className={`artboard-frame ${l.id === active ? 'on' : ''}`} x={X(l.artboard!.x)} y={Y(l.artboard!.y)} width={X(l.artboard!.x + l.artboard!.w) - X(l.artboard!.x)} height={Y(l.artboard!.y + l.artboard!.h) - Y(l.artboard!.y)} />
          <text className="artboard-name" x={X(l.artboard!.x)} y={Y(l.artboard!.y) - 6}>{l.name}</text>
        </g>
      ))}
    </g>
  );
}

type ExportFmt = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/tiff' | 'application/pdf' | 'image/svg+xml';
const FORMATS: [ExportFmt, string][] = [['image/png', 'PNG'], ['image/jpeg', 'JPEG'], ['image/webp', 'WebP'], ['image/gif', 'GIF'], ['image/tiff', 'TIFF'], ['application/pdf', 'PDF'], ['image/svg+xml', 'SVG']];

/** Archivo > Exportar > Exportar como… (formato, calidad, tamaños, color y mesas de trabajo). */
export function ExportAsDialog({ close, initial }: { close: () => void; initial?: ExportFmt }) {
  const hasArtboards = useStore((s) => s.doc.layers.some((l) => !!l.artboard));
  const docMode = useStore((s) => s.doc.mode ?? 'rgb');
  const [fmt, setFmt] = useState<ExportFmt>(initial ?? 'image/png');
  const [q, setQ] = useState(90);
  const [scales, setScales] = useState<number[]>([1]);
  const [which, setWhich] = useState<'document' | 'artboards'>(hasArtboards ? 'artboards' : 'document');
  const [color, setColor] = useState<'rgb' | 'cmyk' | 'gray'>(docMode);
  const [alpha, setAlpha] = useState(true);
  const [colors, setColors] = useState(256);
  const [dither, setDither] = useState(true);
  const [pdfJpeg, setPdfJpeg] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = (s: number) => setScales((cur) => (cur.includes(s) ? (cur.length > 1 ? cur.filter((x) => x !== s) : cur) : [...cur, s].sort()));
  const print = fmt === 'image/tiff' || fmt === 'application/pdf';
  const lossy = fmt === 'image/jpeg' || fmt === 'image/webp' || (fmt === 'application/pdf' && pdfJpeg && color === 'rgb');
  const go = async () => {
    setBusy(true);
    try {
      const quality = fmt === 'application/pdf' && !(pdfJpeg && color === 'rgb') ? 1 : q / 100;
      const opts = { color: print ? color : undefined, alpha, colors, dither };
      const files = await engine.call<{ name: string; blob: Blob }[]>('exportSet', fmt, quality, scales, which, opts);
      if (files.length === 1) download(files[0].blob, files[0].name);
      else download(await makeZip(files), `${useStore.getState().doc.name.replace(/\.[^.]+$/, '') || 'exportacion'}.zip`);
      useStore.getState().toast(files.length === 1 ? `Exportado ${files[0].name}` : `${files.length} archivos en un ZIP`);
      close();
    } finally { setBusy(false); }
  };
  return (
    <Modal title="Exportar como" okLabel={busy ? 'Exportando…' : 'Exportar'} onClose={close} onOk={() => { if (!busy) void go(); }}>
      <label className="field">Formato
        <select value={fmt} aria-label="Formato" onChange={(e) => setFmt(e.target.value as ExportFmt)}>
          {FORMATS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        </select>
      </label>
      {print && (
        <label className="field">Color
          <select value={color} aria-label="Color" onChange={(e) => setColor(e.target.value as typeof color)}>
            <option value="rgb">RGB</option><option value="cmyk">CMYK (imprenta)</option><option value="gray">Escala de grises</option>
          </select>
        </label>
      )}
      {fmt === 'image/tiff' && color !== 'cmyk' && <label className="field">Transparencia<span><input type="checkbox" checked={alpha} aria-label="Transparencia" onChange={(e) => setAlpha(e.target.checked)} /> Conservar</span></label>}
      {fmt === 'application/pdf' && color === 'rgb' && (
        <label className="field">Compresión
          <select value={pdfJpeg ? 'jpeg' : 'zip'} aria-label="Compresión" onChange={(e) => setPdfJpeg(e.target.value === 'jpeg')}>
            <option value="zip">ZIP (sin pérdida)</option><option value="jpeg">JPEG</option>
          </select>
        </label>
      )}
      {fmt === 'image/gif' && (
        <>
          <label className="field">Colores
            <select value={colors} aria-label="Colores" onChange={(e) => setColors(Number(e.target.value))}>
              {[256, 128, 64, 32, 16, 8, 4, 2].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="field">Tramado<span><input type="checkbox" checked={dither} aria-label="Tramado" onChange={(e) => setDither(e.target.checked)} /> Difusión</span></label>
        </>
      )}
      {lossy && <label className="field">Calidad: {q}<input type="range" min={1} max={100} value={q} onChange={(e) => setQ(Number(e.target.value))} /></label>}
      <div className="field">Tamaños
        <span className="row-btns">{[0.5, 1, 2, 3].map((s) => <button type="button" key={s} className={`chip ${scales.includes(s) ? 'on' : ''}`} aria-pressed={scales.includes(s)} onClick={() => toggle(s)}>{s}x</button>)}</span>
      </div>
      {hasArtboards && (
        <label className="field">Qué exportar
          <select value={which} aria-label="Qué exportar" onChange={(e) => setWhich(e.target.value as typeof which)}>
            <option value="artboards">Cada mesa de trabajo</option><option value="document">Todo el documento</option>
          </select>
        </label>
      )}
      <span className="hint">{fmt === 'image/svg+xml' ? 'Las formas y los textos se exportan como vectores; el resto, como imágenes incrustadas. ' : print ? 'CMYK usa un perfil aproximado de estucado (sin gestión ICC). ' : ''}Varios archivos se descargan juntos en un ZIP.</span>
    </Modal>
  );
}
