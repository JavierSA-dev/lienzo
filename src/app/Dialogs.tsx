import { useState, type ReactNode } from 'react';
import { engine } from '../engine/client';
import { useStore } from './store';
import { exportImage } from './commands';
import { PRESETS } from './Home';

function Modal({ title, children, onOk, okLabel = 'Aceptar', onClose }: { title: string; children: ReactNode; onOk: () => void; okLabel?: string; onClose: () => void }) {
  return (
    <div className="modal-veil" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form
        className="modal"
        role="dialog"
        aria-label={title}
        onSubmit={(e) => { e.preventDefault(); onOk(); }}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation(); }}
      >
        <header>{title}</header>
        <div className="body">{children}</div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary">{okLabel}</button>
        </footer>
      </form>
    </div>
  );
}

function NewDocDialog({ close }: { close: () => void }) {
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [name, setName] = useState('Sin título-1');
  const [bgMode, setBg] = useState<'white' | 'black' | 'transparent' | 'bg'>('white');
  return (
    <Modal title="Nuevo documento" okLabel="Crear" onClose={close} onOk={() => { engine.call('newDoc', w, h, bgMode, `${name}.psd`); close(); }}>
      <div className="preset-list">
        {PRESETS.map((p) => (
          <button type="button" key={p.name} className="chip" onClick={() => { setW(p.w); setH(p.h); }}>{p.name}</button>
        ))}
      </div>
      <label className="field">Nombre<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label className="field">Anchura (px)<input type="number" min={1} max={30000} value={w} onChange={(e) => setW(Number(e.target.value))} /></label>
      <label className="field">Altura (px)<input type="number" min={1} max={30000} value={h} onChange={(e) => setH(Number(e.target.value))} /></label>
      <label className="field">Fondo
        <select value={bgMode} onChange={(e) => setBg(e.target.value as typeof bgMode)}>
          <option value="white">Blanco</option>
          <option value="black">Negro</option>
          <option value="bg">Color de fondo</option>
          <option value="transparent">Transparente</option>
        </select>
      </label>
    </Modal>
  );
}

function ImageSizeDialog({ close }: { close: () => void }) {
  const doc = useStore((s) => s.doc);
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [keep, setKeep] = useState(true);
  const ratio = doc.width / doc.height;
  return (
    <Modal title="Tamaño de imagen" onClose={close} onOk={() => { engine.call('resizeImage', w, h); close(); }}>
      <label className="field">Anchura (px)
        <input type="number" min={1} value={w} autoFocus onChange={(e) => { const v = Number(e.target.value); setW(v); if (keep) setH(Math.max(1, Math.round(v / ratio))); }} />
      </label>
      <label className="field">Altura (px)
        <input type="number" min={1} value={h} onChange={(e) => { const v = Number(e.target.value); setH(v); if (keep) setW(Math.max(1, Math.round(v * ratio))); }} />
      </label>
      <label className="field">Proporciones
        <span><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Mantener</span>
      </label>
      <span className="hint">{Math.round((w / doc.width) * 100)} % · el cálculo corre en el motor; la interfaz sigue respondiendo.</span>
    </Modal>
  );
}

function ExportDialog({ close }: { close: () => void }) {
  const [fmt, setFmt] = useState<'image/png' | 'image/jpeg' | 'image/webp'>('image/png');
  const [q, setQ] = useState(90);
  return (
    <Modal title="Exportar como" okLabel="Exportar" onClose={close} onOk={() => { exportImage(fmt, q / 100); close(); }}>
      <label className="field">Formato
        <select value={fmt} onChange={(e) => setFmt(e.target.value as typeof fmt)}>
          <option value="image/png">PNG</option>
          <option value="image/jpeg">JPEG</option>
          <option value="image/webp">WebP</option>
        </select>
      </label>
      {fmt !== 'image/png' && (
        <label className="field">Calidad: {q}<input type="range" min={1} max={100} value={q} onChange={(e) => setQ(Number(e.target.value))} /></label>
      )}
    </Modal>
  );
}

function BrightnessDialog({ close }: { close: () => void }) {
  const [b, setB] = useState(0);
  const [c, setC] = useState(0);
  return (
    <Modal title="Brillo/Contraste" onClose={close} onOk={() => { engine.call('adjust', 'brightness', b, c); close(); }}>
      <label className="field">Brillo: {b}<input type="range" min={-150} max={150} value={b} onChange={(e) => setB(Number(e.target.value))} /></label>
      <label className="field">Contraste: {c}<input type="range" min={-50} max={100} value={c} onChange={(e) => setC(Number(e.target.value))} /></label>
      <span className="hint">Se aplica a la capa activa. En la fase 2 será una capa de ajuste no destructiva.</span>
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const close = () => useStore.getState().setDialog(null);
  switch (dialog) {
    case 'new': return <NewDocDialog close={close} />;
    case 'imageSize': return <ImageSizeDialog close={close} />;
    case 'export': return <ExportDialog close={close} />;
    case 'brightness': return <BrightnessDialog close={close} />;
    default: return null;
  }
}
