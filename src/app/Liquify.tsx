import { useEffect, useRef, useState } from 'react';
import { engine } from '../engine/client';
import { Modal } from './Dialogs';

type Tool = 'warp' | 'reconstruct' | 'pucker' | 'bloat';

/**
 * Licuar (Ctrl+Mayús+X): se deforma una vista reducida con un campo de
 * desplazamiento; al aceptar, el motor aplica el campo a resolución completa en paralelo.
 */
export function LiquifyDialog({ close }: { close: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const src = useRef<{ data: Uint8ClampedArray; w: number; h: number; scale: number } | null>(null);
  const field = useRef<Float32Array | null>(null);
  const [tool, setTool] = useState<Tool>('warp');
  const [size, setSize] = useState(80);
  const [pressure, setPressure] = useState(50);
  const [ready, setReady] = useState(false);
  const last = useRef<[number, number] | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    (async () => {
      const s = await engine.call<{ data: Uint8ClampedArray; w: number; h: number; scale: number } | null>('liquifySource', 900);
      if (!s) { close(); return; }
      src.current = s;
      field.current = new Float32Array(s.w * s.h * 2);
      const c = canvas.current!;
      c.width = s.w; c.height = s.h;
      setReady(true);
      render();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function render() {
    const s = src.current, f = field.current, c = canvas.current;
    if (!s || !f || !c) return;
    const out = new ImageData(s.w, s.h);
    const o = out.data, d = s.data;
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        const i = y * s.w + x;
        const sx = Math.min(s.w - 1, Math.max(0, Math.round(x + f[i * 2]))), sy = Math.min(s.h - 1, Math.max(0, Math.round(y + f[i * 2 + 1])));
        const j = (sy * s.w + sx) * 4;
        o[i * 4] = d[j]; o[i * 4 + 1] = d[j + 1]; o[i * 4 + 2] = d[j + 2]; o[i * 4 + 3] = d[j + 3];
      }
    }
    c.getContext('2d')!.putImageData(out, 0, 0);
  }

  function stamp(x: number, y: number, dx: number, dy: number) {
    const s = src.current!, f = field.current!;
    const r = size / 2, k = pressure / 100;
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(s.w - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(s.h - 1, Math.ceil(y + r));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dist = Math.hypot(px - x, py - y);
        if (dist > r) continue;
        const w = (1 - dist / r) ** 2 * k;
        const i = (py * s.w + px) * 2;
        if (tool === 'warp') { f[i] -= dx * w; f[i + 1] -= dy * w; }
        else if (tool === 'reconstruct') { f[i] *= 1 - w; f[i + 1] *= 1 - w; }
        else {
          // Fruncir / inflar: desplazamiento radial.
          const sgn = tool === 'pucker' ? 1 : -1;
          f[i] += (px - x) * w * 0.08 * sgn; f[i + 1] += (py - y) * w * 0.08 * sgn;
        }
      }
    }
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(render);
  }

  const pos = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.current!.width, ((e.clientY - r.top) / r.height) * canvas.current!.height];
  };

  return (
    <Modal title="Licuar" wide okLabel="OK" onClose={close}
      onOk={async () => {
        const s = src.current, f = field.current;
        if (s && f) await engine.call('applyLiquify', f, s.w, s.h, s.scale);
        close();
      }}>
      <div className="liquify">
        <div className="liquify-tools">
          {([['warp', 'Deformar hacia delante (W)'], ['reconstruct', 'Reconstruir (R)'], ['pucker', 'Fruncir (S)'], ['bloat', 'Inflar (B)']] as [Tool, string][]).map(([t, l]) => (
            <button type="button" key={t} className={`chip ${tool === t ? 'on' : ''}`} onClick={() => setTool(t)}>{l}</button>
          ))}
          <label className="adj-row"><span>Tamaño</span><input type="range" min={5} max={400} value={size} onChange={(e) => setSize(Number(e.target.value))} /></label>
          <label className="adj-row"><span>Presión</span><input type="range" min={1} max={100} value={pressure} onChange={(e) => setPressure(Number(e.target.value))} /></label>
          <button type="button" className="chip" onClick={() => { field.current?.fill(0); render(); }}>Restaurar todo</button>
          {!ready && <span className="hint">Cargando…</span>}
        </div>
        <canvas ref={canvas} className="liquify-canvas"
          onKeyDown={(e) => { const m: Record<string, Tool> = { w: 'warp', r: 'reconstruct', s: 'pucker', b: 'bloat' }; if (m[e.key]) setTool(m[e.key]); if (e.key === '[') setSize((v) => Math.max(5, v - 10)); if (e.key === ']') setSize((v) => v + 10); }}
          tabIndex={0}
          onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); last.current = pos(e); if (tool !== 'warp') stamp(...last.current, 0, 0); }}
          onPointerMove={(e) => {
            if (!last.current) return;
            const p = pos(e);
            stamp(p[0], p[1], p[0] - last.current[0], p[1] - last.current[1]);
            last.current = p;
          }}
          onPointerUp={() => { last.current = null; }} />
      </div>
    </Modal>
  );
}
