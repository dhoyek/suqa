-- 31_pos_m11.sql — POS M11: pack barcodes, scale barcodes, customer credit limit & discount, default margin   (2026-11-08)
-- Requires 30. Idempotent. Base files 04 / 21 carry the columns.

-- A barcode can stand for a pack: scanning it adds pack_qty units at the pack price (stock is kept in units).
alter table suqa.product_barcodes
  add column if not exists pack_qty       numeric(12,3) not null default 1,
  add column if not exists pack_price_usd numeric(12,2),
  add column if not exists pack_price_lbp bigint;

-- Customers: credit limit for the debt book and an automatic discount %.
alter table suqa.shop_customers
  add column if not exists credit_limit_cents int,
  add column if not exists discount_pct numeric(5,2) not null default 0;

-- Shop: weighed-item (scale) barcodes and the default margin used to propose selling prices from cost.
--   scale_prefix        digits a scale label starts with (e.g. '2' or '20'); null = off
--   scale_code_len      digits of item code after the prefix (matched against product sku / a barcode)
--   scale_value_kind    what the remaining digits (before the check digit) carry: 'weight' (÷ divisor = kg) or 'price_lbp' / 'price_usd' (÷ divisor)
--   scale_value_divisor 1000 for grams → kg, 100 for cents …
alter table suqa.shops
  add column if not exists default_margin_pct  numeric(5,2) not null default 0,
  add column if not exists scale_prefix        text,
  add column if not exists scale_code_len      int not null default 5,
  add column if not exists scale_value_kind    text not null default 'weight' check (scale_value_kind in ('weight','price_lbp','price_usd')),
  add column if not exists scale_value_divisor int not null default 1000;

-- ---------- product patch (21 + pack barcodes) --------------------------------------------------------------------
create or replace function suqa._pos_product_patch(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_prod suqa.products; v_fields jsonb; v_k text; v_v jsonb; v_base timestamptz; v_conf int := 0; v_allowed text[] :=
  array['name','description','price_usd','price_currency','price_lbp','cost_cents','sku','unit','unit_kind','decimal_qty','vat','track_stock','min_stock',
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

-- ---------- shop settings (28 + scale / margin) -------------------------------------------------------------------
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
    scale_value_divisor      = coalesce((p_patch->>'scale_value_divisor')::int, scale_value_divisor)
  where id = p_shop;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  select p_shop, tenant_id, auth.uid(), 'shop.settings', 'shops', p_shop::text, p_patch from suqa.shops where id = p_shop;
  return (select to_jsonb(s) - 'printer' from suqa.shops s where id = p_shop);
end $$;
grant execute on function suqa.pos_shop_settings(uuid, jsonb) to authenticated;

-- ---------- customer upsert (28 + credit limit / discount) ------------------------------------------------------
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
    discount_pct = case when p ? 'discount_pct' then coalesce((p->>'discount_pct')::numeric, 0) else discount_pct end
  where id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

select 'pos m11 installed' as result;
