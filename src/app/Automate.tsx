// Archivo > Automatizar: Panorámica y Combinar para HDR.
import { useRef, useState } from 'react';
import { engine } from '../engine/client';
import { Modal } from './Dialogs';
import { useStore } from './store';
import { runSteps, download } from './commands';
import { makeZip } from './zip';

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

type BatchFmt = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/tiff' | 'application/pdf' | 'psd';

/**
 * Archivo > Automatizar > Lote: aplica una acción a muchos archivos y guarda el resultado
 * (también hace de Procesador de imágenes: redimensionar y convertir de formato sin acción).
 */
export function BatchDialog({ close }: { close: () => void }) {
  const actions = useStore((s) => s.actions);
  const [action, setAction] = useState(actions.length ? actions.length - 1 : -1);
  const [files, setFiles] = useState<File[]>([]);
  const [fmt, setFmt] = useState<BatchFmt>('image/jpeg');
  const [q, setQ] = useState(85);
  const [fit, setFit] = useState(false);
  const [fw, setFw] = useState(1920);
  const [fh, setFh] = useState(1920);
  const [suffix, setSuffix] = useState('');
  const [progress, setProgress] = useState<{ i: number; n: number; errors: string[] } | null>(null);
  const cancel = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const run = async () => {
    if (!files.length || progress) return;
    cancel.current = false;
    const out: { name: string; blob: Blob }[] = [];
    const errors: string[] = [];
    const steps = action >= 0 ? actions[action]?.steps ?? [] : [];
    setProgress({ i: 0, n: files.length, errors });
    for (const [i, f] of files.entries()) {
      if (cancel.current) break;
      setProgress({ i, n: files.length, errors });
      try {
        await engine.call('open', f.name, await f.arrayBuffer(), f.type);
        await runSteps(steps);
        if (fit) {
          const st = useStore.getState().doc;
          const k = Math.min(1, fw / st.width, fh / st.height);
          if (k < 1) await engine.call('resizeImage', Math.max(1, Math.round(st.width * k)), Math.max(1, Math.round(st.height * k)), 'auto', 0);
        }
        const base = f.name.replace(/\.[^.]+$/, '') + suffix;
        if (fmt === 'psd') out.push({ name: `${base}.psd`, blob: new Blob([await engine.call<Uint8Array<ArrayBuffer>>('savePsd', false)], { type: 'image/vnd.adobe.photoshop' }) });
        else {
          const [r] = await engine.call<{ name: string; blob: Blob }[]>('exportSet', fmt, q / 100, [1], 'document', {});
          out.push({ name: `${base}.${r.name.split('.').pop()}`, blob: r.blob });
        }
      } catch (e) {
        errors.push(`${f.name}: ${(e as Error).message}`);
      } finally {
        if (useStore.getState().doc.open) await engine.call('closeDoc');
      }
    }
    setProgress({ i: files.length, n: files.length, errors });
    if (out.length) download(out.length === 1 ? out[0].blob : await makeZip(out), out.length === 1 ? out[0].name : 'lote.zip');
    useStore.getState().toast(`Lote: ${out.length} de ${files.length} archivos procesados${errors.length ? ` (${errors.length} con errores)` : ''}`, errors.length ? 'warn' : 'info');
    if (!errors.length) close();
  };
  return (
    <Modal title="Lote" wide okLabel={progress && progress.i < progress.n ? 'Procesando…' : 'Ejecutar'} onClose={() => { cancel.current = true; close(); }} onOk={() => void run()}>
      <label className="field">Acción
        <select value={action} aria-label="Acción" onChange={(e) => setAction(Number(e.target.value))}>
          <option value={-1}>Ninguna (solo convertir)</option>
          {actions.map((a, i) => <option key={i} value={i}>{a.name} ({a.steps.length} pasos)</option>)}
        </select>
      </label>
      <div className="field">Origen
        <span className="row-btns">
          <button type="button" className="btn" onClick={() => input.current?.click()}>Elegir archivos…</button>
          <span className="hint" data-testid="batch-count">{files.length ? `${files.length} archivo${files.length === 1 ? '' : 's'}` : 'Ningún archivo'}</span>
        </span>
        <input ref={input} type="file" multiple hidden aria-label="Archivos del lote" accept="image/*,.psd,.psb" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
      </div>
      <label className="field">Guardar como
        <select value={fmt} aria-label="Formato del lote" onChange={(e) => setFmt(e.target.value as BatchFmt)}>
          <option value="image/jpeg">JPEG</option><option value="image/png">PNG</option><option value="image/webp">WebP</option>
          <option value="image/tiff">TIFF</option><option value="application/pdf">PDF</option><option value="psd">PSD</option>
        </select>
      </label>
      {(fmt === 'image/jpeg' || fmt === 'image/webp') && <label className="field">Calidad: {q}<input type="range" min={1} max={100} value={q} onChange={(e) => setQ(Number(e.target.value))} /></label>}
      <label className="field">Redimensionar<span><input type="checkbox" checked={fit} aria-label="Redimensionar para ajustar" onChange={(e) => setFit(e.target.checked)} /> Ajustar a
        <input type="number" min={1} value={fw} aria-label="Ancho máximo" style={{ width: 72, marginLeft: 6 }} onChange={(e) => setFw(Math.max(1, Number(e.target.value) || 1))} /> ×
        <input type="number" min={1} value={fh} aria-label="Alto máximo" style={{ width: 72 }} onChange={(e) => setFh(Math.max(1, Number(e.target.value) || 1))} /> px</span>
      </label>
      <label className="field">Sufijo del nombre<input value={suffix} aria-label="Sufijo" placeholder="(ninguno)" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setSuffix(e.target.value)} /></label>
      {progress && (
        <div className="batch-progress" data-testid="batch-progress">
          <progress max={progress.n} value={progress.i} /> {progress.i} / {progress.n}
          {progress.errors.length > 0 && <ul className="batch-errors">{progress.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        </div>
      )}
      <span className="hint">Cada archivo se abre, se le aplica la acción y se guarda; el resultado se descarga en un ZIP. Los originales no se modifican.</span>
    </Modal>
  );
}
