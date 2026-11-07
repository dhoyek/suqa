# Suqa POS — implementation plan

Status: **proposal, waiting for approval. No POS code written yet.**
Restore point: branch `snapshot/pre-pos` = commit `1389c09` (schema through `20_fulfillment.sql`). See §9 for the restore procedure.

Pilot: a mini-market (ma7al smene) in Hsarat. Design must fit any shop type on the platform (restaurant, pharmacy, bakery…).

---

## 0. The non-negotiables, and how the design meets each

| Requirement | How |
|---|---|
| Offline-first, never waits on the network during a sale | Everything a sale needs (catalog, barcodes, prices, rate, staff PINs, open orders) lives in IndexedDB on the device and is held **in memory** while the POS is open. A sale is a single local transaction; the network is only ever touched by a background sync loop. |
| USD + LBP together | Integer money: USD in **cents**, LBP in **whole pounds**, rate as integer LBP per USD. Every price has its own currency; every total is computed in both; every sale stores the rate it used. Split tender and change in either currency. |
| One stock across POS / WhatsApp / phone / online | `stock_moves` append-only ledger on the server, mirrored locally. On-hand = Σ moves. Online orders write reservation moves; POS sales write sale moves offline; both count after sync. |
| Multi-device, same login | Each browser/device registers as a `device` with its own id and order prefix. Several devices on one account sell at once; all converge through the ledger + change feed. |
| Two-way sync | Up: outbox of idempotent ops. Down: server change feed with a per-device cursor, poked by Supabase Realtime when online. App versions: PWA service worker with deferred activation. |
| No scope creep | Nothing for accounting, payroll, suppliers, loyalty, e-invoicing, warehouses. "Unpaid" is a tender type with a name/phone/note and a list — no debt book. |
| Any modern browser, no install | Pure web app (PWA). Works in a tab; "Add to home screen" is optional but recommended (keeps storage persistent on iOS). No native code, no Electron. |

---

## 1. Architecture

### 1.1 Where it lives

```
apps/web/app/pos/…          POS UI (client-only route group, own layout, RTL/LTR)
packages/pos-core/          framework-free engine: local DB, sync, money, search, numbering,
                            receipts model, import adapters  — unit-tested with vitest
supabase/schema/21_pos_*.sql  server tables, RPCs, triggers, RLS (full-script rule as today)
apps/web/app/api/pos/…       the few server routes that need the service role (device wipe,
                            Excel import staging, receipt WhatsApp send)
```

Same Next.js app and same Netlify deploy as the store (shared auth, shared Supabase client, one domain, one SW). The `/pos` route group is rendered **client-side only** (`'use client'`, no server data fetching) so the shell can be served from the service-worker cache with no network.

### 1.2 Offline + sync: the decision

Three candidates were weighed against §0 and the required behaviours (outbox, cursor pull, device registry, ledger, LWW per field + conflict log, durability, schema migration with unsynced data, offline PIN).

| | **Hand-rolled: Dexie (IndexedDB) + outbox + change-feed pull** | **PowerSync** | **ElectricSQL** |
|---|---|---|---|
| What it gives | Nothing for free — but the required behaviour list *is* the spec of this design, and it is small | Postgres → SQLite (wa-sqlite in the browser) read sync with sync rules; you still write the upload connector; hosted service or self-host | Read-path "shapes" sync over HTTP; writes are entirely yours; persistence in browser needs PGlite/TanStack DB |
| Moving parts in the path of a sale | Browser + Supabase. One vendor | Browser + PowerSync service + Supabase. Needs a logical-replication slot/publication on the Supabase DB and a PowerSync cloud instance (or a self-hosted container we would have to run and pay for) | Browser + Electric service + Supabase. Same replication-slot requirement |
| Auth model | Supabase RLS stays the single source of truth; push/pull are RPCs run as the user | Sync rules re-express access in PowerSync's own language, parallel to RLS | Shapes with `where` clauses, parallel to RLS |
| Browser support (no install) | IndexedDB: every browser incl. iOS Safari, old Android Chrome | wa-sqlite needs OPFS or an IndexedDB VFS; works, but iOS Safari OPFS + multi-tab + service-worker interplay is the part that bites | Browser persistence is the newest/least settled part |
| Bundle | ~30 KB (dexie) | ~1 MB+ (sqlite wasm) | depends on store |
| Cost | $0 | Free tier, then paid per instance | Free self-host / paid cloud |
| Where it would win | — | If we needed arbitrary ad-hoc local SQL over large data (100k+ rows, joins, reports) | If we needed many read-only shapes with partial replication |

