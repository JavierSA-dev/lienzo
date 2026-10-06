// Asistente de IA: pide cambios con tus palabras ("mejora la foto y recórtala a 4:5").
// Primero intenta el intérprete local (instantáneo y gratis); lo demás va al modelo de lenguaje.
import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, X, Settings2, Undo2, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { engine } from '../../engine/client';
import { useStore } from '../store';
import { planLocal, type Stats } from './local';
import { toolByName, toolSchemas } from './tools';

type Act = { label: string; ok: boolean };
type Msg = { role: 'user' | 'assistant'; text: string; acts?: Act[]; undoTo?: number; via?: 'local' | 'ia'; error?: boolean };
type Wire = { role: 'user' | 'assistant'; content: unknown };

const KEY = 'lienzo:assistant';
interface Cfg { endpoint: string; token: string; alwaysAI: boolean }
const loadCfg = (): Cfg => { try { return { endpoint: '/api/assistant', token: '', alwaysAI: false, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { endpoint: '/api/assistant', token: '', alwaysAI: false }; } };
const saveCfg = (c: Cfg) => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* sin almacenamiento */ } };

const SUGGESTIONS = ['Mejora la foto', 'Quita el fondo', 'Blanco y negro', 'Recorta a 4:5', 'Más cálida y con más contraste', 'Añade el texto "Oferta" arriba en blanco'];
/** Con una selección activa, las sugerencias son sobre lo seleccionado. */
const SEL_SUGGESTIONS = ['Elimínalo', 'Ponlo rojo', 'Hazlo más claro', 'Quítale el color', 'Desenfócalo', 'Pixélalo'];

const S = () => useStore.getState();

/** Identificador aleatorio de este navegador (para la cuota diaria de la versión de pruebas). */
function deviceId(): string {
  try {
    let id = localStorage.getItem('lienzo:device');
    if (!id || !/^[a-z0-9-]{16,64}$/i.test(id)) { id = crypto.randomUUID(); localStorage.setItem('lienzo:device', id); }
    return id;
  } catch { return 'sin-almacenamiento-0000'; }
}

type Quota = { configured: boolean; premium?: boolean; limit: number; left: number | null };

/** Ejecuta un paso de herramienta y devuelve la línea para el chat. */
async function runTool(name: string, args: Record<string, unknown>): Promise<Act & { result: string; image?: string }> {
  const t = toolByName[name];
  if (!t) return { label: `Herramienta desconocida: ${name}`, ok: false, result: `Error: herramienta desconocida ${name}` };
  try {
    const r = await t.run(args ?? {});
    if (typeof r !== 'string') return { label: name === 'inspect' ? 'Zona revisada.' : r.text, ok: true, result: r.text, image: r.image };
    return { label: r, ok: true, result: r };
  } catch (e) {
    const m = (e as Error).message;
    return { label: m, ok: false, result: `Error: ${m}` };
  }
}

