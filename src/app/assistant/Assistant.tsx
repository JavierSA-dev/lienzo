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

const S = () => useStore.getState();

/** Ejecuta un paso de herramienta y devuelve la línea para el chat. */
async function runTool(name: string, args: Record<string, unknown>): Promise<Act & { result: string }> {
  const t = toolByName[name];
  if (!t) return { label: `Herramienta desconocida: ${name}`, ok: false, result: `Error: herramienta desconocida ${name}` };
  try {
    const r = await t.run(args ?? {});
    return { label: r, ok: true, result: r };
  } catch (e) {
    const m = (e as Error).message;
    return { label: m, ok: false, result: `Error: ${m}` };
  }
}

export function AssistantPanel() {
  const open = useStore((s) => s.assistantOpen);
  const docOpen = useStore((s) => s.doc.open);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<Cfg>(loadCfg);
  const [showCfg, setShowCfg] = useState(false);
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
    wire.current = wire.current.map((w) => (Array.isArray(w.content) ? { ...w, content: (w.content as { type: string }[]).map((b) => (b.type === 'image' ? { type: 'text', text: '[miniatura anterior]' } : b)) } : w));
    const content: unknown[] = [];
    if (thumbnail) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumbnail.jpegBase64 } });
    content.push({ type: 'text', text: `Documento: ${ctx ? JSON.stringify(summary) : 'ninguno abierto'}\n\nPetición: ${text}` });
    wire.current.push({ role: 'user', content });
    for (let step = 0; step < 8; step++) {
      const r = await fetch(cfg.endpoint || '/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
        body: JSON.stringify({ messages: wire.current.slice(-24), tools: toolSchemas() }),
      });
      const j = await r.json().catch(() => ({ error: `Error ${r.status}` }));
      if (!r.ok) throw Object.assign(new Error(j.error ?? `Error ${r.status}`), { status: r.status });
      const blocks = (j.content ?? []) as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      wire.current.push({ role: 'assistant', content: blocks });
      const uses = blocks.filter((b) => b.type === 'tool_use');
      if (!uses.length || j.stop_reason !== 'tool_use') return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || 'Hecho.';
      const results: unknown[] = [];
      for (const u of uses) {
        const a = await runTool(u.name!, u.input ?? {});
        acts.push(a);
        setMsgs((o) => [...o.slice(0, -1), { ...o[o.length - 1], acts: [...acts] }]);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: a.result, ...(a.ok ? {} : { is_error: true }) });
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
      const plan = cfg.alwaysAI ? null : planLocal(text, stats);
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
      <div className="assistant-list" ref={list} data-testid="assistant-list">
        {!msgs.length && (
          <div className="assistant-empty">
            <p>{docOpen ? 'Dime qué quieres cambiar en la imagen.' : 'Abre o crea un documento y dime qué quieres hacer.'}</p>
            <div className="assistant-chips">
              {SUGGESTIONS.map((s) => <button type="button" key={s} className="chip" disabled={!docOpen || busy} onClick={() => void send(s)}>{s}</button>)}
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
            {m.text && <div className="amsg-text">{m.text}</div>}
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
      <form className="assistant-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea ref={field} rows={1} value={input} placeholder="p. ej. sube el contraste y recorta a 16:9" aria-label="Petición al asistente"
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } if (e.key === 'Escape') useStore.setState({ assistantOpen: false }); }}
          onChange={(e) => setInput(e.target.value)} />
        <button type="submit" className="icon-btn send" aria-label="Enviar" disabled={!input.trim() || busy}><Send size={15} /></button>
      </form>
    </section>
  );
}
