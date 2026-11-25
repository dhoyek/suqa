-- 114: a visitor (the public key, role anon) reads only the public card of a shop and of the association.
--   Before: every column of suqa.shops and suqa.tenants was readable with the public key — also the shop's commission, its
--   default margin, its highest discount, what it pays its drivers, its printer and scale setup and its till settings.
--   Now anon may read these columns only:
--     shops    id, tenant_id, slug, name, description, status, phone, whatsapp, address_text, location, logo_url, cover_url,
--              opening_hours, is_open_override, min_order_usd, prep_minutes, sort_order, created_at, updated_at, category_id,
--              pickup_enabled, pos_enabled, hide_online_when_zero, default_delivery_fee_usd, known_as, known_as_en, section_names
--     tenants  everything except commission_rate
--   Closed to anon on shops: commission_rate, default_margin_pct, max_discount_pct, driver_pay_mode, driver_pay_cents, printer,
--     scale_prefix, scale_code_len, scale_value_kind, scale_value_divisor, scale_formats, notify_stages, offline_days,
--     allow_negative_stock, lbp_rounding_step, deduct_stock_at, receipt_footer, return_days, cashier_sales_days, stale_days.
--   anon also loses the write grants on the two tables (no row policy ever let it write; now the grant is gone too).
--   NOT changed: signed-in accounts (role authenticated) read as before; the row policies; every function.
--   A column added to shops / tenants later is NOT public until a script grants it to anon.
--   The site must already name its columns (code of 2026-11-25): a `select *` with the public key is refused after this.
-- No table change. Safe to run twice. One transaction: if anything fails nothing is changed (the site never loses its read).

begin;

revoke all on table suqa.shops from anon;
grant select (id, tenant_id, slug, name, description, status, phone, whatsapp, address_text, location, logo_url, cover_url,
              opening_hours, is_open_override, min_order_usd, prep_minutes, sort_order, created_at, updated_at, category_id,
              pickup_enabled, pos_enabled, hide_online_when_zero, default_delivery_fee_usd, known_as, known_as_en, section_names)
  on table suqa.shops to anon;

revoke all on table suqa.tenants from anon;
grant select (id, slug, name, brand_name, status, default_locale, locales, display_currency, fx_lbp_rate, timezone, country_code,
              center, branding, settings, created_at, updated_at)
  on table suqa.tenants to anon;

commit;

notify pgrst, 'reload schema';
