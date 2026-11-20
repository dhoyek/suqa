'use client';
import { useEffect, useRef, useState } from 'react';
import { fmtLbp, fmtUsd, num, text, type CatalogIndex, type Product } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import Modal from './Modal';

// Yorgo in the till: the staff member pastes a customer's message, Yorgo proposes a draft, a person checks it and sends it to the cart.
// The assistant never sells: a draft carries item ids and quantities only — names, prices and stock shown here come from the catalog on
// this device, and the sale itself goes through the cart and the pay dialog like any other. Needs internet; the till works without it.
export type YorgoCartLine = { product: Product; quantity: number; note?: string };
type DraftIn = { kind?: string; add?: boolean; lines?: { product_id: string; quantity: number; note?: string }[]; choices?: { phrase: string; quantity: number; options: string[] }[]; not_found?: string[] };
type Line = { key: string; product: Product; quantity: number; note?: string };
type Choice = { key: string; phrase: string; quantity: number; options: Product[]; picked?: number };
type Draft = { lines: Line[]; choices: Choice[]; notFound: string[]; state: 'open' | 'added' | 'discarded' };
type Msg = { id: number; from: 'me' | 'yorgo' | 'note'; text: string; draft?: Draft; mid?: number | null; fb?: 1 | -1 };
type Sb = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: unknown }>; from: (t: string) => any };   // eslint-disable-line @typescript-eslint/no-explicit-any
type Suggestion = { id: string; phrase: string; picks: number; product_id: string };
type Miss = { id: string; phrase: string; times: number };
type Reply = { status: 'ok'; conversation_id: string; reply: string; drafts: DraftIn[]; message_id?: number | null } | { status: 'paused'; reason: string } | { status: 'error'; error: string; conversation_id?: string };

const price = (p: Product, locale: L) => (p.price_currency === 'lbp' ? fmtLbp(num(p.price_lbp), locale) : fmtUsd(Math.round(num(p.price_usd) * 100)));