**Recommendation: hand-rolled Dexie + outbox + server change feed.**
Reasons, against the requirements:
1. The data per shop is small (≤10k items, a few thousand sales/month). Linear in-memory scans beat SQLite for the two hot paths (barcode → `Map` lookup, search → pre-normalised string scan over 10k rows ≈ 2–5 ms).
2. Every required behaviour (idempotent ops, cursor, device revoke/wipe, ledger, field-level LWW with conflict log, migrations that keep the outbox intact) has to be written by us *anyway* with PowerSync/Electric on the write side; the engines only replace the pull, which with a change-feed table is ~200 lines.
3. No third service, no replication slot, no second access-control language. Supabase RLS + RPC remain the only security boundary, which also keeps the existing store untouched.
4. Works in every browser the pilot will realistically use (an old Windows PC, mid-range Android, an iPad).
5. Escape hatch: the local schema is table-per-entity with UUID keys and server timestamps — exactly what PowerSync would mirror — so switching the pull layer later is contained.

### 1.3 Local data (Dexie)

Database `suqa-pos-<shopId>` (one DB per shop so a user with two shops never mixes data).

```
meta          key → value            (device id, prefix, cursor, local seq, schemaVersion, session, rate)
products      id, shopId, categoryId, *barcodes, sku, nameAr, nameEn, norm (search string), priceCents|priceLbp,
              priceCurrency, costCents (owner only — stripped from the pull for non-owners), unit, decimalQty,
              vat, trackStock, minStock, onHand, reserved, visibleOnline, active, updatedAt
categories    id, parentId, name, sort
quickButtons  id, productId, label, color, sort
rates         id, lbpPerUsd, effectiveAt            (history; latest = current)
staff         userId, name, role, pinHash, pinSalt, active
orders        id, channel, status, localNumber, number, customer…, totals, rate, parked, shiftId, deviceId, updatedAt
orderLines    id, orderId, productId, name, qty, unitPrice{cents|lbp,currency}, discount, lineTotalCents
payments      id, orderId, method (cash_usd|cash_lbp|card|wallet|unpaid), amount, currency, reference, note
stockMoves    id, productId, qty, kind, refId, deviceId, at
shifts        id, deviceId, openedBy, openedAt, floatUsd, floatLbp, closedAt, counted…, expected…, diff…
cashMoves     id, shiftId, kind (in|out), amount, currency, reason
customersSeen phone → name, lastAddress, lastPin
outbox        seq (auto), opId (uuid v7), kind, payload (opaque JSON), schemaVersion, createdAt, tries, nextTryAt, lastError, state (pending|sent|rejected)
conflicts     id, table, rowId, field, local, server, at, seen        (mirror of server conflict log for the owner)
```

Hot path: on open, `products`, `categories`, `quickButtons`, `staff`, latest rate and open `orders` are loaded into a `CatalogIndex` in memory: `byBarcode: Map`, `byId: Map`, `searchRows: {id, norm}[]`, category grid. Pulls patch the index incrementally. The sale screen never reads IndexedDB.

### 1.4 Write path (outbox push)

