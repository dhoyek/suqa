// Yorgo test-set runner. Run in the browser console on the DEV site while signed in as a customer:
//   paste this file, then:  await yorgoEval(CASES, { shopId })   (CASES = the "cases" array of eval-cases.json; shopId = the test shop's id,
//   needed for the "mode": "seller" cases, which also need an owner / cashier login — without it they are skipped)
// It sends each step to /api/yorgo/chat (real AI calls: a few cents per run), 11 s apart (the rate limit is 6 a minute), and returns one
// row per step: what came back and which expectations failed. Nothing is ordered: Yorgo only drafts.
window.yorgoEval = async function (cases, { shopId = null, gapMs = 11000, only = null } = {}) {
  const rows = []; window.__rows = rows;
  for (const c of cases) {
    const seller = c.mode === 'seller'; if ((seller && !shopId) || (only && !only.includes(c.id))) continue;
    let conv = null;
    for (const [n, st] of c.steps.entries()) {
      const res = await fetch('/api/yorgo/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(seller ? { mode: 'seller', shop_id: shopId, conversation_id: conv, message: st.say } : { mode: 'shopper', conversation_id: conv, message: st.say }) });
      const r = await res.json().catch(() => ({}));
      conv = r.conversation_id ?? conv;
      const reply = r.reply ?? ''; const baskets = (r.drafts ?? []).filter(d => d.kind === (seller ? 'draft_order' : 'draft_basket'));
      const lines = baskets.flatMap(d => d.lines ?? []), choices = baskets.flatMap(d => d.choices ?? []);
      const shops = seller ? [] : [...new Set([...lines.map(l => l.shop?.slug), ...choices.flatMap(ch => ch.options.map(o => o.shop?.slug))].filter(Boolean))];
      const got = {
        lang: /[؀-ۿ]/.test(reply) ? 'ar' : 'en', draft: baskets.length > 0, add: baskets.some(d => d.add === true),
        cleared: (r.drafts ?? []).some(d => d.kind === 'clear_draft'), question: /[?؟]/.test(reply), short: reply.length <= 160, garbled: /[ØŲ]/.test(reply), shops,
      };
      const e = st.expect ?? {}; const fails = [];
      for (const k of ['lang', 'draft', 'add', 'cleared', 'question', 'short']) if (k in e && e[k] !== got[k]) fails.push(`${k}: wanted ${e[k]}, got ${got[k]}`);
      if (e.shop && !(shops.length === 1 && shops[0] === e.shop)) fails.push(`shop: wanted ${e.shop}, got ${shops.join(',') || '-'}`);
      if (e.not_shop && shops.includes(e.not_shop)) fails.push(`shop ${e.not_shop} should not be offered`);
      if (got.garbled) fails.push('garbled text'); if (r.status !== 'ok') fails.push(`status ${r.status} ${r.error ?? r.reason ?? ''}`);
      rows.push({ case: c.id, step: n + 1, say: st.say, ok: !fails.length, fails, reply: reply.slice(0, 220),
        lines: lines.map(l => (seller ? `${l.quantity}× ${l.product_id.slice(0, 8)}` : `${l.quantity}× ${l.name?.en ?? l.name?.ar} @${l.shop?.slug}`)), choices: choices.map(ch => `${ch.phrase}: ${ch.options.length}`), not_found: baskets.flatMap(d => d.not_found ?? []) });
      await new Promise(x => setTimeout(x, gapMs));
    }
  }
  return { passed: rows.filter(r => r.ok).length, total: rows.length, rows };
};
