-- 59_supplier_balance_adjust.sql — owner's correction of a supplier balance ("تصحيح الرصيد").   (2026-11-12)
-- Until now the only way to fix a wrong balance (e.g. one that came over wrong from the old system) was a made-up payment or
-- invoice. A correction is stored as a supplier_payments row with tender = 'adjust':
--   * amount_cents = old balance − corrected balance (positive lowers what we owe, negative raises it); note = the reason (required)
--   * owner only (checked on the server), never from the drawer → no cash movement, nothing counted in a shift
--   * the balance trigger (30) already nets every supplier_payments row, so the balance follows by itself and the correction
--     shows in the supplier's statement with its reason; it syncs to the other tills like any payment
--   * reports: "paid to suppliers" no longer includes corrections (pos_report re-created with that one filter)
-- Also: an ordinary supplier payment must now be > 0 (it was unchecked).
-- Changes: the tender check on supplier_payments; _pos_supplier_pay; pos_report. Base file 30 carries the same text
-- (full table script there). Requires 30, 58 (re-applies the internal-function lockdown for the re-created helper). Idempotent.

alter table suqa.supplier_payments drop constraint if exists supplier_payments_tender_check;
alter table suqa.supplier_payments add constraint supplier_payments_tender_check
  check (tender in ('cash_usd','cash_lbp','card','wallet','transfer','adjust'));

create or replace function suqa._pos_supplier_pay(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from suqa.supplier_payments where id = (p->>'id')::uuid) then return jsonb_build_object('ok', true, 'replayed', true); end if;
  if not exists (select 1 from suqa.suppliers where id = (p->>'supplier_id')::uuid and shop_id = d.shop_id) then raise exception 'supplier_not_found'; end if;
  -- 59: balance correction ("تصحيح الرصيد") — owner only, a reason is required, never touches the drawer; amount_cents may be negative (raises what we owe)
  if p->>'tender' = 'adjust' then
    if suqa.pos_role(d.shop_id) is distinct from 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
    if coalesce(trim(p->>'note'), '') = '' then raise exception 'reason_required'; end if;
    if coalesce((p->>'from_drawer')::boolean, false) then raise exception 'adjust_not_cash'; end if;
  elsif (p->>'amount_cents')::bigint <= 0 then raise exception 'bad_amount';
  end if;
  insert into suqa.supplier_payments (id, shop_id, tenant_id, supplier_id, purchase_id, tender, currency, amount, amount_cents, rate, from_drawer, shift_id, note, user_id, device_id, at)
  values ((p->>'id')::uuid, d.shop_id, d.tenant_id, (p->>'supplier_id')::uuid, nullif(p->>'purchase_id', '')::uuid, p->>'tender', p->>'currency', (p->>'amount')::bigint,
          (p->>'amount_cents')::bigint, (p->>'rate')::int, coalesce((p->>'from_drawer')::boolean, false), nullif(p->>'shift_id', '')::uuid, p->>'note', p_user, d.id, coalesce((p->>'at')::timestamptz, now()));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function suqa._pos_supplier_pay(suqa.devices, jsonb, uuid) from public, anon, authenticated;

