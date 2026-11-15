-- 65_pos_order_merge.sql — merge two open orders of one customer; stock follows edits of phone / WhatsApp orders.   (2026-11-15)
-- 1. order.merge { id, from, map }: the lines of order `from` are added to order `id` (which keeps its number), the delivery fee
--    is charged once (the higher of the two), order discounts add up, notes are joined, and `from` is closed as cancelled with
--    "دُمج مع الطلب <number>" — never deleted, the customer is not messaged about that cancel. Allowed for any till user.
--    Refused unless: same shop; both pending / accepted / preparing; same customer (phone, or account); both delivery or both
--    pickup; `from` has no payment recorded (moving payments between orders is where money would be counted twice).
-- 2. FIX found on the way: order.edit on a phone / WhatsApp order did not move stock. Those orders take their stock when they
--    are typed in, but adding a line, changing a quantity or voiding a line afterwards left on-hand untouched (only cancelling
--    the whole order returned stock). Edits now write the matching stock move. Online orders are unchanged (reservations).
-- _pos_order_edit replaces 57 (base file 24 updated), pos_push replaces 60 (one new line). Requires 60, 62. Idempotent.

create or replace function suqa._order_line_stock(d suqa.devices, o suqa.orders, p_product uuid, p_delta numeric, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if o.channel not in ('whatsapp','phone') or p_product is null or coalesce(p_delta, 0) = 0 then return; end if;
  if not coalesce((select track_stock from suqa.products where id = p_product), false) then return; end if;
  -- more of it leaves the shelf = a sale move (negative); less = it comes back (positive). Cancelling the order later returns
  -- whatever the 'sale' and 'return' moves of the order still add up to, so the two stay consistent.
  insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, device_id, user_id, note)
  values (gen_random_uuid(), o.shop_id, o.tenant_id, p_product, -p_delta, case when p_delta > 0 then 'sale' else 'return' end, o.id, d.id, p_user, 'order edit');
end $$;

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
      else
        -- 65: phone / WhatsApp orders took their stock when they were typed in: follow the change
        perform suqa._order_line_stock(d, v_o, v_item.product_id, v_delta, p_user);
      end if;
    else
      -- substitution / added line (reservation for online orders comes from the order_items_reserve trigger)
      insert into suqa.order_items (id, order_id, tenant_id, shop_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes, price_currency, unit_price_cents, unit_price_lbp, discount_cents, line_total_cents)
      values (coalesce(nullif(v_l->>'new_id', '')::uuid, gen_random_uuid()), v_o.id, v_o.tenant_id, v_o.shop_id, nullif(v_l->>'product_id', '')::uuid, coalesce(v_l->'name', '{}'::jsonb), v_l->>'unit',
              coalesce((v_l->>'unit_price_cents')::numeric, 0) / 100, (v_l->>'qty')::numeric, coalesce((v_l->>'line_total_cents')::numeric, 0) / 100, v_l->>'notes',
              coalesce(v_l->>'price_currency', 'usd'), (v_l->>'unit_price_cents')::int, (v_l->>'unit_price_lbp')::bigint,
              greatest(0, coalesce((v_l->>'discount_cents')::int, 0)), (v_l->>'line_total_cents')::int);   -- 57: an added line keeps its discount
      perform suqa._order_line_stock(d, v_o, nullif(v_l->>'product_id', '')::uuid, (v_l->>'qty')::numeric, p_user);   -- 65 (no-op for online: the trigger reserves)
    end if;
  end loop;

  perform suqa._order_recalc(v_o.id);
  update suqa.orders set shop_notes = coalesce(nullif(p->>'note', ''), shop_notes) where id = v_o.id;
  select * into v_o from suqa.orders where id = v_o.id;
  if v_o.channel <> 'walkin' and coalesce((p->>'notify')::boolean, true) then perform suqa._notify_order(v_o, 'order.edited'); end if;
  return jsonb_build_object('total_cents', v_o.total_cents, 'total_lbp', v_o.total_lbp);
end $$;

