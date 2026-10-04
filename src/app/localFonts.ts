// Fuentes instaladas en el equipo (Local Font Access API, Chrome y Edge).
import { useStore, savePrefs } from './store';

export async function askLocalFonts() {
  const w = window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> };
  if (!w.queryLocalFonts) { useStore.getState().toast('Este navegador no permite leer las fuentes del equipo (usa Chrome o Edge).', 'warn'); return; }
  try {
    const list = await w.queryLocalFonts();
    const fams = [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    useStore.setState({ localFonts: fams });
    savePrefs('localFonts', fams);
    useStore.getState().toast(`${fams.length} fuentes del equipo disponibles`);
  } catch {
    useStore.getState().toast('Permiso denegado para leer las fuentes del equipo.', 'warn');
  }
}
