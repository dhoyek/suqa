-- 124: a signed-in account reads only the public card of a shop and of the association — like a visitor since 114.
--   Before: any signed-in customer could read every column of suqa.shops and suqa.tenants with his own session — the shop's
--   default margin, its highest discount, its commission, what it pays its drivers, its printer / scale setup and till settings.
--   Now `authenticated` may read the same columns as `anon` (114):
--     shops    id, tenant_id, slug, name, description, status, phone, whatsapp, address_text, location, logo_url, cover_url,
--              opening_hours, is_open_override, min_order_usd, prep_minutes, sort_order, created_at, updated_at, category_id,
--              pickup_enabled, pos_enabled, hide_online_when_zero, default_delivery_fee_usd, known_as, known_as_en, section_names
--     tenants  everything except commission_rate
--   Who still gets the private settings, and how:
--     · the shop's own till — through pos_bootstrap / pos_pull / pos_shop_settings, which check the caller's role in the shop (unchanged);
--     · the association's commission figures (its own, and the one it sets per shop) — through admin_commission(tenant, shop),
--       association members only. A shop's margin, discount limit, driver pay and till settings are NOT given to the association.
--   Writing is unchanged (the write grants and the row policies stay; the till's settings go through pos_shop_settings).
--   Checked before writing this: no row policy, view or caller-rights function reads any of the closed columns.
--   A column added to shops / tenants later is not readable by signed-in accounts until a script grants it.
--   The site must already name its columns (code of 2026-11-26): deploy the code BEFORE this script.
-- No table change. Safe to run twice. One transaction.

begin;

revoke select on table suqa.shops from authenticated;
grant select (id, tenant_id, slug, name, description, status, phone, whatsapp, address_text, location, logo_url, cover_url,
              opening_hours, is_open_override, min_order_usd, prep_minutes, sort_order, created_at, updated_at, category_id,
              pickup_enabled, pos_enabled, hide_online_when_zero, default_delivery_fee_usd, known_as, known_as_en, section_names)
  on table suqa.shops to authenticated;

revoke select on table suqa.tenants from authenticated;
grant select (id, slug, name, brand_name, status, default_locale, locales, display_currency, fx_lbp_rate, timezone, country_code,
              center, branding, settings, created_at, updated_at)
  on table suqa.tenants to authenticated;

create or replace function suqa.admin_commission(p_tenant uuid, p_shop uuid default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null or not suqa.is_tenant_member(p_tenant) then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  return jsonb_build_object(
    'tenant', (select commission_rate from suqa.tenants where id = p_tenant),
    'shop', (select commission_rate from suqa.shops where id = p_shop and tenant_id = p_tenant));
end $function$;
revoke all on function suqa.admin_commission(uuid, uuid) from public, anon;
grant execute on function suqa.admin_commission(uuid, uuid) to authenticated;

commit;

notify pgrst, 'reload schema';
