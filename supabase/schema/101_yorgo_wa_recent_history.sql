-- 101 — Yorgo on WhatsApp reads only the recent part of a phone's conversation (Dan, 22 Nov 2026).
--   A phone has ONE never-ending WhatsApp conversation. Until now every new message re-read its last 36 stored lines, however
--   old: yesterday's order was paid for again on every message (the main reason a message cost $0.06) and leaked into today's
--   ("this is the same order as before, I added nothing").
--   yorgo_history_wa now returns only lines of the last p_hours hours (default 3, between 1 and 72): long enough to go back and
--   forth on one order, short enough that lunch does not leak into dinner.
--   Nothing is deleted: the messages stay for the caps, the usage figures and the demand report. Only what Yorgo re-reads changes.
--   The old three-argument function is replaced by one with a fourth, optional argument, so today's callers keep working.
-- Idempotent. No table is changed.

drop function if exists suqa.yorgo_history_wa(uuid, text, int);
create or replace function suqa.yorgo_history_wa(p_conversation uuid, p_phone text, p_limit int default 36, p_hours int default 3) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('role', x.role, 'content', x.content) order by x.id desc), '[]'::jsonb)
    from (select m.id, m.role, m.content from suqa.yorgo_messages m join suqa.yorgo_conversations c on c.id = m.conversation_id
           where c.id = p_conversation and c.wa_phone = p_phone and c.channel = 'whatsapp'
             and m.created_at > now() - make_interval(hours => least(greatest(coalesce(p_hours, 3), 1), 72))
           order by m.id desc limit least(greatest(coalesce(p_limit, 36), 1), 120)) x
$$;
revoke all on function suqa.yorgo_history_wa(uuid, text, int, int) from public, anon, authenticated;
grant execute on function suqa.yorgo_history_wa(uuid, text, int, int) to service_role;

select 'yorgo whatsapp recent history installed' as result;
