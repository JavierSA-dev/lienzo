/** Motivos del usuario (Edición > Definir motivo): se guardan en IndexedDB y se registran en el motor. */
import { engine } from '../engine/client';
import { useStore } from './store';
import { openLienzoDb } from './brushPresets';

export interface UserPattern { id: string; name: string; w: number; h: number; data: Uint8ClampedArray }

export async function loadPatterns() {
  try {
    const d = await openLienzoDb();
    const list = await new Promise<UserPattern[]>((res) => { const q = d.transaction('patterns').objectStore('patterns').getAll(); q.onsuccess = () => res(q.result as UserPattern[]); q.onerror = () => res([]); });
    for (const p of list) await engine.call('registerPattern', p.id, p.w, p.h, p.data);
    useStore.setState({ userPatterns: list });
  } catch { /* sin almacenamiento */ }
}

export async function definePattern() {
  const r = await engine.call<{ w: number; h: number; data: Uint8ClampedArray } | null>('definePattern');
  if (!r) return;
  const n = useStore.getState().userPatterns.length + 1;
  const p: UserPattern = { id: `user:${Date.now()}`, name: `Motivo ${n}`, ...r };
  await engine.call('registerPattern', p.id, p.w, p.h, p.data);
  useStore.setState({ userPatterns: [...useStore.getState().userPatterns, p] });
  try { const d = await openLienzoDb(); d.transaction('patterns', 'readwrite').objectStore('patterns').put(p); } catch { /* sólo en esta sesión */ }
  useStore.getState().toast(`Motivo «${p.name}» definido (${p.w} × ${p.h} px)`);
}
