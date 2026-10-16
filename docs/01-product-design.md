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