/** Markdown mínimo de las respuestas del modelo: **negrita** y quitar almohadillas de títulos. */
function rich(t: string) {
  return t.replace(/^#{1,6}\s+/gm, '').split(/(\*\*[^*]+\*\*)/g).map((p, i) => (/^\*\*[^*]+\*\*$/.test(p) ? <b key={i}>{p.slice(2, -2)}</b> : p));
}

export function AssistantPanel() {
  const open = useStore((s) => s.assistantOpen);
  const docOpen = useStore((s) => s.doc.open);
  const hasSel = useStore((s) => !!s.doc.selection);
  const ask = useStore((s) => s.assistantAsk);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<Cfg>(loadCfg);
  const [showCfg, setShowCfg] = useState(false);
  const [quota, setQuota] = useState<Quota | null>(null);
  const headers = () => ({ 'X-Lienzo-Device': deviceId(), ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) });
  // Cuota de hoy al abrir el panel.
  useEffect(() => {
    if (!open) return;
    fetch(cfg.endpoint || '/api/assistant', { headers: headers() })
      .then((r) => (r.ok ? r.json() : null)).then((q) => setQuota(q && typeof q.limit === 'number' ? q : null)).catch(() => setQuota(null));
  }, [open, cfg.endpoint, cfg.token]); // eslint-disable-line react-hooks/exhaustive-deps
  const wire = useRef<Wire[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [msgs, busy]);
  useEffect(() => { if (open) setTimeout(() => field.current?.focus(), 50); }, [open]);

  const push = (m: Msg) => setMsgs((o) => [...o, m]);

  /** Bucle con el modelo: envía, ejecuta las herramientas pedidas y devuelve sus resultados. */
  const viaAI = async (text: string, acts: Act[]): Promise<string> => {
    const ctx = await engine.call<Record<string, unknown> | null>('assistantContext', 512);
    const { thumbnail, ...summary } = (ctx ?? {}) as { thumbnail?: { jpegBase64: string } } & Record<string, unknown>;
    // Las imágenes de turnos anteriores se quitan (solo cuenta la actual).
    // Las imágenes de turnos anteriores se quitan (también dentro de resultados de herramientas).
    const strip = (b: { type: string; content?: unknown }): unknown => b.type === 'image' ? { type: 'text', text: '[imagen anterior]' }
      : b.type === 'tool_result' && Array.isArray(b.content) ? { ...b, content: (b.content as { type: string }[]).map(strip) } : b;
    wire.current = wire.current.map((w) => (Array.isArray(w.content) ? { ...w, content: (w.content as { type: string }[]).map(strip) } : w));
    const content: unknown[] = [];
    if (thumbnail) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumbnail.jpegBase64 } });
    // Con una selección, el modelo ve además la zona seleccionada ampliada (con margen).
    const sel = (summary as { selection?: { x: number; y: number; w: number; h: number } | null }).selection;
    let selNote = '';
    if (sel) {
      const m = Math.round(Math.max(sel.w, sel.h) * 0.25);
      const v = await engine.call<{ w: number; h: number; scale: number; rect: { x: number; y: number; w: number; h: number }; jpegBase64: string } | null>('assistantView', { x: sel.x - m, y: sel.y - m, w: sel.w + 2 * m, h: sel.h + 2 * m }, 512).catch(() => null);
      if (v) {
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: v.jpegBase64 } });
        selNote = `\n\nHay una SELECCIÓN activa (x=${sel.x}, y=${sel.y}, ${sel.w}×${sel.h} px). La segunda imagen es esa zona ampliada con margen (zona x=${v.rect.x}, y=${v.rect.y}, ${v.rect.w}×${v.rect.h}; documento = imagen / ${Math.round(v.scale * 1000) / 1000} + origen). Salvo que diga otra cosa, la petición se refiere a lo seleccionado.`;
      }
    }
    content.push({ type: 'text', text: `Documento: ${ctx ? JSON.stringify(summary) : 'ninguno abierto'}${selNote}\n\nPetición: ${text}` });
    wire.current.push({ role: 'user', content });
    for (let step = 0; step < 12; step++) {
      const r = await fetch(cfg.endpoint || '/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ messages: wire.current.slice(-24), tools: toolSchemas() }),
      });
      const j = await r.json().catch(() => ({ error: `Error ${r.status}` }));
      if (typeof j.left === 'number') setQuota((q) => (q ? { ...q, left: j.left } : { configured: true, limit: j.limit ?? 10, left: j.left }));
      if (!r.ok) throw Object.assign(new Error(j.error ?? `Error ${r.status}`), { status: r.status });
      const blocks = (j.content ?? []) as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      wire.current.push({ role: 'assistant', content: blocks });
      const uses = blocks.filter((b) => b.type === 'tool_use');
      if (j.stop_reason === 'max_tokens') throw new Error('La respuesta del modelo se cortó por larga. Pídelo más sencillo o en partes.');
      if (!uses.length || j.stop_reason !== 'tool_use') return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || 'Hecho.';
      const results: { type: string; tool_use_id?: string; content: unknown; is_error?: boolean }[] = [];
      let changed = false;
      for (const u of uses) {
        const a = await runTool(u.name!, u.input ?? {});
        if (u.name !== 'inspect') changed = changed || a.ok;
        acts.push({ label: a.label, ok: a.ok });
        setMsgs((o) => [...o.slice(0, -1), { ...o[o.length - 1], acts: [...acts] }]);
        const img = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
        results.push({ type: 'tool_result', tool_use_id: u.id, content: a.image ? [{ type: 'text', text: a.result }, img(a.image)] : a.result, ...(a.ok ? {} : { is_error: true }) });
      }
      // El modelo ve cómo ha quedado el documento y puede corregirse.
      if (changed && S().doc.open) {
        const v = await engine.call<{ w: number; h: number; scale: number; jpegBase64: string } | null>('assistantView', null, 640).catch(() => null);
        const last = results[results.length - 1];
        if (v && last) {
          const note = { type: 'text', text: `Así queda el documento ahora (${v.w}×${v.h}; documento = imagen / ${Math.round(v.scale * 10000) / 10000}). Compruébalo: si no está bien, corrígelo antes de terminar.` };
          last.content = [...(Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }]), note, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: v.jpegBase64 } }];
        }
      }
      wire.current.push({ role: 'user', content: results });
    }
    return 'He llegado al máximo de pasos; revisa el resultado.';
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    setInput('');
    push({ role: 'user', text });
    setBusy(true);
    const before = S().doc.historyIndex;
    const acts: Act[] = [];
    push({ role: 'assistant', text: '', acts, undoTo: before });
    const finish = (m: Partial<Msg>) => setMsgs((o) => [...o.slice(0, -1), { ...o[o.length - 1], acts: [...acts], ...m, undoTo: S().doc.historyIndex !== before ? before : undefined }]);
    try {
      let stats: Stats | null = null;
      if (S().doc.open) stats = ((await engine.call<{ stats: Stats } | null>('assistantContext', 64))?.stats) ?? null;
      const plan = cfg.alwaysAI ? null : planLocal(text, stats, !!S().doc.selection);
      if (plan) {
        for (const p of plan) {
          const a = await runTool(p.tool, p.args);
          acts.push(a);
          setMsgs((o) => [...o.slice(0, -1), { ...o[o.length - 1], acts: [...acts] }]);
          if (!a.ok) break;
        }
        finish({ text: acts.every((a) => a.ok) ? 'Hecho.' : 'No he podido terminarlo.', via: 'local' });
      } else {
        try {
          const reply = await viaAI(text, acts);
          finish({ text: reply, via: 'ia' });
        } catch (e) {
          const st = (e as { status?: number }).status;
          const msg = st === 402 ? (e as Error).message
            : st === 503 || st === 404 || st === 405 || !st
              ? 'Esa petición necesita el modelo de IA, que no está disponible aquí. Sin él entiendo órdenes como: «mejora la foto», «quita el fondo», «blanco y negro», «recorta a 16:9», «más contraste», «gira a la derecha», «desenfoca 10 px», «añade el texto "Hola" arriba», «exporta en JPG».'
              : (e as Error).message;
          finish({ text: msg, error: true, via: 'ia' });
        }
      }
    } finally { setBusy(false); }
  };

  // Peticiones desde la barra de la selección.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!open || !ask) return;
    useStore.setState({ assistantAsk: null });
    void sendRef.current(ask.text);
  }, [open, ask]);

  if (!open) return null;
  return (
    <section className="assistant" data-testid="assistant" aria-label="Asistente">
      <header className="assistant-head">
        <Sparkles size={15} /><span className="assistant-title">Asistente</span>
        <span className="grow" />
        <button type="button" className="icon-btn" title="Ajustes del asistente" aria-label="Ajustes del asistente" onClick={() => setShowCfg(!showCfg)}><Settings2 size={14} /></button>
        <button type="button" className="icon-btn" title="Cerrar" aria-label="Cerrar asistente" onClick={() => useStore.setState({ assistantOpen: false })}><X size={14} /></button>
      </header>
      {showCfg && (
        <div className="assistant-cfg">
          <label className="field">Servicio de IA<input value={cfg.endpoint} aria-label="Dirección del servicio" placeholder="/api/assistant" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => { const c = { ...cfg, endpoint: e.target.value }; setCfg(c); saveCfg(c); }} /></label>
          <label className="field">Clave (opcional)<input value={cfg.token} type="password" aria-label="Clave del asistente" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => { const c = { ...cfg, token: e.target.value }; setCfg(c); saveCfg(c); }} /></label>
          <label className="field">Siempre la IA<span><input type="checkbox" checked={cfg.alwaysAI} aria-label="Usar siempre el modelo de IA" onChange={(e) => { const c = { ...cfg, alwaysAI: e.target.checked }; setCfg(c); saveCfg(c); }} /> No usar el intérprete local</span></label>
        </div>
      )}
      <div className="assistant-quota" data-testid="assistant-quota">
        <b>Beta</b>{' '}
        {quota?.premium ? 'Premium: peticiones de IA sin límite.'
          : quota?.configured && quota.left != null ? `El asistente está en pruebas y en desarrollo: irá mejorando. Te quedan ${quota.left} de ${quota.limit} peticiones de IA hoy; las órdenes sencillas no cuentan.`
          : quota && !quota.configured ? 'El asistente está en pruebas: el modelo de IA no está activado; funcionan las órdenes sencillas.'
          : 'El asistente está en pruebas y en desarrollo: peticiones de IA limitadas al día; las órdenes sencillas no cuentan.'}
      </div>
      <div className="assistant-list" ref={list} data-testid="assistant-list">
        {!msgs.length && (
          <div className="assistant-empty">
            <p>{!docOpen ? 'Abre o crea un documento y dime qué quieres hacer.' : hasSel ? 'Dime qué hago con lo seleccionado.' : 'Dime qué quieres cambiar en la imagen. Consejo: selecciona algo (un sombrero, una cara) y pídeme cambios solo ahí.'}</p>
            <div className="assistant-chips">
              {(hasSel ? SEL_SUGGESTIONS : SUGGESTIONS).map((s) => <button type="button" key={s} className="chip" disabled={!docOpen || busy} onClick={() => void send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`amsg ${m.role === 'user' ? 'from-user' : 'from-ai'} ${m.error ? 'error' : ''}`} data-testid={`amsg-${m.role}`}>
            {m.acts && m.acts.length > 0 && (
              <ul className="amsg-acts">
                {m.acts.map((a, k) => <li key={k} className={a.ok ? 'ok' : 'bad'}>{a.ok ? <Check size={12} /> : <AlertTriangle size={12} />}<span>{a.label}</span></li>)}
              </ul>
            )}
            {m.text && <div className="amsg-text">{rich(m.text)}</div>}
            {m.role === 'assistant' && (m.via || m.undoTo != null) && (
              <div className="amsg-foot">
                {m.via && <span className="hint">{m.via === 'local' ? 'Local' : 'IA'}</span>}
                {m.undoTo != null && i === msgs.length - 1 && !busy && (
                  <button type="button" className="link-btn" onClick={() => { engine.call('jumpHistory', m.undoTo!); setMsgs((o) => o.map((x, j) => (j === i ? { ...x, undoTo: undefined, text: `${x.text} (deshecho)` } : x))); }}><Undo2 size={12} /> Deshacer</button>
                )}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="amsg from-ai pending"><Loader2 size={14} className="spin" /> Trabajando…</div>}
      </div>
      {hasSel && docOpen && msgs.length > 0 && (
        <div className="assistant-chips sel-chips" aria-label="Sugerencias para la selección">
          {SEL_SUGGESTIONS.slice(0, 4).map((s) => <button type="button" key={s} className="chip" disabled={busy} onClick={() => void send(s)}>{s}</button>)}
        </div>
      )}
      <form className="assistant-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea ref={field} rows={1} value={input} placeholder={hasSel ? 'p. ej. elimínalo, ponlo azul…' : 'p. ej. sube el contraste y recorta a 16:9'} aria-label="Petición al asistente"
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } if (e.key === 'Escape') useStore.setState({ assistantOpen: false }); }}
          onChange={(e) => setInput(e.target.value)} />
        <button type="submit" className="icon-btn send" aria-label="Enviar" disabled={!input.trim() || busy}><Send size={15} /></button>
      </form>
    </section>
  );
}
