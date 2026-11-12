-- 56_order_ratings.sql — the customer rates a delivered order (1–5 stars + an optional note to the shop).   (2026-11-12)
-- One rating per order; the customer may change it later. Written only through rate_order() — which checks that the caller is
-- the order's customer and that the order was delivered — so there are no insert/update/delete policies.
-- Read: the customer who wrote it, the shop's members, the association. Not public (no storefront averages yet).
-- The rating also lands in the order's timeline (order_events, system note) so the shop sees it in the POS order sheet.
-- Requires 06, 08. Idempotent.

create table if not exists suqa.order_ratings (
  order_id    uuid primary key references suqa.orders(id) on delete cascade,
  tenant_id   uuid not null references suqa.tenants(id) on delete restrict,
  shop_id     uuid not null references suqa.shops(id) on delete cascade,
  customer_id uuid not null references auth.users(id) on delete cascade,
  stars       smallint not null check (stars between 1 and 5),
  comment     text check (comment is null or char_length(comment) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists order_ratings_shop_idx on suqa.order_ratings (shop_id, created_at desc);

alter table suqa.order_ratings enable row level security;
revoke all on table suqa.order_ratings from public, anon;
grant select on table suqa.order_ratings to authenticated;
select suqa._policy('order_ratings','ratings_read','select','authenticated',
  'customer_id = auth.uid() or suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');

create or replace function suqa.rate_order(p_order uuid, p_stars int, p_comment text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o suqa.orders; v_comment text := nullif(trim(coalesce(p_comment, '')), ''); v_new boolean;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = 'insufficient_privilege'; end if;
  if p_stars is null or p_stars < 1 or p_stars > 5 then raise exception 'bad_stars'; end if;
  select * into o from suqa.orders where id = p_order;
  if not found or o.customer_id is distinct from auth.uid() then raise exception 'order_not_found'; end if;
  if o.status <> 'delivered' then raise exception 'not_delivered'; end if;
  v_comment := left(v_comment, 500);
  insert into suqa.order_ratings (order_id, tenant_id, shop_id, customer_id, stars, comment)
  values (o.id, o.tenant_id, o.shop_id, auth.uid(), p_stars, v_comment)
  on conflict (order_id) do update set stars = excluded.stars, comment = excluded.comment, updated_at = now()
  returning (xmax = 0) into v_new;
  insert into suqa.order_events (order_id, tenant_id, actor_kind, note)
  values (o.id, o.tenant_id, 'system',
          '⭐ ' || case when v_new then 'تقييم الزبون' else 'الزبون عدّل تقييمه' end || ': ' || p_stars || '/5' || coalesce(' — ' || v_comment, ''));
  return jsonb_build_object('ok', true, 'stars', p_stars, 'comment', v_comment);
end $$;

revoke all on function suqa.rate_order(uuid, int, text) from public, anon;
grant execute on function suqa.rate_order(uuid, int, text) to authenticated;

select 'order ratings installed' as result;
