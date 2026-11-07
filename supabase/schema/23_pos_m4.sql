-- 23_pos_m4.sql — POS M4: catalog import, bulk price / visibility, online stock guard        (2026-11-07)
--   pos_import_products(p_shop, p_rows, p_dry_run)  rows matched by barcode → SKU → exact name; create/update; 'category' = products.section; initial on_hand as a 'count' move
--   pos_bulk_price(p_shop, p_section, p_pct, p_lbp_step)  ±% on sell prices of a section (null = all)
--   pos_bulk_visibility(p_shop, p_category, p_visible)
--   order_items_check_stock  online orders cannot take more than available (on_hand − reserved) of a tracked item

create or replace function suqa.pos_import_products(p_shop uuid, p_rows jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_shop suqa.shops; v_row jsonb; v_i int := 0; v_out jsonb := '[]'::jsonb; v_prod suqa.products; v_action text; v_msg text; v_bc text; v_bcs text[]; v_fields jsonb; v_id uuid;
        v_owner uuid; v_created int := 0; v_updated int := 0; v_errors int := 0; v_qty numeric; v_detail text;
begin
  select * into v_shop from suqa.shops where id = p_shop;
  if not found then raise exception 'shop_not_found'; end if;
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'bad_rows'; end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1; v_action := null; v_msg := null; v_prod := null; v_id := null;
    v_bcs := array(select nullif(trim(x), '') from jsonb_array_elements_text(coalesce(v_row->'barcodes', '[]'::jsonb)) x where nullif(trim(x), '') is not null);
    begin
      if coalesce(nullif(trim(v_row->>'name_ar'), ''), nullif(trim(v_row->>'name_en'), '')) is null then raise exception 'missing_name'; end if;
      if (v_row->>'price') is null or (v_row->>'price')::numeric < 0 then raise exception 'bad_price'; end if;

      -- match: barcode → sku → exact name
      foreach v_bc in array v_bcs loop
        select p.* into v_prod from suqa.product_barcodes b join suqa.products p on p.id = b.product_id where b.shop_id = p_shop and b.barcode = v_bc limit 1;
        exit when found;
      end loop;
      if v_prod.id is null and nullif(trim(v_row->>'sku'), '') is not null then
        select * into v_prod from suqa.products where shop_id = p_shop and sku = trim(v_row->>'sku') limit 1;
      end if;
      if v_prod.id is null then
        select * into v_prod from suqa.products where shop_id = p_shop
          and ((nullif(trim(v_row->>'name_ar'), '') is not null and name->>'ar' = trim(v_row->>'name_ar')) or (nullif(trim(v_row->>'name_en'), '') is not null and name->>'en' = trim(v_row->>'name_en'))) limit 1;
      end if;
      -- a barcode owned by another product is an error
      foreach v_bc in array v_bcs loop
        v_owner := null;
        select b.product_id into v_owner from suqa.product_barcodes b where b.shop_id = p_shop and b.barcode = v_bc;
        if v_owner is not null and v_owner <> coalesce(v_prod.id, '00000000-0000-0000-0000-000000000000'::uuid) then raise exception 'barcode_taken' using detail = v_bc; end if;
      end loop;


      v_action := case when v_prod.id is null then 'create' else 'update' end;
      if not p_dry_run then
        v_id := coalesce(v_prod.id, gen_random_uuid());
        if v_prod.id is null then
          insert into suqa.products (id, tenant_id, shop_id, name, price_usd) values (v_id, v_shop.tenant_id, p_shop, '{}'::jsonb, 0);
        end if;
        update suqa.products set
          name = jsonb_strip_nulls(jsonb_build_object('ar', coalesce(nullif(trim(v_row->>'name_ar'), ''), nullif(trim(v_row->>'name_en'), '')), 'en', coalesce(nullif(trim(v_row->>'name_en'), ''), nullif(trim(v_row->>'name_ar'), '')))),
          price_currency = case when lower(coalesce(v_row->>'currency', 'usd')) = 'lbp' then 'lbp' else 'usd' end,
          price_usd = case when lower(coalesce(v_row->>'currency', 'usd')) = 'lbp' then price_usd else (v_row->>'price')::numeric end,
          price_lbp = case when lower(coalesce(v_row->>'currency', 'usd')) = 'lbp' then round((v_row->>'price')::numeric) else price_lbp end,
          cost_cents = coalesce(round((v_row->>'cost')::numeric * 100)::int, cost_cents),
          sku = coalesce(nullif(trim(v_row->>'sku'), ''), sku),
          section = coalesce(nullif(trim(v_row->>'category'), ''), section),
          unit_kind = coalesce(nullif(v_row->>'unit', ''), unit_kind),
          unit = case when coalesce(nullif(v_row->>'unit', ''), unit_kind) = 'piece' then null else coalesce(nullif(v_row->>'unit', ''), unit) end,
          decimal_qty = coalesce((v_row->>'decimal_qty')::boolean, decimal_qty) or coalesce(nullif(v_row->>'unit', ''), unit_kind) in ('kg','g'),
          track_stock = coalesce((v_row->>'track_stock')::boolean, (v_row->>'on_hand') is not null, track_stock),
          min_stock = coalesce((v_row->>'min_stock')::numeric, min_stock),
          visible_online = coalesce((v_row->>'visible_online')::boolean, visible_online),
          is_active = true
        where id = v_id;
        foreach v_bc in array v_bcs loop
          insert into suqa.product_barcodes (product_id, shop_id, tenant_id, barcode) values (v_id, p_shop, v_shop.tenant_id, v_bc) on conflict do nothing;
        end loop;
        if (v_row->>'on_hand') is not null then
          select (v_row->>'on_hand')::numeric - on_hand into v_qty from suqa.products where id = v_id;
          if v_qty <> 0 then
            insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, note, user_id) values (gen_random_uuid(), p_shop, v_shop.tenant_id, v_id, v_qty, 'count', 'import', auth.uid());
          end if;
        end if;
      end if;
      if v_action = 'create' then v_created := v_created + 1; else v_updated := v_updated + 1; end if;
      v_out := v_out || jsonb_build_object('i', v_i, 'action', v_action, 'product_id', coalesce(v_id, v_prod.id), 'message', v_msg);
    exception when others then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_errors := v_errors + 1;
      v_out := v_out || jsonb_build_object('i', v_i, 'action', 'error', 'message', sqlerrm || coalesce(' ' || nullif(v_detail, ''), ''));
      if not p_dry_run then raise; end if;   -- commit is all-or-nothing: validate with a dry run first
    end;
  end loop;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, after) values (p_shop, v_shop.tenant_id, auth.uid(), case when p_dry_run then 'import.dry_run' else 'import.commit' end,
    jsonb_build_object('rows', v_i, 'created', v_created, 'updated', v_updated, 'errors', v_errors));
  return jsonb_build_object('rows', v_out, 'created', v_created, 'updated', v_updated, 'errors', v_errors, 'dry_run', p_dry_run);