* Every user action that changes data is an **op**: `{opId: uuidv7, kind, payload, deviceId, clientAt}`. Examples: `sale.commit`, `sale.park`, `sale.void`, `order.status`, `stock.move`, `product.upsert` (field patch), `shift.open/close`, `cash.move`, `return.commit`.
* A sale is committed in **one Dexie `rw` transaction** over `orders, orderLines, payments, stockMoves, outbox, meta` (local seq bump). Only after the transaction resolves does the UI show "paid" and print. IndexedDB transactions are durable across tab close/crash/reboot (we request `durability: 'strict'` where supported and `navigator.storage.persist()` on first run).
* A single **sync leader** per shop (Web Locks API `navigator.locks.request('suqa-pos-sync')`) drains the outbox in `seq` order: batches of ≤50 ops → `rpc('pos_push', {device, ops})`. Retry with exponential backoff (1s → 2s → … → 5 min, with jitter) on network/5xx; the op stays at the head of the queue so order is preserved.
* Server: `suqa.pos_push(p_device uuid, p_ops jsonb) returns jsonb` runs as the signed-in user (RLS applies). For each op: if `op_id` already in `suqa.pos_ops` → return the stored result (**idempotent — a retried sale is never duplicated**). Otherwise apply inside a savepoint, record `{op_id, device_id, kind, result}`, continue. A permanently invalid op (e.g. validation failure, revoked device) is returned as `rejected` with a reason; the client marks it `rejected`, **does not block the queue**, and lists it under "needs attention" for the owner. Nothing is ever silently dropped.
* Server-assigned values come back in the push result (shop-wide order `number`, `server_seq`) and are written to the local rows.

### 1.5 Read path (delta pull + realtime poke)

* `suqa.sync_log(seq bigserial, tenant_id, shop_id, tbl, row_id, op, row jsonb, origin_device uuid, at)`: AFTER triggers on every synced table write the full row (`to_jsonb(NEW)` minus heavy/secret columns; `cost_*` columns are nulled unless the puller is owner — done in the pull RPC, not the log).
* `suqa.pos_pull(p_device uuid, p_cursor bigint, p_limit int default 1000) returns jsonb` → `{rows:[…], cursor, server_now, device:{revoked, prefix}}`. The client applies rows in one Dexie transaction, updates the in-memory index, stores the cursor. Loops while `rows.length == limit`.
* The device's own echoes (`origin_device = me`) are skipped except for server-assigned fields.
* When online, the leader tab subscribes to Supabase Realtime `postgres_changes` on `sync_log` filtered by `shop_id` — payload is **only a poke**; data always comes through `pos_pull`, so there is exactly one apply path. A new online order therefore appears on every device within the Realtime latency (target < 5 s) with a sound + notification. Fallback: periodic pull every 60 s and on `online` event / focus.
* Retention: `sync_log` rows older than 30 days are deleted nightly (pg_cron). A device with a cursor older than the oldest kept row does a **full resync** (truncate local mirrors, keep outbox + meta, re-pull from 0).

### 1.6 Conflicts

* **Catalog/price/settings**: server is the source of truth. A POS edit is pushed as a field patch `{id, fields:{price_cents: 150}, base_updated_at}`. The server applies it field by field: the later *server receipt* wins; if the row's `updated_at` is newer than `base_updated_at`, the overwritten values are written to `suqa.conflict_log(shop_id, tbl, row_id, field, old, new, by_device, at)`. The owner sees these in Settings → "Conflicts" (local mirror via the feed).
* **Sales / stock / payments / shifts / cash**: append-only, no conflicts by construction. Stock can go negative; a product whose on-hand < 0 is flagged `needs_review` in the stock screen.
* **Order status** (online orders handled from two devices): server applies the existing `order_transition_allowed` state machine; a losing transition is returned `rejected` and the device re-pulls the real status.

### 1.7 Numbering

* On registration the server assigns the device a prefix (`A`, `B`, … per shop). Local number = `prefix-000123` from a local counter in `meta` (bumped inside the sale transaction). Shown on the receipt immediately.
* On push, the existing `next_order_number()` assigns the shop-wide/tenant number; both numbers stay on the order and the receipt shows both after sync.

### 1.8 Devices, auth, PIN

