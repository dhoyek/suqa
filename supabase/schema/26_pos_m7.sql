-- 26_pos_m7.sql — POS M7: debt book (الدين)   (2026-11-07)
-- Requires 21–25. Idempotent.
-- A debt is a payment row with tender 'unpaid' (name + phone). Collections are recorded as debt_settlements with
-- oldest-first allocations to the orders they cover; the original sales are never edited. Cash collected goes into
-- the open shift's drawer as a cash move ('in', sent by the POS as its own cash.move op).

create table if not exists suqa.debt_settlements (
  id           uuid primary key,
  shop_id      uuid not null references suqa.shops(id) on delete cascade,
  tenant_id    uuid not null,
  phone        text not null,                       -- digits, as on the unpaid rows
  name         text,
  tender       text not null check (tender in ('cash_usd','cash_lbp','card','wallet')),
  currency     text not null check (currency in ('usd','lbp')),
  amount       bigint not null,                     -- in `currency` (USD cents or LBP)
  amount_cents int    not null,                     -- USD equivalent at `rate`
  rate         int    not null,
  note         text,
  user_id      uuid,
  device_id    uuid,
  shift_id     uuid,
  at           timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists debt_settlements_shop_idx on suqa.debt_settlements(shop_id, phone, at desc);

create table if not exists suqa.debt_allocations (
  id            uuid primary key,
  settlement_id uuid not null references suqa.debt_settlements(id) on delete cascade,
  shop_id       uuid not null,
  tenant_id     uuid not null,
  order_id      uuid not null references suqa.orders(id) on delete restrict,
  amount_cents  int  not null,
  updated_at    timestamptz not null default now()
);
create index if not exists debt_allocations_order_idx on suqa.debt_allocations(order_id);

do $$ declare t text; begin
  foreach t in array array['debt_settlements','debt_allocations'] loop
    execute format('drop trigger if exists set_updated_at on suqa.%I', t);
    execute format('create trigger set_updated_at before update on suqa.%I for each row execute function suqa.set_updated_at()', t);
    execute format('drop trigger if exists sync_log on suqa.%I', t);
    execute format('create trigger sync_log after insert or update or delete on suqa.%I for each row execute function suqa.sync_log_row()', t);
    execute format('alter table suqa.%I enable row level security', t);
  end loop;
end $$;
select suqa._policy('debt_settlements','ds_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('debt_allocations','da_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
grant select on suqa.debt_settlements, suqa.debt_allocations to authenticated;

-- Outstanding per order, USD cents: unpaid rows (LBP converted at the order's rate) minus allocations.
create or replace function suqa.order_debt_cents(p_order uuid) returns int language sql stable as $$
  select greatest(0, coalesce((select sum(case when p.currency = 'lbp' then round(p.amount * 100.0 / nullif(o.rate_lbp_per_usd, 0)) else p.amount end)::int
                                 from suqa.payments p join suqa.orders o on o.id = p.order_id where p.order_id = p_order and p.tender = 'unpaid'), 0)
                   - coalesce((select sum(amount_cents) from suqa.debt_allocations where order_id = p_order), 0))
$$;

-- Open debts of a shop (one row per order still owed), oldest first.
create or replace function suqa.open_debts(p_shop uuid)
returns table (order_id uuid, number text, at timestamptz, name text, phone text, original_cents int, outstanding int)
language sql stable security definer set search_path = public as $$
  select o.id, coalesce(o.number, o.local_number), min(p.at), max(p.unpaid_name), max(p.unpaid_phone),
         sum(case when p.currency = 'lbp' then round(p.amount * 100.0 / nullif(o.rate_lbp_per_usd, 0)) else p.amount end)::int,
         suqa.order_debt_cents(o.id)
    from suqa.payments p join suqa.orders o on o.id = p.order_id
   where o.shop_id = p_shop and p.tender = 'unpaid' and o.status not in ('cancelled','rejected')
   group by o.id having suqa.order_debt_cents(o.id) > 0
   order by min(p.at)
$$;
grant execute on function suqa.open_debts(uuid) to authenticated;

-- payload: { id, phone, name, tender, currency, amount, amount_cents, rate, note, shift_id, at, allocations:[{id, order_id, amount_cents}] }
create or replace function suqa._pos_debt_settle(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_l jsonb;
begin
  if exists (select 1 from suqa.debt_settlements where id = (p->>'id')::uuid) then return jsonb_build_object('ok', true, 'replayed', true); end if;
  insert into suqa.debt_settlements (id, shop_id, tenant_id, phone, name, tender, currency, amount, amount_cents, rate, note, user_id, device_id, shift_id, at)
  values ((p->>'id')::uuid, d.shop_id, d.tenant_id, suqa._digits(p->>'phone'), p->>'name', p->>'tender', p->>'currency', (p->>'amount')::bigint, (p->>'amount_cents')::int,
          (p->>'rate')::int, p->>'note', p_user, d.id, nullif(p->>'shift_id', '')::uuid, coalesce((p->>'at')::timestamptz, now()));
  for v_l in select * from jsonb_array_elements(coalesce(p->'allocations', '[]'::jsonb)) loop
    if not exists (select 1 from suqa.orders where id = (v_l->>'order_id')::uuid and shop_id = d.shop_id) then raise exception 'order_not_found'; end if;
    insert into suqa.debt_allocations (id, settlement_id, shop_id, tenant_id, order_id, amount_cents)
    values ((v_l->>'id')::uuid, (p->>'id')::uuid, d.shop_id, d.tenant_id, (v_l->>'order_id')::uuid, (v_l->>'amount_cents')::int)
    on conflict (id) do nothing;
  end loop;
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
        when 'debt.settle'   then suqa._pos_debt_settle(v_dev, v_op->'payload', v_user)
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


-- ---------- snapshot (21_pos + debt tables; orders that ever carried a debt are always included) ----------------
create or replace function suqa.pos_snapshot(p_device uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dev suqa.devices; v_role text; v_cursor bigint; v_owner boolean;
begin
  select * into v_dev from suqa.devices where id = p_device;
  if not found then raise exception 'device_not_found'; end if;
  if v_dev.revoked_at is not null then raise exception 'device_revoked'; end if;
  v_role := suqa.pos_role(v_dev.shop_id);
  if v_role is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;
  v_owner := v_role = 'owner';
  select coalesce(max(seq), 0) into v_cursor from suqa.sync_log;

  return jsonb_build_object(
    'cursor', v_cursor, 'server_now', now(), 'role', v_role,
    'device', jsonb_build_object('id', v_dev.id, 'prefix', v_dev.prefix, 'name', v_dev.name),
    'shop', (select to_jsonb(s) - 'commission_rate' - 'cover_url' - 'location' from suqa.shops s where s.id = v_dev.shop_id),
    'categories', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from suqa.categories c where c.tenant_id = v_dev.tenant_id),
    'products', (select coalesce(jsonb_agg(case when v_owner then to_jsonb(p) else to_jsonb(p) - 'cost_cents' end), '[]')
                   from suqa.products p where p.shop_id = v_dev.shop_id and p.is_active),
    'product_barcodes', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from suqa.product_barcodes b where b.shop_id = v_dev.shop_id),
    'quick_buttons', (select coalesce(jsonb_agg(to_jsonb(q)), '[]') from suqa.quick_buttons q where q.shop_id = v_dev.shop_id),
    'exchange_rates', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from (select * from suqa.exchange_rates where shop_id = v_dev.shop_id order by effective_at desc limit 50) r),
    'shop_members', (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('full_name', p.full_name)), '[]')
                       from suqa.shop_members m left join suqa.profiles p on p.id = m.user_id where m.shop_id = v_dev.shop_id),
    'devices', (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from suqa.devices d where d.shop_id = v_dev.shop_id),
    'orders', (select coalesce(jsonb_agg(to_jsonb(o)), '[]') from suqa.orders o
                where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days' or o.id in (select order_id from suqa.payments where shop_id = v_dev.shop_id and tender = 'unpaid'))),
    'order_items', (select coalesce(jsonb_agg(case when v_owner then to_jsonb(i) else to_jsonb(i) - 'cost_cents' end), '[]')
                      from suqa.order_items i join suqa.orders o on o.id = i.order_id
                     where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days' or o.id in (select order_id from suqa.payments where shop_id = v_dev.shop_id and tender = 'unpaid'))),
    'payments', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from suqa.payments p join suqa.orders o on o.id = p.order_id
                  where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days' or o.id in (select order_id from suqa.payments where shop_id = v_dev.shop_id and tender = 'unpaid'))),
    'shifts', (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from suqa.shifts s where s.shop_id = v_dev.shop_id and (s.closed_at is null or s.opened_at > now() - interval '7 days')),
    'cash_moves', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from suqa.cash_moves c join suqa.shifts s on s.id = c.shift_id
                    where s.shop_id = v_dev.shop_id and (s.closed_at is null or s.opened_at > now() - interval '7 days')),
    'debt_settlements', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.debt_settlements x where x.shop_id = v_dev.shop_id),
    'debt_allocations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.debt_allocations x where x.shop_id = v_dev.shop_id),
    'stock_moves', (select coalesce(jsonb_agg(to_jsonb(m)), '[]') from (select * from suqa.stock_moves where shop_id = v_dev.shop_id order by at desc limit 2000) m)
  );
