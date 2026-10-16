# Suqa database schema

Postgres on Supabase, everything in schema `suqa`. Files apply in numeric order; `build.sh`
concatenates them into `../all.sql` for one-shot application in the Supabase SQL editor
or `psql "$SUPABASE_DB_URL" -f supabase/all.sql`.

**Change rule:** a table is changed by re-issuing its *full* `CREATE TABLE` script in its file
(bump the header comment with the date), never by ad-hoc `ALTER`. For an already-deployed
database, generate the migration from the diff (`supabase db diff`) — the files here stay the
source of truth.

| File | Contents |
|---|---|
| 00_schema.sql | extensions, schema, grants |
| 01_enums.sql | all enum types |
| 02_tenants.sql | tenants, tenant_domains |
| 03_identity.sql | profiles, platform_admins, tenant_members |
| 04_catalog.sql | shops, shop_members, categories, products |
| 05_delivery.sql | delivery_zones, shop_delivery_zones, addresses |
| 06_orders.sql | orders, order_items, order_events |
| 07_functions.sql | helpers (auth/role checks), triggers, order numbering, state machine |
| 08_rls.sql | row-level security policies |
| ../seed/batroun.sql | first tenant |
