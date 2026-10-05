import { Timeline } from './Timeline';
import { useEffect } from 'react';
import { MenuBar } from './MenuBar';
import { OptionsBar } from './OptionsBar';
import { Toolbar } from './Toolbar';
import { CanvasArea } from './CanvasArea';
import { ColorPanel, HistoryPanel, LayersPanel, PropertiesPanel, ActionsPanel } from './Panels';
import { StatusBar, Toasts } from './StatusBar';
import { Dialogs } from './Dialogs';
import { useStore } from './store';
import { commandForEvent, handleDigit, runCommand, onPasteEvent, markPasteInPlace } from './commands';
import { engine } from '../engine/client';
import { useIsMobile, MobileTopBar, MobileBottomBar, MobileContextBar, MobileSheets } from './Mobile';
import type { ToolId } from '../engine/types';

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

/** Herramientas que Alt convierte temporalmente en Cuentagotas (como Photoshop). */
const ALT_EYEDROPPER = new Set<ToolId>(['brush', 'pencil', 'bucket', 'gradient', 'shape']);
/** Herramientas que no se cambian por Mover al mantener Ctrl. */
const NO_CTRL_MOVE = new Set<ToolId>(['move', 'hand', 'zoom', 'text', 'crop', 'pathSelect']);

function useShortcuts() {
  useEffect(() => {
    // Tecla de herramienta mantenida (>300 ms): al soltar vuelve a la anterior ("spring-loaded").
    let spring: { code: string; prev: ToolId; t: number } | null = null;

    const down = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.dialog || isTyping(e.target) || s.textEdit) return;

      // Herramientas temporales.
      if (e.code === 'Space') {
        e.preventDefault();
        if (e.repeat || !s.doc.open) return;
        if (e.ctrlKey || e.metaKey) s.pushTempTool('zoom', 'Space');
        else s.pushTempTool('hand', 'Space');
        return;
      }
      if ((e.key === 'Control' || e.key === 'Meta') && !e.repeat && s.doc.open && !NO_CTRL_MOVE.has(s.tool) && !s.transform) {
        s.pushTempTool(s.tool === 'pen' ? 'pathSelect' : 'move', 'Control');
      }
      if (e.key === 'Alt') {
        e.preventDefault(); // evita que el navegador enfoque su menú
        if (!e.repeat && ALT_EYEDROPPER.has(s.tool)) s.pushTempTool('eyedropper', 'Alt');
        return;
      }

      // Flechas: mover capa (Mover) o selección (herramientas de selección).
      if (e.key.startsWith('Arrow') && s.doc.open && !e.ctrlKey && !e.altKey) {
        const n = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0, dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
        e.preventDefault();
        if (s.tool === 'move') engine.call('moveLayerBy', dx, dy);
        else if (s.doc.selection && ['marquee', 'marqueeEllipse', 'lasso', 'polylasso', 'wand', 'objectSelect', 'quickSelect'].includes(s.tool)) engine.call('moveSelectionBy', dx, dy);
        return;
      }

      // Escape: deselecciona si no hay otra cosa en curso (Photoshop no lo hace, pero es cómodo en web).
      if (e.key === 'Escape') return;

      if (handleDigit(e)) { e.preventDefault(); return; }

      const cmd = commandForEvent(e);
      if (!cmd) return;
      // Pegar usa el evento "paste" del navegador (trae la imagen del sistema).
      if (cmd.id === 'edit.paste' || cmd.id === 'edit.pasteInPlace') { markPasteInPlace(cmd.id === 'edit.pasteInPlace'); return; }
      // Copiar/cortar sin selección ni documento: deja actuar al navegador.
      e.preventDefault();
      if (s.transform && !cmd.id.startsWith('view.')) return;
      const isTool = cmd.id.startsWith('tool.') && !e.shiftKey;
      const before = s.tool;
      if (isTool && !e.repeat) spring = { code: e.code, prev: before, t: performance.now() };
      if (isTool && e.repeat) return;
      runCommand(cmd);
    };

    const up = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (e.code === 'Space') s.popTempTool('Space');
      if (e.key === 'Control' || e.key === 'Meta') s.popTempTool('Control');
      if (e.key === 'Alt') { e.preventDefault(); s.popTempTool('Alt'); }
      if (spring && e.code === spring.code) {
        if (performance.now() - spring.t > 300 && useStore.getState().tool !== spring.prev) s.setTool(spring.prev);
        spring = null;
      }
    };

    const blur = () => {
      const s = useStore.getState();
      for (const k of ['Space', 'Control', 'Alt']) s.popTempTool(k);
    };

    const paste = (e: ClipboardEvent) => { if (!isTyping(e.target)) onPasteEvent(e); };
    const beforeUnload = (e: BeforeUnloadEvent) => { if (useStore.getState().doc.dirty) e.preventDefault(); };
    const fs = () => useStore.setState({ fullscreen: !!document.fullscreenElement });

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('paste', paste);
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('fullscreenchange', fs);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('paste', paste);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('fullscreenchange', fs);
    };
  }, []);
}

export function App() {
  useShortcuts();
  const panelsHidden = useStore((s) => s.panelsHidden);
  const mobile = useIsMobile();
  const docOpen = useStore((s) => s.doc.open);
  const timeline = useStore((s) => s.timelineOpen);
  // El lienzo ocupa siempre la misma posición del árbol: al cambiar de interfaz no se vuelve a crear
  // (su canvas ya pertenece al motor del worker).
  return (
    <div className={`app ${mobile ? 'mobile' : ''} ${panelsHidden && !mobile ? 'panels-hidden' : ''} ${timeline ? 'with-timeline' : ''}`}>
      {mobile ? <MobileTopBar /> : <MenuBar />}
      {mobile && !docOpen ? null : <OptionsBar />}
      {mobile ? null : <Toolbar />}
      <CanvasArea />
      {mobile ? null : (
        <div className="dock">
          <ColorPanel />
          <PropertiesPanel />
          <HistoryPanel />
          <ActionsPanel />
          <LayersPanel />
        </div>
      )}
      <Timeline />
      {mobile ? null : <StatusBar />}
      {mobile ? <MobileContextBar /> : null}
      {mobile ? <MobileBottomBar /> : null}
      {mobile ? <MobileSheets /> : null}
      <Dialogs />
      <Toasts />
    </div>
  );
}
