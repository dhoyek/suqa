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
| 31_pos_m11.sql | POS M11: pack barcodes (`product_barcodes.pack_qty/pack_price_*`, patch handler accepts objects), customer `credit_limit_cents` / `discount_pct`, shop `default_margin_pct` + scale-barcode settings (`scale_prefix/code_len/value_kind/value_divisor`), settings + customer upsert re-created |
| 32_pos_notify.sql | Customer WhatsApp stages per shop: `shops.notify_stages text[]` (null = tenant default), `order_event_payload` carries shop/tenant stages (tenant default accepted/ready/out_for_delivery/rejected — no `delivered`), `pos_shop_settings` accepts `notify_stages` |
| 33_pos_merge.sql | Customers & suppliers: `shop_customers.active`, ops `customer.merge` / `customer.delete` / `supplier.merge` / `supplier.delete` (history re-pointed, delete only without history → `has_history`), dispatcher re-created |
| 34_pos_m12.sql | Scheduled orders `orders.needed_at` (sale.commit payload, op `order.needed`), customer address book `shop_customers.addresses` (`_addr_remember`, touch + upsert re-created), volume indexes on orders, `prune_sync_log(days)`, dispatcher re-created |
| 35_pos_staff_phone.sql | `pos_staff_phone(shop, user, phone)` — owner moves an employee's login to a new WhatsApp number (auth.users + profiles, refuses numbers in use) |
| 36_known_address.sql | `my_known_address(tenant)` — the signed-in customer's most recent address from the shops' address books, to prefill their first web checkout |
| 37_pos_drivers.sql | Shop drivers (drivers-lite): `shop_drivers` (synced, linked to an account by number), `orders.driver_id`, op `driver.upsert`, `order.status` carries `driver_id`, event payload `driver`; snapshot + dispatcher re-created |
| 38_migration.sql | Repeatable import from the old SQL Server POS: `migration_map` (old key → new id), `migrate_apply(shop, kind, rows, dry)` for product / customer / supplier / driver / order / purchase / settings, `migrate_status` — used by `/api/admin/migrate` + `migration/convert.py` |
| 39_pos_m14.sql | Pilot gaps: `products.supplier_id / margin_pct / next_expiry`, `shops.scale_formats` (extra scale-label formats); product.patch, shop settings and purchase.commit re-created (expiry + default supplier set on receiving). Apply before re-running 38. |
| 40_sync_quiet.sql | Sync-log storm fix: device heartbeat updates (last_sync_at/cursor/pending/app_version) no longer logged to the feed; `pos_pull` returns the shop's `devices` list with every page instead; historic heartbeat rows purged. |
| 41_access_requests.sql | `access_requests` table + `pos_request_targets` / `pos_request_access` (signed-in non-member asks a shop owner for POS access) and `pos_access_requests` / `pos_access_decide` (owner approves → shop_members, or rejects). |
| 42_migration_quiet.sql | Migrated sales history bypasses the device sync feed (`suqa.skip_sync_log`); purges the 430 already-fed receipts; re-numbers migrated receipts to `M-<RCPT_ID>`. Apply before re-running 38. |
| 43_accounts.sql | `tenant_accounts` (admin Accounts tab: every account that touched the tenant + roles), `pos_account_search` + `pos_staff_add_user` (owner adds staff by picking an existing account, linked by user id), `pos_driver_directory` (drivers used by other shops of the association). |
| 44_admin_accounts.sql | `admin_account_update(tenant, user, name, phone)` — association admin edits an account's name / number from Admin → Accounts (number must be free; nothing merged). |
| 45_account_admin.sql | Admin → Accounts as the one user-management place: `admin_account_block/_delete/_merge/_set_shop_role/_set_tenant_role`, `tenant_shops_brief`; `tenant_accounts` re-created with `blocked`/`deleted`. Delete = anonymise + block (history kept). |
| 46_account_ops.sql | Account ops: `admin_account_signout` (all sessions), `admin_account_reset_pin`, `admin_account_activity` (+ `admin_account_view_log`), `admin_account_invite` / `_invites` / `_invite_cancel` + `account_invites` table (tenant-level pre-registration, claimed on first sign-in), `tenant_accounts_export` (CSV). |
| 47_account_merge_fix.sql | Merge completes (`_account_delete_impl` without the membership check); kept account inherits the missing sign-in method (email identity + password, or phone) so the person can sign in either way; devices re-attributed. |
| 48_pos_driver_delete.sql | `driver.delete` op (`_pos_driver_delete`: hard delete if never used on an order, else deactivate); `pos_push` re-created. |
| ../seed/batroun.sql | first tenant |