create or replace function suqa._pos_order_merge(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_t suqa.orders; v_s suqa.orders; v_i suqa.order_items; v_no text; v_n int := 0;
begin
  if (p->>'id') = (p->>'from') then raise exception 'same_order'; end if;
  -- both rows locked, always in the same order, so two tills merging the same pair cannot cross
  perform 1 from suqa.orders where id in ((p->>'id')::uuid, (p->>'from')::uuid) and shop_id = d.shop_id order by id for update;
  select * into v_t from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'order_not_found'; end if;
  select * into v_s from suqa.orders where id = (p->>'from')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'order_not_found'; end if;
  if v_t.status not in ('pending','accepted','preparing') or v_s.status not in ('pending','accepted','preparing') or v_t.parked or v_s.parked then raise exception 'order_closed'; end if;
  if not ((suqa._phone_key(v_t.customer_phone) <> '' and suqa._phone_key(v_t.customer_phone) = suqa._phone_key(v_s.customer_phone))
          or (v_t.customer_id is not null and v_t.customer_id = v_s.customer_id)) then raise exception 'different_customer'; end if;
  if v_t.fulfillment is distinct from v_s.fulfillment then raise exception 'different_fulfillment'; end if;
  if exists (select 1 from suqa.payments where order_id = v_s.id) then raise exception 'source_has_payments'; end if;

  -- the lines are COPIED to the order that stays (ids chosen by the till, so its local copy matches), then the other order is
  -- cancelled through the normal status change: its stock comes back / its reservation is released exactly as for any cancel,
  -- and the copies take stock / reserve exactly as lines added by order.edit do. Nothing is counted twice.
  for v_i in select * from suqa.order_items where order_id = v_s.id and not voided order by id loop
    insert into suqa.order_items (id, order_id, tenant_id, shop_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes, price_currency, unit_price_cents, unit_price_lbp, discount_cents, line_total_cents, cost_cents)
    values (coalesce(nullif(p->'map'->>(v_i.id::text), '')::uuid, gen_random_uuid()), v_t.id, v_t.tenant_id, v_t.shop_id, v_i.product_id, v_i.name, v_i.unit, v_i.unit_price_usd, v_i.quantity, v_i.line_total_usd, v_i.notes,
            v_i.price_currency, v_i.unit_price_cents, v_i.unit_price_lbp, v_i.discount_cents, v_i.line_total_cents, v_i.cost_cents);
    perform suqa._order_line_stock(d, v_t, v_i.product_id, v_i.quantity, p_user);
    v_n := v_n + 1;
  end loop;

  update suqa.orders set
    delivery_fee_usd = greatest(coalesce(v_t.delivery_fee_usd, 0), coalesce(v_s.delivery_fee_usd, 0)),          -- one trip, one fee
    discount_cents   = coalesce(v_t.discount_cents, 0) + coalesce(v_s.discount_cents, 0),                     -- capped at the subtotal by the recalc
    shop_notes       = nullif(concat_ws(' · ', nullif(trim(v_t.shop_notes), ''), nullif(trim(v_s.shop_notes), ''), nullif(trim(v_s.customer_notes), '')), '')
  where id = v_t.id;
  perform suqa._order_recalc(v_t.id);

  v_no := coalesce(v_t.number, v_t.local_number, '');
  perform suqa._pos_order_status(d, jsonb_build_object('id', v_s.id, 'status', 'cancelled', 'cancel_reason', 'دُمج مع الطلب ' || v_no, 'notify_customer', false), p_user);

  select * into v_t from suqa.orders where id = v_t.id;
  if v_t.channel <> 'walkin' and v_t.notify_customer then perform suqa._notify_order(v_t, 'order.edited'); end if;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, device_id, action, ref_tbl, ref_id, after)
  values (d.shop_id, d.tenant_id, p_user, d.id, 'order.merged', 'orders', v_t.id::text, jsonb_build_object('from', v_s.id, 'from_number', coalesce(v_s.number, v_s.local_number), 'lines', v_n));
  return jsonb_build_object('total_cents', v_t.total_cents, 'total_lbp', v_t.total_lbp, 'lines', v_n);
end $$;

