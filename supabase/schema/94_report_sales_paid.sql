-- 94: reports — the list behind a "way of paying" line shows what each sale took that way, and adds up to the line.
--
-- The line is the money received that way (cash $ handed over, before change); the list showed each sale's total, so the two
-- did not agree. With a tender in the filter each row now carries paid_usd / paid_lbp (that tender only), the result carries
-- their sums, and a sale whose rows in that tender add up to nothing (a cancelled payment, 91) is left out — the same sales
-- the line counts (92). Nothing changes for the other filters.
--
-- Changes: pos_report_sales (full function, replaces 93's). No table changes. Read-only.

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
    ), pt as (                                                           -- what each sale took in the asked way of paying (94); a sale whose rows add up to nothing is not in the list
      select p.order_id, sum(case when p.currency = 'usd' then p.amount else 0 end) u, sum(case when p.currency = 'lbp' then p.amount else 0 end) l
        from suqa.payments p join o on o.id = p.order_id where v_tender is not null and p.tender::text = v_tender group by 1
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
             (case when v_by_item then coalesce(li.c, 0) else coalesce(o.total_cents, round(o.total_usd * 100)) end)::bigint cents,
             case when v_tender is not null then pt.u::bigint end paid_usd, case when v_tender is not null then pt.l::bigint end paid_lbp
        from o left join li on li.order_id = o.id left join pt on pt.order_id = o.id
       where (not v_by_item or coalesce(li.any_hit, false))
         and (v_tender is null or coalesce(pt.u, 0) <> 0 or coalesce(pt.l, 0) <> 0)
    )
    select jsonb_build_object(
      'count', (select count(*) from r), 'cents', (select coalesce(sum(cents), 0) from r),
      'paid_usd', (select sum(paid_usd) from r), 'paid_lbp', (select sum(paid_lbp) from r),
      'rows', (select coalesce(jsonb_agg(to_jsonb(y) order by y.placed_at desc), '[]') from (select * from r order by placed_at desc limit 1000) y))
  );
end $$;
revoke all on function suqa.pos_report_sales(uuid, date, date, jsonb) from public, anon;
grant execute on function suqa.pos_report_sales(uuid, date, date, jsonb) to authenticated;