* `suqa.devices(id, shop_id, name, prefix, registered_by, last_sync_at, pending_count, revoked_at, user_agent)`. First sign-in on a device (needs internet — existing WhatsApp-code flow) → register → store device id in `meta` (and in `localStorage` as a guard).
* Owner screen: devices list with last sync / pending / "Revoke". Push and pull RPCs raise `device_revoked`; the client stops syncing, shows "This device was revoked", and wipes the local DB on next connect (the unsynced outbox is exported to a JSON file first so nothing is lost silently).
* Offline unlock: `shop_members.pin_hash` (PBKDF2-SHA256, 100k iterations, per-user salt; set/changed only online) is synced to the device. The POS lock screen asks for the 4-digit PIN; verification is local (WebCrypto). Allowed while `now - last_online_at ≤ shop.offline_days` (shop setting, default 7). When online, supabase-js refreshes tokens normally; if the refresh token is dead the device asks for a full sign-in.
* Quick staff switch = PIN of another staff member on the same device; the current staff id is stamped on every op.
* Roles (per `shop_members.role`, extended): `owner`, `cashier`, `stock`. Permission checks run locally (for UX) **and** server-side in `pos_push` (for truth). Owner PIN or a reason is required for refund, void, discount/override above `shop.max_discount_pct`, and stock adjustment — the approval is recorded on the op.
* Suqa platform admin (existing `platform_admins`) can open any shop's POS/catalog; every admin op is logged with `acting_as_admin = true`.
* Audit: `suqa.audit_log(shop_id, user_id, device_id, at, action, row_ref, before, after)` written by `pos_push` for every op — owners can read it (Reports → Audit).

### 1.9 PWA, updates, migrations

* `@serwist/next` service worker: precache the `/pos` shell + assets; runtime cache for product images (stale-while-revalidate); never cache API calls.
* Updates: SW installs in the background; we **do not** `skipWaiting`. The app shows "Update ready" and applies it (reload) only when no sale is open and no payment dialog is up; if the cashier is busy, it auto-applies at the next idle moment (no open sale for 60 s).
* Dexie `version(n).stores().upgrade()` migrates local data. Rule: the `outbox` store's shape never changes (opaque payload + `schemaVersion`), and `pos_push` accepts every past `schemaVersion`, so unsynced sales survive any update. Test covers it (§5).

### 1.10 Performance plan (targets from the brief)

| Target | Design |
|---|---|
| Scan → line < 100 ms | HID scanner ends with Enter; a global key listener buffers scans (fast inter-key timing) and resolves via `byBarcode.get()` — no DOM focus dependency, so "focus always lands in the sale screen" is free. Line add is a state update; the Dexie write for a *draft* line is deferred (draft persisted every 500 ms + on blur/visibility change). |
| Search 10k items < 200 ms | Pre-normalised `norm` (reuse the Arabic normaliser from `ShopMenu.tsx`: strip tashkeel, unify أإآ→ا, ة→ه, ى→ي, lower-case Latin). Substring scan over 10k strings ≈ 3 ms; results capped at 50; input debounced 60 ms. |
| Cold start < 3 s | SW-cached shell (~200 KB JS for the POS route) + one Dexie bulk read of 10k rows (~300 ms) + index build (~50 ms). |
| Confirm payment < 300 ms | One IndexedDB transaction of ~5–15 rows. Receipt rendering after the commit resolves. |
| 5 items → paid < 10 s | Scan path + `Enter`/`F8` to pay, numeric pad with "exact" shortcuts and `Enter` to confirm. |

A benchmark (`packages/pos-core/bench/`) seeds 10,000 synthetic items (AR/EN names, 1–3 barcodes each) into fake-indexeddb, builds the index, and asserts scan lookup p95 < 1 ms, search p95 < 50 ms (headless; real devices will be slower but within budget), and a full 5-line sale commit < 100 ms. Runs under `npm test` as a non-blocking "bench" project and prints timings.

---

## 2. Data model changes (server, schema `suqa`)

New file `21_pos.sql` (+ updates to the base files 01/03/04/06 per the "full script" rule). All tables carry `tenant_id` and `shop_id`, RLS = member of the shop (owner for cost/audit/conflicts), platform admin bypass as today.

