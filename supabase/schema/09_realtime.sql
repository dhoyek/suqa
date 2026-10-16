-- 09_realtime.sql — realtime change feed for the merchant portal   (2026-10-16)
-- Supabase Realtime streams only tables in the supabase_realtime publication; RLS still applies.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'suqa' and tablename = 'orders') then
    alter publication supabase_realtime add table suqa.orders;
  end if;
exception when undefined_object then
  -- local Postgres without Supabase: no publication, nothing to do
  null;
end $$;
