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

## 2026-11-18 — step D: usage page, feedback, names customers use (dev)
- **Admin → ✨ Yorgo** (`/admin/yorgo`): spent this month against the cap with a forecast, messages and cost per message, shoppers and the top shopper against the per-shopper cap, per-shop POS switch with spend, last 14 days; master and shopper switches, the three caps and the rate limit are editable there. Numbers only (`yorgo_usage`).
- **👍 / 👎** under Yorgo's answers in the POS and on the storefront (`/api/yorgo/feedback` → `yorgo_feedback`, as the person). The chat route now returns `message_id`.
- **Names customers use:** tapping one of Yorgo's choices records "phrase → item" (`alias_suggest`, script 75). In the POS panel, 💡 lists what is waiting; owner / stock / association setup approve (becomes an alias) or reject (`alias_decide`).
- **Script 78 (`yorgo_misses`) written, NOT applied:** counted "asked for and not found" phrases per shop / whole market, no person and no conversation. The route already calls `yorgo_miss` and ignores the error where it is not installed; the POS 💡 list and the admin page show misses once it is.

## 2026-11-20 — the current chat, tightened (no database script)

From reading the real customer chats on prod (50 messages): half the answers asked a question, "add" replaced the basket, shops were
not recognised by name, short answers flipped the language, a typo matched seeds, the same item was searched again and again, items were
listed as long text, and nothing reached `yorgo_misses`.

- **Garbled text** (`core.ts` `isGarbled` / `cleanReply`): mojibake lines and the model's own apology are dropped before the reply is
  shown or stored; a fully garbled answer is asked again once.
- **Draft first, ask rarely** (`prompts.ts`): no quantity = 1, unsure = choices, never "how many" / "which one" in text, one question at most.
- **Add to the open basket**: `draft_basket { add: true }` → the storefront card merges the new lines and choices (`YorgoChat.tsx`);
  without `add` the draft replaces the one on screen, as before.
- **Shops by name**: the open shops (id, names, `known_as`, what they sell) are in the shopper prompt; "min 3end X", "3endo".
  Fill "known as" on the shop (Admin → shop) with the names customers use.
- **Language**: a short neutral answer ("eh", "1", "330ml") keeps the language of the person's last real message (`isShortNeutral`).
- **Category on every candidate** (`match_items` → `category`, the shared list of 87): food is not seeds or tools.
- **Search once** per item per conversation; a pick from the last answer is drafted without a new search.
- **Kind questions** ("chou fi machroubet") come back as one choices entry (up to 6 options), not a text list.
- **Misses**: phrases the search itself found nothing close for (best score < 0.45) are counted, also when the answer was only text.
- **Test set**: `docs/yorgo/eval-cases.json` + `eval-runner.js` (browser, dev, signed in). First run after these changes: 12 / 12,
  2 of 12 answers with a question (both on "do you have…" questions), 30 model calls, $0.13.

## 2026-11-21 — step W1: order by WhatsApp text (dev; script 95 on dev only)

Plan and decisions: `docs/yorgo/PLAN.md`, "step W1". Off until Admin → Yorgo → "Yorgo on the market's WhatsApp" is switched on.

- **Script 95** on dev: `wa_inbox` (each inbound message once), `yorgo_drafts` (a basket behind a link, 24 h), `wa_phone` on
  conversations, the WhatsApp switch and the cap per phone ($2), and the server-only functions for the gate, the history and the record by phone.
- **Core** (`core.ts`): a caller can be a WhatsApp phone instead of an account (`waPhone`): `yorgo_gate_wa`, `yorgo_history_wa`,
  `yorgo_record_wa`. The app and the POS are unchanged. The result now says the reply language and, on WhatsApp, whether it is the phone's first answer.
- **`lib/yorgo/whatsapp.ts`** (pure, tested): one text → Yorgo's line + one summary line + the link + the AI notice on the first
  answer; "add" joins the draft sent before; cap → "paused" line; too fast → "one moment"; off → silent; the wording table.
- **Webhook** (`api/wa/webhook`): Meta gets its 200 at once and the work runs after the response (`after()`); every message is
  taken once; a text that matches no order goes to Yorgo with the **anonymous** catalog client (no account, no order data);
  a voice note / photo gets the "text only" line at most once an hour per phone; order messages, locations and driver "ok" as before.
- **`/y/<id>`**: the draft as the same basket card as the chat (`components/YorgoBasketCard.tsx`, moved out of `YorgoChat.tsx`),
  prices read again when the page opens; "add to cart" → the usual cart and checkout.
- **Admin → Yorgo**: the WhatsApp switch and the cap per WhatsApp phone. **Privacy page**: one line (Arabic and English).
- Not done yet: the test set through the WhatsApp path (plan step 6); an end-to-end run with a real WhatsApp message.

## 2026-11-21 — every shop that has the thing (script 96 written, not applied)

Dan: asking for a product that several shops sell brought suggestions from one shop only.
- Cause: `match_items` returned the market's best 6 by score, so a shop with many variants took every place; and the prompt said "prefer one shop".
- **Script 96** (not applied): market-wide searches put each shop's best candidate first; one-shop searches unchanged.
- Tool: 8 candidates for a market-wide search (6 inside one shop). Prompt: several shops sell it and none was named → the best of each shop as choices; "is there X?" names each shop with its price.

## 2026-11-21 — a kind never matches in the wrong category (script 96 on dev; script 97 written, not applied)

- Script 96 applied on dev: "khebez" now starts with Elie Grocery, Furn Mona, Jneinet Baytna.
- Found on the way: "khebez" also returns Panadol — the kind "bread" has the French tag "pain" and the category is "Pain Relief".
  An audit of every kind on dev showed the same leak elsewhere (deodorant for coffee and alcohol, irrigation for water, tools for
  milk, toothpaste and shampoo for tea, cheese chips for cheese, chocolate milk for milk).
