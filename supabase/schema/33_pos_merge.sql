-- 33_pos_merge.sql — customers & suppliers: inactive flag, merge duplicates, delete   (2026-11-08)
-- Requires 32. Idempotent. Base file 28 carries the shop_customers.active column.
--   customer.upsert   + { active }
--   customer.merge    { keep_id, drop_id }   orders / debt settlements of the dropped record move to the kept one, fields fill in, dropped row deleted
--   customer.delete   { id }                 only when the customer has no orders and no settlements; otherwise 'has_history' (set inactive instead)
--   supplier.merge    { keep_id, drop_id }   purchases / payments re-pointed (balance recomputed by trigger), dropped row deleted
--   supplier.delete   { id }                 only when the supplier has no purchases and no payments; otherwise 'has_history'
-- Cashier needs owner approval for merge / delete.

alter table suqa.shop_customers add column if not exists active boolean not null default true;

-- ---------- customer.upsert (31 + active) ---------------------------------------------------------------------
create or replace function suqa._pos_customer_upsert(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  v_id := suqa._customer_touch(d.shop_id, d.tenant_id, p->>'phone', p->>'name', null, null, now(), false);
  if v_id is null then raise exception 'bad_phone'; end if;
  update suqa.shop_customers set
    name = coalesce(nullif(trim(p->>'name'), ''), name),
    address = case when p ? 'address' then coalesce(p->'address', '{}'::jsonb) else address end,
    notes = case when p ? 'notes' then p->>'notes' else notes end,
    credit_limit_cents = case when p ? 'credit_limit_cents' then (p->>'credit_limit_cents')::int else credit_limit_cents end,
    discount_pct = case when p ? 'discount_pct' then coalesce((p->>'discount_pct')::numeric, 0) else discount_pct end,
    active = case when p ? 'active' then coalesce((p->>'active')::boolean, true) else active end
  where id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ---------- customer.merge -----------------------------------------------------------------------------------
create or replace function suqa._pos_customer_merge(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_keep suqa.shop_customers; v_drop suqa.shop_customers; v_moved int := 0;
begin
  select * into v_keep from suqa.shop_customers where id = (p->>'keep_id')::uuid and shop_id = d.shop_id;
  select * into v_drop from suqa.shop_customers where id = (p->>'drop_id')::uuid and shop_id = d.shop_id;
  if v_keep.id is null or v_drop.id is null then raise exception 'customer_not_found'; end if;
  if v_keep.id = v_drop.id then raise exception 'same_customer'; end if;

  -- history follows the kept number (orders carry the phone, not the customer id)
  update suqa.orders set customer_phone = v_keep.phone, customer_name = case when coalesce(trim(customer_name), '') = '' then v_keep.name else customer_name end,
                         customer_id = coalesce(customer_id, v_keep.user_id)
   where shop_id = d.shop_id and suqa._phone_key(customer_phone) = v_drop.phone_key;
  get diagnostics v_moved = row_count;
  update suqa.debt_settlements set phone = regexp_replace(v_keep.phone, '\D', '', 'g') where shop_id = d.shop_id and suqa._phone_key(phone) = v_drop.phone_key;

  -- fill the kept record's gaps from the dropped one, then recount
  update suqa.shop_customers k set
    name = case when coalesce(trim(k.name), '') = '' then v_drop.name else k.name end,
    address = case when k.address = '{}'::jsonb then v_drop.address else k.address end,
    notes = nullif(concat_ws(' · ', nullif(k.notes, ''), nullif(v_drop.notes, '')), ''),
    user_id = coalesce(k.user_id, v_drop.user_id),
    credit_limit_cents = coalesce(k.credit_limit_cents, v_drop.credit_limit_cents),
    discount_pct = greatest(coalesce(k.discount_pct, 0), coalesce(v_drop.discount_pct, 0)),
    orders_count = (select count(*) from suqa.orders o where o.shop_id = d.shop_id and not coalesce(o.parked, false) and suqa._phone_key(o.customer_phone) = k.phone_key),
    last_order_at = (select max(o.placed_at) from suqa.orders o where o.shop_id = d.shop_id and suqa._phone_key(o.customer_phone) = k.phone_key),
    active = true
  where k.id = v_keep.id;
  delete from suqa.shop_customers where id = v_drop.id;
  return jsonb_build_object('ok', true, 'keep_id', v_keep.id, 'moved_orders', v_moved);
end $$;

-- ---------- customer.delete ----------------------------------------------------------------------------------
create or replace function suqa._pos_customer_delete(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_c suqa.shop_customers;
begin
  select * into v_c from suqa.shop_customers where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if v_c.id is null then return jsonb_build_object('ok', true, 'already', true); end if;
  if exists (select 1 from suqa.orders o where o.shop_id = d.shop_id and suqa._phone_key(o.customer_phone) = v_c.phone_key)
     or exists (select 1 from suqa.debt_settlements s where s.shop_id = d.shop_id and suqa._phone_key(s.phone) = v_c.phone_key) then
    raise exception 'has_history' using errcode = 'check_violation';
  end if;
  delete from suqa.shop_customers where id = v_c.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- supplier.merge / supplier.delete -----------------------------------------------------------------
create or replace function suqa._pos_supplier_merge(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_keep suqa.suppliers; v_drop suqa.suppliers; v_moved int := 0;
begin
  select * into v_keep from suqa.suppliers where id = (p->>'keep_id')::uuid and shop_id = d.shop_id;
  select * into v_drop from suqa.suppliers where id = (p->>'drop_id')::uuid and shop_id = d.shop_id;
  if v_keep.id is null or v_drop.id is null then raise exception 'supplier_not_found'; end if;
  if v_keep.id = v_drop.id then raise exception 'same_supplier'; end if;
  update suqa.purchases set supplier_id = v_keep.id where shop_id = d.shop_id and supplier_id = v_drop.id;
  get diagnostics v_moved = row_count;
  update suqa.supplier_payments set supplier_id = v_keep.id where shop_id = d.shop_id and supplier_id = v_drop.id;
  update suqa.suppliers k set
    phone = coalesce(nullif(k.phone, ''), v_drop.phone), phone_key = coalesce(nullif(k.phone_key, ''), v_drop.phone_key),
    contact = coalesce(nullif(k.contact, ''), v_drop.contact),
    notes = nullif(concat_ws(' · ', nullif(k.notes, ''), nullif(v_drop.notes, '')), ''), active = true
  where k.id = v_keep.id;
  delete from suqa.suppliers where id = v_drop.id;
  perform suqa.supplier_recalc(v_keep.id);
  return jsonb_build_object('ok', true, 'keep_id', v_keep.id, 'moved_purchases', v_moved);
end $$;

create or replace function suqa._pos_supplier_delete(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p->>'id')::uuid;
begin
  if not exists (select 1 from suqa.suppliers where id = v_id and shop_id = d.shop_id) then return jsonb_build_object('ok', true, 'already', true); end if;
  if exists (select 1 from suqa.purchases where supplier_id = v_id) or exists (select 1 from suqa.supplier_payments where supplier_id = v_id) then
    raise exception 'has_history' using errcode = 'check_violation';
  end if;
  delete from suqa.suppliers where id = v_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- dispatcher (30 + merge/delete kinds) ---------------------------------------------------------------
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
      if v_role = 'cashier' and v_kind in ('rate.set','product.patch','stock.move','return.commit','order.delete','purchase.commit','purchase.void','supplier.pay','customer.merge','customer.delete','supplier.merge','supplier.delete') and coalesce((v_op->'payload'->>'approved_by'), '') = '' then
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
        when 'debt.settle'   then suqa._pos_debt_settle(v_dev, v_op->'payload', v_user)
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

select 'pos merge installed' as result;
