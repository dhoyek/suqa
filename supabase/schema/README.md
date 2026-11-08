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
| 09_realtime.sql | realtime publication (orders) |
| 10_admin.sql | admin RPCs (find user by email, people, stats) |
| 21_pos.sql | POS: devices, change feed (sync_log), idempotent ops (pos_push/pos_pull/pos_snapshot), stock ledger, payments, shifts, returns, PIN, RLS |
| 22_pos_m2.sql | POS M2: `sale.cancel` audit op (dispatcher re-created) |
| 23_pos_m4.sql | POS M4: `pos_import_products` (dry-run/commit), `pos_bulk_price`, `pos_bulk_visibility`, online stock guard |
| 24_pos_m5.sql | POS M5: order inbox ops `order.edit` / `order.pay` / `return.commit` (`_pos_order_edit`, `_pos_order_pay`, `_pos_return`), `order_event_payload` with channel + `order.edited` event, WA/phone reject/cancel reverses sale stock |
| 25_pos_m6.sql | POS M6: `staff_invites` + `pos_staff_invite` / `pos_staff_set` / `pos_staff_list` (add staff by WhatsApp number, claimed on first sign-in), `pos_my_shops` (admins open any POS-enabled shop), `pos_report` (period report), `pos_export` (per-shop export), COD settlement (`orders.courier_fee_cents`, `courier_name`) |
| 26_pos_m7.sql | POS M7 debt book: `debt_settlements` + `debt_allocations`, `order_debt_cents`, `open_debts`, op `debt.settle` (dispatcher re-created), snapshot keeps every order that carried a debt, report `unpaid` = open debts + `debt_collected_cents` |
| 27_pos_order_delete.sql | POS: `order.delete` op (`_pos_order_delete`, cancelled/rejected only, audit copy kept), dispatcher re-created, `stock_moves_apply` allows detaching the order reference |
| 28_pos_customers.sql | POS M8: `shop_customers` (synced; auto-filled from every order, `_phone_key` matching), op `customer.upsert`, `pos_shop_settings` (owner edits POS switches from the POS), `shops.default_delivery_fee_usd`; dispatcher + snapshot re-created |
| 29_pos_m9.sql | POS M9: `pos_delivery_fee(shop, lat, lng)` (zone fee for a pin), `wa_attach_location` (WhatsApp location replies pinned on customers + open delivery orders) |
| 30_pos_m10.sql | POS M10 purchases-lite: `suppliers` (balance by trigger), `purchases` + `purchase_lines`, `supplier_payments`, ops `supplier.upsert` / `purchase.commit` / `purchase.void` / `supplier.pay`, stock kinds `purchase` / `purchase_return`; dispatcher, snapshot, report re-created |
| ../seed/batroun.sql | first tenant |
