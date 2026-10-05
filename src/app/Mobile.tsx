// Interfaz para móvil: el mismo motor y los mismos documentos, con controles pensados para el tacto.
// Barra superior (menú, deshacer, capas, exportar), barra inferior de herramientas desplazable,
// barra contextual (acciones de la selección, OK/Cancelar) y hojas que suben desde abajo.
import { useEffect, useState, type ReactNode } from 'react';
import { Sparkles,
  Menu, Undo2, Redo2, Layers as LayersIcon, Share2, SlidersHorizontal, ChevronLeft, ChevronRight, X, History, Palette, Check,
} from 'lucide-react';
import { useStore, type MobileSheet, savePrefs } from './store';
import { engine } from '../engine/client';
import { commandById, runCommand, TOOL_GROUPS, TOOL_NAMES, selectTool, exportImage, savePsd } from './commands';
import { MENUS, type Item } from './MenuBar';
import { ICONS } from './Toolbar';
import { LayersPanel, PropertiesPanel, HistoryPanel, ColorPanel, ADJ_MENU } from './Panels';
import { ADJUSTMENT_LABELS } from '../engine/adjust';
import { APP_NAME } from './brand';
import { finishTextEdit } from './CanvasArea';

/** Pantallas estrechas (móvil en vertical) o bajas y táctiles (móvil en horizontal). */
const QUERY = '(max-width: 760px), (max-height: 500px) and (pointer: coarse)';

export function useIsMobile(): boolean {
  const pref = useStore((s) => s.layout);
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(QUERY);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return pref === 'mobile' || (pref === 'auto' && narrow);
}

export function setLayout(layout: 'auto' | 'mobile' | 'desktop') {
  useStore.setState({ layout, sheet: null });
  savePrefs('layout', layout);
}

const openSheet = (sheet: MobileSheet | null) => useStore.setState({ sheet });
/** Las acciones que en escritorio van con Intro/Esc se envían como teclas al lienzo. */
const press = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const run = (id: string) => { const c = commandById[id]; if (c) runCommand(c); };

// ------------------------------------------------------------------ barra superior

export function MobileTopBar() {
  const doc = useStore((s) => s.doc);
  const canUndo = doc.open && doc.historyIndex > 0;
  const canRedo = doc.open && doc.historyIndex < doc.history.length - 1;
  return (
    <header className="m-top">
      <button className="m-icon" aria-label="Menú" onClick={() => openSheet('menu')} data-testid="m-menu"><Menu size={20} /></button>
      <div className="m-title">{doc.open ? `${doc.name}${doc.dirty ? ' •' : ''}` : APP_NAME}</div>
      {doc.open && <>
        <button className="m-icon" aria-label="Deshacer" disabled={!canUndo} onClick={() => engine.call('undo')} data-testid="m-undo"><Undo2 size={20} /></button>
        <button className="m-icon" aria-label="Rehacer" disabled={!canRedo} onClick={() => engine.call('redo')}><Redo2 size={20} /></button>
        <button className="m-icon" aria-label="Asistente" data-testid="m-assistant" onClick={() => { openSheet(null); useStore.setState({ assistantOpen: !useStore.getState().assistantOpen }); }}><Sparkles size={20} /></button>
        <button className="m-icon" aria-label="Historial" onClick={() => openSheet('history')}><History size={20} /></button>
        <button className="m-icon" aria-label="Capas" onClick={() => openSheet('layers')} data-testid="m-layers"><LayersIcon size={20} /></button>
        <button className="m-icon accent" aria-label="Exportar" onClick={() => openSheet('export')} data-testid="m-export"><Share2 size={20} /></button>
      </>}
    </header>
  );
}

// ------------------------------------------------------------------ barra inferior

/** Orden de los grupos en la barra inferior (los más usados primero). */
const BOTTOM = ['V', 'M', 'L', 'W', 'B', 'E', 'J', 'S', 'T', 'U', 'G', 'O', '_R', 'C', 'I', 'P', 'A', 'Y', 'H', 'Z'];
let flyGroup = 'B';

export function MobileBottomBar() {
  const tool = useStore((s) => s.tool);
  const groupTool = useStore((s) => s.groupTool);
  const fg = useStore((s) => s.fg);
  const open = useStore((s) => s.doc.open);
  if (!open) return null;
  return (
    <nav className="m-bottom" aria-label="Herramientas">
      <div className="m-tools">
        {BOTTOM.map((k) => {
          const g = TOOL_GROUPS.find((x) => x.key === k);
          if (!g) return null;
          const current = g.tools.includes(tool) ? tool : groupTool[g.key] ?? g.tools[0];
          const Icon = ICONS[current];
          const active = g.tools.includes(tool);
          return (
            <button key={k} className={`m-tool ${active ? 'active' : ''}`} aria-label={TOOL_NAMES[current]} aria-pressed={active} data-tool={current}
              onClick={() => {
                if (active && g.tools.length > 1) { flyGroup = g.key; openSheet('tools'); return; }
                selectTool(current);
              }}>
              <Icon size={22} strokeWidth={1.6} />
              {g.tools.length > 1 && <span className="corner" />}
            </button>
          );
        })}
      </div>
      <button className="m-tool" aria-label="Ajustes" onClick={() => openSheet('adjust')} data-testid="m-adjust"><SlidersHorizontal size={22} strokeWidth={1.6} /></button>
      <button className="m-color" aria-label="Color" style={{ background: fg }} onClick={() => openSheet('color')} data-testid="m-color" />
    </nav>
  );
}

