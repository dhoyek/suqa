-- 38_migration.sql — repeatable import from the pilot's old SQL Server POS   (2026-11-09)
-- Requires 37, 39 (products.supplier_id/margin_pct, shops.scale_formats) and 42 (quiet history). Idempotent. Operator-only (called by /api/admin/migrate with the service role; not granted to users).
--
-- The converter (migration/convert.py) turns the old CSV export into row batches; this function applies one batch.
-- Every old record keeps its key in suqa.migration_map, so running the same export twice changes nothing, and a
-- newer export only adds what is new (products/customers/suppliers are refreshed, history is append-only).
--
--   kind 'product'   { key, name, section, price_currency, price_usd, price_lbp, cost_cents, sku, unit_kind, decimal_qty, vat, active, on_hand,
--                     supplier_key, margin_pct   (39: default supplier + margin on selling price)
--                      barcodes: [{ barcode, pack_qty, pack_price_usd, pack_price_lbp }] }        on_hand → a 'count' stock move for the delta
--   kind 'customer'  { key, phone, name, discount_pct, credit_limit_cents, notes, balance_cents }  balance → opening-balance order OB-<key> (unpaid)
--   kind 'supplier'  { key, name, phone, contact, notes, balance_cents }                          balance → opening-balance purchase OB-<key>
--   kind 'driver'    { key, name, phone }
--   kind 'order'     { key, number, at, customer_phone, customer_name, rate, note, total_cents, discount_cents,
--                      lines: [{ key, name, qty, unit, unit_cents, total_cents }], paid: [{ tender, currency, amount }] }   history: walk-in, delivered, paid in full
--   kind 'purchase'  { key, number, at, supplier_key, invoice_no, currency, rate, note, total_cents, lines: [{ key, name, qty, unit_cost_cents }] }   history: posted + paid in full
--   kind 'settings'  { scale_prefix, scale_code_len, scale_value_kind, scale_value_divisor, default_margin_pct }
-- Balances are taken ONLY from the opening-balance rows (what the old system says the party owes/is owed today);
-- imported history is always marked paid so it never double-counts.

create table if not exists suqa.migration_map (
  shop_id   uuid not null references suqa.shops(id) on delete cascade,
  kind      text not null,
  old_key   text not null,
  new_id    uuid not null,
  at        timestamptz not null default now(),
  primary key (shop_id, kind, old_key)
);
create index if not exists migration_map_new_idx on suqa.migration_map (new_id);
alter table suqa.migration_map enable row level security;                    -- 61: no policies — service key / migrate_apply only
revoke all on table suqa.migration_map from public, anon, authenticated;

