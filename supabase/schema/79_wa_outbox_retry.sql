-- 79 — WhatsApp notifications: a failed hand-over to the site is retried instead of lost.
--   An order event (new order, status change, driver, "I'm coming") is posted by the database to the site, which sends the WhatsApp
--   message. The post was fire-and-forget: on 2026-11-18 one new-order alert never reached the site (a TLS error on the connection)
--   and the shop was never told about a pending order. Nothing recorded it and nothing tried again.
--
--   wa_outbox            one row per event handed to the site: the payload, the http request, how it ended.
--   _wa_post             the one place that posts an event (the three callers below now go through it).
--   wa_outbox_retry      every minute: marks what arrived, posts again what never reached the site (at most 3 tries in all).
--                        Only a connection that failed before any answer is retried — a time-out or an error answer from the site
--                        is NOT, because the site may already have sent the message and a retry would send it twice. Those stay
--                        'failed' and visible.
--   Callers changed (same logic, the post goes through _wa_post): notify_order_event (trigger), _notify_order, customer_coming.
-- Needs pg_net (15) and, for the retry, pg_cron; without pg_cron the outbox still records every event. Idempotent.

create table if not exists suqa.wa_outbox (
  id          bigserial primary key,
  order_id    uuid,                                                -- no foreign key: the record outlives a deleted test order
  tenant_id   uuid,
  event       text not null,
  body        jsonb not null,                                      -- the payload as posted (order, items, shop, tenant)
  request_id  bigint,                                              -- pg_net request of the latest try
  attempts    int not null default 1,
  status      text not null default 'sent' check (status in ('sent', 'ok', 'failed')),
  error       text,                                                -- why the latest try failed
  created_at  timestamptz not null default now(),
  last_at     timestamptz not null default now()
);
create index if not exists wa_outbox_open on suqa.wa_outbox (last_at) where status = 'sent';
create index if not exists wa_outbox_order on suqa.wa_outbox (order_id);
alter table suqa.wa_outbox enable row level security;              -- no policies: app roles see nothing (payloads carry phone numbers)
revoke all on suqa.wa_outbox from anon, authenticated;