// ------------------------------------------------------------------ barra contextual

/** Acciones a mano según lo que se esté haciendo (en escritorio van con teclado). */
export function MobileContextBar() {
  const doc = useStore((s) => s.doc);
  const tool = useStore((s) => s.tool);
  const transform = useStore((s) => s.transform);
  const crop = useStore((s) => s.crop);
  const textEdit = useStore((s) => s.textEdit);
  const penDrawing = useStore((s) => s.penDrawing);
  const puppet = useStore((s) => s.puppet);
  const straighten = useStore((s) => s.straighten);
  const pcrop = useStore((s) => s.pcrop);
  if (!doc.open) return null;
  let items: [string, () => void, string?][] = [];
  if (textEdit) items = [['OK', finishTextEdit, 'primary']];
  else if (puppet) items = [['Cancelar', () => press('Escape')], ['Aplicar', () => press('Enter'), 'primary']];
  else if (transform) items = [['Cancelar', () => press('Escape')], ...(transform.mode === 'warp' ? [] : [['Deformar', () => run('edit.warp')] as [string, () => void]]), ['Aplicar', () => press('Enter'), 'primary']];
  else if (crop && tool === 'crop') items = [['Restablecer', () => press('Escape')], ['Enderezar', () => useStore.setState({ straighten: !useStore.getState().straighten }), straighten ? 'on' : undefined], ['Recortar', () => press('Enter'), 'primary']];
  else if (pcrop && tool === 'perspectiveCrop') items = [['Cancelar', () => press('Escape')], ['Recortar', () => press('Enter'), 'primary']];
  else if (tool === 'polylasso') items = [['Cerrar selección', () => press('Enter'), 'primary']];
  else if (penDrawing != null) items = [['Terminar trazado', () => press('Enter'), 'primary']];
  else if (doc.selection) items = [
    ['Deseleccionar', () => run('select.none')], ['Invertir', () => run('select.invert')], ['Refinar', () => run('select.refine')],
    ['Rellenar según contenido', () => run('edit.contentAware')], ['Capa vía copiar', () => run('layer.viaCopy')],
    ['Máscara', () => engine.call('addMask', 'selection')], ['Transformar', () => run('edit.freeTransform')],
  ];
  else if (['marquee', 'marqueeEllipse', 'lasso', 'wand', 'objectSelect', 'quickSelect'].includes(tool)) items = [
    ['Seleccionar sujeto', () => run('select.subject')], ['Gama de colores', () => run('select.colorRange')], ['Todo', () => run('select.all')], ['Quitar fondo', () => run('ai.removeBg')],
  ];
  if (!items.length) return null;
  return (
    <div className="m-context" data-testid="m-context">
      {items.map(([label, fn, kind]) => <button key={label} className={`chip ${kind ?? ''}`} onClick={fn}>{label}</button>)}
    </div>
  );
}

// ------------------------------------------------------------------ hojas

function Sheet({ title, children, onBack, tall }: { title: string; children: ReactNode; onBack?: () => void; tall?: boolean }) {
  return (
    <div className="m-veil" onPointerDown={(e) => { if (e.target === e.currentTarget) openSheet(null); }}>
      <section className={`m-sheet ${tall ? 'tall' : ''}`} role="dialog" aria-label={title} data-testid="m-sheet">
        <div className="m-grip" />
        <header>
          {onBack ? <button className="m-icon" aria-label="Atrás" onClick={onBack}><ChevronLeft size={20} /></button> : <span className="m-icon-space" />}
          <h2>{title}</h2>
          <button className="m-icon" aria-label="Cerrar" onClick={() => openSheet(null)}><X size={20} /></button>
        </header>
        <div className="m-sheet-body">{children}</div>
      </section>
    </div>
  );
}

function MenuList({ items, onSub }: { items: Item[]; onSub: (label: string, items: Item[]) => void }) {
  const doc = useStore((s) => s.doc);
  return (
    <div className="m-list">
      {items.map((it, i) => {
        if (it === '-') return <div key={i} className="m-sep" />;
        if (typeof it !== 'string' && 'sub' in it) {
          return <button key={i} className="m-row" onClick={() => onSub(it.sub, it.items)}><span>{it.sub}</span><ChevronRight size={16} /></button>;
        }
        if (typeof it !== 'string') return <button key={i} className="m-row" disabled><span>{it.label}</span><small>Próximamente</small></button>;
        const c = commandById[it];
        if (!c) return null;
        return (
          <button key={i} className="m-row" disabled={!!c.needsDoc && !doc.open} onClick={() => { openSheet(null); runCommand(c); }}>
            <span>{c.label}</span>{c.checked?.() && <Check size={16} />}
          </button>
        );
      })}
    </div>
  );
}

