-- 82: a lira-priced item is charged at its own lira price. One transaction on a database built from all.sql.
\set ON_ERROR_STOP on
begin;
\i supabase/schema/82_lbp_priced_items.sql
do $$
declare p suqa.products; fx numeric := 90000;
begin
  select * into p from suqa.products limit 1;
  p.price_currency := 'lbp'; p.price_lbp := 600000; p.price_usd := 6.70;       -- the till's dollars at 89,500
  assert suqa._unit_usd(p, fx) = 6.67, 'unit: ' || suqa._unit_usd(p, fx);
  assert round(suqa._line_usd(p, 1, fx) * fx, -3) = 600000, 'one: ' || suqa._line_usd(p, 1, fx);
  assert suqa._line_usd(p, 3, fx) = 20.00 and suqa._line_usd(p, 3, fx) * fx = 1800000, 'three: ' || suqa._line_usd(p, 3, fx);
  assert round(suqa._line_usd(p, 0.5, fx) * fx, -3) = 300000, 'half: ' || suqa._line_usd(p, 0.5, fx);
  p.price_lbp := 800000;  assert round(suqa._line_usd(p, 1, fx) * fx, -3) = 800000, '800k';
  p.price_lbp := 1200000; assert round(suqa._line_usd(p, 2, fx) * fx, -3) = 2400000, '2 × 1.2M';
  -- dollar-priced items and a missing rate: as before
  p.price_currency := 'usd'; assert suqa._line_usd(p, 3, fx) = 20.10 and suqa._unit_usd(p, fx) = 6.70, 'usd item unchanged';
  p.price_currency := 'lbp'; assert suqa._line_usd(p, 3, null) = 20.10 and suqa._line_usd(p, 3, 0) = 20.10, 'no rate → the stored dollars';
  p.price_lbp := 0; assert suqa._line_usd(p, 3, fx) = 20.10, 'no lira price → the stored dollars';
  assert (select count(*) from pg_proc where proname = '_place_shop_order' and prosrc like '%_line_usd%' and prosrc like '%_unit_usd%' and prosrc not like '%round(v_prod.price_usd * v_qty, 2)%') = 1, 'order function patched in both places';
  raise notice 'lira price: all checks passed';
end $$;
rollback;
