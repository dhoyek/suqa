-- 108: the "stale items" report — items the shop still lists but has not sold for a long time.
--   shops.stale_days   an item is stale after this many days without a sale (default 60, 7..730), set by the owner in the shop settings
--   pos_report_stale   owner / stock: the shop's ACTIVE items, older than the window, with no sale inside it — when each was last sold
--                      (never = null), its stock and whether it is on the site. No cost, no amounts. A sale = a line that is not voided
--                      on an order that is not parked, cancelled or rejected (counter and online alike).
-- Safe to run twice.

alter table suqa.shops add column if not exists stale_days int not null default 60;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shops_stale_days_chk') then
    alter table suqa.shops add constraint shops_stale_days_chk check (stale_days between 7 and 730);
  end if;
end $$;

create index if not exists order_items_product_idx on suqa.order_items (product_id) where product_id is not null;

create or replace function suqa.pos_report_stale(p_shop uuid, p_days int default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_days int; v_cut timestamptz;
begin
  if coalesce(suqa.pos_role(p_shop), '') not in ('owner', 'stock') then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  select least(greatest(coalesce(p_days, stale_days), 7), 730) into v_days from suqa.shops where id = p_shop;
  v_cut := now() - make_interval(days => v_days);
  return (
    with last as (
      select i.product_id, max(o.placed_at) at
        from suqa.order_items i join suqa.orders o on o.id = i.order_id
       where o.shop_id = p_shop and i.product_id is not null and not i.voided and not o.parked and o.status not in ('cancelled', 'rejected')
       group by 1
    ), r as (
      select p.id, p.name, p.section, p.sku, p.created_at, l.at last_sold_at, p.track_stock, p.on_hand, p.visible_online, p.is_available,
             (p.visible_online and p.is_available and p.track_stock and coalesce(p.on_hand, 0) <= 0) listed_empty
        from suqa.products p left join last l on l.product_id = p.id
       where p.shop_id = p_shop and p.is_active and p.created_at < v_cut and (l.at is null or l.at < v_cut)
    )
    select jsonb_build_object('days', v_days, 'count', (select count(*) from r),
      'rows', (select coalesce(jsonb_agg(to_jsonb(y) order by y.listed_empty desc, y.last_sold_at asc nulls first, y.created_at asc), '[]')
                 from (select * from r order by listed_empty desc, last_sold_at asc nulls first, created_at asc limit 3000) y))
  );
end $function$;
revoke all on function suqa.pos_report_stale(uuid, int) from public, anon;
grant execute on function suqa.pos_report_stale(uuid, int) to authenticated;

-- the same settings function as 107, plus the key stale_days (clamped to 7..730)
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
    stale_days               = coalesce(least(greatest((p_patch->>'stale_days')::int, 7), 730), stale_days),
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
