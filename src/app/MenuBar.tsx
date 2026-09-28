import { useEffect, useRef, useState } from 'react';
import { commandById, formatKeys, runCommand, BROWSER_RESERVED } from './commands';
import { useStore } from './store';
import { APP_NAME } from './brand';

type Item = string | '-' | { label: string; soon: true } | { sub: string; items: Item[] };

/** Estructura de menús de Photoshop; lo que aún no existe aparece desactivado. */
const MENUS: { label: string; items: Item[] }[] = [
  { label: 'Archivo', items: ['file.new', 'file.open', 'file.place', '-', 'file.close', '-', 'file.save', 'file.saveAs', 'file.saveCopy', 'file.savePsb', '-',
    { sub: 'Exportar', items: ['file.quickPng', 'file.export', 'file.saveForWeb'] }] },
  { label: 'Edición', items: ['edit.undo', 'edit.redo', 'edit.toggleLast', '-', 'edit.cut', 'edit.copy', 'edit.copyMerged', 'edit.paste', 'edit.pasteInPlace', 'edit.clear', '-',
    'edit.fill', 'edit.fillFg', 'edit.fillBg', '-', 'edit.freeTransform',
    { sub: 'Transformar', items: ['edit.rot180', 'edit.rot90', 'edit.rot-90', '-', 'edit.flipH', 'edit.flipV'] },
    '-', 'edit.contentAware', 'ai.generative', '-', 'edit.shortcuts'] },
  { label: 'Imagen', items: [
    { sub: 'Ajustes', items: ['image.brightness', 'image.levels', 'image.curves', 'image.exposure', '-', 'image.vibrance', 'image.hueSat', 'image.colorBalance', 'image.blackWhite', '-',
      'image.invert', 'image.posterize', 'image.threshold', 'image.gradientMap', '-', 'image.desaturate'] },
    '-', 'image.autoTone', 'image.autoContrast', 'image.autoColor', '-', 'image.size', 'image.canvasSize',
    { sub: 'Rotación de imagen', items: ['image.rot180', 'image.rot90', 'image.rot-90', '-', 'image.flipH', 'image.flipV'] },
    'image.crop'] },
  { label: 'Capa', items: [
    { sub: 'Nueva', items: ['layer.new', 'layer.newGroup', '-', 'layer.viaCopy', 'layer.viaCut'] }, 'layer.duplicate', 'layer.delete', '-',
    'layer.style', '-',
    { sub: 'Nueva capa de relleno', items: ['layer.fill.solid'] },
    { sub: 'Nueva capa de ajuste', items: ['layer.adj.brightness', 'layer.adj.levels', 'layer.adj.curves', 'layer.adj.exposure', '-', 'layer.adj.vibrance', 'layer.adj.hueSat', 'layer.adj.colorBalance', 'layer.adj.blackWhite', '-', 'layer.adj.invert', 'layer.adj.posterize', 'layer.adj.threshold', 'layer.adj.gradientMap'] },
    '-',
    { sub: 'Máscara de capa', items: ['layer.mask.reveal', 'layer.mask.hide', 'layer.mask.selection', '-', 'layer.mask.apply', 'layer.mask.delete'] },
    'layer.clip', '-', 'layer.rasterize', '-', 'layer.group', 'layer.ungroup', '-',
    { sub: 'Organizar', items: ['layer.front', 'layer.forward', 'layer.backward', 'layer.back'] },
    { sub: 'Alinear', items: ['layer.align.top', 'layer.align.vcenter', 'layer.align.bottom', '-', 'layer.align.left', 'layer.align.hcenter', 'layer.align.right'] },
    { sub: 'Distribuir', items: ['layer.dist.vcenter', 'layer.dist.hcenter'] },
    'layer.lockAlpha', '-', 'layer.mergeDown', 'layer.mergeVisible', 'layer.stamp', 'layer.flatten'] },
  { label: 'Texto', items: ['type.tool', { label: 'Deformar texto', soon: true }, { label: 'Convertir en forma', soon: true }] },
  { label: 'Selección', items: ['select.all', 'select.none', 'select.reselect', 'select.invert', 'layer.selectAll', '-', 'select.subject', { label: 'Cielo', soon: true }, '-',
    { sub: 'Modificar', items: ['select.feather', 'select.expand', 'select.contract'] }, 'select.fromLayer'] },
  { label: 'Filtro', items: ['filter.last', '-', 'filter.liquify', '-',
    { sub: 'Desenfocar', items: ['filter.gaussianBlur', 'filter.boxBlur', 'filter.motionBlur'] },
    { sub: 'Enfocar', items: ['filter.sharpen', 'filter.unsharpMask'] },
    { sub: 'Ruido', items: ['filter.addNoise', 'filter.median'] },
    { sub: 'Pixelizar', items: ['filter.mosaic'] },
    { sub: 'Interpretar', items: ['filter.clouds'] },
    { sub: 'Estilizar', items: ['filter.findEdges', 'filter.emboss'] },
    { sub: 'Otro', items: ['filter.highPass'] },
    '-', 'ai.removeBg'] },
  { label: 'Vista', items: ['view.zoomIn', 'view.zoomOut', 'view.fit', 'view.actual', '-', 'view.extras', 'view.grid', '-', 'view.fullscreen'] },
  { label: 'Ventana', items: ['view.panels'] },
  { label: 'Ayuda', items: ['help.shortcuts', 'help.about'] },
];

