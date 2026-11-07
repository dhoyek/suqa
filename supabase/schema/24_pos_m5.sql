-- 24_pos_m5.sql — POS M5: order inbox actions, edits, handover payment, returns          (2026-11-07)
--   order.edit     remove / change qty / substitute lines of an open order (online: reservation adjusted); customer notified ('order.edited')
--   order.pay      payment taken at handover (pickup counter / COD) → payments rows, paid fields, status delivered
--   return.commit  full/partial return against a delivered order: returns + return_lines, stock back (or damaged), refund as a negative payment
--   order.status   rejecting/cancelling a POS-created (whatsapp/phone) order reverses its sale stock moves
--   order_event_payload ignores voided items

-- ---------- payload: skip voided lines ------------------------------------------------------------------
create or replace function suqa.order_event_payload(p_order suqa.orders, p_event text, p_old_status suqa.order_status)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'event',      p_event,
    'old_status', p_old_status,
    'phone_number_id', suqa.wa_sender_for_order(p_order.id),
    'channel', p_order.channel,
    'order', jsonb_build_object(
      'id', p_order.id, 'number', p_order.number, 'status', p_order.status, 'tenant_id', p_order.tenant_id,
      'basket_id', p_order.basket_id, 'basket_seq', p_order.basket_seq,
      'fulfillment', p_order.fulfillment, 'notify_customer', p_order.notify_customer,
      'customer_name', p_order.customer_name, 'customer_phone', p_order.customer_phone, 'customer_notes', p_order.customer_notes,
      'address', p_order.address, 'subtotal_usd', p_order.subtotal_usd, 'delivery_fee_usd', p_order.delivery_fee_usd,
      'total_usd', p_order.total_usd, 'fx_lbp_rate', p_order.fx_lbp_rate,
      'reject_reason', p_order.reject_reason, 'eta_minutes', p_order.eta_minutes, 'shop_notes', p_order.shop_notes,
      'courier_id', p_order.courier_id, 'placed_at', p_order.placed_at),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'unit', i.unit, 'quantity', i.quantity, 'line_total_usd', i.line_total_usd, 'notes', i.notes))
                         from suqa.order_items i where i.order_id = p_order.id and not i.voided), '[]'::jsonb),
    'shop', (select jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'whatsapp', s.whatsapp, 'phone', s.phone,
                                       'address', s.address_text, 'location', s.location)
               from suqa.shops s where s.id = p_order.shop_id),
    'tenant', (select jsonb_build_object('id', t.id, 'slug', t.slug, 'brand_name', t.brand_name, 'default_locale', t.default_locale,
                                         'display_currency', t.display_currency,
                                         'courier_enabled', coalesce((t.settings->>'courier_enabled')::boolean, false),
                                         'delivery_mode', coalesce(t.settings->>'delivery_mode', 'per_shop'),
                                         'notify_stages', coalesce(t.settings->'notify_stages', '["accepted","ready","out_for_delivery","delivered","rejected"]'::jsonb))
                 from suqa.tenants t where t.id = p_order.tenant_id),
    'courier_phone', (select p.phone from suqa.profiles p where p.id = p_order.courier_id),
    'couriers', coalesce((select jsonb_agg(p.phone) from suqa.couriers c join suqa.profiles p on p.id = c.user_id
                           where c.tenant_id = p_order.tenant_id and c.is_active and p.phone is not null), '[]'::jsonb)
  )
$$;

-- post an arbitrary order event to the web app (same channel as the triggers)
create or replace function suqa._notify_order(p_order suqa.orders, p_event text) returns void
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  select value into v_url from suqa.integration_config where key = 'wa_events_url';
  select value into v_secret from suqa.integration_config where key = 'wa_events_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := v_url, body := suqa.order_event_payload(p_order, p_event, null),
                        headers := jsonb_build_object('content-type', 'application/json', 'x-suqa-secret', v_secret), timeout_milliseconds := 8000);
end $$;

