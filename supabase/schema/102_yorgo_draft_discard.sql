-- 102 — a WhatsApp basket that was discarded (or already added to the cart) no longer comes back (Dan, 23 Nov 2026).
--   The basket page /y/<id> has "discard" (tajehol), but only the phone's screen knew. The next "zid pepsi" on WhatsApp was
--   joined to the discarded basket, and to a basket already added to the cart (so its items would be added twice).
--   Now the page tells the server: yorgo_drafts.discarded_at, set by yorgo_draft_discarded(id) — callable by whoever holds
--   the link, like yorgo_draft_added. yorgo_draft_get says "discarded" so the page shows it after a reload.
--   The server (webhook) reads added_at / discarded_at itself: a "zid" joins only a basket that is still open, and Yorgo is
--   told what became of the last one (the same note as in the app chat).
-- Idempotent. One column added; nothing deleted. The table as it stands after this script (base file 95 lists it too):
--
--   create table suqa.yorgo_drafts (
--     id              uuid primary key default gen_random_uuid(),
--     tenant_id       uuid not null references suqa.tenants(id) on delete cascade,
--     conversation_id uuid references suqa.yorgo_conversations(id) on delete set null,
--     channel         text not null default 'whatsapp' check (channel in ('whatsapp')),
--     wa_phone        text,
--     draft           jsonb not null,
--     created_at      timestamptz not null default now(),
--     expires_at      timestamptz not null default now() + interval '24 hours',
--     opened_at       timestamptz,
--     added_at        timestamptz,
--     discarded_at    timestamptz
--   );

alter table suqa.yorgo_drafts add column if not exists discarded_at timestamptz;      -- "discard" tapped on the basket page

create or replace function suqa.yorgo_draft_get(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d suqa.yorgo_drafts;
begin
  select * into d from suqa.yorgo_drafts where id = p_id and expires_at > now();
  if not found then return null; end if;
  if d.opened_at is null then update suqa.yorgo_drafts set opened_at = now() where id = p_id; end if;
  return jsonb_build_object('id', d.id, 'tenant_id', d.tenant_id, 'draft', d.draft, 'expires_at', d.expires_at,
                            'added', d.added_at is not null, 'discarded', d.discarded_at is not null);
end $$;

-- whoever holds the link may discard it (as they may mark it added). Once; a basket already added stays "added".
create or replace function suqa.yorgo_draft_discarded(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update suqa.yorgo_drafts set discarded_at = coalesce(discarded_at, now()) where id = p_id and expires_at > now() and added_at is null
$$;

revoke all on function suqa.yorgo_draft_get(uuid) from public;
revoke all on function suqa.yorgo_draft_discarded(uuid) from public;
grant execute on function suqa.yorgo_draft_get(uuid) to anon, authenticated, service_role;
grant execute on function suqa.yorgo_draft_discarded(uuid) to anon, authenticated, service_role;

select 'yorgo draft discard installed' as result;
