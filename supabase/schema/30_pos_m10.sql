-- 30_pos_m10.sql — POS M10: suppliers & purchases (purchases-lite)   (2026-11-08)
-- Requires 29. Idempotent.
-- Suppliers with a running balance; purchase invoices (receive stock at cost, optional new selling price), returns to
-- supplier, payments to suppliers (optionally out of the drawer). No purchase orders, no accounting entries.
-- Balance = Σ purchases − Σ returns − Σ payments, kept on the supplier row by trigger so it is right on every device.

-- stock_moves gets two kinds: purchase (in, ref_id = purchase) and purchase_return (out).
alter table suqa.stock_moves drop constraint if exists stock_moves_kind_check;
alter table suqa.stock_moves add constraint stock_moves_kind_check
  check (kind in ('sale','return','receive','adjust','count','damaged','reserve','release','purchase','purchase_return'));

create table if not exists suqa.suppliers (
  id            uuid primary key,
  shop_id       uuid not null references suqa.shops(id) on delete cascade,
  tenant_id     uuid not null,
  name          text not null,
  phone         text,
  phone_key     text,
  contact       text,
  notes         text,
  balance_cents bigint not null default 0,          -- what the shop owes (USD cents); maintained by trigger
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists suppliers_shop_idx on suqa.suppliers(shop_id, lower(name));

create table if not exists suqa.purchases (
  id            uuid primary key,
  shop_id       uuid not null references suqa.shops(id) on delete cascade,
  tenant_id     uuid not null,
  supplier_id   uuid not null references suqa.suppliers(id) on delete restrict,
  number        text not null,                       -- P-00012 / PR-00003 per shop
  kind          text not null default 'purchase' check (kind in ('purchase','return')),
  invoice_no    text,
  invoice_date  date not null default current_date,
  currency      text not null check (currency in ('usd','lbp')),
  rate          int  not null,                       -- LBP per USD used for the USD equivalents
  subtotal      numeric(14,2) not null default 0,    -- in `currency`
  discount      numeric(14,2) not null default 0,
  total         numeric(14,2) not null default 0,
  total_cents   bigint not null default 0,           -- USD cents equivalent (signed +; kind decides the direction)
  note          text,
  status        text not null default 'posted' check (status in ('posted','void')),
  void_reason   text,
  user_id       uuid,
  approved_by   uuid,
  device_id     uuid,
  at            timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists purchases_shop_idx on suqa.purchases(shop_id, at desc);
create index if not exists purchases_supplier_idx on suqa.purchases(supplier_id, at desc);

create table if not exists suqa.purchase_lines (
  id              uuid primary key,
  purchase_id     uuid not null references suqa.purchases(id) on delete cascade,
  shop_id         uuid not null,
  tenant_id       uuid not null,
  product_id      uuid not null references suqa.products(id) on delete restrict,
  name            jsonb not null,
  qty             numeric(12,3) not null,
  unit_cost       numeric(14,4) not null,            -- in the purchase currency
  unit_cost_cents int  not null,                     -- USD cents
  line_total_cents bigint not null,
  new_price_usd   numeric(12,2),                     -- selling price set at receiving time (optional)
  new_price_lbp   bigint,
  expiry          date,
  sort            int not null default 0,
  updated_at      timestamptz not null default now()
);
create index if not exists purchase_lines_purchase_idx on suqa.purchase_lines(purchase_id);

create table if not exists suqa.supplier_payments (
  id            uuid primary key,
  shop_id       uuid not null references suqa.shops(id) on delete cascade,
  tenant_id     uuid not null,
  supplier_id   uuid not null references suqa.suppliers(id) on delete restrict,
  purchase_id   uuid references suqa.purchases(id) on delete set null,
  tender        text not null check (tender in ('cash_usd','cash_lbp','card','wallet','transfer','adjust')),   -- 'adjust' (59): owner's balance correction, amount may be negative
  currency      text not null check (currency in ('usd','lbp')),
  amount        bigint not null,                     -- in `currency` (USD cents / LBP)
  amount_cents  bigint not null,                     -- USD cents
  rate          int not null,
  from_drawer   boolean not null default false,      -- true → the POS also posts a cash.move 'out' on the open shift
  shift_id      uuid,
  note          text,
  user_id       uuid,
  device_id     uuid,
  at            timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists supplier_payments_supplier_idx on suqa.supplier_payments(supplier_id, at desc);

do $$ declare t text; begin
  foreach t in array array['suppliers','purchases','purchase_lines','supplier_payments'] loop
    execute format('drop trigger if exists set_updated_at on suqa.%I', t);
    execute format('create trigger set_updated_at before update on suqa.%I for each row execute function suqa.set_updated_at()', t);
    execute format('drop trigger if exists sync_log on suqa.%I', t);
    execute format('create trigger sync_log after insert or update or delete on suqa.%I for each row execute function suqa.sync_log_row()', t);
    execute format('alter table suqa.%I enable row level security', t);
    execute format('grant select on suqa.%I to authenticated', t);
  end loop;
end $$;
select suqa._policy('suppliers','sup_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('purchases','pur_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('purchase_lines','purl_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('supplier_payments','supp_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');

-- Supplier balance maintained from posted purchases/returns and payments.
create or replace function suqa.supplier_recalc(p_supplier uuid) returns void language sql security definer set search_path = public as $$
  update suqa.suppliers s set balance_cents =
      coalesce((select sum(case when kind = 'purchase' then total_cents else -total_cents end) from suqa.purchases where supplier_id = p_supplier and status = 'posted'), 0)
    - coalesce((select sum(amount_cents) from suqa.supplier_payments where supplier_id = p_supplier), 0)
  where s.id = p_supplier
$$;
create or replace function suqa.supplier_recalc_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('INSERT','UPDATE') then perform suqa.supplier_recalc(new.supplier_id); end if;
  if tg_op in ('UPDATE','DELETE') and (tg_op = 'DELETE' or old.supplier_id <> new.supplier_id) then perform suqa.supplier_recalc(old.supplier_id); end if;
  return null;
end $$;
drop trigger if exists supplier_recalc on suqa.purchases;
create trigger supplier_recalc after insert or update or delete on suqa.purchases for each row execute function suqa.supplier_recalc_trg();
drop trigger if exists supplier_recalc on suqa.supplier_payments;
create trigger supplier_recalc after insert or update or delete on suqa.supplier_payments for each row execute function suqa.supplier_recalc_trg();

-- ---------- ops ----------------------------------------------------------------------------------------------
-- supplier.upsert { id, name, phone, contact, notes, active }
create or replace function suqa._pos_supplier_upsert(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'bad_name'; end if;
  insert into suqa.suppliers (id, shop_id, tenant_id, name, phone, phone_key, contact, notes, active)
  values ((p->>'id')::uuid, d.shop_id, d.tenant_id, trim(p->>'name'), p->>'phone', suqa._phone_key(p->>'phone'), p->>'contact', p->>'notes', coalesce((p->>'active')::boolean, true))
  on conflict (id) do update set name = excluded.name, phone = excluded.phone, phone_key = excluded.phone_key, contact = excluded.contact, notes = excluded.notes, active = excluded.active
  where suqa.suppliers.shop_id = d.shop_id;
  return jsonb_build_object('ok', true);
end $$;

-- purchase.commit { id, supplier_id, kind, invoice_no, invoice_date, currency, rate, subtotal, discount, total, total_cents, note, approved_by, at,
--                   lines:[{ id, product_id, qty, unit_cost, unit_cost_cents, line_total_cents, new_price_usd, new_price_lbp, expiry }] }
create or replace function suqa._pos_purchase_commit(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_l jsonb; v_n int; v_kind text := coalesce(p->>'kind', 'purchase'); v_number text; v_prod suqa.products; v_i int := 0;
begin
  if exists (select 1 from suqa.purchases where id = (p->>'id')::uuid) then return jsonb_build_object('ok', true, 'replayed', true); end if;
  if not exists (select 1 from suqa.suppliers where id = (p->>'supplier_id')::uuid and shop_id = d.shop_id) then raise exception 'supplier_not_found'; end if;
  select count(*) + 1 into v_n from suqa.purchases where shop_id = d.shop_id and kind = v_kind;
  v_number := case when v_kind = 'return' then 'PR-' else 'P-' end || lpad(v_n::text, 5, '0');
  insert into suqa.purchases (id, shop_id, tenant_id, supplier_id, number, kind, invoice_no, invoice_date, currency, rate, subtotal, discount, total, total_cents, note, user_id, approved_by, device_id, at)
  values ((p->>'id')::uuid, d.shop_id, d.tenant_id, (p->>'supplier_id')::uuid, v_number, v_kind, p->>'invoice_no', coalesce((p->>'invoice_date')::date, current_date),
          p->>'currency', (p->>'rate')::int, coalesce((p->>'subtotal')::numeric, 0), coalesce((p->>'discount')::numeric, 0), coalesce((p->>'total')::numeric, 0),
          coalesce((p->>'total_cents')::bigint, 0), p->>'note', p_user, nullif(p->>'approved_by', '')::uuid, d.id, coalesce((p->>'at')::timestamptz, now()));
  for v_l in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    v_i := v_i + 1;
    select * into v_prod from suqa.products where id = (v_l->>'product_id')::uuid and shop_id = d.shop_id;
    if not found then raise exception 'product_not_found' using detail = v_l->>'product_id'; end if;
    insert into suqa.purchase_lines (id, purchase_id, shop_id, tenant_id, product_id, name, qty, unit_cost, unit_cost_cents, line_total_cents, new_price_usd, new_price_lbp, expiry, sort)
    values ((v_l->>'id')::uuid, (p->>'id')::uuid, d.shop_id, d.tenant_id, v_prod.id, v_prod.name, (v_l->>'qty')::numeric, coalesce((v_l->>'unit_cost')::numeric, 0),
            coalesce((v_l->>'unit_cost_cents')::int, 0), coalesce((v_l->>'line_total_cents')::bigint, 0), (v_l->>'new_price_usd')::numeric, (v_l->>'new_price_lbp')::bigint, (v_l->>'expiry')::date, v_i)
    on conflict (id) do nothing;
    -- stock in (or out for a return) at cost; cost and optional new price on the product
    insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_id, unit_cost_cents, note, device_id, user_id, at)
    values (gen_random_uuid(), d.shop_id, d.tenant_id, v_prod.id, case when v_kind = 'return' then -abs((v_l->>'qty')::numeric) else (v_l->>'qty')::numeric end,
            case when v_kind = 'return' then 'purchase_return' else 'purchase' end, (p->>'id')::uuid, coalesce((v_l->>'unit_cost_cents')::int, 0), v_number, d.id, p_user, coalesce((p->>'at')::timestamptz, now()));
    if v_kind = 'purchase' then
      update suqa.products set
        cost_cents = coalesce((v_l->>'unit_cost_cents')::int, cost_cents),
        price_usd = case when (v_l->>'new_price_usd') is not null then (v_l->>'new_price_usd')::numeric else price_usd end,
        price_lbp = case when (v_l->>'new_price_lbp') is not null then (v_l->>'new_price_lbp')::bigint else price_lbp end
      where id = v_prod.id;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'number', v_number);
end $$;

-- purchase.void { id, reason } — reverses the stock moves; the invoice stays in the list as void.
create or replace function suqa._pos_purchase_void(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_p suqa.purchases; m record;
begin
  select * into v_p from suqa.purchases where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'purchase_not_found'; end if;
  if v_p.status = 'void' then return jsonb_build_object('ok', true, 'replayed', true); end if;
  for m in select * from suqa.stock_moves where ref_id = v_p.id and kind in ('purchase','purchase_return') loop
    insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_id, unit_cost_cents, note, device_id, user_id)
    values (gen_random_uuid(), d.shop_id, d.tenant_id, m.product_id, -m.qty, 'adjust', v_p.id, m.unit_cost_cents, 'void ' || v_p.number, d.id, p_user);
  end loop;
  update suqa.purchases set status = 'void', void_reason = p->>'reason' where id = v_p.id;
  return jsonb_build_object('ok', true);
end $$;

-- supplier.pay { id, supplier_id, purchase_id, tender, currency, amount, amount_cents, rate, from_drawer, shift_id, note, at }
create or replace function suqa._pos_supplier_pay(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from suqa.supplier_payments where id = (p->>'id')::uuid) then return jsonb_build_object('ok', true, 'replayed', true); end if;
  if not exists (select 1 from suqa.suppliers where id = (p->>'supplier_id')::uuid and shop_id = d.shop_id) then raise exception 'supplier_not_found'; end if;
  -- 59: balance correction ("تصحيح الرصيد") — owner only, a reason is required, never touches the drawer; amount_cents may be negative (raises what we owe)
  if p->>'tender' = 'adjust' then
    if suqa.pos_role(d.shop_id) is distinct from 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
    if coalesce(trim(p->>'note'), '') = '' then raise exception 'reason_required'; end if;
    if coalesce((p->>'from_drawer')::boolean, false) then raise exception 'adjust_not_cash'; end if;
  elsif (p->>'amount_cents')::bigint <= 0 then raise exception 'bad_amount';
  end if;
  insert into suqa.supplier_payments (id, shop_id, tenant_id, supplier_id, purchase_id, tender, currency, amount, amount_cents, rate, from_drawer, shift_id, note, user_id, device_id, at)
  values ((p->>'id')::uuid, d.shop_id, d.tenant_id, (p->>'supplier_id')::uuid, nullif(p->>'purchase_id', '')::uuid, p->>'tender', p->>'currency', (p->>'amount')::bigint,
          (p->>'amount_cents')::bigint, (p->>'rate')::int, coalesce((p->>'from_drawer')::boolean, false), nullif(p->>'shift_id', '')::uuid, p->>'note', p_user, d.id, coalesce((p->>'at')::timestamptz, now()));
  return jsonb_build_object('ok', true);
end $$;

-- ---------- dispatcher (28 + supplier/purchase ops) ------------------------------------------------------------
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
      if v_role = 'cashier' and v_kind in ('rate.set','product.patch','stock.move','return.commit','order.delete','purchase.commit','purchase.void','supplier.pay') and coalesce((v_op->'payload'->>'approved_by'), '') = '' then
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




-- ---------- snapshot (28 + suppliers/purchases) -----------------------------------------------------------------
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
    'suppliers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.suppliers x where x.shop_id = v_dev.shop_id),
    'purchases', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.purchases x where x.shop_id = v_dev.shop_id and x.at > now() - interval '180 days'),
    'purchase_lines', (select coalesce(jsonb_agg(to_jsonb(l)), '[]') from suqa.purchase_lines l join suqa.purchases x on x.id = l.purchase_id where x.shop_id = v_dev.shop_id and x.at > now() - interval '180 days'),
    'supplier_payments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.supplier_payments x where x.shop_id = v_dev.shop_id and x.at > now() - interval '180 days'),
    'shop_customers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.shop_customers x where x.shop_id = v_dev.shop_id),
    'debt_settlements', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.debt_settlements x where x.shop_id = v_dev.shop_id),
    'debt_allocations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.debt_allocations x where x.shop_id = v_dev.shop_id),
    'stock_moves', (select coalesce(jsonb_agg(to_jsonb(m)), '[]') from (select * from suqa.stock_moves where shop_id = v_dev.shop_id order by at desc limit 2000) m)
  );
end $$;

-- ---------- report (26 + purchases) -----------------------------------------------------------------------------
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
          'purchases_cents', (select coalesce(sum(case when kind = 'purchase' then total_cents else -total_cents end), 0) from suqa.purchases where shop_id = p_shop and status = 'posted' and at >= v_from and at < v_to),
          'supplier_paid_cents', (select coalesce(sum(amount_cents), 0) from suqa.supplier_payments where shop_id = p_shop and tender <> 'adjust' and at >= v_from and at < v_to),   -- 59: a balance correction is not money paid
          'suppliers_balance_cents', (select coalesce(sum(balance_cents), 0) from suqa.suppliers where shop_id = p_shop),
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
grant execute on function suqa.pos_report(uuid, date, date) to authenticated;

select 'pos m10 installed' as result;
