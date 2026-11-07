# Local schema test (verified 2026-10-16 on Postgres 16 + PostGIS 3)

Emulate Supabase, apply, seed, then run `smoke.sql` as the three actors:

```sql
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users(id uuid primary key default gen_random_uuid(), phone text, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
```
`psql -f supabase/all.sql && psql -f supabase/seed/batroun.sql && psql -f supabase/test/smoke.sql`

Expected: BAT-000001 placed (6.00 + 2.00 fee), outside-zone address rejected, customer cannot set
`delivered`, shop walks pending→accepted→preparing→ready→delivered, 5 order_events, anon sees
1 shop / 2 products / 0 orders / 0 addresses.

## POS (21_pos.sql)

`psql -f supabase/test/pos_smoke.sql` after `smoke.sql`. Expected: devices A and B registered; a sale pushed twice yields one
order (`BAT-000002`, second result `replayed: true`), 2 payments, on_hand 17; feed rows for device B; a cashier's pull has no
`cost_cents`; cashier `rate.set` → `owner_approval_required`; an online order reserves 2, deducts at `ready` (15/0) with
reserve/release/sale moves; `pos_pull` on the revoked device raises `device_revoked`. Local emulation needs a `net.http_post`
stub and a `storage` schema stub (see the session notes in docs/pos/PLAN.md §9).
