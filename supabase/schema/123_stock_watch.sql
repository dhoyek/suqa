-- 123: what the shop should look at in its stock, for the assistant in the till ("shou na2es?", "what expires this month?").
--   pos_stock_watch(shop, expiry_days default 30)   the shop's owner, stock keeper or cashier. Active items that track stock:
--       out       nothing left (on_hand <= 0)
--       low       at or under the item's own minimum (min_stock > 0 and 0 < on_hand <= min_stock)
--       expiring  the earliest known expiry is within N days (1..365) or already past, and there is stock
--     Up to 60 lines of each, the most urgent first, with the full counts. Names, quantities, unit, minimum, expiry date only —
--     NO cost, no price, no supplier, no sales. min_stock and next_expiry are not readable directly by signed-in accounts (71),
--     which is why this goes through a function that checks the caller's role in the shop.
-- Read only. No table change. Safe to run twice.

create or replace function suqa.pos_stock_watch(p_shop uuid, p_expiry_days int default 30)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_days int := least(greatest(coalesce(p_expiry_days, 30), 1), 365);
begin
  if coalesce(suqa.pos_role(p_shop), '') not in ('owner', 'stock', 'cashier') then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  return (
    with p as (
      select id, name, unit, on_hand, min_stock, next_expiry from suqa.products where shop_id = p_shop and is_active and track_stock
    ), o as (select * from p where on_hand <= 0),
       l as (select * from p where min_stock > 0 and on_hand > 0 and on_hand <= min_stock),
       e as (select * from p where next_expiry is not null and next_expiry <= current_date + v_days and on_hand > 0)
    select jsonb_build_object(
      'expiry_days', v_days,
      'counts', jsonb_build_object('out', (select count(*) from o), 'low', (select count(*) from l), 'expiring', (select count(*) from e)),
      'out', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'unit', unit, 'on_hand', on_hand) order by on_hand, name->>'ar'), '[]')
                from (select * from o order by on_hand, name->>'ar' limit 60) x),
      'low', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'unit', unit, 'on_hand', on_hand, 'min_stock', min_stock) order by on_hand / min_stock, name->>'ar'), '[]')
                from (select * from l order by on_hand / min_stock, name->>'ar' limit 60) x),
      'expiring', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'unit', unit, 'on_hand', on_hand, 'expiry', next_expiry, 'expired', next_expiry < current_date) order by next_expiry, name->>'ar'), '[]')
                from (select * from e order by next_expiry, name->>'ar' limit 60) x))
  );
end $function$;
revoke all on function suqa.pos_stock_watch(uuid, int) from public, anon;
grant execute on function suqa.pos_stock_watch(uuid, int) to authenticated;
