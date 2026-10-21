# Suqa — Product Design

> Codename `suqa` (Syriac *šūqā*, market). The consumer brand is **configuration, not code**: each
> client (a merchants' association, a municipality, a mall) is a *tenant* with its own name, logo,
> colours, domain and app icon. Nothing user-facing ever says "suqa".

## 1. What Suqa is

A white-label **local shops ordering platform**: shoppers browse the shops of a town, order, and get
delivered. One codebase, one database, many towns. First tenant: **Jam3iyet Tejjar al Batroun**
(Batroun Merchants' Association), existing directory site gobatroun.com.

Product, not project — so every decision below is taken for *N* tenants, with Batroun as tenant #1.

## 2. Tenancy model (decision)

| Option | Isolation | Ops load for N towns | Cost | Verdict |
|---|---|---|---|---|
| One Supabase project per tenant | Hard | N projects, N migrations, N backups | N × plan | ✗ fine for 1–2, hostile to a product |
| **Shared project, `tenant_id` on every row, RLS** | Logical (Postgres RLS) | 1 project, 1 migration | 1 plan | **✓ chosen** |
| Schema per tenant | Medium | Migrations × N | 1 plan | ✗ Supabase tooling fights it |

Rules that follow:

- Every business table carries `tenant_id` (NOT NULL, FK → `suqa.tenants`). No exceptions.
- RLS is on for every table. Policies are the security boundary; the app layer only *filters*.
- **Tenant resolution**
  - Web: by hostname (`suqa.tenant_domains`): `batroun.suqa.app`, later `shop.gobatroun.com`.
  - Mobile: the tenant slug is baked into the build (`SUQA_TENANT_SLUG`) — one store listing per town.
  - Platform admin UI: no tenant; sees all, switches context.
- A tenant can be moved to its own project later by `COPY … WHERE tenant_id = …` — the schema never
  prevents it. We keep the option; we don't pay for it now.

## 3. Actors and roles

```
platform_admin  (Dan / Yorgoinc)      → everything, all tenants
tenant: admin | ops                   → the association: onboard shops, zones, fees, support
shop:   owner | staff                 → the merchant: products, availability, accept/deliver orders
customer                              → any signed-in user (phone OTP), scoped to a tenant on sign-up
courier                               → Phase 2 (reserved in enum, no tables yet)
```

A user is one `auth.users` row and may hold several memberships (a shop owner who is also a
customer; an association employee who also runs a shop).

## 4. Domain model

```
tenants ─┬─ tenant_domains
         ├─ tenant_members
         ├─ categories
         ├─ delivery_zones ──── shop_delivery_zones ──┐
         ├─ shops ──┬─ shop_members                   │
         │          ├─ products                       │
         │          └─ orders ──┬─ order_items        │
         │                      └─ order_events       │
         └─ profiles (per auth user)                  │
                └─ addresses ─────────────────────────┘
```

Key choices:

- **Multilingual text as JSONB** `{ "en": "…", "ar": "…", "fr": "…" }` on names/descriptions.
  Tenant sets `default_locale` and `locales`.
- **Money**: prices stored in **USD** (`numeric(12,2)`). Each tenant holds `fx_lbp_rate` and a
  `display_currency` rule (`usd`, `lbp`, `both`). Orders **snapshot** the rate and the item
  prices at checkout — a price change never rewrites history.
- **Snapshots over joins** on orders: `order_items` copy product name & price; `orders.address`
  copies the delivery address. Orders are immutable facts.
- **Order state machine** (`order_status`):
  `pending → accepted → preparing → ready → out_for_delivery → delivered`
  with `rejected` (by shop, from pending) and `cancelled` (by customer while pending, by tenant any
  time). Every transition is a row in `order_events`.
- **Delivery zones** are polygons (PostGIS) with a fee; a shop serves a subset of the tenant's
  zones. Checkout: address point → zone → fee. Outside all zones → not deliverable.
- **Commission** rate lives on the tenant (default) and optionally per shop (override). Phase 1
  only *records* `commission_usd` on each order; settlement runs are Phase 2.
- **Order number**: per-tenant human-readable sequence (`BAT-000123`), separate from the UUID.

## 5. Phases

| Phase | Scope | Exit gate |
|---|---|---|
| **1 — Batroun pilot** | PWA (Next.js) only. Customer storefront, shop portal, tenant admin. COD. Shops deliver themselves. AR/EN. WhatsApp notification to shop on new order. | 20+ shops live, 100 real orders, association runs support alone |
| **2 — Product** | Expo native apps (store presence), platform-admin console, settlements & commission reports, courier role, 2nd tenant onboarded in < 1 day | Second paying tenant |
| **3 — Growth** | Card payments (local gateway), promotions, ratings, analytics for merchants | Driven by tenant demand |

## 6. Stack

- **Supabase**: Postgres (schema `suqa`), Auth (phone OTP + email), Storage (product images, per
  tenant bucket prefix), Edge Functions (WhatsApp Cloud API webhooks), PostGIS.
- **Web**: Next.js (App Router), hosted on Netlify. One app, three role areas: `/` storefront,
  `/shop` merchant portal, `/admin` tenant admin. Middleware resolves the tenant from the host.
- **Mobile** (Phase 2): Expo, same `@suqa/shared` package, tenant from build env.
- **Shared**: `@suqa/shared` — DB types, tenant resolution, Supabase client factory, money &
  i18n helpers.

## 7. Non-goals (Phase 1)

Card payments · courier dispatch · inventory counts · multi-shop carts (one order = one shop) ·
customer ratings · loyalty.

## 8. Open decisions (to settle with the association)

1. Who physically onboards the first 20 shops and keeps catalogues fresh.
2. Delivery: strictly shop-delivers, or does the association contract a courier from day one?
3. Commission or flat fee to the association? (schema supports both; `0` is valid)
4. Relationship to gobatroun.com: link out, embed, or subdomain `shop.gobatroun.com`.
5. Apple/Google developer accounts — association's entity or Yorgoinc's (Phase 2).

## 9. Conventions

Repo `suqa` · packages `@suqa/*` · DB schema `suqa` · env prefix `SUQA_` · instances
`suqa-<slug>` · bundle id `com.yorgoinc.suqa.<slug>` · SQL changes = full table script re-issued
(see `supabase/schema/README.md`).

## Hardening notes (2026-10-17)

- **Two layers of authorisation.** RLS decides *who* may touch a row; `BEFORE UPDATE` guard triggers
  (`supabase/schema/11_hardening.sql`) decide *which columns* they may change. Orders are frozen snapshots
  (only `status`, `reject_reason`, `shop_notes`, `eta_minutes` move, customers only `status`); merchants
  cannot change their own `commission_rate`, `slug` or leave `pending`/`disabled`; association admins
  cannot change a tenant's `slug`/`status`; the last tenant admin cannot be removed.
- Guards apply only to end users (`anon`/`authenticated`) who are not platform admins. The SQL editor and
  the service role bypass them. **Platform admins bypass them too** — `dev-admin@suqa.dev` is one, so use
  a plain tenant admin when testing (see `supabase/test/hardening.sql`, which runs 19 negative tests).
- `place_order` raises stable snake_case errors (`min_order`, `outside_delivery_area`, `product_unavailable`,
  `too_many_open_orders` …) with the parameter in `DETAIL`; the web app translates them in
  `lib/ui-text.ts → friendlyError()`. Limits: ≤50 lines, qty ≤999, notes ≤500/200 chars, ≤5 open orders per customer.
- Web: `?next=` redirects are restricted to same-site paths; `x-suqa-host` is forwarded as a request header;
  unknown hostnames render a neutral page instead of crashing; `error.tsx`/`not-found.tsx`/`global-error.tsx`
  exist; security headers set in `netlify.toml`; dev deploys are `noindex`.

## Multi-shop baskets (2026-10-17)

- Tenant setting `settings.multi_shop_cart` turns on one cart across shops. The cart is grouped by shop with a
  checkbox per shop (AliExpress-style): the customer checks out the selected shops and the rest stay in the cart.
- One checkout → `suqa.place_basket()` → one `suqa.baskets` row + one `suqa.orders` row per shop
  (`BAT-000123-A`, `-B`, …, `orders.basket_id/basket_seq`). Each part has its own status/state machine; a shop
  only sees its own part. A rejected/cancelled part drops out of the basket total on the tracking page `/orders/b/<id>`.
- Delivery of baskets: `settings.delivery_mode` = `per_shop` (each shop delivers, one fee per shop — default) or
  `courier` (association delivers everything, one fee = `settings.courier_fee_usd`, else the highest zone fee among the parts;
  parts carry `delivery_fee_usd = 0`, the fee lives on the basket). A courier/driver app is a later phase.
- Single-shop checkouts keep using `suqa.place_order()` (no basket row). Both share `suqa._place_shop_order()`.
- The "max 5 open checkouts" limit counts a basket as one.

## Couriers (2026-10-17)

- `settings.courier_enabled` shows the driver app at `/courier` (and the Couriers section in admin → Members).
  Independent of `delivery_mode`: an association can run drivers for single-shop orders too.
- A courier is a row in `suqa.couriers`, **not** a tenant member — no access to finances, shops or other orders.
  RLS: couriers read orders in their tenant that are `ready`/`out_for_delivery` (or theirs), and may only set
  `courier_id = me` on an unassigned `ready` order and move it `ready → out_for_delivery → delivered`.
- `/courier`: "My deliveries" (out for delivery, by me) + "Ready for pickup"; basket parts grouped into one card
  (pick up from N shops → one address), call/navigate links, cash to collect; realtime + 20 s polling.
- Shops can still mark `delivered` themselves (pickup-at-shop / own delivery) — the courier flow is additive.
- Theming note: brand = `tenants.branding` → CSS variables per hostname. Extend with logo/favicon/derived palette
  when needed; no per-tenant layouts.

## Quality gates (2026-10-17)

- `npm test` runs Vitest over the pure logic (money, i18n, geo, opening hours, phone/WhatsApp links, redirect guard,
  error mapping). Netlify runs it before every build; GitHub Actions runs tests + build on every push/PR.
- Database rules are tested in SQL: `supabase/test/smoke.sql` (happy path) and `supabase/test/hardening.sql`
  (19 negative cases) — paste into the Supabase SQL editor of the dev project.
- Public storefront reads are server-cached (`apps/web/lib/public-data.ts`): home 60 s, shop menu 15 s.
  A merchant's availability toggle therefore reaches the public page within ~15 s.
- No native `alert()`/`confirm()` anywhere: use `useNotify()` / `useConfirm()` from `ConfirmProvider`.

## WhatsApp Cloud API (2026-10-19)
- Meta app **Suqa** (App ID 4004002429909677); test number for now, production number + payment later.
- Server helper `apps/web/lib/server/whatsapp.ts` (`waSendText`, `waSendTemplate`, `waVerifySignature`). Secrets in Netlify env only:
  `WHATSAPP_TOKEN` (system-user permanent token), `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `SUPABASE_SMS_HOOK_SECRET`.
- Webhook: `GET/POST /api/wa/webhook` — verify handshake + `X-Hub-Signature-256` check; subscribed to `messages` (statuses + replies). Phase 1 logs only.
- OTP login: Supabase Auth **Send SMS hook** → `POST /api/auth/sms-hook` (Standard Webhooks signature) → WhatsApp text with the code. Login page shows a WhatsApp tab when `NEXT_PUBLIC_WHATSAPP_LOGIN=1`.
- Admin → Settings has a "Send test" box (admins only) to verify the configuration.
- Production note: business-initiated messages (OTP to a new number, order alerts after 24h) need approved templates — authentication template for OTP, utility templates for order events. Plain text is fine for test recipients and inside a 24h customer window.
- Order notifications (2026-10-21): `supabase/schema/15_notifications.sql` — trigger `orders_notify` posts a self-contained payload via pg_net to `POST /api/wa/events` (header `x-suqa-secret` = Netlify `SUQA_EVENTS_SECRET`; URL + secret stored in `suqa.integration_config`, postgres-only). Endpoint sends: new order → shop WhatsApp; status → customer (accepted/preparing/ready/out_for_delivery/delivered/rejected); ready → active couriers when `courier_enabled` and `delivery_mode = courier`. Copy in `lib/server/wa-messages.ts` (= future template texts).

## Quick checkout (2026-10-21) — "order like you do on WhatsApp"
- Phone is a checkout field (prefilled from profile / default address; saved back to the profile on order). `place_order`/`place_basket` take `p_phone` (16_quick_checkout.sql, `_checkout_phone`).
- Address text is optional; the pin is required (fee/zone need it). Addresses are editable/deletable inline on the checkout screen.
- Merchant order card: 📍 address with map link + 💬 WhatsApp link to the customer. Phase B (next): free-text order line priced by the shop, "repeat last order", wa.me links in alerts. Phase C: shop replies from WhatsApp logged on the order (needs production number).
