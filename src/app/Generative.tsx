import { useState } from 'react';
import { engine } from '../engine/client';
import { useStore, savePrefs } from './store';
import { Modal } from './Dialogs';
import type { Rect } from '../engine/types';

interface GenSettings { endpoint: string; apiKey: string }

function loadSettings(): GenSettings {
  try { return { endpoint: '', apiKey: '', ...JSON.parse(localStorage.getItem('lienzo:gen') ?? '{}') }; } catch { return { endpoint: '', apiKey: '' }; }
}

/**
 * Relleno generativo: envía la zona seleccionada (imagen + máscara + texto) a un
 * proveedor configurable. El resultado vuelve como capa nueva con máscara, como en Photoshop.
 * Protocolo: POST multipart (image, mask, prompt) → image/png o JSON { image: base64 }.
 * En server/generative-proxy.mjs hay un proxy de ejemplo con créditos por usuario.
 */
export function GenerativeDialog({ close }: { close: () => void }) {
  const hasSel = useStore((s) => !!s.doc.selection);
  const [settings, setSettings] = useState(loadSettings);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    if (!settings.endpoint) { setError('Configura primero la URL del servicio.'); return; }
    savePrefs('gen', settings);
    setBusy(true);
    setError('');
    try {
      const input = await engine.call<{ image: Blob; mask: Blob; rect: Rect } | null>('generativeInput');
      if (!input) throw new Error('Haz primero una selección.');
      const fd = new FormData();
      fd.append('image', input.image, 'image.png');
      fd.append('mask', input.mask, 'mask.png');
      fd.append('prompt', prompt);
      const res = await fetch(settings.endpoint, { method: 'POST', body: fd, headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {} });
      if (!res.ok) throw new Error(`El servicio respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
      let buf: ArrayBuffer;
      if ((res.headers.get('content-type') ?? '').includes('json')) {
        const j = await res.json();
        const b64 = j.image ?? j.data?.[0]?.b64_json;
        if (!b64) throw new Error('Respuesta sin imagen.');
        buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      } else {
        buf = await res.arrayBuffer();
      }
      await engine.call('placeGenerated', buf, input.rect, prompt);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Relleno generativo" okLabel={busy ? 'Generando…' : 'Generar'} onClose={close} onOk={() => { if (!busy) run(); }}>
      {!hasSel && <p className="warn-box">Haz una selección de la zona que quieres rellenar.</p>}
      <label className="field">Descripción<input value={prompt} autoFocus placeholder="p. ej. un cielo al atardecer (vacío = rellenar según el contenido)" onChange={(e) => setPrompt(e.target.value)} /></label>
      <details open={!settings.endpoint}>
        <summary>Servicio de IA</summary>
        <label className="field">URL<input value={settings.endpoint} placeholder="https://tu-servidor/generate" onChange={(e) => setSettings({ ...settings, endpoint: e.target.value })} /></label>
        <label className="field">Clave (opcional)<input type="password" value={settings.apiKey} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} /></label>
        <p className="hint">La generación necesita un servidor con un modelo de imagen (y cuesta dinero por imagen): es la función de pago natural con créditos. Usa el proxy de ejemplo de <code>server/generative-proxy.mjs</code>. La clave se guarda sólo en este navegador.</p>
      </details>
      {error && <p className="warn-box">{error}</p>}
    </Modal>
  );
}
