// Selector de color como el de Photoshop: campo de saturación/brillo, barra de tono,
// color nuevo y actual, campos HSB, RGB y hexadecimal, recientes y "Añadir a muestras".
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { cmykOf, proofColor, printModel } from '../engine/color';
import { Modal } from './Dialogs';

export type HSB = [number, number, number]; // h 0..360, s 0..100, b 0..100

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

export function rgbToHsb(r: number, g: number, b: number): HSB {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx ? (d / mx) * 100 : 0, (mx / 255) * 100];
}

export function hsbToRgb(h: number, s: number, v: number): [number, number, number] {
  s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Colores usados recientemente (se guardan en el navegador). */
export function pushRecent(hex: string) {
  const s = useStore.getState();
  const recent = [hex, ...s.recentColors.filter((c) => c !== hex)].slice(0, 12);
  useStore.setState({ recentColors: recent });
  try { localStorage.setItem('lienzo:recent', JSON.stringify(recent)); } catch { /* sin almacenamiento */ }
}

function drag(e: React.PointerEvent, onMove: (x: number, y: number) => void) {
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const at = (ev: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    // Los 3 px de cada borde "pegan" (es fácil llegar al 0 % y al 100 % exactos).
    const f = (px: number, len: number) => (px <= 3 ? 0 : px >= len - 3 ? 1 : px / len);
    onMove(f(ev.clientX - r.left, r.width), f(ev.clientY - r.top, r.height));
  };
  at(e);
  const move = (ev: PointerEvent) => at(ev);
  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

export function ColorPickerDialog({ which, close }: { which: 'fg' | 'bg'; close: () => void }) {
  const cur = useStore((s) => (which === 'fg' ? s.fg : s.bg));
  const recent = useStore((s) => s.recentColors);
  const [hsb, setHsb] = useState<HSB>(() => rgbToHsb(...hexToRgb(cur)));
  const [hexText, setHexText] = useState(cur);
  const rgb = hsbToRgb(...hsb).map(Math.round) as [number, number, number];
  const hex = rgbToHex(...rgb);
  const lastHex = useRef(hex);
  useEffect(() => { if (lastHex.current !== hex) { lastHex.current = hex; setHexText(hex); } }, [hex]);
  const setRgb = (r: number, g: number, b: number) => setHsb(rgbToHsb(r, g, b));
  // Tintas CMYK y aviso de gama (el color no se puede imprimir tal cual).
  const cmyk = useMemo(() => cmykOf(...rgb), [rgb[0], rgb[1], rgb[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  const printable = useMemo(() => proofColor(...rgb), [rgb[0], rgb[1], rgb[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  const outOfGamut = Math.hypot(printable[0] - rgb[0], printable[1] - rgb[1], printable[2] - rgb[2]) > 23;
  const setCmyk = (i: number, v: number) => {
    const q = cmyk.map((x) => x / 100) as [number, number, number, number];
    q[i] = v / 100;
    const p = printModel(...q);
    setRgb(...(p.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)) as [number, number, number]));
  };
  const ok = () => {
    const s = useStore.getState();
    if (which === 'fg') s.setColors(hex, s.bg); else s.setColors(s.fg, hex);
    pushRecent(hex);
    close();
  };
  const num = (v: string, max: number) => Math.max(0, Math.min(max, Number(v) || 0));
  const field = (label: string, value: number, max: number, set: (v: number) => void, unit = '') => (
    <label className="cp-field"><span>{label}</span>
      <input type="number" min={0} max={max} value={Math.round(value)} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set(num(e.target.value, max))} />{unit}
    </label>
  );
  return (
    <Modal title={`Selector de color (${which === 'fg' ? 'color frontal' : 'color de fondo'})`} onClose={close} onOk={ok} wide>
      <div className="color-picker" data-testid="color-picker">
        <div className="cp-field-sv" style={{ background: `hsl(${hsb[0]} 100% 50%)` }}
          onPointerDown={(e) => drag(e, (x, y) => setHsb([hsb[0], x * 100, (1 - y) * 100]))} data-testid="cp-sv">
          <div className="cp-sv-white" /><div className="cp-sv-black" />
          <div className="cp-knob" style={{ left: `${hsb[1]}%`, top: `${100 - hsb[2]}%` }} />
        </div>
        <div className="cp-hue" onPointerDown={(e) => drag(e, (_x, y) => setHsb([(1 - y) * 359.99, hsb[1], hsb[2]]))} data-testid="cp-hue">
          <div className="cp-hue-knob" style={{ top: `${100 - (hsb[0] / 360) * 100}%` }} />
        </div>
        <div className="cp-side">
          <div className="cp-compare">
            <span>nuevo</span>
            <div style={{ background: hex }} title="Nuevo" />
            <div style={{ background: cur }} title="Actual (clic para recuperarlo)" onClick={() => setHsb(rgbToHsb(...hexToRgb(cur)))} />
            <span>actual</span>
          </div>
          <div className="cp-grid">
            {field('H:', hsb[0], 360, (v) => setHsb([v % 360, hsb[1], hsb[2]]), '°')}
            {field('R:', rgb[0], 255, (v) => setRgb(v, rgb[1], rgb[2]))}
            {field('S:', hsb[1], 100, (v) => setHsb([hsb[0], v, hsb[2]]), '%')}
            {field('G:', rgb[1], 255, (v) => setRgb(rgb[0], v, rgb[2]))}
            {field('B:', hsb[2], 100, (v) => setHsb([hsb[0], hsb[1], v]), '%')}
            {field('B:', rgb[2], 255, (v) => setRgb(rgb[0], rgb[1], v))}
          </div>
          <div className="cp-grid cp-cmyk" data-testid="cp-cmyk">
            {field('C:', cmyk[0], 100, (v) => setCmyk(0, v), '%')}
            {field('M:', cmyk[1], 100, (v) => setCmyk(1, v), '%')}
            {field('Y:', cmyk[2], 100, (v) => setCmyk(2, v), '%')}
            {field('K:', cmyk[3], 100, (v) => setCmyk(3, v), '%')}
          </div>
          {outOfGamut && (
            <button type="button" className="cp-gamut" data-testid="cp-gamut" title="Fuera de gama para impresión: clic para usar el color imprimible más próximo" onClick={() => setRgb(...printable)}>
              <span aria-hidden>⚠</span><i style={{ background: rgbToHex(...printable) }} />
            </button>
          )}
          <label className="cp-field cp-hex"><span>#</span>
            <input value={hexText.replace('#', '')} maxLength={6} aria-label="Hexadecimal" onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => { const v = e.target.value.replace(/[^0-9a-f]/gi, ''); setHexText('#' + v); if (v.length === 6) setRgb(...hexToRgb('#' + v)); }} />
          </label>
          <button type="button" className="btn" onClick={() => { addSwatch(hex); }}>Añadir a muestras</button>
          {recent.length > 0 && (
            <div className="cp-recent" title="Recientes">
              {recent.map((c) => <button type="button" key={c} style={{ background: c }} title={c} onClick={() => setHsb(rgbToHsb(...hexToRgb(c)))} />)}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function addSwatch(hex: string) {
  const s = useStore.getState();
  if (s.swatches.includes(hex)) { s.toast('Ese color ya está en Muestras.'); return; }
  const swatches = [...s.swatches, hex];
  useStore.setState({ swatches });
  try { localStorage.setItem('lienzo:swatches', JSON.stringify(swatches)); } catch { /* sin almacenamiento */ }
  s.toast('Añadido a Muestras');
}

export function removeSwatch(hex: string) {
  const swatches = useStore.getState().swatches.filter((c) => c !== hex);
  useStore.setState({ swatches });
  try { localStorage.setItem('lienzo:swatches', JSON.stringify(swatches)); } catch { /* sin almacenamiento */ }
}