function MenuItems({ items, close }: { items: Item[]; close: () => void }) {
  const doc = useStore((s) => s.doc);
  const [sub, setSub] = useState<number | null>(null);
  return (
    <>
      {items.map((it, j) => {
        if (it === '-') return <div className="menu-sep" key={j} />;
        if (typeof it !== 'string' && 'sub' in it) {
          return (
            <div key={j} className="menu-sub" onMouseEnter={() => setSub(j)} onMouseLeave={() => setSub(null)}>
              <button className="menu-item" type="button"><span>{it.sub}</span><span className="keys">▸</span></button>
              {sub === j && <div className="menu-pop side"><MenuItems items={it.items} close={close} /></div>}
            </div>
          );
        }
        if (typeof it !== 'string') {
          return <button className="menu-item" disabled key={j}><span>{it.label}</span><span className="keys">Próximamente</span></button>;
        }
        const c = commandById[it];
        if (!c) return null;
        const disabled = !!c.needsDoc && !doc.open;
        const k = c.keys?.[0];
        const alt = k && BROWSER_RESERVED.has(k) ? c.keys?.[1] : undefined;
        return (
          <button key={j} className="menu-item" disabled={disabled} onClick={() => { close(); runCommand(c); }}>
            <span>{c.label}</span>
            <span className="keys" title={alt ? `El navegador reserva ${formatKeys(k)} (funciona en pantalla completa). Alternativa: ${formatKeys(alt)}` : undefined}>
              {formatKeys(k)}{alt ? ` · ${formatKeys(alt)}` : ''}
            </span>
          </button>
        );
      })}
    </>
  );
}

export function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const doc = useStore((s) => s.doc);
  const recording = useStore((s) => s.recording);

  useEffect(() => {
    if (open === null) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <nav className="menubar" ref={ref}>
      <div className="brand"><div className="brand-mark">L</div>{APP_NAME}</div>
      {MENUS.map((m, i) => (
        <div className="menu-root" key={m.label}>
          <button className={`menu-btn ${open === i ? 'open' : ''}`} onClick={() => setOpen(open === i ? null : i)} onMouseEnter={() => open !== null && setOpen(i)}>
            {m.label}
          </button>
          {open === i && <div className="menu-pop" role="menu"><MenuItems items={m.items} close={() => setOpen(null)} /></div>}
        </div>
      ))}
      <div className="spacer" />
      {recording && <span className="rec-label"><span className="rec-dot" /> Grabando acción</span>}
      {doc.open && <span className="doc-title">{doc.name}{doc.dirty ? ' •' : ''}</span>}
    </nav>
  );
}
