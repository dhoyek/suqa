-- 93: reports — the sales behind a report line, and one sale in full, read from the server.
--
-- A till keeps the orders that passed through it (a new or reinstalled till starts with the last 7 days), while the report's
-- totals come from the server: tapping a line of an older period showed fewer sales than the total said. Online, the owner's
-- list now comes from the server with the same rules as pos_report (same orders, same Beirut days), so list and total agree for
-- any period; offline the till's own copy is used, as before. A sale that is not on the till opens from the server too.
--
-- New: pos_report_sales(shop, from, to, filter) — owner only. filter (all optional): shift_id (then the dates are ignored),
--      channel, tender, product_id, section ('' = items with no category). With product_id / section each row carries the
--      quantity and amount of those items only. Newest first, at most 1,000 rows; count and cents are for the whole list.
--      pos_sale_detail(shop, order) — any member of the shop's staff (not the platform's setup role: admins must not see a
--      shop's finances); cost is left out for anyone but the owner. Rows as the till keeps them (full table rows).
-- No table changes. Read-only.

create or replace function suqa.pos_report_sales(p_shop uuid, p_from date, p_to date, p_filter jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := (p_from::timestamp at time zone 'Asia/Beirut');
        v_to   timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Beirut');
        f jsonb := coalesce(p_filter, '{}'::jsonb);
        v_shift   uuid := nullif(f->>'shift_id', '')::uuid;
        v_channel text := nullif(f->>'channel', '');
        v_tender  text := nullif(f->>'tender', '');
        v_product uuid := nullif(f->>'product_id', '')::uuid;
        v_section text := f->>'section';                                   -- null = not asked; '' = items with no category
        v_by_item boolean;
begin
  if suqa.pos_role(p_shop) is distinct from 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  v_by_item := v_product is not null or v_section is not null;
  return (
    with o as (
      select * from suqa.orders
       where shop_id = p_shop and not parked and status not in ('cancelled','rejected')
         and (case when v_shift is not null then shift_id = v_shift else placed_at >= v_from and placed_at < v_to end)
         and (v_channel is null or channel::text = v_channel)
         and (v_tender is null or exists (select 1 from suqa.payments p where p.order_id = orders.id and p.tender::text = v_tender))
    ), li as (
      select x.order_id, count(*) n, sum(x.quantity) filter (where x.hit) q, sum(x.cents) filter (where x.hit) c, bool_or(x.hit) any_hit
        from (select i.order_id, i.quantity, coalesce(i.line_total_cents, round(i.line_total_usd * 100)) cents,
                     coalesce(v_by_item and ((v_product is not null and i.product_id = v_product) or (v_section is not null and coalesce(p.section, '') = v_section)), false) hit
                from suqa.order_items i join o on o.id = i.order_id left join suqa.products p on p.id = i.product_id
               where not i.voided) x
       group by 1
    ), r as (
      select o.id, o.number, o.local_number, o.placed_at, o.customer_name, o.channel::text channel, coalesce(li.n, 0) items,
             case when v_by_item then li.q end qty,
             (case when v_by_item then coalesce(li.c, 0) else coalesce(o.total_cents, round(o.total_usd * 100)) end)::bigint cents
        from o left join li on li.order_id = o.id
       where not v_by_item or coalesce(li.any_hit, false)
    )
    select jsonb_build_object(
      'count', (select count(*) from r), 'cents', (select coalesce(sum(cents), 0) from r),
      'rows', (select coalesce(jsonb_agg(to_jsonb(y) order by y.placed_at desc), '[]') from (select * from r order by placed_at desc limit 1000) y))
  );
end $$;
revoke all on function suqa.pos_report_sales(uuid, date, date, jsonb) from public, anon;
grant execute on function suqa.pos_report_sales(uuid, date, date, jsonb) to authenticated;

create or replace function suqa.pos_sale_detail(p_shop uuid, p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_role text := suqa.pos_role(p_shop);
begin
  if v_role is null or v_role = 'setup' then raise exception 'not_staff' using errcode = 'insufficient_privilege'; end if;
  return (
    select jsonb_build_object(
      'order', to_jsonb(o),
      'lines', (select coalesce(jsonb_agg(case when v_role = 'owner' then to_jsonb(i) else to_jsonb(i) - 'cost_cents' end), '[]') from suqa.order_items i where i.order_id = o.id),
      'payments', (select coalesce(jsonb_agg(to_jsonb(p) order by p.at), '[]') from suqa.payments p where p.order_id = o.id),
      'returned', exists (select 1 from suqa.returns r where r.order_id = o.id))
      from suqa.orders o where o.id = p_order and o.shop_id = p_shop);
end $$;
revoke all on function suqa.pos_sale_detail(uuid, uuid) from public, anon;
grant execute on function suqa.pos_sale_detail(uuid, uuid) to authenticated;