-- Post one event to the site and remember it. Never raises: a notification must not block or undo the order.
create or replace function suqa._wa_post(p_order uuid, p_tenant uuid, p_body jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text; v_req bigint;
begin
  select value into v_url    from suqa.integration_config where key = 'wa_events_url';
  select value into v_secret from suqa.integration_config where key = 'wa_events_secret';
  if v_url is null or v_secret is null then return; end if;
  begin
    v_req := net.http_post(url := v_url, body := p_body,
      headers := jsonb_build_object('content-type', 'application/json', 'x-suqa-secret', v_secret), timeout_milliseconds := 8000);
    insert into suqa.wa_outbox (order_id, tenant_id, event, body, request_id) values (p_order, p_tenant, coalesce(p_body->>'event', '?'), p_body, v_req);
  exception when others then
    begin insert into suqa.wa_outbox (order_id, tenant_id, event, body, status, error) values (p_order, p_tenant, coalesce(p_body->>'event', '?'), p_body, 'failed', left(sqlerrm, 300));
    exception when others then null; end;
  end;
end $$;
revoke all on function suqa._wa_post(uuid, uuid, jsonb) from public, anon, authenticated;

-- Every minute: settle what was posted, post again what never arrived.
create or replace function suqa.wa_outbox_retry() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v_url text; v_secret text; v_req bigint; v_ok int := 0; v_again int := 0; v_failed int := 0;
begin
  select value into v_url    from suqa.integration_config where key = 'wa_events_url';
  select value into v_secret from suqa.integration_config where key = 'wa_events_secret';
  for r in
    select o.id, o.body, o.attempts, o.last_at, h.id as resp_id, h.status_code, h.error_msg, coalesce(h.timed_out, false) as timed_out
      from suqa.wa_outbox o left join net._http_response h on h.id = o.request_id
     where o.status = 'sent' and o.last_at < now() - interval '20 seconds' and o.created_at > now() - interval '30 minutes'
     order by o.id for update of o skip locked
  loop
    if r.resp_id is null then
      continue when r.last_at > now() - interval '2 minutes';                       -- no answer recorded yet: give it time
      update suqa.wa_outbox set status = 'failed', error = 'no answer recorded' where id = r.id; v_failed := v_failed + 1;
    elsif r.status_code between 200 and 299 then
      update suqa.wa_outbox set status = 'ok', error = null where id = r.id; v_ok := v_ok + 1;
    elsif r.status_code is null and not r.timed_out and r.attempts < 3 and v_url is not null and v_secret is not null then
      -- the connection failed before the site answered (TLS, DNS, refused): nothing was sent, so sending again is safe
      v_req := net.http_post(url := v_url, body := r.body,
        headers := jsonb_build_object('content-type', 'application/json', 'x-suqa-secret', v_secret), timeout_milliseconds := 8000);
      update suqa.wa_outbox set request_id = v_req, attempts = attempts + 1, last_at = now(), error = left(coalesce(r.error_msg, 'connection failed'), 300) where id = r.id;
      v_again := v_again + 1;
    else
      update suqa.wa_outbox set status = 'failed',
        error = left(coalesce(r.error_msg, case when r.timed_out then 'timed out' else 'http ' || coalesce(r.status_code::text, '?') end), 300) where id = r.id;
      v_failed := v_failed + 1;
    end if;
  end loop;
  -- a 'sent' row older than 30 minutes was never settled (the job was not running): close it as failed rather than leave it open
  update suqa.wa_outbox set status = 'failed', error = coalesce(error, 'never settled') where status = 'sent' and created_at <= now() - interval '30 minutes';
  delete from suqa.wa_outbox where created_at < now() - interval '14 days';
  return jsonb_build_object('ok', v_ok, 'retried', v_again, 'failed', v_failed);
end $$;
revoke all on function suqa.wa_outbox_retry() from public, anon, authenticated;

-- ---------- the three callers, unchanged except that the post goes through _wa_post ----------
create or replace function suqa.notify_order_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_event text;
begin
  if new.channel = 'walkin' then return new; end if;
  if tg_op = 'INSERT' then v_event := 'order.created';
  elsif new.status is distinct from old.status then v_event := 'order.status';
  elsif new.driver_id is distinct from old.driver_id and new.driver_id is not null
        and new.status in ('accepted', 'preparing', 'ready', 'out_for_delivery') then v_event := 'order.driver';
  else return new; end if;

  perform suqa._wa_post(new.id, new.tenant_id,
    suqa.order_event_payload(new, v_event, case when tg_op = 'UPDATE' then old.status end)
      || jsonb_build_object('channel', new.channel)
      || case when tg_op = 'UPDATE' then jsonb_build_object('driver_changed', new.driver_id is distinct from old.driver_id) else '{}'::jsonb end);
  return new;
end $$;

create or replace function suqa._notify_order(p_order suqa.orders, p_event text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform suqa._wa_post(p_order.id, p_order.tenant_id, suqa.order_event_payload(p_order, p_event, null));
end $$;

create or replace function suqa.customer_coming(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o suqa.orders;
begin
  select * into o from suqa.orders where id = p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.fulfillment <> 'pickup' or o.channel = 'walkin' or o.status not in ('accepted', 'preparing', 'ready') then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'status', o.status);
  end if;
  if o.customer_coming_at is not null then return jsonb_build_object('ok', true, 'already', true, 'at', o.customer_coming_at); end if;
  update suqa.orders set customer_coming_at = now(), updated_at = now() where id = p_order returning * into o;
  insert into suqa.order_events (order_id, tenant_id, actor_kind, note)
  values (p_order, o.tenant_id, 'system', '🚶 ' || coalesce(nullif(o.customer_name, ''), 'الزبون') || ' — في الطريق لاستلام الطلب');
  perform suqa._wa_post(o.id, o.tenant_id, suqa.order_event_payload(o, 'order.coming', o.status) || jsonb_build_object('channel', o.channel));
  return jsonb_build_object('ok', true, 'at', o.customer_coming_at);
end $$;

-- ---------- the schedule ----------
do $$ begin
  perform cron.unschedule('suqa-wa-outbox') where exists (select 1 from cron.job where jobname = 'suqa-wa-outbox');
  perform cron.schedule('suqa-wa-outbox', '* * * * *', $c$select suqa.wa_outbox_retry()$c$);
exception when others then raise notice 'pg_cron not available here (%): events are recorded, retries are not scheduled', sqlerrm; end $$;

select 'wa outbox + retry installed' as result;
