import { useEffect } from 'react';
import { MenuBar } from './MenuBar';
import { OptionsBar } from './OptionsBar';
import { Toolbar } from './Toolbar';
import { CanvasArea } from './CanvasArea';
import { ColorPanel, HistoryPanel, LayersPanel } from './Panels';
import { StatusBar, Toasts } from './StatusBar';
import { Dialogs } from './Dialogs';
import { useStore } from './store';
import { commandForEvent, opacityFromDigit } from './commands';

function useShortcuts() {
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

    const down = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.dialog || isTyping(e.target)) return;
      // Espacio mantenido = Mano temporal (como en Photoshop).
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat && s.doc.open) s.holdTool('hand');
        return;
      }
      const op = opacityFromDigit(e);
      if (op !== null && (s.tool === 'brush' || s.tool === 'eraser')) {
        s.setBrush({ opacity: op });
        return;
      }
      const cmd = commandForEvent(e);
      if (!cmd) return;
      e.preventDefault();
      if (cmd.needsDoc && !s.doc.open) return;
      cmd.run();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') useStore.getState().holdTool(null);
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().doc.dirty) e.preventDefault();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);
}

export function App() {
  useShortcuts();
  const panelsHidden = useStore((s) => s.panelsHidden);
  return (
    <div className={`app ${panelsHidden ? 'panels-hidden' : ''}`}>
      <MenuBar />
      <OptionsBar />
      <Toolbar />
      <CanvasArea />
      <div className="dock">
        <ColorPanel />
        <HistoryPanel />
        <LayersPanel />
      </div>
      <StatusBar />
      <Dialogs />
      <Toasts />
    </div>
  );
}