**Enums** — `shop_role` gains `cashier`, `stock` (existing `staff` kept = cashier). New: `order_channel (online, walkin, whatsapp, phone)`, `tender (cash_usd, cash_lbp, card, wallet, unpaid)`, `stock_move_kind (sale, return, receive, adjust, reserve, release, damaged, count)`, `price_currency (usd, lbp)`, `unit_kind (piece, kg, g, l, ml, pack)`.

**Decision: one `orders` table for every channel.** Walk-in, WhatsApp and phone orders created on the POS are rows in the existing `orders`, so the inbox, status flow, customer WhatsApp notifications, reports and stock all work on one set. Changes needed (all additive, defaults keep today's store flow identical):
* `channel order_channel default 'online'`, `device_id`, `staff_user_id`, `local_number`, `shift_id`, `parked boolean`, `discount_cents`, `discount_reason`, `cancel_reason`.
* `customer_id` becomes **nullable** (walk-in has no account); `address` default `'{}'`; `customer_name` default `''`.
* Money in both currencies: `rate_lbp_per_usd int` (keep `fx_lbp_rate` in sync), `subtotal_lbp`, `total_lbp`, `paid_usd_cents`, `paid_lbp`, `change_usd_cents`, `change_lbp`.
* `order_items`: `price_currency`, `unit_price_lbp`, `discount_cents`, `cost_cents` snapshot (owner-only via RLS column rule in the pull), `void_reason`.
* Triggers: `_check_open_limit`, customer notifications and the shop new-order alert fire only for `channel = 'online'` (phone/WA orders created by the shop itself still notify the **customer** on status changes). Walk-in sales insert directly as `delivered` with `closed_at = now()` — no transition trigger involved.

**Products** (`04_catalog.sql` full script): add `price_currency`, `price_lbp`, `cost_cents`, `sku`, `unit_kind`, `decimal_qty`, `vat`, `track_stock`, `min_stock`, `visible_online` (today's `is_available` stays = "sellable online right now"), `on_hand numeric`, `reserved numeric` (both maintained by trigger from `stock_moves`), `photo_url` (= existing `image_url`). New `product_barcodes(product_id, barcode, unique(shop_id, barcode))`.

**New tables**
```
devices           id, shop_id, name, prefix, user_agent, registered_by, registered_at, last_sync_at, last_cursor, pending_count, revoked_at
pos_ops           op_id pk, device_id, shop_id, kind, schema_version, applied_at, result jsonb
sync_log          seq, tenant_id, shop_id, tbl, row_id, op, row jsonb, origin_device, at
conflict_log      id, shop_id, tbl, row_id, field, old, new, by_device, by_user, at, seen
audit_log         id, shop_id, user_id, device_id, at, action, ref_tbl, ref_id, before, after, acting_as_admin
exchange_rates    id, shop_id, lbp_per_usd int, effective_at, set_by        (shop-level; tenant fx_lbp_rate stays the store default)
stock_moves       id, shop_id, product_id, qty numeric(12,3), kind, ref_order_id, ref_id, unit_cost_cents, note, device_id, user_id, at
payments          id, order_id, shop_id, tender, amount (int: cents or pounds), currency, reference, unpaid_name, unpaid_phone, note, at
shifts            id, shop_id, device_id, opened_by, opened_at, float_usd_cents, float_lbp, closed_by, closed_at,
                  counted_usd_cents, counted_lbp, expected_usd_cents, expected_lbp, diff_usd_cents, diff_lbp, note
cash_moves        id, shift_id, shop_id, kind (in|out), amount, currency, reason, user_id, at
quick_buttons     id, shop_id, product_id, label, color, sort
returns           id, shop_id, order_id, number, device_id, user_id, approved_by, refund_usd_cents, refund_lbp, reason, at
return_lines      id, return_id, order_item_id, product_id, qty, to (stock|damaged), amount_cents
```
`shop_members` gains `pin_hash`, `pin_salt`, `pin_set_at`, `active`. `shops.settings`-style columns added to `shops`: `offline_days`, `max_discount_pct`, `allow_negative_stock`, `lbp_rounding_step`, `deduct_stock_at (ready|delivered)`, `hide_online_when_zero`, `receipt_footer`, `printer jsonb`.

**RPCs**: `pos_register_device`, `pos_push`, `pos_pull`, `pos_revoke_device`, `pos_set_pin`, `pos_import_products(jsonb, dry_run)`; public catalog query gains `available = on_hand - reserved` and honours `hide_online_when_zero`.

**Stock for online orders** (server-side, no POS involvement): `reserve` move on placement; at `ready` or `delivered` (shop setting) a `sale` move + `release`; on reject/cancel a `release`. `products.on_hand/reserved` are updated by the `stock_moves` trigger, which also writes to `sync_log`, so "POS price/stock changes visible on the public catalog within 1 minute" is immediate (public pages are already ISR/no-cache for availability).

---

## 3. Packages, routes, libraries

### 3.1 New package `packages/pos-core` (TypeScript, no React)
`db.ts` (Dexie schema + migrations) · `index.ts` (CatalogIndex, normaliser, search) · `money.ts` (integer USD/LBP math, rounding steps, split tender, change) · `sale.ts` (draft → commit transaction, numbering) · `sync/outbox.ts`, `sync/pull.ts`, `sync/leader.ts` · `auth/pin.ts` · `receipt.ts` (receipt model → text/HTML/ESC-POS bytes) · `import/adapter.ts` (interface + CSV/XLSX generic adapter; `adapters/<system>.ts` added per source) · `shortcuts.ts` · `bench/`.

### 3.2 Routes (`apps/web/app/pos/`)
```
/pos                     lock / PIN / staff switch; redirects to /pos/sell
/pos/sell                the sale screen (scan, search, grid, quick buttons, cart, pay, park)
/pos/orders              inbox: online + WhatsApp + phone + parked, status actions, new WA/phone order
/pos/items               catalog list/editor, barcode, quick buttons, bulk price/visibility, import
/pos/stock               receive, count, low stock + WhatsApp reorder share, adjustments, negative review
/pos/shift               open/close shift, cash in/out, Z report
/pos/returns             return against an order
/pos/reports             today (offline), period/channel/item/category, top/slow, unpaid, exports
/pos/settings            devices, staff & PINs, rate history, printer, rounding, conflicts, audit, export
/api/pos/import          XLSX/CSV staging (server parses the file, returns mapped preview JSON)
/api/pos/receipt         sends the receipt WhatsApp template (reuses lib/server/whatsapp.ts)
```
Entry from the existing merchant area: a "نقطة البيع / POS" button on `/shop`.

### 3.3 Libraries to add (and why)

| Library | Why | Size |
|---|---|---|
| `dexie` ^4 | IndexedDB with transactions, versioned migrations, multi-tab safety. The de-facto standard; our whole local layer | ~30 KB |
| `@serwist/next` | Maintained successor of next-pwa: precaching, runtime caching, update lifecycle for Next 15 app router | build-time |
| `uuid` ^11 (`v7`) | Time-ordered UUID v7 for every client-generated id (sortable, index-friendly) | tiny |
| `barcode-detector` (zxing-wasm ponyfill) | Camera scanning for EAN-13/8, UPC, Code128, QR. Uses the native `BarcodeDetector` where present (Chrome/Android), WASM elsewhere (Safari/iPad) | lazy-loaded only when the camera button is used |
| `xlsx` (SheetJS CE) | Read Excel/CSV for import; write Excel for report export. Used server-side in `/api/pos/import` and client-side for exports | server + lazy client |
| `fake-indexeddb` (dev) | Run Dexie in vitest for sync/durability tests and the benchmark | dev |
| `qrcode` | On-screen receipt QR | tiny |

Not added: a search library (not needed at 10k rows), a state manager (React state + the in-memory index suffice), a UI kit (the app already has its own CSS; the POS gets a dedicated large-target stylesheet), PowerSync/Electric (§1.2).

**Printing**: ESC/POS over **Web Serial** (USB, Chrome/Edge desktop), **Web Bluetooth** (Android/desktop Chrome), and network printers via whatever the Hsarat POS does today — I will ask for that code at M3 and reuse its approach (Arabic rendering, cash-drawer kick) rather than inventing one. iPad/Safari has none of these APIs: there the receipt goes by WhatsApp/QR or `window.print()` on a receipt-width page (AirPrint).

---

## 4. Screens (short)

* **Sell**: left — cart with big rows (name, qty ±, price, line total in USD and LBP), totals in both currencies, rate shown; right — search box (always focused unless a dialog is open), category chips, product grid / quick buttons, camera button. Status bar: online/offline, last sync, pending count, "Sync now", staff name, shift state. Shortcuts: `F2` search, `F4` qty, `F6` discount, `F8` pay, `F9` park, `Esc` cancel line, `Ctrl+Enter` cash exact.
* **Pay**: amount due in USD and LBP; tender list (add lines: cash USD / cash LBP / card / wallet+ref / unpaid+name+phone); change in the currency the cashier taps; LBP rounded to the configured note step; "exact USD" / "exact LBP" buttons.
* **Orders inbox**: columns by status, online orders highlighted and sounded on arrival, accept / reject / edit (substitute, remove — customer notified with the existing WhatsApp templates), pickup vs delivery, fee, driver info (reuse existing).
* **Lock**: numeric PIN pad, staff tiles; offline days remaining.

---

## 5. Tests

`packages/pos-core` (vitest + fake-indexeddb), all deterministic with a fake server (`FakeServer` implements `push/pull` with the real idempotency/ledger rules, also run against the real RPCs in a Supabase branch in CI later):

1. **Two devices sell the same item offline, then sync** — on-hand on both devices and the server = start − (a + b); both orders get distinct server numbers; the ledger has exactly two sale moves.
2. **Push retried after a timeout** — the first push "times out" after the server applied it; the retry returns the stored result; one order, one stock move, local row gets the server number.
3. **Online order arrives while a device is offline** — reservation move + order are in the feed; on reconnect the device pulls them, shows the order in the inbox, `available` drops; the sound hook fires once.
4. **App update while unsynced sales exist** — Dexie schema v(n) → v(n+1) with 3 pending outbox ops; after migration the ops push successfully and the server accepts the old `schemaVersion`.
5. **Revoked device** — push/pull return `device_revoked`; the client stops the loop, exports the outbox to JSON, wipes the DB; a re-registration gets a new prefix.
6. Money: split tender, change in either currency, LBP rounding, rate snapshot; conflicts: field-level LWW + conflict log entries; numbering: prefix/seq survives reload.
7. Benchmark (§1.10). Server SQL: additions to `supabase/test/smoke.sql` for `pos_push` idempotency, RLS on cost columns, stock trigger sums, channel-scoped notification triggers.

Existing 36 tests keep gating the Netlify build.

---

## 6. Milestones

Each milestone ends deployed on `suqa-dev` and demoable; the pilot can start after **M3**.

| # | Milestone | Scope | Done when |
|---|---|---|---|
| **M1** | Foundations (sync core) | `21_pos.sql` (tables, RPCs, triggers, RLS, feed), `packages/pos-core` (Dexie schema, index, money, outbox, pull, leader, PIN), device registration, lock screen, sync status bar, PWA shell + update banner, tests 1–5 + benchmark | A device registers, goes offline, enqueues ops, reconnects and converges; all tests green |
| **M2** | Selling & payments | Sell screen, HID + camera scanning, search/category grid/quick buttons, qty/price/line discount with permission gating, park/resume, order discount, void/cancel with reason, dual-currency pay dialog with split tender + change + rounding, local/server numbering, on-screen receipt + QR + WhatsApp receipt template, keyboard shortcuts, low-stock warning | A full offline sale in < 10 s on the pilot PC and an Android phone |
| **M3** | Shifts, cash, printing, Today | Shift open/close with float & count per currency, cash in/out, Z report, Today report (offline), ESC/POS printing reusing the Hsarat approach (USB/Bluetooth/network), cash-drawer kick, printer settings per device | Pilot day-one checklist passes; **pilot can start** |
| **M4** | Catalog, stock, import | Item editor (AR/EN, photo, cost owner-only, currency, multi-barcode, unit/decimals, VAT, track/min stock, online visibility), unknown barcode → new item, receive by scan, stock count with auto-adjust, low-stock list + WhatsApp reorder share, negative-stock review, bulk price % per category, bulk visibility, XLSX/CSV import with mapping + dry-run + error report, adapter interface + first adapter from the pilot sample (`samples/` git-ignored), public catalog availability + auto-hide at 0 | Pilot shop loaded from its current POS export; online catalog reflects POS stock within a minute |
| **M5** | Order inbox & returns | Online/WhatsApp/phone orders in the POS with sound, accept/reject/edit with substitution + customer notification, create WhatsApp/phone orders (customer by phone, pin + optional address, pickup/delivery, fee), reservation/deduction setting, returns (full/partial, to stock/damaged, cash refund, owner PIN) | The shop runs all channels from the POS alone |
| **M6** | Roles, reports, hardening | Staff invite by phone, cashier/stock roles end to end, owner-PIN approvals, audit log UI, devices admin, conflict log UI, reports (period/channel/item/category, top/slow, stock value, unpaid list) + Excel/CSV export, per-shop data export, Arabic/English/RTL pass, large-target pass on iPad, Safari storage persistence, docs | All brief items ticked; pilot feedback round closed |

Order of M4/M5 can swap depending on whether the pilot shop wants its online catalog or its order inbox first.

---

## 7. Decisions (approved 2026-11-07)

1. **Sync engine**: hand-rolled Dexie + change feed. ✔
2. **One `orders` table for all channels**. ✔
3. `offline_days` is a shop setting 1–90, **default 30** (risk accepted: a revoke/PIN change only reaches a device when it next connects; a device lost while offline loses its unsynced sales; a banner warns after 3 days unsynced). Currency display **both** everywhere. LBP rounding step 5,000, `max_discount_pct` 10, deduct at `ready`, negative stock allowed — all shop settings.
4. Printing: port the printing module from Dan's Hsarat POS / Hsarat Kids / academy systems (same printer hardware) — code to be shared at M3.
5. Import adapter for the pilot shop's current POS: optional, later.
6. `receipt` WhatsApp utility template on the Yorgo WABA. ✔
7. Status: M1 live 2026-11-07 (21_pos.sql applied) · M2 live 2026-11-07 (22_pos_m2.sql) · M3 built 2026-11-07 (printing = Hsarat browser-print approach, see SETUP.md). Restore point: branch `snapshot/pre-pos` + `suqa-db-snapshot-2026-11-07.json` (in Dan's `Suqa - General` folder).

---

## 8. Risks

* **iOS Safari storage eviction** (7-day rule for non-installed web apps): mitigated by "Add to Home Screen" prompt + `storage.persist()`; the outbox is also exported on revoke/wipe.
* **Thermal printing from a browser** is Chrome-only for USB/Bluetooth; iPad needs AirPrint or a LAN bridge — decided per device, not per shop.
* **Clock skew** on devices: ordering uses server sequence numbers, never client time; client time is display-only.
* **Existing store flow**: all schema changes are additive with defaults; the 36 existing tests + smoke SQL run before every deploy; the restore point exists (§9).

---

## 9. Restore procedure (snapshot taken 2026-11-07)

* **Code**: `git checkout snapshot/pre-pos` (commit `1389c09`) — or `git revert`/reset `main` to it and push; Netlify redeploys. Tag `v1.0-pre-pos` is created locally in the dev container (GitHub tag push is blocked from here — create it in the GitHub UI from the branch if you want it).
* **Database**: schema files through `20_fulfillment.sql` are the snapshot of structure. A full data dump (`pg_dump` of schema `suqa` + `auth`) is still to be taken — needs your Chrome session or the DB password (see chat). Until POS migrations start, nothing changes the DB, so the dump can be taken any time before M1.
* **Settings**: Netlify env vars and Supabase Auth/hook settings are listed in `docs/whatsapp-templates.md` and the session notes; none are touched by the POS work.
