-- 90_op_cancel.sql — operations log, step 2: the owner cancels a cash in / out, a stock change, a supplier payment and a
-- driver settlement.   (2026-11-21)
--
-- WHY: step 1 (Reports → operations log) cancels what already had a safe reversal: a cash sale, a purchase, a debt collection.
-- These four had none. Cancelling an order's payment is NOT in this script (it touches a closed shift's sales; its own script).
--
-- HOW (the same for all four):
--   * suqa.pos_op_cancel(shop, operation, open shift, reason) — the shop's OWNER only, online, with a reason.
--     Nothing is deleted or edited in the past: the cancel WRITES THE OPPOSITE entry now, so reports of closed days stay as
--     they were, and any cash that moves, moves in TODAY's open drawer (the shift passed in; refused without an open shift).
--   * Once only: suqa.op_cancels holds one row per cancelled operation (unique). A second cancel, from any till, changes nothing.
--   * The cancel is itself logged (audit_log action 'op.cancel', linked to the original), so the log shows who, when and why.
--
--   What each cancel writes:
--     cash in / out       the opposite drawer move in today's shift. ONLY a move the cashier made by hand: a move that belongs
--                         to another operation (a debt collection, a supplier payment, a driver settlement, a delivery fee) is
--                         reversed with that operation, never by itself — otherwise the drawer would be counted twice.
--     stock change        the opposite stock move (the quantity comes back / leaves again). A cost entered with it is not restored.
--     supplier payment    a correction that puts the amount back on what the shop owes that supplier; if it was paid in cash
--                         from the drawer, the same cash comes back into today's drawer.
--     driver settlement   his deliveries are "pay not settled" again and the cash he handed in is "with the driver" again; if
--                         the settlement moved the drawer, the opposite moves in today's drawer (per currency). The settlement
--                         row is removed (it stays in the audit log).
--
--   To tell a hand-made drawer move from one that belongs to another operation, cash_moves gets two columns (below). Moves
--   recorded before this script have no mark: they cannot be cancelled by themselves (the safe side).
--
-- Table changes:
--   * suqa.cash_moves: + source, + ref_id. The table is then:
--       create table suqa.cash_moves (
--         id         uuid primary key,
--         shift_id   uuid not null references suqa.shifts(id) on delete cascade,
--         shop_id    uuid not null references suqa.shops(id) on delete cascade,
--         tenant_id  uuid not null,
--         kind       text not null check (kind in ('in','out')),
--         amount     bigint not null check (amount > 0),
--         currency   text not null check (currency in ('usd','lbp')),
--         reason     text,
--         user_id    uuid,
--         at         timestamptz not null default now(),
--         updated_at timestamptz not null default now(),
--         source     text check (source in ('manual','debt','supplier','driver','fee','cancel')),   -- NEW: what made this move (null = recorded before script 90)
--         ref_id     uuid                                                                        -- NEW: the operation it belongs to (settlement, payment, payout, order, or the cancelled move)
--       );
--   * NEW table suqa.op_cancels.
-- Function changes: _pos_cash_move stores source / ref_id (nothing else changes in it); new pos_op_cancel. Idempotent.

alter table suqa.cash_moves add column if not exists source text;
alter table suqa.cash_moves add column if not exists ref_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cash_moves_source_check' and conrelid = 'suqa.cash_moves'::regclass) then
    alter table suqa.cash_moves add constraint cash_moves_source_check check (source in ('manual', 'debt', 'supplier', 'driver', 'fee', 'cancel'));
  end if;
end $$;

create or replace function suqa._pos_cash_move(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  insert into suqa.cash_moves (id, shift_id, shop_id, tenant_id, kind, amount, currency, reason, user_id, at, source, ref_id)
  values ((p->>'id')::uuid, (p->>'shift_id')::uuid, d.shop_id, d.tenant_id, p->>'kind', (p->>'amount')::bigint, p->>'currency', p->>'reason', p_user,
          coalesce((p->>'at')::timestamptz, now()),
          case when p->>'source' in ('manual', 'debt', 'supplier', 'driver', 'fee') then p->>'source' end,      -- 90: 'cancel' is written by pos_op_cancel only
          nullif(p->>'ref_id', '')::uuid)
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true);
end $$;

create table if not exists suqa.op_cancels (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references suqa.shops(id) on delete cascade,
  tenant_id   uuid not null,
  action      text not null,                    -- the cancelled operation's kind: cash.move, stock.move, supplier.pay, driver.payout
  target_id   uuid not null,                    -- its row (the drawer move, the stock move, the payment, the settlement)
  audit_id    bigint,                           -- its line in the operations log
  reason      text not null,
  user_id     uuid,
  at          timestamptz not null default now(),
  result      jsonb,
  constraint op_cancels_once unique (shop_id, action, target_id)
);
alter table suqa.op_cancels enable row level security;   -- no policies: written by pos_op_cancel, read through the audit log
revoke all on suqa.op_cancels from public, anon, authenticated;

create or replace function suqa.pos_op_cancel(p_shop uuid, p_audit_id bigint, p_shift uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a suqa.audit_log; v_id uuid; v_reason text := nullif(left(trim(coalesce(p_reason, '')), 200), ''); v_res jsonb := '{}'::jsonb;
        cm suqa.cash_moves; sm suqa.stock_moves; sp suqa.supplier_payments; dp suqa.driver_payouts;
        v_usd bigint; v_lbp bigint; v_n int := 0; v_m int := 0; v_shift_ok boolean; v_note text;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if suqa.pos_role(p_shop) is distinct from 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  if v_reason is null then raise exception 'reason_required'; end if;
  select * into a from suqa.audit_log where id = p_audit_id and shop_id = p_shop;
  if not found then raise exception 'op_not_found'; end if;
  if a.action not in ('cash.move', 'stock.move', 'supplier.pay', 'driver.payout') then raise exception 'not_cancellable'; end if;
  if a.after->'result'->>'status' = 'rejected' then raise exception 'op_failed'; end if;
  begin v_id := nullif(coalesce(a.after->>'id', a.ref_id), '')::uuid; exception when others then v_id := null; end;
  if v_id is null then raise exception 'op_not_found'; end if;

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
  end if;

  update suqa.op_cancels set result = v_res where shop_id = p_shop and action = a.action and target_id = v_id;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (p_shop, a.tenant_id, auth.uid(), 'op.cancel', 'audit_log', v_id::text,
          jsonb_build_object('id', v_id, 'cancel_of', a.id, 'action', a.action, 'reason', v_reason, 'shift_id', p_shift, 'result', v_res || jsonb_build_object('ok', true)));
  return jsonb_build_object('ok', true, 'action', a.action, 'result', v_res);
end $$;
revoke all on function suqa.pos_op_cancel(uuid, bigint, uuid, text) from public, anon;
grant execute on function suqa.pos_op_cancel(uuid, bigint, uuid, text) to authenticated;

select 'operations log step 2 installed' as result, (select count(*) from suqa.op_cancels) as cancels;
