-- 57_pos_order_edit_discount.sql — a line ADDED to an open order keeps its discount.   (2026-11-12)
-- "Add the cart to this order" (POS → customer dialog → open orders) now carries each cart line as it stands: its note, a changed
-- price and its line discount. order.edit already stored the note and the price of an added line but wrote discount_cents = 0,
-- so a later quantity change on that line recomputed its total without the discount. The only change is that one value;
-- everything else in the function is as in 24. Base file 24 carries the same text. Requires 24. Idempotent.

create or replace function suqa._pos_order_edit(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_o suqa.orders; v_l jsonb; v_item suqa.order_items; v_delta numeric; v_track boolean;
begin
  select * into v_o from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'order_not_found'; end if;
  if v_o.status in ('delivered','rejected','cancelled') then raise exception 'order_closed'; end if;

  for v_l in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    if (v_l->>'id') is not null then
      select * into v_item from suqa.order_items where id = (v_l->>'id')::uuid and order_id = v_o.id;
      if not found then continue; end if;
      if coalesce((v_l->>'voided')::boolean, false) and not v_item.voided then
        update suqa.order_items set voided = true, void_reason = v_l->>'void_reason' where id = v_item.id;
        v_delta := -v_item.quantity;
      elsif (v_l->>'qty') is not null and (v_l->>'qty')::numeric <> v_item.quantity then
        v_delta := (v_l->>'qty')::numeric - v_item.quantity;
        update suqa.order_items set quantity = (v_l->>'qty')::numeric,
          line_total_usd = round(unit_price_usd * (v_l->>'qty')::numeric, 2),
          line_total_cents = round(coalesce(unit_price_cents, round(unit_price_usd * 100)::int) * (v_l->>'qty')::numeric)::int - coalesce(discount_cents, 0)
        where id = v_item.id;
      else
        continue;
      end if;
      -- online orders hold a reservation: adjust it by the delta
      if v_o.channel = 'online' and v_item.product_id is not null then
        select track_stock into v_track from suqa.products where id = v_item.product_id;
        if coalesce(v_track, false) and v_delta <> 0 then
          insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, device_id, user_id)
          values (gen_random_uuid(), v_o.shop_id, v_o.tenant_id, v_item.product_id, v_delta, case when v_delta < 0 then 'release' else 'reserve' end, v_o.id, d.id, p_user);
        end if;
      end if;
    else
      -- substitution / added line (reservation for online orders comes from the order_items_reserve trigger)
      insert into suqa.order_items (id, order_id, tenant_id, shop_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes, price_currency, unit_price_cents, unit_price_lbp, discount_cents, line_total_cents)
      values (coalesce(nullif(v_l->>'new_id', '')::uuid, gen_random_uuid()), v_o.id, v_o.tenant_id, v_o.shop_id, nullif(v_l->>'product_id', '')::uuid, coalesce(v_l->'name', '{}'::jsonb), v_l->>'unit',
              coalesce((v_l->>'unit_price_cents')::numeric, 0) / 100, (v_l->>'qty')::numeric, coalesce((v_l->>'line_total_cents')::numeric, 0) / 100, v_l->>'notes',
              coalesce(v_l->>'price_currency', 'usd'), (v_l->>'unit_price_cents')::int, (v_l->>'unit_price_lbp')::bigint,
              greatest(0, coalesce((v_l->>'discount_cents')::int, 0)), (v_l->>'line_total_cents')::int);   -- 57: an added line keeps its discount
    end if;
  end loop;

  perform suqa._order_recalc(v_o.id);
  update suqa.orders set shop_notes = coalesce(nullif(p->>'note', ''), shop_notes) where id = v_o.id;
  select * into v_o from suqa.orders where id = v_o.id;
  if v_o.channel <> 'walkin' and coalesce((p->>'notify')::boolean, true) then perform suqa._notify_order(v_o, 'order.edited'); end if;
  return jsonb_build_object('total_cents', v_o.total_cents, 'total_lbp', v_o.total_lbp);
end $$;

select 'order.edit keeps added-line discount' as result;