end $$;

-- ---------- report (25_pos_m6 + open debts / debt collected) ---------------------------------------------------
create or replace function suqa.pos_report(p_shop uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := (p_from::timestamp at time zone 'Asia/Beirut');
        v_to   timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Beirut');
        v_rate numeric;
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  select lbp_per_usd into v_rate from suqa.exchange_rates where shop_id = p_shop order by effective_at desc limit 1;
  v_rate := coalesce(v_rate, 89500);
  return (
    with o as (
      select * from suqa.orders
       where shop_id = p_shop and not parked and status not in ('cancelled','rejected')
         and placed_at >= v_from and placed_at < v_to
    ), li as (
      select i.* from suqa.order_items i join o on o.id = i.order_id where not i.voided
    ), r as (
      select * from suqa.returns where shop_id = p_shop and at >= v_from and at < v_to
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to, 'rate', v_rate,
      'totals', (select jsonb_build_object(
          'sales_count', count(*), 'total_cents', coalesce(sum(total_cents), 0),
          'items_count', (select coalesce(sum(quantity), 0) from li),
          'discount_cents', coalesce(sum(discount_cents), 0),
          'courier_fees_cents', coalesce(sum(courier_fee_cents), 0), 'delivery_fees_cents', coalesce(sum(round(delivery_fee_usd * 100)), 0),
          'cost_cents', (select coalesce(sum(round(coalesce(cost_cents, 0) * quantity)), 0) from li),
          'debt_collected_cents', (select coalesce(sum(amount_cents), 0) from suqa.debt_settlements where shop_id = p_shop and at >= v_from and at < v_to),
          'returns_count', (select count(*) from r),
          'returns_cents', (select coalesce(sum(refund_usd_cents + round(refund_lbp / v_rate * 100)), 0) from r))
        from o),
      'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'count', c, 'cents', s) order by d), '[]')
                   from (select (placed_at at time zone 'Asia/Beirut')::date d, count(*) c, sum(total_cents) s from o group by 1) x),
      'by_channel', (select coalesce(jsonb_object_agg(channel, jsonb_build_object('count', c, 'cents', s)), '{}')
                       from (select channel, count(*) c, sum(total_cents) s from o group by 1) x),
      'by_tender', (select coalesce(jsonb_object_agg(tender, jsonb_build_object('count', c, 'usd', u, 'lbp', l)), '{}')
                      from (select p.tender, count(*) c, sum(case when p.currency = 'usd' then p.amount else 0 end) u,
                                   sum(case when p.currency = 'lbp' then p.amount else 0 end) l
                              from suqa.payments p join o on o.id = p.order_id group by 1) x),
      'by_item', (select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name, 'qty', q, 'cents', s, 'cost_cents', c) order by s desc), '[]')
                    from (select product_id, min(name::text)::jsonb name, sum(quantity) q, sum(line_total_cents) s, sum(round(coalesce(cost_cents, 0) * quantity)) c
                            from li group by product_id order by s desc limit 100) x),
      'by_section', (select coalesce(jsonb_agg(jsonb_build_object('section', section, 'qty', q, 'cents', s) order by s desc), '[]')
                       from (select coalesce(p.section, '') section, sum(li.quantity) q, sum(li.line_total_cents) s
                               from li left join suqa.products p on p.id = li.product_id group by 1) x),
      'slow', (select coalesce(jsonb_agg(jsonb_build_object('product_id', p.id, 'name', p.name, 'on_hand', p.on_hand, 'cost_cents', p.cost_cents) order by p.on_hand desc), '[]')
                 from (select * from suqa.products where shop_id = p_shop and is_active and track_stock and on_hand > 0
                         and not exists (select 1 from li where li.product_id = products.id) order by on_hand desc limit 100) p),
      'stock', (select jsonb_build_object(
          'skus', count(*), 'units', coalesce(sum(on_hand), 0),
          'cost_cents', coalesce(sum(round(coalesce(cost_cents, 0) * on_hand)), 0),
          'retail_cents', coalesce(sum(round(case when price_currency = 'usd' then price_usd * 100 else price_lbp / v_rate * 100 end * on_hand)), 0),
          'low', (select count(*) from suqa.products where shop_id = p_shop and is_active and track_stock and on_hand <= min_stock))
        from suqa.products where shop_id = p_shop and is_active and track_stock),
      'unpaid', (select coalesce(jsonb_agg(jsonb_build_object('order_id', x.order_id, 'number', x.number, 'at', x.at, 'name', x.name, 'phone', x.phone, 'amount', x.outstanding, 'currency', 'usd') order by x.at desc), '[]')
                   from suqa.open_debts(p_shop) x),
      'shifts', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'opened_at', opened_at, 'closed_at', closed_at, 'device_id', device_id,
                          'expected_usd_cents', expected_usd_cents, 'counted_usd_cents', counted_usd_cents, 'diff_usd_cents', diff_usd_cents,
                          'expected_lbp', expected_lbp, 'counted_lbp', counted_lbp, 'diff_lbp', diff_lbp) order by opened_at desc), '[]')
                   from suqa.shifts where shop_id = p_shop and opened_at >= v_from and opened_at < v_to)
    )
  );
end $$;

select 'pos m7 installed' as result;
