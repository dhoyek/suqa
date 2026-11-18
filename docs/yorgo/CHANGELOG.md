# Yorgo — changelog

## Milestone 1a — item matching (script 75)

**Built**

- `supabase/schema/75_item_matching.sql`
  - `products.aliases text[]` (public, max 40 per item). Base file `04_catalog.sql` lists it.
  - `suqa.norm_text` — lower-case, tashkeel off, alef / ya / ta-marbuta / hamza variants unified, Arabic-Indic digits, punctuation.
  - `suqa.skel_text` — consonant skeleton in one alphabet: خبز = khebez = 5ebez → `xbz`; منقوشة = man2ouche → `mnkc`; بيبسي = pepsi = bebsi → `bbs`. Arabizi digits 2 3 5 7 8 9 count as letters only inside a word, never inside a number (`185ml` stays).
  - `suqa.product_search` — folded names per item, kept by trigger, two trigram indexes, RLS on with no policy.
  - `suqa.match_items(tenant, phrases[], shop?, limit?)` — up to 10 candidates per phrase with score, USD / LBP price, availability, weekday limits and how it matched (exact / spelling / sound).
  - `suqa.alias_suggestions`, `alias_suggest`, `alias_decide` (audited as `alias.approve` / `alias.reject`).
  - `pos_restore_finish` patched: a restore loads rows with triggers off, so the shop's items are folded when it finishes.
- `supabase/test/yorgo_match.sql` + fixtures: the pilot shop's 1,159 item names and 85 phrases.

**Match accuracy** (pilot catalog, 1,159 items, no aliases added)

| Kind | Phrases | Right item first | In the first three |
|---|---|---|---|
| Arabic | 31 | 30 | 31 |
| Arabizi | 22 | 21 | 21 |
| English | 23 | 23 | 23 |
| Mixed script | 5 | 5 | 5 |
| Typos | 4 | 4 | 4 |
| **All** | **85** | **83 (98%)** | **84 (99%)** |

Misses: `bayd` → the skeleton is two letters, too short to trust, and "bayda" in another item's name wins (an alias fixes it); `علبة تونا` → a tinned hot dog comes first because of "tin / علبة", tuna is second.

The phrases were written by the developer from the catalog, not taken from real customers. Six expected answers were widened after the first run because the catalog's own spelling differs ("ketchuup", "FA7EM", "chame3", "HOMMOS", "BATT"). Expect lower numbers on real messages; re-measure with real ones after the first weeks of orders.

**Speed**: about 40 ms per phrase on 1,159 items (local Postgres).

**Access rules proven by the test**

- Anonymous and other shops' staff never get a hidden item; `product_search` cannot be read directly.
- The shop's own staff get all active items; an alias is an exact hit (score 1).
- A suggestion for an item the caller cannot see is dropped; a shopper cannot read suggestions; another shop's owner cannot decide; an approval lands on the item and in the audit log.

**Decisions**

- Milestone 1 split into 1a (this) and 1b (Claude call, conversations, metering) — see PLAN.md.
- No pgvector: not needed at this accuracy.
- Not wired into any screen yet. The storefront and POS searches are unchanged.

## Milestone 1a, follow-up — closest name first (script 76)

Found on prod after 75: "khebez" returned two crouton items ahead of "Arabic bread". All three contain خبز and tied at 0.77, because closeness to the whole name was measured by spelling only, so a Latin phrase against an Arabic name scored 0. The local run had bread first only by row order, which is why the accuracy table did not show it.

