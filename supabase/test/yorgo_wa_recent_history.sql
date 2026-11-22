-- 101: WhatsApp history is the recent hours only; nothing is deleted; still the phone's own, still service role only. Rolls back.
\set ON_ERROR_STOP on
begin;
\i supabase/schema/101_yorgo_wa_recent_history.sql
\i supabase/schema/101_yorgo_wa_recent_history.sql
do $$
declare t uuid := (select id from suqa.tenants where slug = 'batroun'); c uuid := gen_random_uuid(); h jsonb;
begin
  insert into suqa.yorgo_conversations (id, tenant_id, wa_phone, mode, channel) values (c, t, '96170000009', 'shopper', 'whatsapp');
  insert into suqa.yorgo_messages (conversation_id, tenant_id, role, content, created_at) values
    (c, t, 'user',      '[{"type":"text","text":"yesterday: 4 lahme"}]', now() - interval '26 hours'),
    (c, t, 'assistant', '[{"type":"text","text":"done"}]',                now() - interval '26 hours'),
    (c, t, 'user',      '[{"type":"text","text":"lunch: khebez"}]',       now() - interval '5 hours'),
    (c, t, 'assistant', '[{"type":"text","text":"ok"}]',                  now() - interval '5 hours'),
    (c, t, 'user',      '[{"type":"text","text":"now: labne"}]',          now() - interval '10 minutes'),
    (c, t, 'assistant', '[{"type":"text","text":"tfaddal"}]',             now() - interval '9 minutes');
  h := suqa.yorgo_history_wa(c, '96170000009');                                   -- the old way of calling it: 3 hours
  assert jsonb_array_length(h) = 2 and h->0->'content'->0->>'text' = 'tfaddal' and h->1->'content'->0->>'text' = 'now: labne', 'the last 3 hours, newest first: ' || h::text;
  assert jsonb_array_length(suqa.yorgo_history_wa(c, '96170000009', 36)) = 2, 'three arguments, as the app calls it today';
  assert jsonb_array_length(suqa.yorgo_history_wa(c, '96170000009', 36, 6)) = 4, '6 hours: lunch too';
  assert jsonb_array_length(suqa.yorgo_history_wa(c, '96170000009', 36, 9999)) = 6, 'at most 72 hours: yesterday is inside that';
  assert jsonb_array_length(suqa.yorgo_history_wa(c, '96170000009', 1, 6)) = 1, 'the line limit still holds';
  assert jsonb_array_length(suqa.yorgo_history_wa(c, '96170000009', 36, 0)) = 2, 'at least one hour';
  assert jsonb_array_length(suqa.yorgo_history_wa(c, '96170000008')) = 0, 'another phone reads nothing';
  assert (select count(*) from suqa.yorgo_messages where conversation_id = c) = 6, 'nothing is deleted';
  assert not has_function_privilege('authenticated', 'suqa.yorgo_history_wa(uuid,text,int,int)', 'execute') and not has_function_privilege('anon', 'suqa.yorgo_history_wa(uuid,text,int,int)', 'execute')
     and has_function_privilege('service_role', 'suqa.yorgo_history_wa(uuid,text,int,int)', 'execute'), 'service role only';
  assert (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'suqa' and proname = 'yorgo_history_wa') = 1, 'one function, not two';
end $$;
rollback;
select 'yorgo wa recent history ok' as result;
