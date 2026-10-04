// Archivo > Automatizar: Panorámica y Combinar para HDR.
import { useRef, useState } from 'react';
import { engine } from '../engine/client';
import { Modal } from './Dialogs';

type F = { name: string; buffer: ArrayBuffer; mime: string; url: string };

export function AutomateDialog({ mode, close }: { mode: 'photomerge' | 'hdr'; close: () => void }) {
  const [files, setFiles] = useState<F[]>([]);
  const [blend, setBlend] = useState(true);
  const [fix, setFix] = useState(true);
  const [align, setAlign] = useState(true);
  const [strength, setStrength] = useState(1);
  const input = useRef<HTMLInputElement>(null);
  const add = async (list: FileList | null) => {
    if (!list) return;
    const out: F[] = [];
    for (const f of Array.from(list)) out.push({ name: f.name, buffer: await f.arrayBuffer(), mime: f.type, url: URL.createObjectURL(f) });
    setFiles((o) => [...o, ...out]);
  };
  const run = () => {
    const payload = files.map(({ name, buffer, mime }) => ({ name, buffer, mime }));
    for (const f of files) URL.revokeObjectURL(f.url);
    if (mode === 'photomerge') engine.call('photomerge', payload, blend, fix);
    else engine.call('mergeHdr', payload, align, strength);
    close();
  };
  const title = mode === 'photomerge' ? 'Panorámica' : 'Combinar para HDR';
  return (
    <Modal title={title} wide okLabel={mode === 'photomerge' ? 'Crear panorámica' : 'Combinar'} onClose={close} onOk={() => { if (files.length >= 2) run(); }}>
      <p className="hint">{mode === 'photomerge'
        ? 'Elige fotos que se solapen (un 20-30 %). Se colocan en capas, alineadas, con máscaras que puedes retocar.'
        : 'Elige la misma toma con distintas exposiciones (por ejemplo −2, 0 y +2 EV). Se alinean y se funden conservando luces y sombras.'}</p>
      <div className="auto-files" data-testid="auto-files">
        {files.map((f, i) => (
          <figure key={i}>
            <img src={f.url} alt={f.name} />
            <figcaption>{f.name}</figcaption>
            <button type="button" className="icon-btn" aria-label={`Quitar ${f.name}`} onClick={() => setFiles((o) => o.filter((_, j) => j !== i))}>×</button>
          </figure>
        ))}
        <button type="button" className="auto-add" onClick={() => input.current?.click()}>+ Añadir fotos…</button>
        <input ref={input} type="file" accept="image/*,.psd,.psb" multiple hidden data-testid="auto-input" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
      </div>
      {mode === 'photomerge' ? (
        <>
          <label className="check-row"><input type="checkbox" checked={blend} onChange={(e) => setBlend(e.target.checked)} /> Fusionar imágenes (máscaras de costura)</label>
          <label className="check-row"><input type="checkbox" checked={fix} onChange={(e) => setFix(e.target.checked)} /> Igualar la exposición entre fotos</label>
        </>
      ) : (
        <>
          <label className="check-row"><input type="checkbox" checked={align} onChange={(e) => setAlign(e.target.checked)} /> Alinear automáticamente (tomas a pulso)</label>
          <label className="field sfield">Peso de la buena exposición <b>{strength.toFixed(1)}</b>
            <input type="range" min={0.3} max={3} step={0.1} value={strength} aria-label="Peso de la buena exposición" onChange={(e) => setStrength(Number(e.target.value))} />
          </label>
        </>
      )}
      {files.length < 2 && <span className="hint">Hacen falta al menos dos fotos.</span>}
    </Modal>
  );
}
