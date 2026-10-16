# suqa

White-label local-shops ordering platform. One codebase, one database, many towns.
First tenant: Batroun Merchants' Association (`suqa-batroun`).

Read `docs/01-product-design.md` first.

```
suqa/
├─ docs/                 product design & decisions
├─ supabase/
│  ├─ schema/            full table scripts, 00…08, source of truth
│  ├─ seed/batroun.sql   first tenant
│  └─ build.sh           → all.sql
├─ packages/shared/      @suqa/shared — types, tenant resolution, supabase client, money/i18n
├─ apps/web/             @suqa/web — Next.js (storefront /, merchant /shop, association /admin)
└─ apps/mobile/          @suqa/mobile — Expo shell (Phase 2)
```

## Setup

1. Create a Supabase project. In **Project Settings → API → Exposed schemas** add `suqa`.
   Enable **Phone** auth (OTP) and Email.
2. `npm run db:build` then run `supabase/all.sql`, then `supabase/seed/batroun.sql` in the SQL editor.
3. Dev data (dev project only): run `supabase/seed/dev.sql` — creates the dev accounts listed at the top of that file
   (password `Suqa-dev-2026!`), 5 demo shops, products and orders. `dev-admin@suqa.dev` is platform admin.
4. `cp .env.example apps/web/.env.local` and fill the Supabase URL + anon key.
5. `npm install` · `npm run web` → http://localhost:3000 resolves tenant `batroun` (seeded `localhost` domain).

## Conventions

Packages `@suqa/*` · DB schema `suqa` · env prefix `SUQA_` · instance `suqa-<slug>` ·
bundle id `com.yorgoinc.suqa.<slug>` · schema changes = re-issue the full table script.
