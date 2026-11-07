-- 27_pos_order_delete.sql — POS: delete cancelled / rejected orders (owner, or cashier with owner PIN)   (2026-11-07)
-- Requires 26. Idempotent. Only orders that are already cancelled or rejected can be deleted (stock was reversed on
-- cancel); orders with returns or debt collections cannot (FK restrict). Items, payments and the WhatsApp thread go
-- with it; stock_moves keep their rows with ref_order_id = null; the audit log keeps a copy of the order.
-- stock_moves stay append-only, except that the order reference may be detached (FK on delete set null) when a
-- cancelled order is deleted — quantities are untouched.
create or replace function suqa.stock_moves_apply() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_q numeric := case when tg_op = 'DELETE' then -old.qty else new.qty end;
        v_row suqa.stock_moves := case when tg_op = 'DELETE' then old else new end;
begin
  if tg_op = 'UPDATE' then
    if new.ref_order_id is null and old.ref_order_id is not null and (to_jsonb(new) - 'ref_order_id' - 'updated_at') = (to_jsonb(old) - 'ref_order_id' - 'updated_at') then return new; end if;
    raise exception 'stock_moves are append-only' using errcode = 'check_violation';
  end if;
  if v_row.kind in ('reserve','release') then
    update suqa.products set reserved = greatest(reserved + v_q, 0) where id = v_row.product_id;
  else
    update suqa.products set on_hand = on_hand + v_q,
                             needs_review = (on_hand + v_q < 0) or needs_review
     where id = v_row.product_id;
  end if;
  return v_row;
end $$;

create or replace function suqa._pos_order_delete(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_o suqa.orders;
begin
  select * into v_o from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if not found then return jsonb_build_object('ok', true, 'replayed', true); end if;
  if v_o.status not in ('cancelled','rejected') then raise exception 'cancel_first' using detail = v_o.status::text; end if;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, device_id, action, ref_tbl, ref_id, before)
  values (d.shop_id, d.tenant_id, p_user, d.id, 'order.deleted', 'orders', v_o.id::text,
          to_jsonb(v_o) || jsonb_build_object('items', (select coalesce(jsonb_agg(to_jsonb(i)), '[]') from suqa.order_items i where i.order_id = v_o.id)));
  delete from suqa.orders where id = v_o.id;
  return jsonb_build_object('ok', true);
end $$;
-- ---------- dispatcher (24_pos_m5 + debt.settle) ----------------------------------------------------------------
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
      if v_role = 'cashier' and v_kind in ('rate.set','product.patch','stock.move','return.commit','order.delete') and coalesce((v_op->'payload'->>'approved_by'), '') = '' then
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


select 'pos order.delete installed' as result;