- **Script 97** (not applied) + `concepts.ts`: `NON_FOOD` (38 categories no food kind matches in) and `notIn` per kind for flavour
  leaks inside food. The till's own search and the storefront's shop search use the same lists (`Folded.section`).
- Left as is: "Chips & Nuts" is one category, so "chips" still brings nuts and "mkasarat" still brings chips; only splitting the
  category would separate them.
- **Script 97 applied on dev** (21 Nov). Checked on dev's catalog: "khebez" → bread, kaak, toast (no Panadol); "ahwe" → Coffee, Drinks;
  "may" → Water, Drinks; "chay" → tea categories; "sakaker" → sweets and chocolate; "jebne" → cheese, dairy, manakish (no chips);
  "tandif", "dekhen", "deo" unchanged. 8 phrases in one call: 0.39 s. Scripts 95, 96, 97 are on dev only.

## Demand report (script 99) — 22 Nov 2026

- `supabase/schema/99_demand.sql`, test `supabase/test/demand.sql`: `search_log` + `search_note`; `demand_report`, `demand_people` (association admins only). Yorgo's requests are read from the item searches already stored in `yorgo_messages` (shopper conversations: app and WhatsApp), so the report goes back to Yorgo's first day; the search boxes count from the day 99 is applied.
- Admin → Yorgo → "Demand" (`/admin/yorgo/demand`): 7 / 30 / 90 days; most asked, asked and not found, Yorgo only, search box only; a phrase opens who asked (name, phone, how, how many times, last time). A visitor without an account has no name.
- Storefront: the home search and a shop's search box record the words 2 s after typing stops (`lib/search-note.ts`); words carried from the home page into a shop are not counted twice.
- Privacy page: the association now sees the items asked for or searched, with the person — still not the text of messages. Decided by Dan (names / phone numbers, searches counted).
- Not tested in a browser. The AI providers table moves to script 100.

## Step B1 + W2 — AI providers table and voice notes on WhatsApp (script 100) — 22 Nov 2026

**Built (on dev; script 100 not applied until approved; voice is OFF until the route is priced and switched on)**

- `supabase/schema/100_yorgo_ai_routes.sql` + test: `yorgo_ai_routes`, platform admins only.
- `apps/web/lib/ai/`: `routes.ts` (route, cost from the route's prices, 60 s cache), `google.ts` (Gemini **Interactions API**, `store:false`, audio inline, key in the header — as documented on 22 Nov 2026), `voice.ts` (`runVoice`: 2 min / 2 MB limit read from the Ogg file itself, fallback model once, silence = "nothing").
- `lib/yorgo/whatsapp.ts`: `waVoiceTurn` — gate first (a paused phone costs nothing), then hear, then the same turn as a typed message; the reply starts with "🎤 I heard: …". The transcription's cost is stored on the customer's own line (`TurnInput.heard`), so the caps count it. Silence is recorded as one costed line and answered without drafting.
- Webhook: an `audio` message is heard when the `voice` route is on and `GOOGLE_AI_API_KEY` is set; otherwise the "text only" line as before. `waDownloadMedia` reads the file from Meta into memory (our token only goes to Meta's hosts). The audio is never stored.
- Admin → Yorgo → "AI providers" (platform admin only): model, fallback, prices, on/off, and a Test that runs a clip on the saved model and shows the words, the time and the cost.
- Privacy page: voice notes go to Google only to be turned into text; the recording is not kept.

**Decisions taken as proposed in the plan:** voice on Google, chat stays on Claude (the `chat` row is a record only); 2 minutes; "what I heard" shown; audio never stored; providers page for the platform admin only. Wording of the three new lines is in `WA_TEXT` (`voiceLong`, `voiceUnclear`, `heard`).

**Not done from the plan:** `lib/yorgo/model.ts` was not moved under `lib/ai/` (no behaviour to gain; chat on another provider is step B2). Audit = `updated_at` / `updated_by` on the route, set by the database.

**Tested:** database test (who reads and writes, no switch without prices, voice provider); 17 new unit tests (cost, Ogg length, limits, fallback, adapter request and answer, the voice turn: paused, too long, silence, provider down). **Not tested:** anything live — no Google key yet, no real voice note, the admin page in a browser, the quality on Lebanese speech (step 6 needs real recordings).

## Item details kept through option groups — 22 Nov 2026 (no script)

- A detail said about an item ("bered", "bala basal") was lost when Yorgo offered options instead of one sure line: `choices` had no note. Now a choices entry carries `note` (tool schema, `runDraft`, `hydrateBasket`, `slimBasket`), the group shows it with 📝, and the picked item takes it into the cart — customer basket card (app chat and the WhatsApp basket link) and the POS panel. When only one option is still on sale, the line that replaces the group keeps the note too.
- Prompt: one sentence saying what is said about an item is its note, on the line or on the choices entry, never part of the search words.

## A discarded suggestion no longer comes back — 22 Nov 2026 (no script)

- Dan's report: after "tajehol" (discard) on a suggested basket, the next request brought the discarded items back. Cause: the model sees its own earlier drafts in the conversation and did not know the card was thrown away, so it carried their items into the next draft.
- Fix: the app chat and the POS panel send what became of the last card (`open` / `added` / `discarded`); for a discarded or added card the model gets a note for that call only (`cardNote` in `core.ts`): start from nothing, only what this message asks for, no `add`. Nothing of the note is stored.
- Not covered: the WhatsApp basket link. "Discard" on that page is not known to the server, so a later "zid …" on WhatsApp still joins the last basket sent. Needs a small script (a `discarded_at` on `yorgo_drafts`).
