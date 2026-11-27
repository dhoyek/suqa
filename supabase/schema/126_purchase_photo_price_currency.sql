-- 126: purchase invoices — keep the photo of the supplier's paper, and a new selling price in dollars OR lira.
--   purchases.photo_path     where the photo is kept: "<shop id>/<random id>.jpg" in the PRIVATE storage bucket "invoices" (null = none)
--   Bucket "invoices": private (no public link), 5 MB, images only. Only the shop's OWNER and STOCK KEEPER can add a photo under their
--     shop's folder and read it (through a short-lived signed link made by the till). Nobody else: not a cashier, not a customer,
--     not the association's admins (a supplier invoice is the shop's finances). Nothing is deleted by the app.
--   _pos_purchase_commit: the same function as 119 + it stores photo_path (only a path inside this shop's folder), and when a line
--     carries new_price_currency ('usd' | 'lbp') the item's price_currency follows the currency the new price was typed in.
--     A till that does not send new_price_currency (older version) behaves exactly as before.
--   The tills receive the new column with the rows they already sync. Safe to run twice.

alter table suqa.purchases add column if not exists photo_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- may the caller keep / open a supplier invoice photo at this path? "<shop id>/<file>", owner or stock keeper of that shop
create or replace function suqa.can_use_invoice_photo(p_path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_parts text[] := string_to_array(p_path, '/'); v_id uuid;
begin
  if array_length(v_parts, 1) <> 2 then return false; end if;
  begin v_id := v_parts[1]::uuid; exception when others then return false; end;
  return coalesce(suqa.pos_role(v_id), '') in ('owner', 'stock');
end $$;
revoke all on function suqa.can_use_invoice_photo(text) from public, anon;
grant execute on function suqa.can_use_invoice_photo(text) to authenticated;

drop policy if exists "invoices shop read"   on storage.objects;
drop policy if exists "invoices shop insert" on storage.objects;
create policy "invoices shop read"   on storage.objects for select to authenticated using (bucket_id = 'invoices' and suqa.can_use_invoice_photo(name));
create policy "invoices shop insert" on storage.objects for insert to authenticated with check (bucket_id = 'invoices' and suqa.can_use_invoice_photo(name));

create or replace function suqa._pos_purchase_commit(d suqa.devices, p jsonb, p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_l jsonb; v_n int; v_kind text := coalesce(p->>'kind', 'purchase'); v_number text; v_prod suqa.products; v_i int := 0;
begin
  if exists (select 1 from suqa.purchases where id = (p->>'id')::uuid) then return jsonb_build_object('ok', true, 'replayed', true); end if;
  if not exists (select 1 from suqa.suppliers where id = (p->>'supplier_id')::uuid and shop_id = d.shop_id) then raise exception 'supplier_not_found'; end if;
  select count(*) + 1 into v_n from suqa.purchases where shop_id = d.shop_id and kind = v_kind;
  v_number := case when v_kind = 'return' then 'PR-' else 'P-' end || lpad(v_n::text, 5, '0');
  insert into suqa.purchases (id, shop_id, tenant_id, supplier_id, number, kind, invoice_no, invoice_date, currency, rate, subtotal, discount, discount_pct, total, total_cents, note, user_id, approved_by, device_id, at, photo_path)
  values ((p->>'id')::uuid, d.shop_id, d.tenant_id, (p->>'supplier_id')::uuid, v_number, v_kind, p->>'invoice_no', coalesce((p->>'invoice_date')::date, current_date),
          p->>'currency', (p->>'rate')::int, coalesce((p->>'subtotal')::numeric, 0), coalesce((p->>'discount')::numeric, 0), (p->>'discount_pct')::numeric, coalesce((p->>'total')::numeric, 0),
          coalesce((p->>'total_cents')::bigint, 0), p->>'note', p_user, nullif(p->>'approved_by', '')::uuid, d.id, coalesce((p->>'at')::timestamptz, now()),
          -- 126: the photo of the supplier's paper, only a path inside this shop's own folder
          case when v_kind = 'purchase' and (p->>'photo_path') ~ ('^' || d.shop_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then p->>'photo_path' end);
  for v_l in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    v_i := v_i + 1;
    select * into v_prod from suqa.products where id = (v_l->>'product_id')::uuid and shop_id = d.shop_id;
    if not found then raise exception 'product_not_found' using detail = v_l->>'product_id'; end if;
    insert into suqa.purchase_lines (id, purchase_id, shop_id, tenant_id, product_id, name, qty, unit_cost, unit_cost_cents, line_total_cents, new_price_usd, new_price_lbp, expiry, discount, discount_pct, note, sort)
    values ((v_l->>'id')::uuid, (p->>'id')::uuid, d.shop_id, d.tenant_id, v_prod.id, v_prod.name, (v_l->>'qty')::numeric, coalesce((v_l->>'unit_cost')::numeric, 0),
            coalesce((v_l->>'unit_cost_cents')::int, 0), coalesce((v_l->>'line_total_cents')::bigint, 0), (v_l->>'new_price_usd')::numeric, (v_l->>'new_price_lbp')::bigint, (v_l->>'expiry')::date,
            nullif((v_l->>'discount')::numeric, 0), (v_l->>'discount_pct')::numeric, nullif(trim(v_l->>'note'), ''), v_i)
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
        -- 126: the new price was typed in a currency; when the till says which, the item is priced in that currency from now on
        price_currency = case when (v_l->>'new_price_currency') = 'lbp' and (v_l->>'new_price_lbp') is not null then 'lbp'
                              when (v_l->>'new_price_currency') = 'usd' and (v_l->>'new_price_usd') is not null then 'usd' else price_currency end,
        -- 39: expiry tracking + default supplier (earliest known expiry wins; first supplier we buy from becomes the default)
        next_expiry = case when nullif(v_l->>'expiry', '') is not null then least(coalesce(next_expiry, (v_l->>'expiry')::date), (v_l->>'expiry')::date) else next_expiry end,
        supplier_id = coalesce(supplier_id, (p->>'supplier_id')::uuid)
      where id = v_prod.id;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'number', v_number);
end $function$;

notify pgrst, 'reload schema';