-- ---------- recompute an order's totals from its live lines ----------------------------------------------
create or replace function suqa._order_recalc(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_sub int; v_o suqa.orders;
begin
  select * into v_o from suqa.orders where id = p_order;
  select coalesce(sum(coalesce(line_total_cents, round(line_total_usd * 100)::int)), 0) into v_sub from suqa.order_items where order_id = p_order and not voided;
  update suqa.orders set
    subtotal_cents = v_sub, subtotal_usd = v_sub / 100.0,
    discount_cents = least(coalesce(discount_cents, 0), v_sub),
    total_cents = v_sub - least(coalesce(discount_cents, 0), v_sub) + round(coalesce(delivery_fee_usd, 0) * 100)::int,
    total_usd = (v_sub - least(coalesce(discount_cents, 0), v_sub)) / 100.0 + coalesce(delivery_fee_usd, 0),
    total_lbp = round(((v_sub - least(coalesce(discount_cents, 0), v_sub)) / 100.0 + coalesce(delivery_fee_usd, 0)) * coalesce(rate_lbp_per_usd, fx_lbp_rate::int)),
    commission_usd = round(((v_sub - least(coalesce(discount_cents, 0), v_sub)) / 100.0) * coalesce(commission_rate, 0), 2)
  where id = p_order;
end $$;

-- ---------- order.edit ----------------------------------------------------------------------------------------
-- payload: { id, lines: [ {id, qty?, voided?, void_reason?} | {product_id, name, unit, qty, price_currency, unit_price_cents, unit_price_lbp, line_total_cents} ], note }
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
              coalesce(v_l->>'price_currency', 'usd'), (v_l->>'unit_price_cents')::int, (v_l->>'unit_price_lbp')::bigint, 0, (v_l->>'line_total_cents')::int);
    end if;
  end loop;

  perform suqa._order_recalc(v_o.id);
  update suqa.orders set shop_notes = coalesce(nullif(p->>'note', ''), shop_notes) where id = v_o.id;
  select * into v_o from suqa.orders where id = v_o.id;
  if v_o.channel <> 'walkin' and coalesce((p->>'notify')::boolean, true) then perform suqa._notify_order(v_o, 'order.edited'); end if;
  return jsonb_build_object('total_cents', v_o.total_cents, 'total_lbp', v_o.total_lbp);
end $$;

-- ---------- order.pay (handover) ------------------------------------------------------------------------------
-- payload: { id, payments:[...], paid_usd_cents, paid_lbp, change_usd_cents, change_lbp, shift_id, status ('delivered' default) }
create or replace function suqa._pos_order_pay(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_o suqa.orders; v_l jsonb; v_status suqa.order_status;
begin
  select * into v_o from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'order_not_found'; end if;
  for v_l in select * from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) loop
    insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, reference, unpaid_name, unpaid_phone, note, at)
    values ((v_l->>'id')::uuid, v_o.id, d.shop_id, d.tenant_id, v_l->>'tender', (v_l->>'amount')::bigint, v_l->>'currency', v_l->>'reference', v_l->>'unpaid_name', v_l->>'unpaid_phone', v_l->>'note', coalesce((v_l->>'at')::timestamptz, now()))
    on conflict (id) do nothing;
  end loop;
  v_status := coalesce(p->>'status', 'delivered')::suqa.order_status;
  update suqa.orders set
    paid_usd_cents = coalesce((p->>'paid_usd_cents')::int, paid_usd_cents), paid_lbp = coalesce((p->>'paid_lbp')::bigint, paid_lbp),
    change_usd_cents = coalesce((p->>'change_usd_cents')::int, change_usd_cents), change_lbp = coalesce((p->>'change_lbp')::bigint, change_lbp),
    shift_id = coalesce(nullif(p->>'shift_id', '')::uuid, shift_id), device_id = coalesce(device_id, d.id), staff_user_id = coalesce(staff_user_id, p_user),
    status = case when status <> v_status and suqa.order_transition_allowed(status, v_status) then v_status else status end,
    delivered_at = case when v_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
    closed_at = case when v_status = 'delivered' then coalesce(closed_at, now()) else closed_at end
  where id = v_o.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- return.commit --------------------------------------------------------------------------------------
