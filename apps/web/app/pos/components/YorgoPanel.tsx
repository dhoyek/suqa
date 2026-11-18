'use client';
import { useEffect, useRef, useState } from 'react';
import { fmtLbp, fmtUsd, num, text, type CatalogIndex, type Product } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import Modal from './Modal';

// Yorgo in the till: the staff member pastes a customer's message, Yorgo proposes a draft, a person checks it and sends it to the cart.
// The assistant never sells: a draft carries item ids and quantities only — names, prices and stock shown here come from the catalog on
// this device, and the sale itself goes through the cart and the pay dialog like any other. Needs internet; the till works without it.
export type YorgoCartLine = { product: Product; quantity: number; note?: string };
type DraftIn = { kind?: string; lines?: { product_id: string; quantity: number; note?: string }[]; choices?: { phrase: string; quantity: number; options: string[] }[]; not_found?: string[] };
type Line = { key: string; product: Product; quantity: number; note?: string };
type Choice = { key: string; phrase: string; quantity: number; options: Product[] };
type Draft = { lines: Line[]; choices: Choice[]; notFound: string[]; state: 'open' | 'added' | 'discarded' };
type Msg = { id: number; from: 'me' | 'yorgo' | 'note'; text: string; draft?: Draft };
type Reply = { status: 'ok'; conversation_id: string; reply: string; drafts: DraftIn[] } | { status: 'paused'; reason: string } | { status: 'error'; error: string; conversation_id?: string };

const price = (p: Product, locale: L) => (p.price_currency === 'lbp' ? fmtLbp(num(p.price_lbp), locale) : fmtUsd(Math.round(num(p.price_usd) * 100)));