end $$;
grant execute on function suqa.pos_import_products(uuid, jsonb, boolean) to authenticated;

create or replace function suqa.pos_bulk_price(p_shop uuid, p_section text, p_pct numeric, p_lbp_step int default 1000)
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  if p_pct is null or p_pct <= -100 or p_pct > 1000 then raise exception 'bad_pct'; end if;
  update suqa.products set
    price_usd = case when price_currency = 'usd' then round(price_usd * (1 + p_pct / 100), 2) else price_usd end,
    price_lbp = case when price_currency = 'lbp' then (round(price_lbp * (1 + p_pct / 100) / greatest(p_lbp_step, 1)) * greatest(p_lbp_step, 1))::bigint else price_lbp end
  where shop_id = p_shop and is_active and (p_section is null or section = p_section);
  get diagnostics n = row_count;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, after) select p_shop, tenant_id, auth.uid(), 'bulk.price', jsonb_build_object('section', p_section, 'pct', p_pct, 'rows', n) from suqa.shops where id = p_shop;
  return n;
end $$;
grant execute on function suqa.pos_bulk_price(uuid, text, numeric, int) to authenticated;

create or replace function suqa.pos_bulk_visibility(p_shop uuid, p_section text, p_visible boolean)
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  update suqa.products set visible_online = p_visible where shop_id = p_shop and is_active and (p_section is null or section = p_section);
  get diagnostics n = row_count;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, after) select p_shop, tenant_id, auth.uid(), 'bulk.visibility', jsonb_build_object('section', p_section, 'visible', p_visible, 'rows', n) from suqa.shops where id = p_shop;
  return n;
end $$;
grant execute on function suqa.pos_bulk_visibility(uuid, text, boolean) to authenticated;

-- Online orders never take more than what is available of a tracked item (walk-in sales may go negative per shop setting).
create or replace function suqa.order_items_check_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_channel text; v_p suqa.products;
begin
  select channel into v_channel from suqa.orders where id = new.order_id;
  if v_channel <> 'online' or new.product_id is null then return new; end if;
  select * into v_p from suqa.products where id = new.product_id;
  if v_p.track_stock and (v_p.on_hand - v_p.reserved) < new.quantity then
    raise exception 'out_of_stock' using detail = coalesce(v_p.name->>'ar', v_p.name->>'en');
  end if;
  return new;
end $$;
drop trigger if exists order_items_0_check_stock on suqa.order_items;
create trigger order_items_0_check_stock before insert on suqa.order_items for each row execute function suqa.order_items_check_stock();

select 'pos m4 installed' as result;
