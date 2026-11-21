-- 91_order_pay_cancel.sql — the owner cancels a payment recorded on an order; and a refund counts in the drawer it leaves.   (2026-11-21)
--
-- WHY: operations log step 2 (90) left the order payment out. A payment is counted in the drawer of the shift the order belongs
-- to, which may be closed and counted days ago; reversing it must not change that day, and the cash that moves now must move in
-- TODAY's drawer. The same was wrong for a return on an old sale: its refund was counted in the sale's old shift, not today's.
--
-- NOW:
--   * payments gets shift_id: the drawer (shift) a payment row is counted in WHEN IT IS NOT the order's own shift.
--     Empty = the order's shift, as before, so nothing changes for the rows that exist. The till's shift totals read it.
--   * A return's refund row now carries the shift that was open when the refund was given (it was sent by the till already and
--     ignored): the refund leaves today's drawer, the old day stays as it was closed. With no shift open: as before.
--   * pos_op_cancel also takes 'order.pay' — the shop's owner, online, with a reason, once (as in 90):
--       - what the payment left in its own shift is pinned there (its rows, and the change given back, written as rows);
--       - the opposite is written per way of paying — cash $, cash L.L., card, Whish — in today's open drawer, so the
--         order's payments add up to zero and the order shows "not paid" again (its status does not change);
--       - a debt (dayn) written by that payment is removed: it never touched a drawer;
--       - the order can then be paid again from the orders screen.
--     It is refused, with nothing changed, when: the order has cash collected by a driver (corrected in Drivers; if he
--     already settled, cancel the settlement first), a return was made on it, part of its debt was already collected (cancel
--     that collection first), other payments are still on it, or no shift is open while the payment was counted in one.
--
-- Table changes: suqa.payments + shift_id. The table is then:
--   create table suqa.payments (
--     id           uuid primary key,
--     order_id     uuid not null references suqa.orders(id) on delete cascade,
--     shop_id      uuid not null references suqa.shops(id) on delete cascade,
--     tenant_id    uuid not null,
--     tender       text not null check (tender in ('cash_usd','cash_lbp','card','wallet','unpaid','driver')),
--     amount       bigint not null,
--     currency     text not null check (currency in ('usd','lbp')),
--     reference    text,
--     unpaid_name  text,
--     unpaid_phone text,
--     note         text,
--     settled_at   timestamptz,
--     at           timestamptz not null default now(),
--     updated_at   timestamptz not null default now(),
--     shift_id     uuid references suqa.shifts(id) on delete set null     -- NEW: the drawer this row counts in, when not the order's own shift
--   );
-- Function changes: _pos_return (two lines, patched in place: the refund rows get shift_id), pos_op_cancel (the 'order.pay'
-- case added; the four cases of 90 are unchanged). New helper _shift_if_open. Idempotent.

alter table suqa.payments add column if not exists shift_id uuid references suqa.shifts(id) on delete set null;

-- the shift a till names, only if it is this shop's and still open (else nothing: the row follows its order, as before)
create or replace function suqa._shift_if_open(p_shop uuid, p_shift text) returns uuid
language sql stable security definer set search_path = public as $$
  select s.id from suqa.shifts s where s.id = nullif(p_shift, '')::uuid and s.shop_id = p_shop and s.closed_at is null
$$;
revoke all on function suqa._shift_if_open(uuid, text) from public, anon, authenticated;

-- _pos_return: the refund rows carry the shift the refund was given in. Patched in place (the function is long and live).
do $$
declare v_def text := pg_get_functiondef('suqa._pos_return(suqa.devices,jsonb,uuid)'::regprocedure);
        v_a text := 'insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note) values (';
        v_b text := $q$'refund ' || (p->>'id'));$q$;
begin
  if position('_shift_if_open' in v_def) > 0 then return; end if;                                 -- patched already
  if (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a) <> 2 or (length(v_def) - length(replace(v_def, v_b, ''))) / length(v_b) <> 2 then
    raise exception '_pos_return is not as expected: 91 not applied';
  end if;
  v_def := replace(v_def, v_a, 'insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note, shift_id) values (');
  v_def := replace(v_def, v_b, $q$'refund ' || (p->>'id'), suqa._shift_if_open(d.shop_id, p->>'shift_id'));$q$);
  execute v_def;
