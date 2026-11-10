-- 48_pos_driver_delete.sql — owner removes a driver from the shop (POS → Settings → Drivers).
--   driver.delete { id }  — deleted outright when no order ever used them; otherwise kept inactive (history stays readable,
--                           orders.driver_id keeps pointing at the row). Result says which happened.
-- Dispatcher (pos_push) re-created with the new kind. Requires 37.

create or replace function suqa._pos_driver_delete(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p->>'id')::uuid; v_used boolean;
begin
  if suqa.pos_role(d.shop_id) <> 'owner' and coalesce(p->>'approved_by', '') = '' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  if not exists (select 1 from suqa.shop_drivers where id = v_id and shop_id = d.shop_id) then raise exception 'driver_not_found'; end if;
  v_used := exists (select 1 from suqa.orders where shop_id = d.shop_id and driver_id = v_id);
  if v_used then
    update suqa.shop_drivers set active = false, available = false, updated_at = now() where id = v_id;
    return jsonb_build_object('id', v_id, 'deleted', false, 'deactivated', true);
  end if;
  delete from suqa.shop_drivers where id = v_id;
  return jsonb_build_object('id', v_id, 'deleted', true);
end $$;

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
      if v_role = 'cashier' and v_kind in ('rate.set','product.patch','stock.move','return.commit','order.delete','purchase.commit','purchase.void','supplier.pay','customer.merge','customer.delete','supplier.merge','supplier.delete','driver.delete') and coalesce((v_op->'payload'->>'approved_by'), '') = '' then
        raise exception 'owner_approval_required' using errcode = 'insufficient_privilege';
      end if;

      v_res := case v_kind
        when 'sale.commit'   then suqa._pos_sale_commit(v_dev, v_op->'payload', coalesce(nullif(v_op->'payload'->>'staff_user_id','')::uuid, v_user))
        when 'sale.cancel'   then suqa._pos_sale_cancel(v_dev, v_op->'payload', v_user)
        when 'order.status'  then suqa._pos_order_status(v_dev, v_op->'payload', v_user)
        when 'order.edit'    then suqa._pos_order_edit(v_dev, v_op->'payload', v_user)
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


select 'driver delete installed' as result;
