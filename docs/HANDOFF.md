# Suqa — handoff note

_Written 2026-11-19 by the previous Claude session (Fable 5.2) for the next model. Read this first, then `claude/suqa-context.md` (project doc, partly out of date — this note wins where they differ), `docs/yorgo/PLAN.md` and `docs/yorgo/CHANGELOG.md`._

---

## 0. Bottom line

- **Prod (`prod`) is at commit `97b1565`; dev (`main`) is ahead by one fix** — the receipt page `/r/<order id>` showed **$0.00, "paid", $1 = 0** for storefront orders (Dan's report on HS-000030, 2026-11-19). Fixed and tested on dev (commits `984933e`, `11e1e65`), **waiting for Dan's "release"**. No database change. Scripts 77–82 are applied on both databases.
- No work is in progress in the repo. The **next task** Dan has queued is in the project doc `claude/yorgo-next-step-prompt.md`: multi-provider AI wrapper + customer orders by WhatsApp (text and voice). It starts with a **plan for approval**, not code.
- Dan's standing rules (section 2) are strict and he notices when they are broken. Follow them literally.

---

## 1. What Suqa is

White-label local-shops platform for Lebanon. Owner: **Dan** (product person, not a developer; reads English, writes English and Arabizi). Two products in one Next.js app:

1. **Storefront** — customers order from nearby shops (delivery or pickup, cash on delivery).
2. **POS** at `/pos` — offline-first point of sale per shop: sales, orders from the storefront and WhatsApp, customers, debts (dayn), stock, purchases, shifts and cash drawer, drivers, reports.

Plus **Yorgo**, an AI assistant (POS paste-a-message → draft order; storefront chat → basket), and **WhatsApp** notifications to shops, customers and drivers.

Currencies: **USD and LBP everywhere.** Prices are stored in USD (`price_usd`), with `price_currency` + `price_lbp` for items a shop prices in lira.

---

## 2. Dan's rules (verbatim intent — do not bend)

- **Push to `main` (dev) only.** Touch prod only when Dan writes **"release"**: database scripts on Suqa Prod first, then `git push origin origin/main:prod`.
- **Never apply a database script without approval.** "approve NN" = apply NN on **dev only**. Give him the **full script file** (he prefers complete scripts; for table changes show the full `CREATE TABLE` in the header comment even when the migration itself uses `alter … add column if not exists`).
- **Never type, copy or store passwords, API keys, tokens or one-time codes.** He enters them himself (Netlify env, Supabase secrets, Meta).
- **Change only what he asked for in the UI.** If he asks "do you recommend…", advise and **wait for his go**.
- **POS: offline-first, USD + LBP, mobile-first. Money actions must never double count** (payments, cash drawer, driver cash/pay, debts).
- **Admins (tenant/platform) must not see a shop's finances.**
- **Re-check the database before telling him the state of anything.**
- **Explain in English, Arabic words in Latin letters** (e.g. "7addeth al-2an", "dayn"). **Short answers, bottom line first.**
- **Test in the browser before saying something works, and say what you did not test.**
- Sending WhatsApp messages / submitting templates to Meta on his behalf needs his OK. Don't complete real sales or payments on prod.
- Commits end with the attribution lines the harness gives you. A stop hook requires unpushed commits on `main` to be pushed.

Message shorthand he uses: "approve NN", "release", "fix 21" (= fix order HS-000021), "go".

---

## 3. Environments and IDs

| | Dev | Prod |
|---|---|---|
| Site | `https://suqa-dev.netlify.app` (brand "Batroun Basket") | `https://purplestore.app` (brand "Yorgo Suqa") |
| Netlify | `suqa-dev`, site id `b3f99b16-0c99-46fd-bd31-a7fb7cf08e4b`, builds `main` | `yorgo-suqa`, site id `b0c11819-86ae-4aaf-bf47-084798dabe5f`, builds `prod` |
| Supabase | "Suqa" `ixwyhiecmudqeahlejzp` | "Suqa Prod" `snkvytnyzaxmjnlxbubs` |
| Order prefix | `BAT-` | `HS-` |
| Tenant | `ed1655e4-b41b-47e9-bfba-fded0f51cbc6` | (one tenant, "Yorgo Suqa") |

- Repo: GitHub `dhoyek/suqa`, working copy `/home/claude/suqa`. Monorepo: `apps/web` (Next.js), `packages/pos-core` (offline POS engine, Dexie/IndexedDB + sync), `packages/shared`.
- Supabase schema: `suqa`. Free plan — **no automatic backups**.
- **Dev test shop:** Elie Grocery / "dekan Elie", id `1211d8d3-10a8-4376-83c4-7f7b1bb45f86`, slug `abou-elie`. POS staff "Dan" (owner), **test PIN `1111` (dev only)**. Test driver "Dan Test" `01a1c642-3ade-735d-8914-143940068045`.
- **Prod shops:** Yorgo · Dekanet Jadde · Furn El Dayaa · Abi Hanna for Agriculture · B4 Sushi · Jneinet Baytna · Najem Market (POS off) · BC Cell. Last prod order at handoff: HS-000030.
- **Rates:** market rate `tenants.fx_lbp_rate` = **90,000** on prod (89,500 on dev). Every prod shop has a POS rate row of **90,000** in `exchange_rates` (inserted 2026-11-19 at Dan's request).
- Yorgo on prod: enabled, shopper chat on; caps $100 global / $10 per shop / $0.50 per shopper; rate 6/min; POS Yorgo on for Dekanet Jadde, Furn El Dayaa, Abi Hanna, B4 Sushi, Jneinet Baytna. Model: Anthropic Haiku 5.5 via `ANTHROPIC_API_KEY` (Dan set it in Netlify for both sites). ≈ $0.0005–0.001 per message.

---

## 4. How to work here (practical)

- **Schema changes:** numbered files in `supabase/schema/NN_name.sql`, idempotent; add a row to `supabase/schema/README.md`; run `bash supabase/build.sh` (rebuilds `supabase/all.sql`). **Next free number: 83.**
- When a script must change an existing big function (e.g. `pos_push`, `_place_shop_order`, `_pos_order_pay`), the pattern used in 80–82 is: read `pg_get_functiondef`, `replace()` one anchor line, `execute` — with a guard that it was not already patched and an exception if the anchor is missing. This avoids copying 300-line functions and drifting from what is live. Before applying, compare `md5(pg_get_functiondef(...))` on dev and prod (they matched for every script so far).
- **Local Postgres for tests:** `pg_ctlcluster 16 main start` then `PGPASSWORD=pg psql -h localhost -U postgres -d suqa_fresh`. It has all scripts + fixtures; `net.http_post` is stubbed in each test file; no pg_cron. Tests: `supabase/test/*.sql` (e.g. `order_info.sql`, `driver_cash.sql`, `lbp_price.sql`, `wa_outbox.sql`, `yorgo_core.sql`) — each runs in one transaction and rolls back; success prints a `NOTICE: … all checks passed`.
- **JS tests:** from repo root `npx vitest run` (121 pass at handoff). Type-check: `cd apps/web && npx tsc --noEmit -p .` (then `git checkout apps/web/tsconfig.tsbuildinfo` — tsc touches it). **Run both before every push**; one broken push early on is why.
- **Applying scripts:** `mcp__Supabase__apply_migration` with the project id. On prod it may pop a confirmation on Dan's side; if he is away it **times out (230 s) and nothing is applied** — re-check, tell him, ask him to stay on screen. Verify after applying with `md5(pg_get_functiondef)` comparisons dev vs prod.
- **Deploy check:** after a push wait ~3–4 min (shell `sleep` is blocked; `python3 -c "import time; time.sleep(200)"` works), then `mcp__Netlify__netlify-project-services-reader get-project` for the deploy id/state.
- **Browser testing:** Claude in Chrome (`mcp__claude-in-chrome__*`). Dan's Chrome is signed in to dev as owner "Dan" and to prod as tenant admin. On the POS: enter `1111` on the lock screen; **the POS service worker shows a yellow "حدّث الآن / Update now" bar after each deploy — press it, then enter the PIN again**, or you test old code. Screenshots sometimes time out on the POS right after load; `find` / `get_page_text` / `javascript_tool` reads work. Close tabs you open.
- Netlify logs: `netlify-observability-services-reader` (`get-request-logs`, ms timestamps). WhatsApp delivery issues: `net._http_response` and now `suqa.wa_outbox`.
- The project doc `claude/suqa-context.md` mirrors `docs/PROJECT_CONTEXT.md`; both are out of date (they still say Yorgo is dev-only). Update with `Projects` `project_write` + `local_path` inside the working dir.

---

## 5. Architecture (the parts that matter)

### 5.1 POS sync (pos-core)
- The device keeps everything in IndexedDB (`packages/pos-core/src/db.ts`) and writes **ops** to an outbox (`enqueue(db, kind, payload)`). The engine (`sync/engine.ts`) pushes them to `suqa.pos_push(device, ops)` and pulls snapshots/changes from `sync_log`.
- `pos_push` dispatches on `kind` (`sale.commit`, `order.pay`, `order.status`, `order.edit`, `order.info`, `order.driver_cash`, `driver.payout`, `rate.set`, …) to `suqa._pos_*` functions. **Every op is idempotent by `op_id`** (replays return `replayed: true`) and audited in `suqa.audit_log` (`action` = kind, `after->'result'` = result).
- Role rules live in `pos_push` (cashier needs `approved_by` for `rate.set`, `product.patch`, `stock.move`) and inside the op functions (e.g. `owner_only`).
- Client changes local rows optimistically, then the op; the server re-checks everything and computes money from its own rows, **never trusting amounts from the device**. This is the core "never double count" mechanism.
- `fillCents` / `repairCents` in the engine: storefront orders are stored in dollars only (`total_cents` null); the device fills cents when it applies them (fix for "$0.00 / paid" online orders).
- UI: `apps/web/app/pos/` — `Shell.tsx` (views, nav, Yorgo button, PIN gate for debts), `views/*.tsx`, `components/*.tsx`, `i18n.ts` (`pt(key, locale)`, Arabic + English), `pos.css`, `lib/useScanner.ts` + `lib/scan-buffer.ts` (barcode scanner; tolerant of slow PCs; ignores textareas), `lib/perm.ts` (`can(role, cap)`).

### 5.2 Storefront orders
- `_place_shop_order` (DB) prices lines; since script 82 a lira-priced item's line is `round(qty × price_lbp ÷ tenants.fx_lbp_rate, 2)` via `suqa._line_usd` / `_unit_usd`. The web side shows the same figure via `apps/web/lib/price.ts` (`usdPrice`), used in `lib/public-data.ts` (`getShopWithProducts(tenant, slug, fx)`) and Yorgo tools.
- Checkout: `apps/web/app/(store)/checkout/Checkout.tsx`. Cart: `components/CartProvider.tsx`.

### 5.3 WhatsApp
- DB triggers (`notify_order_event`, `_notify_order`, `customer_coming`) post events to `/api/wa/events` through **`suqa._wa_post`** (script 79), which records each post in `suqa.wa_outbox`; cron job `suqa-wa-outbox` runs `wa_outbox_retry()` every minute and re-sends **only connection failures** (no HTTP answer), max 3 tries. Reason: on prod a shop missed an order alert because pg_net failed with an SSL error.
- Templates: `apps/web/lib/server/wa-templates.ts` (definitions), `wa-messages.ts` (builders; each `Tpl` has a `fallback` template for WABAs that lack the new one). Admin → Settings → WhatsApp has "Templates status" / "Submit missing templates". All 10 templates are APPROVED on prod. Phone numbers go out with 961 (`normalizePhone`).
- Routes: `app/api/wa/{events,webhook,numbers,templates}`. **I did not review what `webhook` does with inbound text/audio** — the next task asks you to report that first.

### 5.4 Yorgo (AI)
- `apps/web/lib/yorgo/`: `config.ts` (maxTokens 1024), `model.ts` (Anthropic Messages via fetch, `thinking: disabled` — thinking ate the token budget; key trimmed — stray whitespace caused 401), `tools.ts` (`match_items`, `draft_order` seller, `draft_basket` shopper), `prompts.ts`, `core.ts` (`runTurn`; `detectScript` + language note so Arabizi is answered in Arabizi, repeated after tool results), `enabled.ts`.
- Routes `/api/yorgo/chat` (returns `message_id`, calls `yorgo_miss`), `/api/yorgo/feedback`. Admin page `/admin/yorgo`.
- DB (scripts 77, 78): `yorgo_settings`, `yorgo_shops`, `yorgo_conversations`, `yorgo_messages`, `yorgo_usage`, `yorgo_gate`, `yorgo_record`, `yorgo_feedback`, `yorgo_misses`.
- **Non-negotiables:** tools run with the **caller's own JWT** (no service role on paths that read shop data); drafts only — a person confirms; never in the POS critical path (offline till untouched); no free-form SQL; everything audited; reply in the user's language and script; the model never names an item or price on its own (ids come from `match_items`, names/prices from the catalog).

### 5.5 Drivers (script 81, released 2026-11-19)
- Driver gets a WhatsApp with a link to `/d/<order id>` (unguessable id, no login, server-side service role in `app/d/[id]/page.tsx` + `app/api/d/[id]/step`). Steps: ack → picked (order goes `out_for_delivery`) → **delivered (final)**.
- "Delivered" opens a **pay screen** (`app/d/[id]/DriverPay.tsx`): cash USD and/or LBP with suggested notes and change in either currency, Whish, and debt for what was not paid (within the customer's credit limit). Server `suqa.driver_step(order, 'delivered', pay jsonb)` checks it covers what is due (±1 lira note), then writes payments:
  - cash → tender **`driver`**, one row per currency, net of change (an LBP row can be negative: paid $20, gave 715,000 change). **Not drawer cash, in no shift.**
  - Whish → `wallet`; debt → `unpaid` on the customer.
- Driver's own page `/d/me/<driver id>` (`suqa.driver_balance`): cash he holds (USD + LBP), unpaid pay, net, open items, past settlements. Only his own deliveries.
- POS Drivers view: cash per driver/order, owner correction (`order.driver_cash`, owner only, only while unsettled, never more than the order), **one settlement** (`driver.payout` with `order_ids` for pay and `cash_order_ids` for cash; each row claimed once server-side; drawer moves once per currency by the net).
- If an offline till later records the customer's payment on an order the driver already closed, `_driver_cash_absorb` (hooked into `_pos_order_pay`) takes the excess off the driver's open cash — money counted once.

### 5.6 Other recent features (all released)
- **Edit order info** (script 80): POS customer box reopened on an existing order (`CustomerDialog` `editing` mode, `editOrderInfo` in pos-core, op `order.info`). Any stage except rejected/cancelled and walk-ins. **Delivered orders: info editable, amount/fee/payments/driver locked** (money already counted; refunds go through Return). Totals are recalculated only when the fee changes (a name fix must not re-round the LBP total). Customer notified only if amount, delivery/pickup or time changed.
- **PIN on al-dayn:** opening Debts from the menu asks the signed-in person's own PIN (`components/PinGate.tsx`), 5-minute grace, 5 wrong tries = 1-minute lock. Does not cover dayn chosen in the pay box or the customer page (by Dan's choice).
- **Shop exchange rate in POS:** Settings → 💱 (`components/RatePanel.tsx`, `setShopRate` in `sale.ts`, op `rate.set`), **owner role only**, dated history, past sales keep their rate.
- **Lira-priced items** (script 82): see 5.2.
- **Checkout:** bottom bar button is always the next step — "📍 Save address and continue" while the address form is open, otherwise "Confirm order", with a one-line reason when disabled. (Customers were abandoning at a grey button with the save button hidden above.)
- Cart line note keeps spaces (was trimmed per keystroke). Photo picker has separate Gallery / Camera buttons. Confirm dialog buttons follow the POS language (`useConfirmLabels`).

---

## 6. Key decisions and why

| Decision | Why |
|---|---|
| Server recomputes every amount; device amounts are hints only | Multi-device offline POS; the only way to guarantee no double counting. |
| Ops idempotent by op id; replays answer `replayed` | Devices retry after lost answers. |
| Driver "delivered" is **final**, shop can correct | Dan: driver confirmation is final, shop able to correct it. |
| Driver cash is its own tender (`driver`), not drawer cash, settled later | Otherwise the shift cash would be wrong until the driver comes back. |
| Driver cash kept **per real currency** (USD row + LBP row) | So settlement shows the notes he actually hands over; change in lira produces a negative LBP row. |
| Whish from the driver = just "paid by Whish", no reference | Dan's choice. |
| Driver dayn limited by the customer's credit limit, same as POS | Dan's choice. |
| Delivered orders: info editable, money locked | Money already in shifts/reports/driver pay; refunds via Return. |
| Debts screen PIN = own PIN, not a separate dayn PIN | A shared PIN ends up on paper; till left open is the real risk. |
| Lira-priced items charged at their lira price, dollars derived at market rate | Two rates made 600,000 show as 603,000 online. |
| Rate box owner-only | Rate drives every LBP figure; setup/admin roles must not change a shop's money. |
| Patch big functions by anchor replacement | Keep exactly what is live; dev and prod definitions verified identical by md5. |
| WhatsApp retry only on connection failure | A timed-out or answered request may already have sent the message — resending could duplicate it. |
| Feature branches until the script is approved | A client op the server doesn't know yet would be rejected on dev. Merged to main after approval. |

---

## 7. Known bugs, risks and loose ends

1. **Shop rate vs market rate:** POS uses the shop's `exchange_rates` row; storefront uses `tenants.fx_lbp_rate`. They are both 90,000 on prod today. If a shop changes its POS rate, POS LBP figures and online LBP figures differ for dollar-priced items (told to Dan, accepted for now).
2. **Hard-coded 89,500 fallbacks** remain in pos-core (`orders.ts`, `reports.ts`) and several POS views (`useState(89500)` until the rate loads) and in `_order_rate` / `driver_balance`. Harmless while every shop has a rate row; wrong for a new shop until its rate is set. Consider seeding a rate row when a shop is created.
3. **`price_usd` of lira-priced items** is the till's own conversion and is not recomputed when rates change. Online is correct (derived from `price_lbp`); on the POS a lira-priced item uses `price_lbp` for lira but `price_usd` for the dollar figure — **not verified** after the 90,000 change.
4. **Storefront orders carry dollars only** (`total_cents`, `subtotal_cents`, item cents and `rate_lbp_per_usd` are null; only `*_usd` + `fx_lbp_rate`). Every reader of cents must fill them from the dollars: the POS does it on the device (`fillCents`), the receipt page `/r/[id]` does it since `984933e` (dev). This bit us twice — HS-000020 in the POS, HS-000030 on the receipt. **Recommended permanent fix: script 83** that fills cents + rate in `_place_shop_order` (or a trigger) and backfills existing online orders; then the per-page fills become harmless. Not written yet — propose it to Dan, needs "approve 83". Driver cash (`_order_due_cents`) already coalesces from dollars.
5. **Dev WhatsApp shows "bad format" messages** because the dev WABA lacks `order_update_v3` / `driver_dispatch_v2` (fallback templates). Dan must press "Submit missing templates" on dev as admin. Not a code bug.
6. Orders that a driver marked "delivered" the **old way** (before 81) stay open until the shop closes them.
7. **Unverified on prod** (tested on dev only): driver pay screen + settlement, edit order info, debts PIN, cart note spaces, checkout save-address button (also never tested at real phone width — the desktop window would not shrink), photo gallery button, lira price on a real prod order, rate box, POS showing 90,000 after sync, `/admin/yorgo` page with an admin login, phone layouts.
8. Cashier not seeing the rate box — tested only as owner.
9. Photo for "khabset djej w batata" (Furn El Dayaa, prod) not added; Dan can do it with the gallery button.
10. Local `supabase/test/smoke.sql` exited with code 3 on the last run — **not investigated** (may be pre-existing or fixture drift). Check before relying on it.
11. Commit messages for 80/81/82 say "not applied" — they were applied later; trust this note and the database.
12. Old branches `order-info-edit`, `driver-cash`, `lbp-price` are fully merged; safe to delete with Dan's OK. `milestone/2026-11-18-pre-yorgo` is a restore point (plus prod DB snapshot schema `suqa_snap_20261118`).
14. **Shop page item limit (fixed on dev 2026-11-19, `3bb4b70`, not yet on prod):** the storefront read a shop's items in one API call, which Supabase caps at 1,000 rows — Dekanet Jadde (1,159 items) lost its last 159 (e.g. most water) from the page and the search. Now paged in `lib/public-data.ts`. Any new list query over a whole shop's items must page too (`.range`).
15. **Short Arabizi words** ("miyah", "mayye", "may") rarely match: the matcher compares consonant skeletons and a one-consonant word (مياه → "m") is only matched as typed or through an item alias. Options given to Dan: add aliases, or teach the matcher (client `lib/item-match` / pos-core `item-match.ts` AND `suqa.norm_text/skel_text` in the DB must stay in step).
13. Dev test data left: BAT-000105 and BAT-000084 closed by the test driver with a settlement; BAT-000108 pending test order with a lira item; Elie Grocery rate history has 89,600 then 89,500 entries.

---

## 8. Waiting on Dan (don't do these yourself)

- Press "Submit missing templates" on dev (admin).
- Check `/admin/yorgo` with his admin account; check phone layouts; tell shops about the driver flow; poster inputs for marketing (logos for Dekanet Jadde / Furn El Dayaa, launch offer, size) — marketing doc is the Claude Doc "Yorgo Suqa — launch marketing kit".
- Real WhatsApp order messages and voice notes as test material for Yorgo.
- Supabase paid plan for backups (open item).

---

## 9. Next task (queued by Dan)

Project doc **`claude/yorgo-next-step-prompt.md`**: Yorgo multi-provider AI (`ai.run(task, input)`, Anthropic + Google adapters, table `yorgo_ai_routes`, admin page) and **WhatsApp inbound text/voice → basket draft** with confirmation. It explicitly says:

- read `docs/yorgo/PLAN.md` and `CHANGELOG.md`, **write a short plan as a new section in PLAN.md and stop for approval before building**;
- first tell Dan what the existing webhook (`apps/web/app/api/wa/webhook`) does today with text and audio;
- propose how inbound messages run with the sender's own access (no service role for shop/order data) — e.g. a short-lived JWT for the mapped user — and explain it before building;
- several wording/caps/"Confirm from WhatsApp?" decisions are **his**, not yours;
- test on dev with the Meta test number only; never touch prod; the script for `yorgo_ai_routes` is number **83** (or later) and needs "approve 83".

Reuse what exists: `match_items` / `draft_basket` (shopper tools), `yorgo_gate` / `yorgo_record` / `yorgo_usage` (caps, rate limit, metering), `via_yorgo` audit tagging, the language/script detection in `core.ts`, and the storefront's existing checkout path for confirmation.
