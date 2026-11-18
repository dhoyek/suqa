-- 80_pos_order_info.sql — edit an order's information from the POS   (2026-11-18)
-- Requires 71 (latest pos_push) and 24 (_order_recalc). Idempotent. No table changes.
--   order.info { id, customer_name, customer_phone, fulfillment, address, delivery_fee_cents, notes, needed_at, notify }
--     who the order is for, delivery or pickup, the address, the delivery fee, the note and the wanted time —
--     the same box the order was typed in with, opened on an order that already exists.
--   Rules
--     · any stage except rejected / cancelled (those are closed for good) and never a walk-in sale;
--     · a DELIVERED order keeps its amount and its driver: the money was already counted (payments, shift cash, driver pay),
--       so the delivery fee is not touched — name, phone, address, delivery/pickup, note and time can still be corrected;
--     · before delivery: delivery → pickup drops the fee, the zone and the driver; the total is recalculated (_order_recalc);
--       a driver who was already paid for it blocks the switch (driver_paid);
--     · the customer record / address book learns the corrected name and address; the customer is messaged ("order.edited")
--       only when the amount, delivery/pickup or the time changed, the order is still open and notify is not false.
--   The lines of the order are not touched here (that stays order.edit).

create or replace function suqa._pos_order_info(d suqa.devices, p jsonb, p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_o suqa.orders; v_n suqa.orders; v_ful text; v_fee numeric; v_closed boolean; v_phone text; v_addr jsonb; v_drop_driver boolean := false;
begin
  select * into v_o from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_o.status in ('rejected','cancelled') then raise exception 'order_closed'; end if;
  if v_o.channel = 'walkin' or coalesce(v_o.parked, false) then raise exception 'not_an_order'; end if;
  v_closed := v_o.status = 'delivered';

  v_ful   := case when p->>'fulfillment' in ('delivery','pickup') then p->>'fulfillment' else v_o.fulfillment end;
  v_phone := coalesce(nullif(trim(p->>'customer_phone'), ''), v_o.customer_phone);
  v_addr  := case when v_ful = 'pickup' then '{}'::jsonb
                  when p ? 'address' and jsonb_typeof(p->'address') = 'object' then p->'address'
                  else coalesce(v_o.address, '{}'::jsonb) end;

  -- the amount: fixed once delivered; no fee on a pickup; otherwise what the box says (never negative)
  v_fee := case when v_closed then coalesce(v_o.delivery_fee_usd, 0)
                when v_ful = 'pickup' then 0
                when (p->>'delivery_fee_cents') is not null then greatest(0, round((p->>'delivery_fee_cents')::numeric)) / 100
                else coalesce(v_o.delivery_fee_usd, 0) end;

  if not v_closed and v_ful = 'pickup' and v_o.driver_id is not null then
    if v_o.driver_paid_at is not null or v_o.driver_payout_id is not null then raise exception 'driver_paid'; end if;
    v_drop_driver := true;
  end if;

  update suqa.orders set
    customer_name  = case when p ? 'customer_name' then coalesce(trim(p->>'customer_name'), '') else customer_name end,
    customer_phone = v_phone,
    fulfillment    = v_ful,
    address        = v_addr,
    zone_id        = case when v_ful = 'pickup' then null else zone_id end,
    delivery_fee_usd = v_fee,
    customer_notes = case when p ? 'notes' then nullif(trim(p->>'notes'), '') else customer_notes end,
    needed_at      = case when p ? 'needed_at' then nullif(p->>'needed_at', '')::timestamptz else needed_at end,
    driver_id           = case when v_drop_driver then null else driver_id end,
    courier_name        = case when v_drop_driver then null else courier_name end,
    courier_fee_cents   = case when v_drop_driver then 0 else courier_fee_cents end,
    driver_ack_at       = case when v_drop_driver then null else driver_ack_at end,
    driver_picked_at    = case when v_drop_driver then null else driver_picked_at end,
    driver_delivered_at = case when v_drop_driver then null else driver_delivered_at end,
    updated_at = now()
  where id = v_o.id;

  -- totals move only when the fee moved (a name or address fix must not re-round the LBP total)
  if not v_closed and v_fee is distinct from coalesce(v_o.delivery_fee_usd, 0) then perform suqa._order_recalc(v_o.id); end if;
  select * into v_n from suqa.orders where id = v_o.id;

  -- the shop's customer list learns the correction (not counted as a new order)
  perform suqa._customer_touch(v_n.shop_id, v_n.tenant_id, v_n.customer_phone, v_n.customer_name,
                               case when v_n.fulfillment = 'delivery' and not coalesce((v_n.address->>'transient')::boolean, false) then v_n.address - 'transient' else null end,
                               v_n.customer_id, now(), false);

  if not v_closed and coalesce((p->>'notify')::boolean, true)
     and (v_n.total_usd is distinct from v_o.total_usd or v_n.fulfillment is distinct from v_o.fulfillment or v_n.needed_at is distinct from v_o.needed_at) then
    perform suqa._notify_order(v_n, 'order.edited');
  end if;

  return jsonb_build_object('total_cents', v_n.total_cents, 'total_lbp', v_n.total_lbp, 'fulfillment', v_n.fulfillment,
                            'delivery_fee_cents', round(coalesce(v_n.delivery_fee_usd, 0) * 100)::int, 'amount_locked', v_closed);
end $$;

-- ---------- pos_push (as on dev and prod today, + order.info) ---------------------------------------------------------
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
      if v_role = 'setup' and v_kind not in ('product.patch','rate.set') then raise exception 'role_not_allowed' using errcode = 'insufficient_privilege'; end if;
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
        when 'order.info'    then suqa._pos_order_info(v_dev, v_op->'payload', v_user)
        when 'driver.upsert' then suqa._pos_driver_upsert(v_dev, v_op->'payload', v_user)
        when 'driver.delete' then suqa._pos_driver_delete(v_dev, v_op->'payload', v_user)
        when 'order.pay'     then suqa._pos_order_pay(v_dev, v_op->'payload', v_user)
        when 'return.commit' then suqa._pos_return(v_dev, v_op->'payload', v_user)
        when 'stock.move'    then suqa._pos_stock_move(v_dev, v_op->'payload', v_user)
        when 'product.patch' then suqa._pos_product_patch(v_dev, case when v_role = 'setup' and v_op->'payload' ? 'fields' then jsonb_set(v_op->'payload', '{fields}', (v_op->'payload'->'fields') - 'cost_cents' - 'margin_pct' - 'supplier_id') else v_op->'payload' end, v_user)
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

revoke all on function suqa._pos_order_info(suqa.devices, jsonb, uuid) from public, anon, authenticated;
revoke all on function suqa.pos_push(uuid, jsonb, int) from public, anon;
grant execute on function suqa.pos_push(uuid, jsonb, int) to authenticated;

select 'order.info installed' as result;