create or replace function suqa.pos_report(p_shop uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := (p_from::timestamp at time zone 'Asia/Beirut');
        v_to   timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Beirut');
        v_rate numeric;
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  select lbp_per_usd into v_rate from suqa.exchange_rates where shop_id = p_shop order by effective_at desc limit 1;
  v_rate := coalesce(v_rate, 89500);
  return (
    with o as (
      select * from suqa.orders
       where shop_id = p_shop and not parked and status not in ('cancelled','rejected')
         and placed_at >= v_from and placed_at < v_to
    ), li as (
      select i.* from suqa.order_items i join o on o.id = i.order_id where not i.voided
    ), r as (
      select * from suqa.returns where shop_id = p_shop and at >= v_from and at < v_to
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to, 'rate', v_rate,
      'totals', (select jsonb_build_object(
          'sales_count', count(*), 'total_cents', coalesce(sum(total_cents), 0),
          'items_count', (select coalesce(sum(quantity), 0) from li),
          'discount_cents', coalesce(sum(discount_cents), 0),
          'courier_fees_cents', coalesce(sum(courier_fee_cents), 0), 'delivery_fees_cents', coalesce(sum(round(delivery_fee_usd * 100)), 0),
          'cost_cents', (select coalesce(sum(round(coalesce(cost_cents, 0) * quantity)), 0) from li),
          'purchases_cents', (select coalesce(sum(case when kind = 'purchase' then total_cents else -total_cents end), 0) from suqa.purchases where shop_id = p_shop and status = 'posted' and at >= v_from and at < v_to),
          'supplier_paid_cents', (select coalesce(sum(amount_cents), 0) from suqa.supplier_payments where shop_id = p_shop and tender <> 'adjust' and at >= v_from and at < v_to),   -- 59: a balance correction is not money paid
          'suppliers_balance_cents', (select coalesce(sum(balance_cents), 0) from suqa.suppliers where shop_id = p_shop),
          'debt_collected_cents', (select coalesce(sum(amount_cents), 0) from suqa.debt_settlements where shop_id = p_shop and at >= v_from and at < v_to),
          'returns_count', (select count(*) from r),
          'returns_cents', (select coalesce(sum(refund_usd_cents + round(refund_lbp / v_rate * 100)), 0) from r))
        from o),
      'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'count', c, 'cents', s) order by d), '[]')
                   from (select (placed_at at time zone 'Asia/Beirut')::date d, count(*) c, sum(total_cents) s from o group by 1) x),
      'by_channel', (select coalesce(jsonb_object_agg(channel, jsonb_build_object('count', c, 'cents', s)), '{}')
                       from (select channel, count(*) c, sum(total_cents) s from o group by 1) x),
      'by_tender', (select coalesce(jsonb_object_agg(tender, jsonb_build_object('count', c, 'usd', u, 'lbp', l)), '{}')
                      from (select p.tender, count(*) c, sum(case when p.currency = 'usd' then p.amount else 0 end) u,
                                   sum(case when p.currency = 'lbp' then p.amount else 0 end) l
                              from suqa.payments p join o on o.id = p.order_id group by 1) x),
      'by_item', (select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name, 'qty', q, 'cents', s, 'cost_cents', c) order by s desc), '[]')
                    from (select product_id, min(name::text)::jsonb name, sum(quantity) q, sum(line_total_cents) s, sum(round(coalesce(cost_cents, 0) * quantity)) c
                            from li group by product_id order by s desc limit 100) x),
      'by_section', (select coalesce(jsonb_agg(jsonb_build_object('section', section, 'qty', q, 'cents', s) order by s desc), '[]')
                       from (select coalesce(p.section, '') section, sum(li.quantity) q, sum(li.line_total_cents) s
                               from li left join suqa.products p on p.id = li.product_id group by 1) x),
      'slow', (select coalesce(jsonb_agg(jsonb_build_object('product_id', p.id, 'name', p.name, 'on_hand', p.on_hand, 'cost_cents', p.cost_cents) order by p.on_hand desc), '[]')
                 from (select * from suqa.products where shop_id = p_shop and is_active and track_stock and on_hand > 0
                         and not exists (select 1 from li where li.product_id = products.id) order by on_hand desc limit 100) p),
      'stock', (select jsonb_build_object(
          'skus', count(*), 'units', coalesce(sum(on_hand), 0),
          'cost_cents', coalesce(sum(round(coalesce(cost_cents, 0) * on_hand)), 0),
          'retail_cents', coalesce(sum(round(case when price_currency = 'usd' then price_usd * 100 else price_lbp / v_rate * 100 end * on_hand)), 0),
          'low', (select count(*) from suqa.products where shop_id = p_shop and is_active and track_stock and on_hand <= min_stock))
        from suqa.products where shop_id = p_shop and is_active and track_stock),
      'unpaid', (select coalesce(jsonb_agg(jsonb_build_object('order_id', x.order_id, 'number', x.number, 'at', x.at, 'name', x.name, 'phone', x.phone, 'amount', x.outstanding, 'currency', 'usd') order by x.at desc), '[]')
                   from suqa.open_debts(p_shop) x),
      'shifts', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'opened_at', opened_at, 'closed_at', closed_at, 'device_id', device_id,
                          'expected_usd_cents', expected_usd_cents, 'counted_usd_cents', counted_usd_cents, 'diff_usd_cents', diff_usd_cents,
                          'expected_lbp', expected_lbp, 'counted_lbp', counted_lbp, 'diff_lbp', diff_lbp) order by opened_at desc), '[]')
                   from suqa.shifts where shop_id = p_shop and opened_at >= v_from and opened_at < v_to)
    )
  );
end $$;

select 'supplier balance correction installed' as result;
