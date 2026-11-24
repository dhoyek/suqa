-- 107: two shop settings for returns from past sales.
--   return_days         how many days after a sale its items can still be returned at the till (default 7)
--   cashier_sales_days  how many days back a cashier sees the shop's sales on the sale screen (default 7)
-- Both 1..365, set by the owner in the shop settings (pos_shop_settings). The tills read them from the shop row they already sync.
-- Safe to run twice.

alter table suqa.shops add column if not exists return_days int not null default 7;
alter table suqa.shops add column if not exists cashier_sales_days int not null default 7;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shops_return_days_chk') then
    alter table suqa.shops add constraint shops_return_days_chk check (return_days between 1 and 365);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shops_cashier_sales_days_chk') then
    alter table suqa.shops add constraint shops_cashier_sales_days_chk check (cashier_sales_days between 1 and 365);
  end if;
end $$;

-- the same function as before, plus the two new keys (clamped to 1..365)
create or replace function suqa.pos_shop_settings(p_shop uuid, p_patch jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(suqa.pos_role(p_shop), '') not in ('owner', 'setup') then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  update suqa.shops set
    default_delivery_fee_usd = coalesce((p_patch->>'default_delivery_fee_usd')::numeric, default_delivery_fee_usd),
    max_discount_pct         = coalesce((p_patch->>'max_discount_pct')::numeric, max_discount_pct),
    lbp_rounding_step        = coalesce((p_patch->>'lbp_rounding_step')::int, lbp_rounding_step),
    allow_negative_stock     = coalesce((p_patch->>'allow_negative_stock')::boolean, allow_negative_stock),
    hide_online_when_zero    = coalesce((p_patch->>'hide_online_when_zero')::boolean, hide_online_when_zero),
    deduct_stock_at          = coalesce(p_patch->>'deduct_stock_at', deduct_stock_at),
    receipt_footer           = case when p_patch ? 'receipt_footer' then p_patch->>'receipt_footer' else receipt_footer end,
    offline_days             = coalesce(least(greatest((p_patch->>'offline_days')::int, 1), 90), offline_days),
    return_days              = coalesce(least(greatest((p_patch->>'return_days')::int, 1), 365), return_days),
    cashier_sales_days       = coalesce(least(greatest((p_patch->>'cashier_sales_days')::int, 1), 365), cashier_sales_days),
    default_margin_pct       = coalesce((p_patch->>'default_margin_pct')::numeric, default_margin_pct),
    scale_prefix             = case when p_patch ? 'scale_prefix' then nullif(p_patch->>'scale_prefix', '') else scale_prefix end,
    scale_code_len           = coalesce((p_patch->>'scale_code_len')::int, scale_code_len),
    scale_value_kind         = coalesce(p_patch->>'scale_value_kind', scale_value_kind),
    scale_value_divisor      = coalesce((p_patch->>'scale_value_divisor')::int, scale_value_divisor),
    scale_formats            = case when p_patch ? 'scale_formats' and jsonb_typeof(p_patch->'scale_formats') = 'array' then p_patch->'scale_formats' else scale_formats end,
    notify_stages            = case when p_patch ? 'notify_stages' then (select array_agg(x) from jsonb_array_elements_text(p_patch->'notify_stages') x) else notify_stages end
  where id = p_shop;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  select p_shop, tenant_id, auth.uid(), 'shop.settings', 'shops', p_shop::text, p_patch from suqa.shops where id = p_shop;
  return (select to_jsonb(s) - 'printer' from suqa.shops s where id = p_shop);
end $function$;