end $$;

create or replace function suqa.pos_op_cancel(p_shop uuid, p_audit_id bigint, p_shift uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a suqa.audit_log; v_id uuid; v_reason text := nullif(left(trim(coalesce(p_reason, '')), 200), ''); v_res jsonb := '{}'::jsonb;
        cm suqa.cash_moves; sm suqa.stock_moves; sp suqa.supplier_payments; dp suqa.driver_payouts;
        v_usd bigint; v_lbp bigint; v_n int := 0; v_m int := 0; v_shift_ok boolean; v_note text;
        o suqa.orders; v_ids uuid[]; v_s uuid;                                                   -- 91: order.pay
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if suqa.pos_role(p_shop) is distinct from 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  if v_reason is null then raise exception 'reason_required'; end if;
  select * into a from suqa.audit_log where id = p_audit_id and shop_id = p_shop;
  if not found then raise exception 'op_not_found'; end if;
  if a.action not in ('cash.move', 'stock.move', 'supplier.pay', 'driver.payout', 'order.pay') then raise exception 'not_cancellable'; end if;
  if a.after->'result'->>'status' = 'rejected' then raise exception 'op_failed'; end if;
  begin v_id := nullif(coalesce(a.after->>'id', a.ref_id), '')::uuid; exception when others then v_id := null; end;
  if v_id is null then raise exception 'op_not_found'; end if;
  if a.action = 'order.pay' then
    -- an order can be paid, cancelled and paid again: what is cancelled once is THIS payment (its first row), not the order
    select * into o from suqa.orders where id = v_id and shop_id = p_shop for update;
    if not found then raise exception 'op_not_found'; end if;
    begin select coalesce(array_agg((x->>'id')::uuid), '{}') into v_ids from jsonb_array_elements(coalesce(a.after->'payments', '[]'::jsonb)) x where nullif(x->>'id', '') is not null;
    exception when others then v_ids := '{}'; end;
    if cardinality(v_ids) = 0 then raise exception 'no_payments'; end if;                        -- a status-only step: nothing to cancel
    v_id := v_ids[1];
  end if;

  -- once: the first cancel takes this row; any other (a second tap, another till) finds it taken and changes nothing
  insert into suqa.op_cancels (shop_id, tenant_id, action, target_id, audit_id, reason, user_id)
  values (p_shop, a.tenant_id, a.action, v_id, a.id, v_reason, auth.uid())
  on conflict (shop_id, action, target_id) do nothing;
  if not found then return jsonb_build_object('ok', true, 'replayed', true); end if;

  v_shift_ok := p_shift is not null and exists (select 1 from suqa.shifts where id = p_shift and shop_id = p_shop and closed_at is null);
  v_note := left('إلغاء · ' || v_reason, 200);

  if a.action = 'cash.move' then
    select * into cm from suqa.cash_moves where id = v_id and shop_id = p_shop;
    if not found then raise exception 'op_not_found'; end if;
    if cm.source is null then raise exception 'cash_move_unmarked'; end if;                     -- recorded before 90: cannot tell what made it
    if cm.source <> 'manual' then raise exception 'cash_move_belongs_to_operation'; end if;     -- reversed with its own operation
    if not v_shift_ok then raise exception 'no_open_shift'; end if;
    insert into suqa.cash_moves (id, shift_id, shop_id, tenant_id, kind, amount, currency, reason, user_id, source, ref_id)
    values (gen_random_uuid(), p_shift, p_shop, cm.tenant_id, case cm.kind when 'in' then 'out' else 'in' end, cm.amount, cm.currency,
            left(v_note || coalesce(' · ' || cm.reason, ''), 200), auth.uid(), 'cancel', cm.id);
    v_res := jsonb_build_object('kind', case cm.kind when 'in' then 'out' else 'in' end, 'amount', cm.amount, 'currency', cm.currency);

  elsif a.action = 'stock.move' then
    select * into sm from suqa.stock_moves where id = v_id and shop_id = p_shop;
    if not found then raise exception 'op_not_found'; end if;
    insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_id, note, user_id)
    values (gen_random_uuid(), p_shop, sm.tenant_id, sm.product_id, -sm.qty, 'adjust', sm.id, v_note, auth.uid());
    v_res := jsonb_build_object('product_id', sm.product_id, 'qty', -sm.qty);

  elsif a.action = 'supplier.pay' then
    select * into sp from suqa.supplier_payments where id = v_id and shop_id = p_shop;
    if not found then raise exception 'op_not_found'; end if;
    if sp.from_drawer and sp.tender in ('cash_usd', 'cash_lbp') and not v_shift_ok then raise exception 'no_open_shift'; end if;
    -- the amount goes back on what the shop owes (same invoice link, so the invoice shows unpaid again by that much)
    insert into suqa.supplier_payments (id, shop_id, tenant_id, supplier_id, purchase_id, tender, currency, amount, amount_cents, rate, from_drawer, shift_id, note, user_id)
    values (gen_random_uuid(), p_shop, sp.tenant_id, sp.supplier_id, sp.purchase_id, 'adjust', sp.currency, -sp.amount, -sp.amount_cents, sp.rate, false, null, v_note, auth.uid());
    if sp.from_drawer and sp.tender in ('cash_usd', 'cash_lbp') then
      insert into suqa.cash_moves (id, shift_id, shop_id, tenant_id, kind, amount, currency, reason, user_id, source, ref_id)
      values (gen_random_uuid(), p_shift, p_shop, sp.tenant_id, case when sp.amount >= 0 then 'in' else 'out' end, abs(sp.amount), sp.currency, v_note, auth.uid(), 'cancel', sp.id);
      v_n := 1;
    end if;
    v_res := jsonb_build_object('supplier_id', sp.supplier_id, 'amount_cents', sp.amount_cents, 'drawer_moves', v_n);

  elsif a.action = 'driver.payout' then
    select * into dp from suqa.driver_payouts where id = v_id and shop_id = p_shop for update;
    if not found then raise exception 'op_not_found'; end if;
    -- what the settlement moved in the drawer, per currency: the cash he handed in minus his pay (in the currency it was paid in)
    v_usd := dp.cash_cents - case when dp.currency = 'usd' then dp.amount else 0 end;
    v_lbp := dp.cash_lbp   - case when dp.currency = 'lbp' then dp.amount else 0 end;
    if dp.from_drawer and (v_usd <> 0 or v_lbp <> 0) then
      if not v_shift_ok then raise exception 'no_open_shift'; end if;
      if v_usd <> 0 then
        insert into suqa.cash_moves (id, shift_id, shop_id, tenant_id, kind, amount, currency, reason, user_id, source, ref_id)
        values (gen_random_uuid(), p_shift, p_shop, dp.tenant_id, case when v_usd > 0 then 'out' else 'in' end, abs(v_usd), 'usd', v_note, auth.uid(), 'cancel', dp.id);
      end if;
      if v_lbp <> 0 then
        insert into suqa.cash_moves (id, shift_id, shop_id, tenant_id, kind, amount, currency, reason, user_id, source, ref_id)
        values (gen_random_uuid(), p_shift, p_shop, dp.tenant_id, case when v_lbp > 0 then 'out' else 'in' end, abs(v_lbp), 'lbp', v_note, auth.uid(), 'cancel', dp.id);
      end if;
    else v_usd := 0; v_lbp := 0;
    end if;
    update suqa.orders set driver_paid_at = null, driver_payout_id = null where shop_id = p_shop and driver_payout_id = dp.id;
    get diagnostics v_n = row_count;
    update suqa.payments set settled_at = null, reference = null where shop_id = p_shop and tender = 'driver' and reference = dp.id::text;
    get diagnostics v_m = row_count;
    delete from suqa.driver_payouts where id = dp.id;
    v_res := jsonb_build_object('driver_id', dp.driver_id, 'orders', v_n, 'cash_payments', v_m, 'drawer_usd_cents', -v_usd, 'drawer_lbp', -v_lbp);


  elsif a.action = 'order.pay' then
    if not exists (select 1 from suqa.payments where id = any(v_ids) and order_id = o.id) then raise exception 'op_not_found'; end if;
    if exists (select 1 from suqa.payments where order_id = o.id and tender = 'driver') then raise exception 'has_driver_cash'; end if;      -- the driver's cash is corrected in Drivers
    if exists (select 1 from suqa.returns where order_id = o.id) then raise exception 'has_return'; end if;
    if exists (select 1 from suqa.debt_allocations where order_id = o.id) then raise exception 'debt_collected'; end if;                 -- cancel the debt collection first
    if exists (select 1 from suqa.payments where order_id = o.id and not (id = any(v_ids)) group by tender, currency having sum(amount) <> 0) then raise exception 'other_payments'; end if;
    v_s := o.shift_id;                                                       -- the drawer this payment was counted in (null: no shift was open then)
    if v_s is not null and not v_shift_ok then raise exception 'no_open_shift'; end if;
    -- a debt written by this payment simply goes: it never touched a drawer
    delete from suqa.payments where id = any(v_ids) and order_id = o.id and tender = 'unpaid';
    get diagnostics v_m = row_count;
    -- what the payment left in its own shift stays there for good: its rows are pinned to that shift, and the change given
    -- back becomes rows of that shift too (so the order's change fields can go back to zero without moving that day's cash)
    update suqa.payments set shift_id = v_s where id = any(v_ids) and order_id = o.id and shift_id is null and v_s is not null;
    if coalesce(o.change_usd_cents, 0) > 0 then
      insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note, shift_id)
      values (gen_random_uuid(), o.id, p_shop, o.tenant_id, 'cash_usd', -o.change_usd_cents, 'usd', 'change', v_s);
    end if;
    if coalesce(o.change_lbp, 0) > 0 then
      insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note, shift_id)
      values (gen_random_uuid(), o.id, p_shop, o.tenant_id, 'cash_lbp', -o.change_lbp, 'lbp', 'change', v_s);
    end if;
    -- the opposite, per way of paying, in TODAY's drawer: afterwards the order's payments add up to zero
    insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, note, shift_id)
    select gen_random_uuid(), o.id, p_shop, o.tenant_id, q.tender, -q.total, q.currency, 'cancel ' || a.id, case when v_s is null then null else p_shift end
      from (select tender, currency, sum(amount) as total from suqa.payments where order_id = o.id group by tender, currency) q
     where q.total <> 0;
    get diagnostics v_n = row_count;
    update suqa.orders set paid_usd_cents = 0, paid_lbp = 0, change_usd_cents = 0, change_lbp = 0 where id = o.id;
    v_res := jsonb_build_object('order_id', o.id, 'number', coalesce(o.number, o.local_number), 'reversed', v_n, 'debts_removed', v_m);
  end if;

  update suqa.op_cancels set result = v_res where shop_id = p_shop and action = a.action and target_id = v_id;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (p_shop, a.tenant_id, auth.uid(), 'op.cancel', 'audit_log', v_id::text,
          jsonb_build_object('id', v_id, 'cancel_of', a.id, 'action', a.action, 'reason', v_reason, 'shift_id', p_shift, 'result', v_res || jsonb_build_object('ok', true)));
  return jsonb_build_object('ok', true, 'action', a.action, 'result', v_res);
end $$;
revoke all on function suqa.pos_op_cancel(uuid, bigint, uuid, text) from public, anon;
grant execute on function suqa.pos_op_cancel(uuid, bigint, uuid, text) to authenticated;

select 'order payment cancel installed' as result,
       position('_shift_if_open' in pg_get_functiondef('suqa._pos_return(suqa.devices,jsonb,uuid)'::regprocedure)) > 0 as refund_in_todays_drawer;