- `match_items`: the whole-name term is also measured on the consonant skeleton; equal scores go to the shorter name.
- Test: a dedicated check that bread outscores croutons for "khebez" (it fails on 75, passes on 76).
- Accuracy on the 85 phrases is unchanged: 83 first (98%), 84 in the first three (99%). One more expected answer was widened ("CANDEL", the catalog's own spelling).
- Also learned on real data: searching across all shops is noisier than inside one shop ("bayd b 2awarma" puts a grocery item first). The assistant should search inside the chosen shop whenever there is one.

## Step A — core (script 77, not applied yet)

**Built**

- `supabase/schema/77_yorgo_core.sql`: `yorgo_settings` (master switch, shopper switch, monthly caps, rate limit, history length), `yorgo_shops` (per-shop switch and cap), `yorgo_conversations`, `yorgo_messages` (content, model, tokens, cost, feedback), `yorgo_usage` (per day × shop × user); `yorgo_gate`, `yorgo_record` (server only), `yorgo_feedback`.
- `apps/web/lib/yorgo/`: `config` (model names and prices from the environment), `model` (the only file that talks to the provider; prompt caching on the system prompt and tool list), `tools` (typed tools filtered by mode and role; `match_items` is the first), `prompts`, `core` (`runTurn`: gate → history → model with tools → metering).
- `apps/web/app/api/yorgo/chat`: one exchange as the signed-in person. Answers "paused: off" when no key or no settings exist.

**Decisions**

- Usage is written by the server only (service role, two functions). A person's own token could otherwise under-report and walk past the caps. Tools and history still run with the caller's token.
- Association admins read switches and usage numbers, never message text.
- A shop cannot switch itself on: the association pays, so it decides.
- A model without a price is charged at the dearest known rate, so caps never under-count.
- Not done in this step: summarising older turns (the window is the last N turns; the `summary` column is there), drafts, any screen.

**Tests**

- `supabase/test/yorgo_core.sql`: off by default at every level; rate limit; shop, shopper and global caps and their order; a shop's own cap; a conversation cannot be continued by someone else or in another shop; seller, stranger, admin and anonymous each read exactly what they should; nobody signed in can write usage or call the gate.
- `apps/web/lib/yorgo/core.test.ts` (8 tests, mock model): a seller's search is forced to their own shop and goes through their own client; closed gate = no model call; a tool outside the person's list is refused; a tool loop is stopped; cost is recorded even when the provider fails half-way; history never opens inside a tool exchange.
- Not tested: a real call to the provider (no key yet).

## 2026-11-18 — first real call on dev
- Script 77 applied on dev; `ANTHROPIC_API_KEY` set on Netlify (dev and prod projects).
- The key is trimmed of stray spaces/quotes before use (first call failed with 401 for that reason).
- Thinking is switched off in the request: the 5.5 models think by default and the thinking is billed as output inside `max_tokens`, which left no room for the answer (first call returned no text). `max_tokens` 700 → 1024.

## 2026-11-18 — step B: paste a message → draft order (dev)
- New seller tool `draft_order` (owner, cashier): item ids and quantities only — `lines` (sure), `choices` (the staff member taps the right one), `not_found`. The draft goes to the screen; the model is only told it was shown.
- POS: ✨ Yorgo button in the top bar (shown when `yorgo_shops.enabled` for the shop and the person sells). Chat panel with the draft card: change quantity, remove, pick between candidates, then "Add to cart" or "Discard".
- Names, prices and stock on the card come from the catalog on the device; an id the till does not know is dropped. The sale is finished in the cart as usual (approval PIN, stock rules unchanged).
- A sale whose cart took a Yorgo draft carries `via_yorgo` = conversation id in the `sale.commit` op, so it is in the audit log. No schema change.
- Needs internet; offline the panel says so and the till is untouched.

## 2026-11-18 — step C: Yorgo on the storefront (dev)
- Floating "✨ Ask Yorgo" button on every storefront page (not on checkout, login or signup), shown when `yorgo_settings.enabled` and `shopper_enabled` are on and a key is configured (`lib/yorgo/enabled.ts`, cached 60 s).
- Signed-in customers write what they want; new shopper tool `draft_basket` returns a suggested basket (lines, choices, not found) filled from the public catalog with the customer's own access. "Add to cart" puts the lines in the normal cart; checkout is unchanged.
- On a shop page the model is told which shop the customer is looking at and searches it first.
- Not signed in: the panel explains and links to sign-in. One-shop carts: the shop with most lines is added, with the usual "replace cart?" question.
- POS: keystrokes in a multi-line text box are never read as a barcode scan.
- Prompt: mixed-language messages are answered in their main language.