function MenuSheet() {
  const [stack, setStack] = useState<{ label: string; items: Item[] }[]>([]);
  const top = stack[stack.length - 1];
  if (top) return <Sheet title={top.label} onBack={() => setStack(stack.slice(0, -1))} tall><MenuList items={top.items} onSub={(label, items) => setStack([...stack, { label, items }])} /></Sheet>;
  return (
    <Sheet title="Menú" tall>
      <div className="m-list">
        {MENUS.map((m) => <button key={m.label} className="m-row" onClick={() => setStack([{ label: m.label, items: m.items }])}><span>{m.label}</span><ChevronRight size={16} /></button>)}
        <div className="m-sep" />
        <button className="m-row" onClick={() => setLayout('desktop')} data-testid="m-desktop"><span>Usar la interfaz de escritorio</span></button>
      </div>
    </Sheet>
  );
}

function ToolsSheet() {
  const tool = useStore((s) => s.tool);
  const g = TOOL_GROUPS.find((x) => x.key === flyGroup) ?? TOOL_GROUPS[0];
  return (
    <Sheet title="Herramientas">
      <div className="m-list">
        {g.tools.map((t) => {
          const Icon = ICONS[t];
          return <button key={t} className={`m-row ${t === tool ? 'on' : ''}`} onClick={() => { selectTool(t); openSheet(null); }}><span className="m-row-icon"><Icon size={18} /> {TOOL_NAMES[t]}</span>{t === tool && <Check size={16} />}</button>;
        })}
      </div>
    </Sheet>
  );
}

function AdjustSheet() {
  return (
    <Sheet title="Ajustes" tall>
      <div className="m-grid">
        {ADJ_MENU.map((t) => (
          <button key={t} className="m-tile" onClick={async () => { await engine.call('newAdjustmentLayer', t); openSheet('props'); }}>
            <Palette size={18} /><span>{ADJUSTMENT_LABELS[t]}</span>
          </button>
        ))}
      </div>
      <div className="m-list">
        <div className="m-sep" />
        {['ai.removeBg', 'select.subject', 'edit.contentAware', 'filter.gaussianBlur', 'filter.unsharpMask', 'image.autoTone', 'image.desaturate'].map((id) => {
          const c = commandById[id];
          return c ? <button key={id} className="m-row" onClick={() => { openSheet(null); runCommand(c); }}><span>{c.label}</span></button> : null;
        })}
      </div>
    </Sheet>
  );
}

function ExportSheet() {
  const name = useStore((s) => s.doc.name);
  const share = async () => {
    try {
      const blob = await engine.call<Blob>('exportImage', 'image/png', 0.92);
      const file = new File([blob], `${name.replace(/\.[^.]+$/, '') || 'imagen'}.png`, { type: 'image/png' });
      const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
      if (nav.canShare?.({ files: [file] })) { await nav.share({ files: [file], title: name }); openSheet(null); return; }
    } catch (e) { if ((e as Error).name === 'AbortError') return; }
    useStore.getState().toast('Este navegador no permite compartir archivos: se descarga el PNG.');
    exportImage('image/png');
  };
  const rows: [string, () => void][] = [
    ['Compartir…', share],
    ['Guardar PNG', () => exportImage('image/png')],
    ['Guardar JPEG', () => exportImage('image/jpeg', 0.9)],
    ['Guardar WebP', () => exportImage('image/webp', 0.9)],
    ['Guardar PSD', () => { void savePsd(); }],
    ['Exportar como…', () => run('file.export')],
  ];
  return (
    <Sheet title="Exportar">
      <div className="m-list">{rows.map(([l, fn]) => <button key={l} className="m-row" onClick={() => { if (l !== 'Compartir…') openSheet(null); fn(); }}><span>{l}</span></button>)}</div>
    </Sheet>
  );
}

export function MobileSheets() {
  const sheet = useStore((s) => s.sheet);
  switch (sheet) {
    case 'menu': return <MenuSheet />;
    case 'tools': return <ToolsSheet />;
    case 'adjust': return <AdjustSheet />;
    case 'export': return <ExportSheet />;
    case 'layers': return (
      <Sheet title="Capas" tall>
        <div className="m-panel">
          <div className="m-actions"><button className="chip" onClick={() => openSheet('props')} data-testid="m-props">Propiedades de la capa</button><button className="chip" onClick={() => useStore.getState().setDialog({ kind: 'layerStyle' })}>Estilo de capa</button></div>
          <LayersPanel />
        </div>
      </Sheet>
    );
    case 'props': return <Sheet title="Propiedades" tall onBack={() => openSheet('layers')}><div className="m-panel"><PropertiesPanel /></div></Sheet>;
    case 'history': return <Sheet title="Historial" tall><div className="m-panel"><HistoryPanel /></div></Sheet>;
    case 'color': return <Sheet title="Color"><div className="m-panel"><ColorPanel /></div></Sheet>;
    default: return null;
  }
}