-- payload: { id, order_id, lines:[{id, order_item_id, product_id, qty, destination, amount_cents}], refund_usd_cents, refund_lbp, refund_tender, reason, approved_by, shift_id }
create or replace function suqa._pos_return(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_o suqa.orders; v_l jsonb; v_track boolean; v_n int;
begin
  select * into v_o from suqa.orders where id = (p->>'order_id')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'order_not_found'; end if;
  if exists (select 1 from suqa.returns where id = (p->>'id')::uuid) then return jsonb_build_object('ok', true, 'replayed', true); end if;
  select count(*) + 1 into v_n from suqa.returns where shop_id = d.shop_id;
  insert into suqa.returns (id, shop_id, tenant_id, order_id, number, device_id, user_id, approved_by, refund_usd_cents, refund_lbp, reason)
  values ((p->>'id')::uuid, d.shop_id, d.tenant_id, v_o.id, 'R-' || lpad(v_n::text, 5, '0'), d.id, p_user, nullif(p->>'approved_by', '')::uuid,
          coalesce((p->>'refund_usd_cents')::int, 0), coalesce((p->>'refund_lbp')::bigint, 0), p->>'reason');
  for v_l in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    insert into suqa.return_lines (id, return_id, shop_id, tenant_id, order_item_id, product_id, qty, destination, amount_cents)
    values ((v_l->>'id')::uuid, (p->>'id')::uuid, d.shop_id, d.tenant_id, nullif(v_l->>'order_item_id', '')::uuid, nullif(v_l->>'product_id', '')::uuid, (v_l->>'qty')::numeric, coalesce(v_l->>'destination', 'stock'), coalesce((v_l->>'amount_cents')::int, 0))
    on conflict (id) do nothing;
    if nullif(v_l->>'product_id', '') is not null then
      select track_stock into v_track from suqa.products where id = (v_l->>'product_id')::uuid;
      if coalesce(v_track, false) then
        insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, ref_id, device_id, user_id)
        values (gen_random_uuid(), d.shop_id, d.tenant_id, (v_l->>'product_id')::uuid, (v_l->>'qty')::numeric, 'return', v_o.id, (p->>'id')::uuid, d.id, p_user);
        if coalesce(v_l->>'destination', 'stock') = 'damaged' then
          insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, ref_id, device_id, user_id, note)
          values (gen_random_uuid(), d.shop_id, d.tenant_id, (v_l->>'product_id')::uuid, -(v_l->>'qty')::numeric, 'damaged', v_o.id, (p->>'id')::uuid, d.id, p_user, 'return');
        end if;
      end if;
    end if;
  end loop;
  -- refund leaves the drawer: negative payment row in the refund currency (shows in the shift's expected cash)
  if coalesce((p->>'refund_usd_cents')::int, 0) > 0 then
    insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note) values (gen_random_uuid(), v_o.id, d.shop_id, d.tenant_id, 'cash_usd', -(p->>'refund_usd_cents')::int, 'usd', 'refund ' || (p->>'id'));
  end if;
  if coalesce((p->>'refund_lbp')::bigint, 0) > 0 then
    insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note) values (gen_random_uuid(), v_o.id, d.shop_id, d.tenant_id, 'cash_lbp', -(p->>'refund_lbp')::bigint, 'lbp', 'refund ' || (p->>'id'));
  end if;
  return jsonb_build_object('ok', true, 'number', 'R-' || lpad(v_n::text, 5, '0'));
end $$;

-- ---------- order.status: reverse POS-created sales on reject/cancel ---------------------------------------------
create or replace function suqa._pos_order_status(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order suqa.orders; v_m record;
begin
  select * into v_order from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status::text = p->>'status' then return jsonb_build_object('status', v_order.status, 'noop', true); end if;
  update suqa.orders
     set status = (p->>'status')::suqa.order_status,
         reject_reason = coalesce(p->>'reject_reason', reject_reason),
         cancel_reason = coalesce(p->>'cancel_reason', cancel_reason),
         shop_notes = coalesce(p->>'shop_notes', shop_notes),
         notify_customer = coalesce((p->>'notify_customer')::boolean, notify_customer),
         eta_minutes = coalesce((p->>'eta_minutes')::int, eta_minutes)
   where id = v_order.id;
  if v_order.channel in ('whatsapp','phone') and (p->>'status') in ('rejected','cancelled') then
    for v_m in select product_id, sum(qty) q from suqa.stock_moves where ref_order_id = v_order.id and kind in ('sale','return') group by product_id having sum(qty) < 0 loop
      insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, device_id, user_id, note)
      values (gen_random_uuid(), v_order.shop_id, v_order.tenant_id, v_m.product_id, -v_m.q, 'return', v_order.id, d.id, p_user, 'cancelled');
    end loop;
  end if;
  return jsonb_build_object('status', p->>'status');
end $$;

-- ---------- dispatcher --------------------------------------------------------------------------------------------
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
      if v_role = 'cashier' and v_kind in ('rate.set','product.patch','stock.move','return.commit') and coalesce((v_op->'payload'->>'approved_by'), '') = '' then
        raise exception 'owner_approval_required' using errcode = 'insufficient_privilege';
      end if;

      v_res := case v_kind
        when 'sale.commit'   then suqa._pos_sale_commit(v_dev, v_op->'payload', coalesce(nullif(v_op->'payload'->>'staff_user_id','')::uuid, v_user))
        when 'sale.cancel'   then suqa._pos_sale_cancel(v_dev, v_op->'payload', v_user)
        when 'order.status'  then suqa._pos_order_status(v_dev, v_op->'payload', v_user)
        when 'order.edit'    then suqa._pos_order_edit(v_dev, v_op->'payload', v_user)
        when 'order.pay'     then suqa._pos_order_pay(v_dev, v_op->'payload', v_user)
        when 'return.commit' then suqa._pos_return(v_dev, v_op->'payload', v_user)
        when 'stock.move'    then suqa._pos_stock_move(v_dev, v_op->'payload', v_user)
        when 'product.patch' then suqa._pos_product_patch(v_dev, v_op->'payload', v_user)
        when 'shift.open'    then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.open')
        when 'shift.close'   then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.close')
        when 'cash.move'     then suqa._pos_cash_move(v_dev, v_op->'payload', v_user)
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

select 'pos m5 installed' as result;