export default function YorgoPanel({ open, onClose, shopId, locale, index, online, sells, sb, canReview, onAddToCart }: {
  open: boolean; onClose: () => void; shopId: string; locale: L; index: CatalogIndex; online: boolean; sells: boolean; sb: Sb; canReview: boolean;
  /** asOrder: the lines become a delivery / pickup order (the customer box opens next) instead of a sale at the counter */
  onAddToCart: (lines: YorgoCartLine[], conversationId: string | null, asOrder: boolean) => void;
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
        const orders = (r.drafts ?? []).filter(d => d.kind === 'draft_order');
        // "add" (zid, kamen): the new items join the draft still open on screen — the card moves down, under the answer
        const stamp = `a${Date.now()}`;
        const adds = orders.filter(d => d.add).map(toDraft).filter((d): d is Draft => !!d);
        const drafts = orders.filter(d => !d.add).map(toDraft).filter((d): d is Draft => !!d);
        // a new draft replaces the one still open on screen; clear_draft takes it away
        const cleared = (r.drafts ?? []).some(d => d.kind === 'clear_draft');
        if (cleared || drafts.length) setMsgs(ms => ms.map(x => (x.draft?.state === 'open' ? { ...x, draft: { ...x.draft, state: 'discarded' } } : x)));
        if (r.reply) push({ from: 'yorgo', text: r.reply, mid: r.message_id ?? null });
        drafts.forEach(draft => push({ from: 'yorgo', text: '', draft }));
        if (adds.length) setMsgs(ms => {
          const open = [...ms].reverse().find(x => x.draft?.state === 'open');
          let d: Draft = open?.draft ?? { lines: [], choices: [], notFound: [], state: 'open' };
          adds.forEach((a, n) => {
            const lines = [...d.lines];
            for (const l of a.lines) { const i = lines.findIndex(x => x.product.id === l.product.id && (x.note ?? '') === (l.note ?? '')); if (i >= 0) lines[i] = { ...lines[i], quantity: lines[i].quantity + l.quantity }; else lines.push({ ...l, key: `${stamp}${n}${l.key}` }); }
            d = { ...d, lines, choices: [...d.choices, ...a.choices.map(c => ({ ...c, key: `${stamp}${n}${c.key}` }))], notFound: [...new Set([...d.notFound, ...a.notFound])] };
          });
          return [...ms.filter(x => x !== open), { id: ++seq.current, from: 'yorgo' as const, text: '', draft: d }];
        });
        if (!r.reply && !drafts.length && !adds.length && !cleared) push({ from: 'note', text: pt('yorgoError', locale) });
      } else if (r.status === 'paused') {
        push({ from: 'note', text: pt(r.reason === 'rate' ? 'yorgoRate' : r.reason === 'off' ? 'yorgoOff' : 'yorgoCap', locale) });
      } else {
        if (r.conversation_id) conv.current = r.conversation_id;
        push({ from: 'note', text: pt(r.error === 'unauthorized' ? 'yorgoSignIn' : 'yorgoError', locale) });
      }
    } catch { push({ from: 'note', text: pt('yorgoOffline', locale) }); }
    setBusy(false);
  };

  // a pick joins the draft and the OTHER suggestions stay, so a second and a third can be picked from the same group;
  // the group goes when it is empty or closed
  const pickOption = (d: Draft, c: Choice, p: Product): Draft => {
    const i = d.lines.findIndex(x => x.product.id === p.id && !x.note);
    const lines = i >= 0 ? d.lines.map((x, n) => (n === i ? { ...x, quantity: x.quantity + c.quantity } : x)) : [...d.lines, { key: `${c.key}-${p.id}`, product: p, quantity: c.quantity }];
    return { ...d, lines, choices: d.choices.map(x => (x.key === c.key ? { ...x, picked: (x.picked ?? 0) + 1, options: x.options.filter(y => y.id !== p.id) } : x)).filter(x => x.options.length) };
  };
  const patch = (id: number, f: (d: Draft) => Draft) => setMsgs(ms => ms.map(m => (m.id === id && m.draft ? { ...m, draft: f(m.draft) } : m)));
  const step = (p: Product) => (p.decimal_qty ? 0.5 : 1);
  const accept = (m: Msg, asOrder = false) => {
    if (!m.draft?.lines.length) return;
    onAddToCart(m.draft.lines.map(l => ({ product: l.product, quantity: l.quantity, note: l.note })), conv.current, asOrder);
    patch(m.id, d => ({ ...d, state: 'added' }));
  };
  const reset = () => { setMsgs([]); conv.current = null; setInput(''); };
  // 👍 / 👎: tapping the same thumb again takes it back
  const rate = (m: Msg, v: 1 | -1) => { if (!m.mid) return; const value = m.fb === v ? null : v;
    setMsgs(ms => ms.map(x => (x.id === m.id ? { ...x, fb: value ?? undefined } : x)));
    void fetch('/api/yorgo/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message_id: m.mid, value }) }).catch(() => null); };
  // a pick teaches the shop a name: "<phrase>" meant this item — it waits for the shop's approval before it becomes an alias
  const learn = (p: Product, phrase: string) => { void Promise.resolve(sb.rpc('alias_suggest', { p_product: p.id, p_phrase: phrase, p_source: 'yorgo' })).catch(() => null); };

  // names customers use: picks waiting for approval, and phrases nobody could find (owner / stock / association setup)
  const [review, setReview] = useState(false); const [sugg, setSugg] = useState<Suggestion[] | null>(null); const [misses, setMisses] = useState<Miss[]>([]);
  const loadReview = async () => {
    const a = await sb.from('alias_suggestions').select('id,phrase,picks,product_id').eq('shop_id', shopId).eq('status', 'pending').order('picks', { ascending: false }).limit(50);
    setSugg(((a.data as Suggestion[] | null) ?? []).filter(x => index.byId.has(x.product_id)));
    const b = await sb.from('yorgo_misses').select('id,phrase,times').eq('shop_id', shopId).is('dismissed_at', null).order('times', { ascending: false }).limit(30);
    setMisses((b.data as Miss[] | null) ?? []);                      // empty where the misses table is not installed yet
  };
  useEffect(() => { if (open && review && online) void loadReview(); }, [open, review, online]);   // eslint-disable-line react-hooks/exhaustive-deps
  const decide = async (x: Suggestion, ok: boolean) => { setSugg(l => (l ?? []).filter(y => y.id !== x.id)); await Promise.resolve(sb.rpc('alias_decide', { p_id: x.id, p_approve: ok })).catch(() => null); };
  const dismiss = async (x: Miss) => { setMisses(l => l.filter(y => y.id !== x.id)); await Promise.resolve(sb.rpc('yorgo_miss_dismiss', { p_id: x.id })).catch(() => null); };

  return (
    <Modal open={open} onClose={onClose} wide title={<>✨ Yorgo <small className="yorgo-tag">{pt('yorgoAi', locale)}</small></>}
      actions={<>
        {canReview && <button className={`btn icon${review ? ' primary' : ''}`} title={pt('yorgoNames', locale)} onClick={() => setReview(v => !v)}>💡</button>}
        {!!msgs.length && !review && <button className="btn icon" title={pt('yorgoNew', locale)} onClick={reset}>↺</button>}
      </>}
      footer={<div className="yorgo-input">
        <textarea ref={boxRef} className="input" rows={2} dir="auto" placeholder={pt(sells ? 'yorgoPlaceholder' : 'yorgoPlaceholderItems', locale)} value={input} maxLength={2000} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); void send(); } }} />
        <button className="btn primary" disabled={busy || !input.trim()} onClick={() => void send()} aria-label={pt('yorgoSend', locale)}>↑</button>
        <p className="yorgo-foot muted">{pt('yorgoDisclaimer', locale)}</p>
      </div>}>
      {review ? <div className="yorgo-chat">
        <p className="muted" style={{ margin: 0 }}>{pt('yorgoNamesHint', locale)}</p>
        {sugg === null && <p className="muted">…</p>}
        {sugg?.map(x => { const p = index.byId.get(x.product_id)!; return (
          <div key={x.id} className="yorgo-line">
            <div className="yorgo-line-name"><strong dir="auto">{x.phrase}</strong> <span className="muted">→</span> {text(p.name, locale)}{x.picks > 1 && <small className="muted"> · ×{x.picks}</small>}</div>
            <div className="qty-btns"><button title={pt('yorgoNameOk', locale)} onClick={() => void decide(x, true)}>✓</button><button className="rm" title={pt('yorgoNameNo', locale)} onClick={() => void decide(x, false)}>✕</button></div>
          </div>); })}
        {sugg !== null && !sugg.length && <p className="muted">{pt('yorgoNamesNone', locale)}</p>}
        {!!misses.length && <><strong style={{ marginTop: 8 }}>{pt('yorgoMisses', locale)}</strong><p className="muted" style={{ margin: 0, fontSize: 13 }}>{pt('yorgoMissesHint', locale)}</p></>}
        {misses.map(x => (
          <div key={x.id} className="yorgo-line">
            <div className="yorgo-line-name"><span dir="auto">{x.phrase}</span>{x.times > 1 && <small className="muted"> · ×{x.times}</small>}</div>
            <div className="qty-btns"><button className="rm" title={pt('yorgoMissDone', locale)} onClick={() => void dismiss(x)}>✕</button></div>
          </div>))}
      </div> : <div className="yorgo-chat">
        {!msgs.length && <div className="yorgo-hello">
          <p style={{ margin: 0 }}><strong>{pt('yorgoHello', locale)}</strong></p>
          <p className="muted" style={{ margin: 0 }}>{pt(sells ? 'yorgoHint' : 'yorgoHintItems', locale)}</p>
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
                  {c.options.map(p => <button key={p.id} className="btn" onClick={() => { learn(p, c.phrase); patch(m.id, d => pickOption(d, c, p)); }}>{text(p.name, locale)} <small className="muted num">{price(p, locale)}</small></button>)}
                  <button className="btn ghost" onClick={() => patch(m.id, d => ({ ...d, choices: d.choices.filter(x => x.key !== c.key) }))}>{c.picked ? `✓ ${pt('ok', locale)}` : `✕ ${pt('yorgoSkip', locale)}`}</button>
                </div>
              </div>
            ))}
            {!!m.draft.notFound.length && <div className="yorgo-missing">⚠ {pt('yorgoNotFound', locale)}: <span dir="auto">{m.draft.notFound.join('، ')}</span></div>}
            {m.draft.state === 'open' && <div className="yorgo-draft-actions">
              <button className="btn ghost" onClick={() => patch(m.id, d => ({ ...d, state: 'discarded' }))}>{pt('yorgoDiscard', locale)}</button>
              <span style={{ flex: 1 }} />
              <button className="btn" disabled={!m.draft.lines.length} title={pt('yorgoToCartHint', locale)} onClick={() => accept(m)}>🛒 {pt('yorgoToCart', locale)}</button>
              <button className="btn primary" disabled={!m.draft.lines.length} title={pt('yorgoToOrderHint', locale)} onClick={() => accept(m, true)}>📥 {pt('yorgoToOrder', locale)} ({m.draft.lines.length})</button>
            </div>}
            {m.draft.state === 'open' && !!m.draft.choices.length && <small className="muted">{pt('yorgoPickFirst', locale)}</small>}
          </div>
        ) : (
          <div key={m.id} className={`yorgo-msg ${m.from}`} dir="auto">{m.text}{m.from === 'yorgo' && !!m.mid && <span className="yorgo-thumbs" dir="ltr">
            <button className={m.fb === 1 ? 'on' : ''} aria-label="👍" onClick={() => rate(m, 1)}>👍</button><button className={m.fb === -1 ? 'on' : ''} aria-label="👎" onClick={() => rate(m, -1)}>👎</button></span>}</div>
        ))}
        {busy && <div className="yorgo-msg yorgo typing">…</div>}
        <div ref={endRef} />
      </div>}
    </Modal>
  );
}
