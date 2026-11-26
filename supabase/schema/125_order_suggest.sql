-- 125: "what should I order?" for the till (Stock screen and the assistant).
--   pos_order_suggest(shop, days default 14, cover default 7)   the shop's owner or stock keeper.
--     For each active item that tracks stock:
--       sold     = what left the shelf by sales in the last N days (1..90), net of customer returns and cancelled orders (stock moves)
--       free     = on_hand - reserved, never under zero (a shelf below zero is a counting problem, not something to buy back)
--       target   = the larger of: sold / N * cover days (1..60), and the item's own minimum
--       suggest  = target - free, rounded up (two decimals for items sold by weight); listed only when above zero
--     Up to 400 lines, the largest share of the target missing first, with the item's usual supplier (id and name) so the till groups
--     them. Names, quantities, unit, minimum, supplier only — NO cost, no price, no money. Nothing is ordered or written.
--   Index stock_moves(shop_id, at desc) for the window read.
-- Read only. No table change. Safe to run twice.

create index if not exists stock_moves_shop_at on suqa.stock_moves (shop_id, at desc);

create or replace function suqa.pos_order_suggest(p_shop uuid, p_days int default 14, p_cover int default 7)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_days int := least(greatest(coalesce(p_days, 14), 1), 90); v_cover int := least(greatest(coalesce(p_cover, 7), 1), 60);
begin
  if coalesce(suqa.pos_role(p_shop), '') not in ('owner', 'stock') then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  return (
    with s as (
      select product_id, greatest(-sum(qty), 0) sold
        from suqa.stock_moves
       where shop_id = p_shop and at >= now() - make_interval(days => v_days)
         and (kind = 'sale' or (kind = 'return' and ref_order_id is not null))
       group by 1
    ), p as (
      select p.id, p.name, p.unit, p.decimal_qty, p.on_hand, coalesce(p.reserved, 0) reserved, coalesce(p.min_stock, 0) min_stock, p.supplier_id,
             coalesce(s.sold, 0) sold, greatest(coalesce(p.on_hand, 0) - coalesce(p.reserved, 0), 0) free,
             greatest(coalesce(s.sold, 0) / v_days * v_cover, coalesce(p.min_stock, 0)) target
        from suqa.products p left join s on s.product_id = p.id
       where p.shop_id = p_shop and p.is_active and p.track_stock
    ), r as (
      select p.id, p.name, p.unit, p.on_hand, p.reserved, p.min_stock, p.sold, p.free,
             case when p.decimal_qty then ceil((p.target - p.free) * 100) / 100 else ceil(p.target - p.free) end suggest,
             p.supplier_id, sp.name supplier
        from p left join suqa.suppliers sp on sp.id = p.supplier_id and sp.shop_id = p_shop
       where p.target > 0 and p.target - p.free > 0
    )
    select jsonb_build_object('days', v_days, 'cover', v_cover, 'count', (select count(*) from r),
      'rows', (select coalesce(jsonb_agg(to_jsonb(y) order by y.supplier nulls last, (y.suggest / greatest(y.suggest + greatest(y.free, 0), 0.001)) desc, y.name->>'ar'), '[]')
                 from (select * from r order by (suggest / greatest(suggest + greatest(free, 0), 0.001)) desc, sold desc limit 400) y))
  );
end $function$;
revoke all on function suqa.pos_order_suggest(uuid, int, int) from public, anon;
grant execute on function suqa.pos_order_suggest(uuid, int, int) to authenticated;

notify pgrst, 'reload schema';