export default function YorgoPanel({ open, onClose, shopId, locale, index, online, onAddToCart }: {
  open: boolean; onClose: () => void; shopId: string; locale: L; index: CatalogIndex; online: boolean;
  onAddToCart: (lines: YorgoCartLine[], conversationId: string | null) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState(''); const [busy, setBusy] = useState(false);
  const conv = useRef<string | null>(null); const seq = useRef(0); const endRef = useRef<HTMLDivElement>(null); const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) { endRef.current?.scrollIntoView({ block: 'end' }); } }, [msgs, busy, open]);
  useEffect(() => { if (open && window.matchMedia('(pointer: fine)').matches) boxRef.current?.focus(); }, [open]);

  const push = (m: Omit<Msg, 'id'>) => setMsgs(ms => [...ms, { ...m, id: ++seq.current }]);
  // the draft as the till sees it: an id this device does not know (another shop, a made-up id, an inactive item) is not sellable here
  const sellable = (id: string): Product | undefined => { const p = index.byId.get(id); return p && p.is_active !== false ? p : undefined; };
  const toDraft = (d: DraftIn): Draft | undefined => {
    const lines: Line[] = []; const choices: Choice[] = []; const notFound = [...(d.not_found ?? [])];
    (d.lines ?? []).forEach((l, i) => { const p = sellable(l.product_id); if (p) lines.push({ key: `l${i}`, product: p, quantity: l.quantity, note: l.note }); });
    (d.choices ?? []).forEach((c, i) => {
      const options = c.options.map(sellable).filter((p): p is Product => !!p);
      if (options.length > 1) choices.push({ key: `c${i}`, phrase: c.phrase, quantity: c.quantity, options });
      else if (options.length === 1) lines.push({ key: `c${i}`, product: options[0], quantity: c.quantity });
      else notFound.push(c.phrase);
    });
    return lines.length || choices.length || notFound.length ? { lines, choices, notFound, state: 'open' } : undefined;
  };

  const send = async () => {
    const message = input.trim(); if (!message || busy) return;
    if (!online) { push({ from: 'note', text: pt('yorgoOffline', locale) }); return; }
    setInput(''); push({ from: 'me', text: message }); setBusy(true);
    try {
      const res = await fetch('/api/yorgo/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'seller', shop_id: shopId, conversation_id: conv.current, message }) });
      const r = (res.status === 401 ? { status: 'error', error: 'unauthorized' } : await res.json()) as Reply;
      if (r.status === 'ok') {
        conv.current = r.conversation_id;
        const drafts = (r.drafts ?? []).filter(d => d.kind === 'draft_order').map(toDraft).filter((d): d is Draft => !!d);
        if (r.reply) push({ from: 'yorgo', text: r.reply });
        drafts.forEach(draft => push({ from: 'yorgo', text: '', draft }));
        if (!r.reply && !drafts.length) push({ from: 'note', text: pt('yorgoError', locale) });
      } else if (r.status === 'paused') {
        push({ from: 'note', text: pt(r.reason === 'rate' ? 'yorgoRate' : r.reason === 'off' ? 'yorgoOff' : 'yorgoCap', locale) });
      } else {
        if (r.conversation_id) conv.current = r.conversation_id;
        push({ from: 'note', text: pt(r.error === 'unauthorized' ? 'yorgoSignIn' : 'yorgoError', locale) });
      }
    } catch { push({ from: 'note', text: pt('yorgoOffline', locale) }); }
    setBusy(false);
  };

  const patch = (id: number, f: (d: Draft) => Draft) => setMsgs(ms => ms.map(m => (m.id === id && m.draft ? { ...m, draft: f(m.draft) } : m)));
  const step = (p: Product) => (p.decimal_qty ? 0.5 : 1);
  const accept = (m: Msg) => {
    if (!m.draft?.lines.length) return;
    onAddToCart(m.draft.lines.map(l => ({ product: l.product, quantity: l.quantity, note: l.note })), conv.current);
    patch(m.id, d => ({ ...d, state: 'added' }));
  };
  const reset = () => { setMsgs([]); conv.current = null; setInput(''); };

  return (
    <Modal open={open} onClose={onClose} wide title={<>✨ Yorgo <small className="yorgo-tag">{pt('yorgoAi', locale)}</small></>}
      actions={msgs.length ? <button className="btn icon" title={pt('yorgoNew', locale)} onClick={reset}>🗒</button> : undefined}
      footer={<div className="yorgo-input">
        <textarea ref={boxRef} className="input" rows={2} dir="auto" placeholder={pt('yorgoPlaceholder', locale)} value={input} maxLength={2000} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); void send(); } }} />
        <button className="btn primary" disabled={busy || !input.trim()} onClick={() => void send()} aria-label={pt('yorgoSend', locale)}>➤</button>
      </div>}>
      <div className="yorgo-chat">
        {!msgs.length && <div className="yorgo-hello">
          <p style={{ margin: 0 }}><strong>{pt('yorgoHello', locale)}</strong></p>
          <p className="muted" style={{ margin: 0 }}>{pt('yorgoHint', locale)}</p>
          {!online && <p className="pill warn" style={{ margin: 0 }}>{pt('yorgoOffline', locale)}</p>}
        </div>}
        {msgs.map(m => m.draft ? (
          <div key={m.id} className={`yorgo-draft ${m.draft.state}`}>
            <div className="yorgo-draft-head">🧾 {pt('yorgoDraft', locale)}{m.draft.state === 'added' && <span className="pill ok">✓ {pt('yorgoAdded', locale)}</span>}{m.draft.state === 'discarded' && <span className="pill">{pt('yorgoDiscarded', locale)}</span>}</div>
            {m.draft.lines.map(l => (
              <div key={l.key} className="yorgo-line">
                <div className="yorgo-line-name">{text(l.product.name, locale)}{l.note && <small className="muted"> · 📝 {l.note}</small>}<small className="muted num"> · {price(l.product, locale)}{l.product.unit ? ` /${l.product.unit}` : ''}</small></div>
                {m.draft!.state === 'open' ? <div className="qty-btns">
                  <button onClick={() => patch(m.id, d => ({ ...d, lines: d.lines.map(x => (x.key === l.key ? { ...x, quantity: Math.max(step(l.product), Math.round((x.quantity - step(l.product)) * 1000) / 1000) } : x)) }))}>−</button>
                  <span>{l.quantity}</span>
                  <button onClick={() => patch(m.id, d => ({ ...d, lines: d.lines.map(x => (x.key === l.key ? { ...x, quantity: Math.round((x.quantity + step(l.product)) * 1000) / 1000 } : x)) }))}>+</button>
                  <button className="rm" onClick={() => patch(m.id, d => ({ ...d, lines: d.lines.filter(x => x.key !== l.key) }))}>✕</button>
                </div> : <strong className="num">× {l.quantity}</strong>}
              </div>
            ))}
            {m.draft.state === 'open' && m.draft.choices.map(c => (
              <div key={c.key} className="yorgo-choice">
                <div>❓ <strong dir="auto">{c.phrase}</strong> <span className="muted">× {c.quantity} · {pt('yorgoPick', locale)}</span></div>
                <div className="yorgo-options">
                  {c.options.map(p => <button key={p.id} className="btn" onClick={() => patch(m.id, d => ({ ...d, choices: d.choices.filter(x => x.key !== c.key), lines: [...d.lines, { key: c.key, product: p, quantity: c.quantity }] }))}>{text(p.name, locale)} <small className="muted num">{price(p, locale)}</small></button>)}
                  <button className="btn ghost" onClick={() => patch(m.id, d => ({ ...d, choices: d.choices.filter(x => x.key !== c.key) }))}>✕ {pt('yorgoSkip', locale)}</button>
                </div>
              </div>
            ))}
            {!!m.draft.notFound.length && <div className="yorgo-missing">⚠ {pt('yorgoNotFound', locale)}: <span dir="auto">{m.draft.notFound.join('، ')}</span></div>}
            {m.draft.state === 'open' && <div className="yorgo-draft-actions">
              <button className="btn ghost" onClick={() => patch(m.id, d => ({ ...d, state: 'discarded' }))}>{pt('yorgoDiscard', locale)}</button>
              <span style={{ flex: 1 }} />
              <button className="btn primary" disabled={!m.draft.lines.length} onClick={() => accept(m)}>🛒 {pt('yorgoToCart', locale)} ({m.draft.lines.length})</button>
            </div>}
            {m.draft.state === 'open' && !!m.draft.choices.length && <small className="muted">{pt('yorgoPickFirst', locale)}</small>}
          </div>
        ) : (
          <div key={m.id} className={`yorgo-msg ${m.from}`} dir="auto">{m.text}</div>
        ))}
        {busy && <div className="yorgo-msg yorgo typing">…</div>}
        <div ref={endRef} />
      </div>
      <p className="yorgo-foot muted">{pt('yorgoDisclaimer', locale)}</p>
    </Modal>
  );
}