-- ---------- dispatcher (60 + order.merge) ------------------------------------------------------------------------------
create or replace function suqa.pos_push(p_device uuid, p_ops jsonb, p_pending int default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dev suqa.devices; v_role text; v_op jsonb; v_id uuid; v_kind text; v_res jsonb; v_out jsonb := '[]'::jsonb;
        v_user uuid := auth.uid(); v_admin boolean; v_detail text;
begin
  if v_user is null then raise exception 'not_signed_in' using errcode = 'insufficient_privilege'; end if;
  select * into v_dev from suqa.devices where id = p_device;
  if not found then raise exception 'device_not_found'; end if;
  if v_dev.revoked_at is not null then raise exception 'device_revoked'; end if;
  v_role := suqa.pos_role(v_dev.shop_id);
  if v_role is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;
  v_admin := suqa.is_platform_admin();
  perform set_config('suqa.device', p_device::text, true);
  if jsonb_typeof(p_ops) <> 'array' then raise exception 'bad_ops'; end if;

  for v_op in select * from jsonb_array_elements(p_ops) loop
    v_id := (v_op->>'op_id')::uuid; v_kind := v_op->>'kind';
    select result into v_res from suqa.pos_ops where op_id = v_id;
    if found then
      v_out := v_out || (v_res || jsonb_build_object('op_id', v_id, 'replayed', true));
      continue;
    end if;

    begin
      if v_role = 'stock' and v_kind not in ('stock.move','product.patch') then raise exception 'role_not_allowed' using errcode = 'insufficient_privilege'; end if;
      if v_role = 'cashier' and v_kind in ('rate.set','product.patch','stock.move','return.commit','order.delete','purchase.commit','purchase.void','supplier.pay','customer.merge','customer.delete','supplier.merge','supplier.delete','driver.delete','debt.unsettle') and coalesce((v_op->'payload'->>'approved_by'), '') = '' then
        raise exception 'owner_approval_required' using errcode = 'insufficient_privilege';
      end if;

      v_res := case v_kind
        when 'sale.commit'   then suqa._pos_sale_commit(v_dev, v_op->'payload', coalesce(nullif(v_op->'payload'->>'staff_user_id','')::uuid, v_user))
        when 'sale.cancel'   then suqa._pos_sale_cancel(v_dev, v_op->'payload', v_user)
        when 'order.status'  then suqa._pos_order_status(v_dev, v_op->'payload', v_user)
        when 'order.edit'    then suqa._pos_order_edit(v_dev, v_op->'payload', v_user)
        when 'order.merge'   then suqa._pos_order_merge(v_dev, v_op->'payload', v_user)
        when 'order.needed'  then suqa._pos_order_needed(v_dev, v_op->'payload', v_user)
        when 'driver.upsert' then suqa._pos_driver_upsert(v_dev, v_op->'payload', v_user)
        when 'driver.delete' then suqa._pos_driver_delete(v_dev, v_op->'payload', v_user)
        when 'order.pay'     then suqa._pos_order_pay(v_dev, v_op->'payload', v_user)
        when 'return.commit' then suqa._pos_return(v_dev, v_op->'payload', v_user)
        when 'stock.move'    then suqa._pos_stock_move(v_dev, v_op->'payload', v_user)
        when 'product.patch' then suqa._pos_product_patch(v_dev, v_op->'payload', v_user)
        when 'shift.open'    then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.open')
        when 'shift.close'   then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.close')
        when 'cash.move'     then suqa._pos_cash_move(v_dev, v_op->'payload', v_user)
        when 'debt.settle'   then suqa._pos_debt_settle(v_dev, v_op->'payload', v_user)
        when 'debt.unsettle' then suqa._pos_debt_unsettle(v_dev, v_op->'payload', v_user)
        when 'driver.payout' then suqa._pos_driver_payout(v_dev, v_op->'payload', v_user)
        when 'order.driver_pay' then suqa._pos_order_driver_pay(v_dev, v_op->'payload', v_user)
        when 'order.delete'  then suqa._pos_order_delete(v_dev, v_op->'payload', v_user)
        when 'customer.upsert' then suqa._pos_customer_upsert(v_dev, v_op->'payload', v_user)
        when 'supplier.upsert' then suqa._pos_supplier_upsert(v_dev, v_op->'payload', v_user)
        when 'purchase.commit' then suqa._pos_purchase_commit(v_dev, v_op->'payload', v_user)
        when 'purchase.void'   then suqa._pos_purchase_void(v_dev, v_op->'payload', v_user)
        when 'supplier.pay'    then suqa._pos_supplier_pay(v_dev, v_op->'payload', v_user)
        when 'customer.merge'  then suqa._pos_customer_merge(v_dev, v_op->'payload', v_user)
        when 'customer.delete' then suqa._pos_customer_delete(v_dev, v_op->'payload', v_user)
        when 'supplier.merge'  then suqa._pos_supplier_merge(v_dev, v_op->'payload', v_user)
        when 'supplier.delete' then suqa._pos_supplier_delete(v_dev, v_op->'payload', v_user)
        when 'rate.set'      then suqa._pos_rate_set(v_dev, v_op->'payload', v_user)
        else null end;
      if v_res is null then raise exception 'unknown_op' using detail = v_kind; end if;
      v_res := v_res || jsonb_build_object('status', 'ok');
    exception when others then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_res := jsonb_build_object('status', 'rejected', 'error', sqlerrm, 'code', sqlstate, 'detail', coalesce(v_detail, ''));
    end;

    insert into suqa.pos_ops (op_id, device_id, shop_id, kind, schema_version, result)
    values (v_id, p_device, v_dev.shop_id, v_kind, coalesce((v_op->>'schema_version')::int, 1), v_res);
    insert into suqa.audit_log (shop_id, tenant_id, user_id, device_id, action, ref_id, after, acting_as_admin)
    values (v_dev.shop_id, v_dev.tenant_id, v_user, p_device, v_kind, v_op->'payload'->>'id', v_op->'payload' || jsonb_build_object('result', v_res), v_admin);
    v_out := v_out || (v_res || jsonb_build_object('op_id', v_id));
  end loop;

  update suqa.devices set last_sync_at = now(), pending_count = greatest(p_pending, 0) where id = p_device;
  return jsonb_build_object('results', v_out, 'server_now', now());
end $$;

revoke all on function suqa._order_line_stock(suqa.devices, suqa.orders, uuid, numeric, uuid) from public, anon, authenticated;
revoke all on function suqa._pos_order_merge(suqa.devices, jsonb, uuid) from public, anon, authenticated;
revoke all on function suqa._pos_order_edit(suqa.devices, jsonb, uuid) from public, anon, authenticated;
revoke all on function suqa.pos_push(uuid, jsonb, int) from public, anon;
grant execute on function suqa.pos_push(uuid, jsonb, int) to authenticated;

select 'order.merge installed' as result;