create or replace function suqa.migrate_apply(p_shop uuid, p_kind text, p_rows jsonb, p_dry boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_shop suqa.shops; r jsonb; l jsonb; b jsonb; v_id uuid; v_pid uuid; v_sid uuid; v_cid uuid;
        v_ins int := 0; v_upd int := 0; v_skip int := 0; v_err int := 0; v_errs jsonb := '[]'::jsonb;
        v_key text; v_phone text; v_pk text; v_delta numeric; v_cents bigint; v_rate int; v_paid_usd bigint; v_paid_lbp bigint; v_n int;
begin
  select * into v_shop from suqa.shops where id = p_shop;
  if v_shop.id is null then raise exception 'shop_not_found'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows_must_be_array'; end if;
  perform set_config('suqa.migrating', '1', true);
  -- sales history is bulk: keep it off the device sync feed and out of the notification trigger (42_migration_quiet)
  if p_kind = 'order' then perform set_config('suqa.skip_sync_log', '1', true); end if;   -- purchases stay on the feed (the POS purchases screen reads them locally)

  for r in select * from jsonb_array_elements(p_rows) loop
    begin
      v_key := r->>'key';
      -- ======================================================================================= products
      if p_kind = 'product' then
        select new_id into v_pid from suqa.migration_map where shop_id = p_shop and kind = 'product' and old_key = v_key;
        if v_pid is null then
          insert into suqa.products (tenant_id, shop_id, name, description, price_usd, price_currency, price_lbp, cost_cents, sku, unit_kind, unit, decimal_qty, vat,
                                     track_stock, visible_online, is_available, is_active, section, on_hand, sort_order, supplier_id, margin_pct)
          values (v_shop.tenant_id, p_shop, r->'name', '{}'::jsonb, coalesce((r->>'price_usd')::numeric, 0), coalesce(r->>'price_currency', 'usd'), coalesce((r->>'price_lbp')::bigint, 0),
                  (r->>'cost_cents')::int, nullif(r->>'sku', ''), coalesce(r->>'unit_kind', 'piece'), case when coalesce(r->>'unit_kind', 'piece') = 'piece' then null else r->>'unit_kind' end,
                  coalesce((r->>'decimal_qty')::boolean, false), coalesce((r->>'vat')::boolean, false),
                  true, false, true, coalesce((r->>'active')::boolean, true), nullif(r->>'section', ''), 0, 0,
                  (select new_id from suqa.migration_map where shop_id = p_shop and kind = 'supplier' and old_key = r->>'supplier_key'), (r->>'margin_pct')::numeric)
          returning id into v_pid;
          insert into suqa.migration_map (shop_id, kind, old_key, new_id) values (p_shop, 'product', v_key, v_pid);
          v_ins := v_ins + 1;
        else
          update suqa.products set name = r->'name', price_usd = coalesce((r->>'price_usd')::numeric, price_usd), price_currency = coalesce(r->>'price_currency', price_currency),
                 price_lbp = coalesce((r->>'price_lbp')::bigint, price_lbp), cost_cents = coalesce((r->>'cost_cents')::int, cost_cents), sku = coalesce(nullif(r->>'sku', ''), sku),
                 section = coalesce(nullif(r->>'section', ''), section), is_active = coalesce((r->>'active')::boolean, is_active), vat = coalesce((r->>'vat')::boolean, vat),
                 supplier_id = coalesce((select new_id from suqa.migration_map where shop_id = p_shop and kind = 'supplier' and old_key = r->>'supplier_key'), supplier_id),
                 margin_pct = coalesce((r->>'margin_pct')::numeric, margin_pct)
           where id = v_pid;
          v_upd := v_upd + 1;
        end if;
        for b in select * from jsonb_array_elements(coalesce(r->'barcodes', '[]'::jsonb)) loop
          if coalesce(b->>'barcode', '') <> '' then
            insert into suqa.product_barcodes (product_id, shop_id, tenant_id, barcode, pack_qty, pack_price_usd, pack_price_lbp)
            values (v_pid, p_shop, v_shop.tenant_id, b->>'barcode', coalesce((b->>'pack_qty')::numeric, 1), (b->>'pack_price_usd')::numeric, (b->>'pack_price_lbp')::bigint)
            on conflict (shop_id, barcode) do update set product_id = excluded.product_id, pack_qty = excluded.pack_qty, pack_price_usd = excluded.pack_price_usd, pack_price_lbp = excluded.pack_price_lbp;
          end if;
        end loop;
        if r ? 'on_hand' then
          select (r->>'on_hand')::numeric - on_hand into v_delta from suqa.products where id = v_pid;
          if abs(coalesce(v_delta, 0)) > 0.0001 then
            insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, note) values (gen_random_uuid(), p_shop, v_shop.tenant_id, v_pid, v_delta, 'count', 'migration opening stock');
          end if;
        end if;

      -- ======================================================================================= customers
      elsif p_kind = 'customer' then
        v_phone := coalesce(nullif(trim(r->>'phone'), ''), '1' || lpad(v_key, 7, '0'));   -- no number in the old system → placeholder (1xxxxxxx, never a real LB number) the owner can fix
        v_pk := suqa._phone_key(v_phone);
        select new_id into v_cid from suqa.migration_map where shop_id = p_shop and kind = 'customer' and old_key = v_key;
        if v_cid is null then
          v_cid := suqa._customer_touch(p_shop, v_shop.tenant_id, v_phone, r->>'name', null, null, now(), false);
          insert into suqa.migration_map (shop_id, kind, old_key, new_id) values (p_shop, 'customer', v_key, v_cid) on conflict do nothing;
          v_ins := v_ins + 1;
        else v_upd := v_upd + 1; end if;
        update suqa.shop_customers set name = coalesce(nullif(trim(r->>'name'), ''), name), discount_pct = coalesce((r->>'discount_pct')::numeric, discount_pct),
               credit_limit_cents = coalesce((r->>'credit_limit_cents')::int, credit_limit_cents), notes = coalesce(nullif(r->>'notes', ''), notes)
         where id = v_cid;
        -- opening balance → one unpaid order the debts screen can settle like any other
        v_cents := coalesce((r->>'balance_cents')::bigint, 0);
        select new_id into v_id from suqa.migration_map where shop_id = p_shop and kind = 'opening' and old_key = v_key;
        if v_cents > 0 and v_id is null then
          insert into suqa.orders (tenant_id, shop_id, number, status, channel, fulfillment, customer_name, customer_phone, customer_notes, notify_customer,
                                   rate_lbp_per_usd, subtotal_cents, total_cents, total_lbp, subtotal_usd, total_usd, fx_lbp_rate, delivery_fee_usd, placed_at, delivered_at, closed_at)
          values (v_shop.tenant_id, p_shop, 'OB-' || v_key, 'delivered', 'walkin', 'pickup', coalesce(nullif(r->>'name', ''), ''), v_phone, 'رصيد افتتاحي من النظام القديم', false,
                  90000, v_cents, v_cents, v_cents * 900, v_cents / 100.0, v_cents / 100.0, 90000, 0, now(), now(), now())
          returning id into v_id;
          insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, unpaid_name, unpaid_phone, note)
          values (gen_random_uuid(), v_id, p_shop, v_shop.tenant_id, 'unpaid', v_cents, 'usd', r->>'name', v_phone, 'opening balance');
          insert into suqa.migration_map (shop_id, kind, old_key, new_id) values (p_shop, 'opening', v_key, v_id);
        elsif v_id is not null and not exists (select 1 from suqa.debt_allocations where order_id = v_id) then
          -- not settled yet → the newer export's balance wins
          update suqa.orders set subtotal_cents = v_cents, total_cents = v_cents, total_lbp = v_cents * 900, subtotal_usd = v_cents / 100.0, total_usd = v_cents / 100.0 where id = v_id;
          update suqa.payments set amount = v_cents where order_id = v_id and tender = 'unpaid';
        end if;

      -- ======================================================================================= suppliers
      elsif p_kind = 'supplier' then
        select new_id into v_sid from suqa.migration_map where shop_id = p_shop and kind = 'supplier' and old_key = v_key;
        if v_sid is null then
          insert into suqa.suppliers (id, shop_id, tenant_id, name, phone, phone_key, contact, notes, active)
          values (gen_random_uuid(), p_shop, v_shop.tenant_id, coalesce(nullif(trim(r->>'name'), ''), 'Supplier ' || v_key), nullif(r->>'phone', ''), suqa._phone_key(r->>'phone'), nullif(r->>'contact', ''), nullif(r->>'notes', ''), true)
          returning id into v_sid;
          insert into suqa.migration_map (shop_id, kind, old_key, new_id) values (p_shop, 'supplier', v_key, v_sid);
          v_ins := v_ins + 1;
        else
          update suqa.suppliers set name = coalesce(nullif(trim(r->>'name'), ''), name), phone = coalesce(nullif(r->>'phone', ''), phone), phone_key = coalesce(suqa._phone_key(r->>'phone'), phone_key),
                 contact = coalesce(nullif(r->>'contact', ''), contact), notes = coalesce(nullif(r->>'notes', ''), notes) where id = v_sid;
          v_upd := v_upd + 1;
        end if;
        v_cents := coalesce((r->>'balance_cents')::bigint, 0);
        select new_id into v_id from suqa.migration_map where shop_id = p_shop and kind = 'opening_supplier' and old_key = v_key;
        if v_cents <> 0 and v_id is null then
          insert into suqa.purchases (id, shop_id, tenant_id, supplier_id, number, kind, invoice_no, invoice_date, currency, rate, subtotal, discount, total, total_cents, note, status, at)
          values (gen_random_uuid(), p_shop, v_shop.tenant_id, v_sid, 'OB-S' || v_key, case when v_cents > 0 then 'purchase' else 'return' end, 'OB', current_date, 'usd', 90000,
                  abs(v_cents) / 100.0, 0, abs(v_cents) / 100.0, abs(v_cents), 'رصيد افتتاحي من النظام القديم', 'posted', now())
          returning id into v_id;
          insert into suqa.migration_map (shop_id, kind, old_key, new_id) values (p_shop, 'opening_supplier', v_key, v_id);
        elsif v_id is not null then
          update suqa.purchases set kind = case when v_cents > 0 then 'purchase' else 'return' end, subtotal = abs(v_cents) / 100.0, total = abs(v_cents) / 100.0, total_cents = abs(v_cents) where id = v_id;
        end if;
        perform suqa.supplier_recalc(v_sid);

      -- ======================================================================================= drivers
      elsif p_kind = 'driver' then
        if coalesce(length(suqa._phone_key(r->>'phone')), 0) < 6 then v_skip := v_skip + 1; continue; end if;
        insert into suqa.shop_drivers (shop_id, tenant_id, name, phone, phone_key) values (p_shop, v_shop.tenant_id, r->>'name', r->>'phone', suqa._phone_key(r->>'phone'))
        on conflict (shop_id, phone_key) do update set name = excluded.name;
        v_ins := v_ins + 1;

      -- ======================================================================================= sales history
      elsif p_kind = 'order' then
        if exists (select 1 from suqa.migration_map where shop_id = p_shop and kind = 'order' and old_key = v_key) then v_skip := v_skip + 1; continue; end if;
        v_rate := coalesce((r->>'rate')::int, 90000); v_cents := coalesce((r->>'total_cents')::bigint, 0); v_paid_usd := 0; v_paid_lbp := 0;
        for b in select * from jsonb_array_elements(coalesce(r->'paid', '[]'::jsonb)) loop
          if b->>'currency' = 'lbp' then v_paid_lbp := v_paid_lbp + (b->>'amount')::bigint; else v_paid_usd := v_paid_usd + (b->>'amount')::bigint; end if;
        end loop;
        insert into suqa.orders (tenant_id, shop_id, number, status, channel, fulfillment, customer_name, customer_phone, customer_notes, notify_customer, rate_lbp_per_usd,
                                 subtotal_cents, discount_cents, total_cents, total_lbp, paid_usd_cents, paid_lbp, subtotal_usd, total_usd, fx_lbp_rate, delivery_fee_usd, placed_at, delivered_at, closed_at)
        values (v_shop.tenant_id, p_shop, coalesce(nullif(r->>'number', ''), 'M-' || v_key), 'delivered', 'walkin', 'pickup', coalesce(nullif(r->>'customer_name', ''), ''), coalesce(nullif(r->>'customer_phone', ''), ''), nullif(r->>'note', ''), false, v_rate,
                v_cents + coalesce((r->>'discount_cents')::bigint, 0), coalesce((r->>'discount_cents')::bigint, 0), v_cents, round(v_cents * v_rate / 100.0), v_paid_usd, v_paid_lbp,
                (v_cents + coalesce((r->>'discount_cents')::bigint, 0)) / 100.0, v_cents / 100.0, v_rate, 0, (r->>'at')::timestamptz, (r->>'at')::timestamptz, (r->>'at')::timestamptz)
        returning id into v_id;
        v_n := 0;
        for l in select * from jsonb_array_elements(coalesce(r->'lines', '[]'::jsonb)) loop
          v_n := v_n + 1;
          select new_id into v_pid from suqa.migration_map where shop_id = p_shop and kind = 'product' and old_key = l->>'key';
          insert into suqa.order_items (order_id, tenant_id, shop_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, price_currency, unit_price_cents, line_total_cents)
          values (v_id, v_shop.tenant_id, p_shop, v_pid, coalesce(l->'name', jsonb_build_object('ar', 'صنف', 'en', 'Item')), nullif(l->>'unit', ''), coalesce((l->>'unit_cents')::numeric, 0) / 100.0,
                  coalesce((l->>'qty')::numeric, 1), coalesce((l->>'total_cents')::numeric, 0) / 100.0, 'usd', coalesce((l->>'unit_cents')::int, 0), coalesce((l->>'total_cents')::bigint, 0));
        end loop;
        for b in select * from jsonb_array_elements(coalesce(r->'paid', '[]'::jsonb)) loop
          insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, at)
          values (gen_random_uuid(), v_id, p_shop, v_shop.tenant_id, coalesce(b->>'tender', 'cash_usd'), (b->>'amount')::bigint, coalesce(b->>'currency', 'usd'), (r->>'at')::timestamptz);
        end loop;
        if coalesce(jsonb_array_length(r->'paid'), 0) = 0 and v_cents > 0 then   -- no payment detail in the old data: count it as cash in the receipt currency
          insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, at) values (gen_random_uuid(), v_id, p_shop, v_shop.tenant_id, 'cash_usd', v_cents, 'usd', (r->>'at')::timestamptz);
          update suqa.orders set paid_usd_cents = v_cents where id = v_id;
        end if;
        insert into suqa.migration_map (shop_id, kind, old_key, new_id) values (p_shop, 'order', v_key, v_id);
        v_ins := v_ins + 1;

      -- ======================================================================================= purchase history
      elsif p_kind = 'purchase' then
        if exists (select 1 from suqa.migration_map where shop_id = p_shop and kind = 'purchase' and old_key = v_key) then v_skip := v_skip + 1; continue; end if;
        select new_id into v_sid from suqa.migration_map where shop_id = p_shop and kind = 'supplier' and old_key = r->>'supplier_key';
        if v_sid is null then v_err := v_err + 1; v_errs := v_errs || jsonb_build_object('key', v_key, 'error', 'supplier_not_imported'); continue; end if;
        v_rate := coalesce((r->>'rate')::int, 90000); v_cents := coalesce((r->>'total_cents')::bigint, 0);
        insert into suqa.purchases (id, shop_id, tenant_id, supplier_id, number, kind, invoice_no, invoice_date, currency, rate, subtotal, discount, total, total_cents, note, status, at)
        values (gen_random_uuid(), p_shop, v_shop.tenant_id, v_sid, coalesce(nullif(r->>'number', ''), 'M-P' || v_key), coalesce(r->>'kind', 'purchase'), nullif(r->>'invoice_no', ''), (r->>'at')::date, 'usd', v_rate,
                v_cents / 100.0, 0, v_cents / 100.0, v_cents, nullif(r->>'note', ''), 'posted', (r->>'at')::timestamptz)
        returning id into v_id;
        v_n := 0;
        for l in select * from jsonb_array_elements(coalesce(r->'lines', '[]'::jsonb)) loop
          v_n := v_n + 1;
          select new_id into v_pid from suqa.migration_map where shop_id = p_shop and kind = 'product' and old_key = l->>'key';
          if v_pid is null then continue; end if;   -- line for an item outside the imported catalog: the invoice total still carries it
          insert into suqa.purchase_lines (id, purchase_id, shop_id, tenant_id, product_id, name, qty, unit_cost, unit_cost_cents, line_total_cents, sort)
          values (gen_random_uuid(), v_id, p_shop, v_shop.tenant_id, v_pid, coalesce(l->'name', jsonb_build_object('ar', 'صنف', 'en', 'Item')), coalesce((l->>'qty')::numeric, 1),
                  coalesce((l->>'unit_cost_cents')::numeric, 0) / 100.0, coalesce((l->>'unit_cost_cents')::int, 0), round(coalesce((l->>'qty')::numeric, 1) * coalesce((l->>'unit_cost_cents')::numeric, 0)), v_n);
        end loop;
        -- history is settled: a matching payment so the supplier balance comes only from the opening-balance row
        insert into suqa.supplier_payments (id, shop_id, tenant_id, supplier_id, purchase_id, tender, currency, amount, amount_cents, rate, from_drawer, note, at)
        values (gen_random_uuid(), p_shop, v_shop.tenant_id, v_sid, v_id, 'cash_usd', 'usd', case when coalesce(r->>'kind', 'purchase') = 'purchase' then v_cents else -v_cents end,
                case when coalesce(r->>'kind', 'purchase') = 'purchase' then v_cents else -v_cents end, v_rate, false, 'migration (settled in old system)', (r->>'at')::timestamptz);
        insert into suqa.migration_map (shop_id, kind, old_key, new_id) values (p_shop, 'purchase', v_key, v_id);
        v_ins := v_ins + 1;

      -- ======================================================================================= shop settings
      elsif p_kind = 'settings' then
        update suqa.shops set scale_prefix = coalesce(r->>'scale_prefix', scale_prefix), scale_code_len = coalesce((r->>'scale_code_len')::int, scale_code_len),
               scale_value_kind = coalesce(r->>'scale_value_kind', scale_value_kind), scale_value_divisor = coalesce((r->>'scale_value_divisor')::int, scale_value_divisor),
               default_margin_pct = coalesce((r->>'default_margin_pct')::numeric, default_margin_pct),
               scale_formats = coalesce(r->'scale_formats', scale_formats)
         where id = p_shop;
        v_upd := v_upd + 1;
      else
        raise exception 'unknown_kind %', p_kind;
      end if;
    exception when others then
      v_err := v_err + 1;
      if jsonb_array_length(v_errs) < 20 then v_errs := v_errs || jsonb_build_object('key', v_key, 'error', sqlerrm); end if;
    end;
  end loop;

  if p_dry then raise exception 'dry_run' using detail = jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'skipped', v_skip, 'errors', v_err, 'samples', v_errs)::text; end if;
  return jsonb_build_object('kind', p_kind, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip, 'errors', v_err, 'samples', v_errs);
end $$;
revoke all on function suqa.migrate_apply(uuid, text, jsonb, boolean) from public, authenticated, anon;

-- what has been imported so far (per kind)
create or replace function suqa.migrate_status(p_shop uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) n from suqa.migration_map where shop_id = p_shop group by kind) x;
$$;
revoke all on function suqa.migrate_status(uuid) from public, authenticated, anon;

select 'migration installed' as result;
