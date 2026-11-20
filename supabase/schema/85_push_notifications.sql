-- 85_push_notifications.sql — a phone notification for every new online order, even with the POS closed.   (2026-11-20)
--
-- WHY: a new online / Yorgo order already rings and shows a count in the POS, but only while the POS is open on screen.
--
-- NOW:
--   * suqa.push_subscriptions — the devices of a shop's staff that tapped "🔔 enable notifications" in POS → Settings and allowed it
--     in the browser (web push: the browser's own endpoint + its two public keys; no password, nothing secret of the person).
--   * suqa.push_subscribe(shop, endpoint, p256dh, auth, label)  — called by the POS; only the shop's own owner / cashier / stock.
--     The same device subscribing again (same endpoint) is updated, never doubled.
--   * suqa.push_unsubscribe(endpoint)                            — the device turns it off.
--   The sending itself is done by the site when an order is created: the existing order trigger already calls /api/wa/events
--   ('order.created'); that route now also pushes to the shop's subscribed devices (service role) and drops endpoints the push
--   service reports gone (404/410). An association admin ("setup") is never subscribed: the notification carries the order total.
--
-- Table changes: NEW table suqa.push_subscriptions (RLS on, no direct access: only the two functions and the service role).
-- Idempotent.

create table if not exists suqa.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references suqa.shops(id) on delete cascade,
  user_id       uuid not null,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  label         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_sent_at  timestamptz,
  failures      int not null default 0,
  constraint push_subscriptions_endpoint_https check (endpoint ~ '^https://'),
  constraint push_subscriptions_sizes check (length(endpoint) <= 1000 and length(p256dh) <= 200 and length(auth) <= 100 and length(coalesce(label, '')) <= 80)
);
create index if not exists push_subscriptions_shop_idx on suqa.push_subscriptions (shop_id);
alter table suqa.push_subscriptions enable row level security;   -- no policies: the functions below and the service role only
revoke all on suqa.push_subscriptions from public, anon, authenticated;

create or replace function suqa.push_subscribe(p_shop uuid, p_endpoint text, p_p256dh text, p_auth text, p_label text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_role text := suqa.pos_role(p_shop);
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if v_role is null or v_role not in ('owner', 'cashier', 'stock') then raise exception 'not_shop_staff'; end if;
  insert into suqa.push_subscriptions (shop_id, user_id, endpoint, p256dh, auth, label)
  values (p_shop, auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_label, 80))
  on conflict (endpoint) do update
    set shop_id = excluded.shop_id, user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        label = excluded.label, updated_at = now(), failures = 0;
  return jsonb_build_object('ok', true);
end $$;

create or replace function suqa.push_unsubscribe(p_endpoint text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  delete from suqa.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

revoke all on function suqa.push_subscribe(uuid, text, text, text, text) from public, anon;
revoke all on function suqa.push_unsubscribe(text) from public, anon;
grant execute on function suqa.push_subscribe(uuid, text, text, text, text) to authenticated;
grant execute on function suqa.push_unsubscribe(text) to authenticated;

select 'push notifications installed' as result, (select count(*) from suqa.push_subscriptions) as subscriptions;
