-- 119: purchase invoices — a discount and a note on each line, and a discount in percent on the whole invoice.
--   purchase_lines.discount       this line's own discount, an AMOUNT in the invoice currency (null = none)
--   purchase_lines.discount_pct   the percent it was typed as (null when typed as an amount)
--   purchase_lines.note           a note on the line
--   purchases.discount_pct        the invoice discount as typed in percent (purchases.discount stays the amount)
--   Meaning of the existing columns, unchanged for invoices without line discounts:
--     unit_cost         the supplier's price for one unit, before the line's discount
--     unit_cost_cents   what one unit really cost, after the line's discount — this is what becomes the item's cost and the stock move's cost
--     line_total_cents  the line after its discount
--   _pos_purchase_commit: the same function as before (39) + it stores the four new values. Stock, cost, price, expiry, supplier
--   balance and the invoice number are computed exactly as before; the till sends the amounts, the server stores them.
--   The tills receive the new columns with the rows they already sync. Safe to run twice.

alter table suqa.purchase_lines add column if not exists discount numeric(14,2);
alter table suqa.purchase_lines add column if not exists discount_pct numeric(6,3);
alter table suqa.purchase_lines add column if not exists note text;
alter table suqa.purchases add column if not exists discount_pct numeric(6,3);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_lines_discount_chk') then
    alter table suqa.purchase_lines add constraint purchase_lines_discount_chk check ((discount is null or discount >= 0) and (discount_pct is null or discount_pct between 0 and 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchases_discount_pct_chk') then
    alter table suqa.purchases add constraint purchases_discount_pct_chk check (discount_pct is null or discount_pct between 0 and 100);
  end if;
end $$;

create or replace function suqa._pos_purchase_commit(d suqa.devices, p jsonb, p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_l jsonb; v_n int; v_kind text := coalesce(p->>'kind', 'purchase'); v_number text; v_prod suqa.products; v_i int := 0;
begin
  if exists (select 1 from suqa.purchases where id = (p->>'id')::uuid) then return jsonb_build_object('ok', true, 'replayed', true); end if;
  if not exists (select 1 from suqa.suppliers where id = (p->>'supplier_id')::uuid and shop_id = d.shop_id) then raise exception 'supplier_not_found'; end if;
  select count(*) + 1 into v_n from suqa.purchases where shop_id = d.shop_id and kind = v_kind;
  v_number := case when v_kind = 'return' then 'PR-' else 'P-' end || lpad(v_n::text, 5, '0');
  insert into suqa.purchases (id, shop_id, tenant_id, supplier_id, number, kind, invoice_no, invoice_date, currency, rate, subtotal, discount, discount_pct, total, total_cents, note, user_id, approved_by, device_id, at)
  values ((p->>'id')::uuid, d.shop_id, d.tenant_id, (p->>'supplier_id')::uuid, v_number, v_kind, p->>'invoice_no', coalesce((p->>'invoice_date')::date, current_date),
          p->>'currency', (p->>'rate')::int, coalesce((p->>'subtotal')::numeric, 0), coalesce((p->>'discount')::numeric, 0), (p->>'discount_pct')::numeric, coalesce((p->>'total')::numeric, 0),
          coalesce((p->>'total_cents')::bigint, 0), p->>'note', p_user, nullif(p->>'approved_by', '')::uuid, d.id, coalesce((p->>'at')::timestamptz, now()));
  for v_l in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    v_i := v_i + 1;
    select * into v_prod from suqa.products where id = (v_l->>'product_id')::uuid and shop_id = d.shop_id;
    if not found then raise exception 'product_not_found' using detail = v_l->>'product_id'; end if;
    insert into suqa.purchase_lines (id, purchase_id, shop_id, tenant_id, product_id, name, qty, unit_cost, unit_cost_cents, line_total_cents, new_price_usd, new_price_lbp, expiry, discount, discount_pct, note, sort)
    values ((v_l->>'id')::uuid, (p->>'id')::uuid, d.shop_id, d.tenant_id, v_prod.id, v_prod.name, (v_l->>'qty')::numeric, coalesce((v_l->>'unit_cost')::numeric, 0),
            coalesce((v_l->>'unit_cost_cents')::int, 0), coalesce((v_l->>'line_total_cents')::bigint, 0), (v_l->>'new_price_usd')::numeric, (v_l->>'new_price_lbp')::bigint, (v_l->>'expiry')::date,
            nullif((v_l->>'discount')::numeric, 0), (v_l->>'discount_pct')::numeric, nullif(trim(v_l->>'note'), ''), v_i)
    on conflict (id) do nothing;
    -- stock in (or out for a return) at cost; cost and optional new price on the product
    insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_id, unit_cost_cents, note, device_id, user_id, at)
    values (gen_random_uuid(), d.shop_id, d.tenant_id, v_prod.id, case when v_kind = 'return' then -abs((v_l->>'qty')::numeric) else (v_l->>'qty')::numeric end,
            case when v_kind = 'return' then 'purchase_return' else 'purchase' end, (p->>'id')::uuid, coalesce((v_l->>'unit_cost_cents')::int, 0), v_number, d.id, p_user, coalesce((p->>'at')::timestamptz, now()));
    if v_kind = 'purchase' then
      update suqa.products set
        cost_cents = coalesce((v_l->>'unit_cost_cents')::int, cost_cents),
        price_usd = case when (v_l->>'new_price_usd') is not null then (v_l->>'new_price_usd')::numeric else price_usd end,
        price_lbp = case when (v_l->>'new_price_lbp') is not null then (v_l->>'new_price_lbp')::bigint else price_lbp end,
        -- 39: expiry tracking + default supplier (earliest known expiry wins; first supplier we buy from becomes the default)
        next_expiry = case when nullif(v_l->>'expiry', '') is not null then least(coalesce(next_expiry, (v_l->>'expiry')::date), (v_l->>'expiry')::date) else next_expiry end,
        supplier_id = coalesce(supplier_id, (p->>'supplier_id')::uuid)
      where id = v_prod.id;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'number', v_number);
end $function$;
