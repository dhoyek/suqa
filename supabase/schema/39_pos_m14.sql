-- 39_pos_m14.sql — pilot gaps: second scale format, default supplier & margin per item, expiry tracking   (2026-11-09)
-- Requires 37. Idempotent. Base file 04 carries the new columns.
--   products.supplier_id    default supplier (purchase entry suggests the supplier's items; set automatically on first purchase)
--   products.margin_pct     per-item margin on selling price (null → shop default_margin_pct) for the suggested new price on receiving
--   products.next_expiry    earliest expiry known from purchase lines → "expiring soon" list in stock
--   shops.scale_formats     extra scale-label formats [{prefix, code_len, value_kind, divisor}] besides the first one in the scale_* columns
alter table suqa.products add column if not exists supplier_id uuid references suqa.suppliers(id) on delete set null;
alter table suqa.products add column if not exists margin_pct numeric(6,2);
alter table suqa.products add column if not exists next_expiry date;
alter table suqa.shops add column if not exists scale_formats jsonb not null default '[]'::jsonb;
create index if not exists products_supplier_idx on suqa.products (supplier_id) where supplier_id is not null;
create index if not exists products_expiry_idx on suqa.products (shop_id, next_expiry) where next_expiry is not null;

-- ---------- product.patch (31 + supplier / margin / expiry) -----------------------------------------------------------
create or replace function suqa._pos_product_patch(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_prod suqa.products; v_fields jsonb; v_k text; v_v jsonb; v_base timestamptz; v_conf int := 0; v_allowed text[] :=
  array['name','description','price_usd','price_currency','price_lbp','cost_cents','sku','unit','unit_kind','decimal_qty','vat','track_stock','min_stock','supplier_id','margin_pct','next_expiry',
        'visible_online','is_available','is_active','category_id','section','sort_order','image_url'];
begin
  v_fields := p->'fields'; v_base := (p->>'base_updated_at')::timestamptz;
  if (p->>'id') is null then
    -- new product created offline
    insert into suqa.products (id, tenant_id, shop_id, name, price_usd) values ((p->>'new_id')::uuid, d.tenant_id, d.shop_id, '{}'::jsonb, 0) on conflict (id) do nothing;
    select * into v_prod from suqa.products where id = (p->>'new_id')::uuid;
  else
    select * into v_prod from suqa.products where id = (p->>'id')::uuid and shop_id = d.shop_id;
    if not found then raise exception 'product_not_found'; end if;
  end if;

  for v_k, v_v in select * from jsonb_each(v_fields) loop
    if v_k <> all (v_allowed) then raise exception 'field_not_allowed' using detail = v_k; end if;
    if v_base is not null and v_prod.updated_at > v_base and to_jsonb(v_prod)->v_k is distinct from v_v then
      insert into suqa.conflict_log (shop_id, tenant_id, tbl, row_id, field, old_value, new_value, by_device, by_user)
      values (d.shop_id, d.tenant_id, 'products', v_prod.id::text, v_k, to_jsonb(v_prod)->v_k, v_v, d.id, p_user);
      v_conf := v_conf + 1;
    end if;
    execute format('update suqa.products set %I = ($1->>%L)::%s where id = $2', v_k, v_k,
                   (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = 'suqa.products'::regclass and a.attname = v_k))
      using v_fields, v_prod.id;
  end loop;

  -- barcodes_add: "123" or { barcode, pack_qty, pack_price_usd, pack_price_lbp }  (31_pos_m11)
  for v_v in select * from jsonb_array_elements(coalesce(p->'barcodes_add', '[]'::jsonb)) loop
    if jsonb_typeof(v_v) = 'object' then
      insert into suqa.product_barcodes (product_id, shop_id, tenant_id, barcode, pack_qty, pack_price_usd, pack_price_lbp)
      values (v_prod.id, d.shop_id, d.tenant_id, v_v->>'barcode', coalesce((v_v->>'pack_qty')::numeric, 1), (v_v->>'pack_price_usd')::numeric, (v_v->>'pack_price_lbp')::bigint)
      on conflict (product_id, barcode) do update set pack_qty = excluded.pack_qty, pack_price_usd = excluded.pack_price_usd, pack_price_lbp = excluded.pack_price_lbp;
    else
      insert into suqa.product_barcodes (product_id, shop_id, tenant_id, barcode) values (v_prod.id, d.shop_id, d.tenant_id, v_v#>>'{}') on conflict do nothing;
    end if;
  end loop;
  for v_v in select * from jsonb_array_elements(coalesce(p->'barcodes_remove', '[]'::jsonb)) loop
    delete from suqa.product_barcodes where product_id = v_prod.id and barcode = v_v#>>'{}';
  end loop;
  return jsonb_build_object('conflicts', v_conf);
end $$;

-- ---------- shop settings (32 + scale_formats) -------------------------------------------------------------------------
create or replace function suqa.pos_shop_settings(p_shop uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  update suqa.shops set
    default_delivery_fee_usd = coalesce((p_patch->>'default_delivery_fee_usd')::numeric, default_delivery_fee_usd),
    max_discount_pct         = coalesce((p_patch->>'max_discount_pct')::numeric, max_discount_pct),
    lbp_rounding_step        = coalesce((p_patch->>'lbp_rounding_step')::int, lbp_rounding_step),
    allow_negative_stock     = coalesce((p_patch->>'allow_negative_stock')::boolean, allow_negative_stock),
    hide_online_when_zero    = coalesce((p_patch->>'hide_online_when_zero')::boolean, hide_online_when_zero),
    deduct_stock_at          = coalesce(p_patch->>'deduct_stock_at', deduct_stock_at),
    receipt_footer           = case when p_patch ? 'receipt_footer' then p_patch->>'receipt_footer' else receipt_footer end,
    offline_days             = coalesce(least(greatest((p_patch->>'offline_days')::int, 1), 90), offline_days),
    default_margin_pct       = coalesce((p_patch->>'default_margin_pct')::numeric, default_margin_pct),
    scale_prefix             = case when p_patch ? 'scale_prefix' then nullif(p_patch->>'scale_prefix', '') else scale_prefix end,
    scale_code_len           = coalesce((p_patch->>'scale_code_len')::int, scale_code_len),
    scale_value_kind         = coalesce(p_patch->>'scale_value_kind', scale_value_kind),
    scale_value_divisor      = coalesce((p_patch->>'scale_value_divisor')::int, scale_value_divisor),
    scale_formats            = case when p_patch ? 'scale_formats' and jsonb_typeof(p_patch->'scale_formats') = 'array' then p_patch->'scale_formats' else scale_formats end,
    notify_stages            = case when p_patch ? 'notify_stages' then (select array_agg(x) from jsonb_array_elements_text(p_patch->'notify_stages') x) else notify_stages end
  where id = p_shop;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  select p_shop, tenant_id, auth.uid(), 'shop.settings', 'shops', p_shop::text, p_patch from suqa.shops where id = p_shop;
  return (select to_jsonb(s) - 'printer' from suqa.shops s where id = p_shop);
end $$;

-- ---------- purchase.commit (30 + expiry / default supplier) -----------------------------------------------------------
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
        price_lbp = case when (v_l->>'new_price_lbp') is not null then (v_l->>'new_price_lbp')::bigint else price_lbp end,
        -- 39: expiry tracking + default supplier (earliest known expiry wins; first supplier we buy from becomes the default)
        next_expiry = case when nullif(v_l->>'expiry', '') is not null then least(coalesce(next_expiry, (v_l->>'expiry')::date), (v_l->>'expiry')::date) else next_expiry end,
        supplier_id = coalesce(supplier_id, (p->>'supplier_id')::uuid)
      where id = v_prod.id;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'number', v_number);
end $$;

select 'pos m14 installed' as result;
