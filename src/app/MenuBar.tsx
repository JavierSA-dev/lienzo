import { useEffect, useRef, useState } from 'react';
import { commandById, formatKeys } from './commands';
import { useStore } from './store';
import { APP_NAME } from './brand';

type Item = string | '-' | { label: string; soon: true };

/** Estructura de menús de Photoshop; lo que aún no existe aparece desactivado. */
const MENUS: { label: string; items: Item[] }[] = [
  { label: 'Archivo', items: ['file.new', 'file.open', '-', 'file.save', 'file.quickPng', 'file.export', '-', 'file.close'] },
  { label: 'Edición', items: ['edit.undo', 'edit.redo', '-', 'edit.fillFg', 'edit.fillBg', 'edit.clear', '-', { label: 'Transformación libre', soon: true }, { label: 'Relleno según contenido', soon: true }] },
  { label: 'Imagen', items: ['image.brightness', 'image.invert', 'image.desaturate', '-', 'image.size', { label: 'Tamaño de lienzo…', soon: true }, { label: 'Rotación de imagen', soon: true }] },
  { label: 'Capa', items: ['layer.new', 'layer.duplicate', 'layer.delete', '-', 'layer.mergeDown', 'layer.flatten', '-', { label: 'Estilo de capa', soon: true }, { label: 'Máscara de capa', soon: true }] },
  { label: 'Texto', items: [{ label: 'Herramienta de texto (fase 2)', soon: true }] },
  { label: 'Selección', items: ['select.all', 'select.none', '-', { label: 'Sujeto (IA)', soon: true }, { label: 'Invertir', soon: true }] },
  { label: 'Filtro', items: [{ label: 'Desenfoque gaussiano (fase 2)', soon: true }, { label: 'Licuar (fase 3)', soon: true }] },
  { label: 'Vista', items: ['view.zoomIn', 'view.zoomOut', 'view.fit', 'view.actual', '-', 'view.panels'] },
  { label: 'Ventana', items: ['view.panels'] },
];

export function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const doc = useStore((s) => s.doc);

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
          <button
            className={`menu-btn ${open === i ? 'open' : ''}`}
            onClick={() => setOpen(open === i ? null : i)}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="menu-pop" role="menu">
              {m.items.map((it, j) => {
                if (it === '-') return <div className="menu-sep" key={j} />;
                if (typeof it !== 'string') {
                  return <button className="menu-item" disabled key={j}><span>{it.label}</span><span className="keys">Próximamente</span></button>;
                }
                const c = commandById[it];
                const disabled = !!c.needsDoc && !doc.open;
                return (
                  <button
                    key={j}
                    className="menu-item"
                    disabled={disabled}
                    onClick={() => { setOpen(null); c.run(); }}
                  >
                    <span>{c.label}</span>
                    <span className="keys">{formatKeys(c.keys)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      <div className="spacer" />
      {doc.open && <span className="doc-title">{doc.name}{doc.dirty ? ' •' : ''}</span>}
    </nav>
  );
}
