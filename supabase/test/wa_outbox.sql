-- Notification outbox + retry (79). Runs in one transaction on a database built from all.sql; pg_net is replaced by a stub.
\set ON_ERROR_STOP on
begin;
create schema if not exists net;
create sequence if not exists net.req_seq;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
returns bigint language sql as $$ select nextval('net.req_seq') $$;
create table if not exists net._http_response (id bigint, status_code int, error_msg text, timed_out bool, content text, created timestamptz default now());
insert into suqa.integration_config (key, value) values ('wa_events_url', 'https://x.test/api/wa/events'), ('wa_events_secret', 's') on conflict (key) do update set value = excluded.value;
\i supabase/schema/79_wa_outbox_retry.sql

do $$
declare a bigint; b bigint; c bigint; d bigint; r jsonb; x suqa.wa_outbox; o suqa.orders; n int;
  function_old constant interval := interval '1 minute';
begin
  delete from suqa.wa_outbox;
  -- four events handed over
  perform suqa._wa_post(null, null, '{"event":"order.created","k":"arrives"}');
  perform suqa._wa_post(null, null, '{"event":"order.created","k":"tls"}');
  perform suqa._wa_post(null, null, '{"event":"order.status","k":"timeout"}');
  perform suqa._wa_post(null, null, '{"event":"order.status","k":"http500"}');
  select request_id into a from suqa.wa_outbox where body->>'k' = 'arrives';  select request_id into b from suqa.wa_outbox where body->>'k' = 'tls';
  select request_id into c from suqa.wa_outbox where body->>'k' = 'timeout';  select request_id into d from suqa.wa_outbox where body->>'k' = 'http500';
  assert (select count(*) from suqa.wa_outbox where status = 'sent' and attempts = 1 and request_id is not null) = 4, 'every event is recorded with its request';

  -- too fresh: nothing is touched
  insert into net._http_response (id, status_code, error_msg, timed_out) values (a, 200, null, false), (b, null, 'SSL peer certificate or SSH remote key was not OK', false), (c, null, 'Timeout was reached', true), (d, 500, null, false);
  r := suqa.wa_outbox_retry(); assert r = '{"ok":0,"retried":0,"failed":0}', 'fresh rows wait: ' || r;

  update suqa.wa_outbox set last_at = now() - function_old;
  r := suqa.wa_outbox_retry(); assert r = '{"ok":1,"retried":1,"failed":2}', 'first pass: ' || r;
  select * into x from suqa.wa_outbox where body->>'k' = 'arrives'; assert x.status = 'ok', 'arrived';
  select * into x from suqa.wa_outbox where body->>'k' = 'timeout'; assert x.status = 'failed' and x.attempts = 1, 'a time-out is not retried (the site may have sent it)';
  select * into x from suqa.wa_outbox where body->>'k' = 'http500'; assert x.status = 'failed' and x.attempts = 1 and x.error = 'http 500', 'an error answer is not retried';
  select * into x from suqa.wa_outbox where body->>'k' = 'tls';     assert x.status = 'sent' and x.attempts = 2 and x.request_id <> b, 'a failed connection is posted again';

  -- second try fails the same way → third try; third fails → given up, visible
  insert into net._http_response (id, status_code, error_msg, timed_out) values (x.request_id, null, 'SSL peer certificate or SSH remote key was not OK', false);
  update suqa.wa_outbox set last_at = now() - function_old where id = x.id;
  r := suqa.wa_outbox_retry(); assert r = '{"ok":0,"retried":1,"failed":0}', 'second pass: ' || r;
  select * into x from suqa.wa_outbox where body->>'k' = 'tls'; assert x.attempts = 3, 'third try';
  insert into net._http_response (id, status_code, error_msg, timed_out) values (x.request_id, null, 'SSL peer certificate or SSH remote key was not OK', false);
  update suqa.wa_outbox set last_at = now() - function_old where id = x.id;
  r := suqa.wa_outbox_retry(); assert r = '{"ok":0,"retried":0,"failed":1}', 'third pass: ' || r;
  select * into x from suqa.wa_outbox where body->>'k' = 'tls'; assert x.status = 'failed' and x.attempts = 3, 'no fourth try';

  -- the retry that works: second try answers 200
  perform suqa._wa_post(null, null, '{"event":"order.created","k":"tls-then-ok"}');
  select * into x from suqa.wa_outbox where body->>'k' = 'tls-then-ok';
  insert into net._http_response (id, status_code, error_msg, timed_out) values (x.request_id, null, 'SSL peer certificate or SSH remote key was not OK', false);
  update suqa.wa_outbox set last_at = now() - function_old where id = x.id; perform suqa.wa_outbox_retry();
  select * into x from suqa.wa_outbox where body->>'k' = 'tls-then-ok'; assert x.attempts = 2;
  insert into net._http_response (id, status_code) values (x.request_id, 200);
  update suqa.wa_outbox set last_at = now() - function_old where id = x.id; perform suqa.wa_outbox_retry();
  select * into x from suqa.wa_outbox where body->>'k' = 'tls-then-ok'; assert x.status = 'ok' and x.attempts = 2, 'delivered on the second try';

  -- the order trigger goes through the outbox, with the same payload shape as before
  select * into o from suqa.orders where channel <> 'walkin' and status = 'ready' limit 1;
  if found then
    select count(*) into n from suqa.wa_outbox where order_id = o.id;
    update suqa.orders set status = 'delivered' where id = o.id;
    select * into x from suqa.wa_outbox where order_id = o.id order by id desc limit 1;
    assert (select count(*) from suqa.wa_outbox where order_id = o.id) = n + 1 and x.event = 'order.status' and x.body->'order'->>'status' = 'delivered'
       and x.body ? 'channel' and x.body ? 'driver_changed' and x.body->>'old_status' = 'ready' and x.tenant_id = o.tenant_id and jsonb_array_length(x.body->'items') > 0, 'trigger records the status event';
    raise notice 'trigger path checked on order %', o.number;
  else raise notice 'no ready order in this database: trigger path not exercised';
  end if;

  -- app roles cannot see payloads
  assert not has_table_privilege('authenticated', 'suqa.wa_outbox', 'select') and not has_table_privilege('anon', 'suqa.wa_outbox', 'select'), 'outbox is closed to app roles';
  assert not has_function_privilege('authenticated', 'suqa.wa_outbox_retry()', 'execute') and not has_function_privilege('anon', 'suqa._wa_post(uuid,uuid,jsonb)', 'execute'), 'functions are closed to app roles';
  raise notice 'wa_outbox: all checks passed';
end $$;
rollback;
