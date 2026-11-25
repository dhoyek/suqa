-- 112: the Data API serves only the app's schema.
--   The role `authenticator` carried pgrst.db_schemas = 'public, graphql_public, suqa' (set when the project was created). That
--   in-database setting is the one the Data API follows, so `public` — which holds nothing of ours, only the PostGIS and citext
--   extensions — was reachable from outside, including PostGIS's own table spatial_ref_sys (Supabase's "table publicly accessible"
--   warning; the table belongs to Supabase's user, so its RLS and grants cannot be changed from here).
--   Now: suqa (the app) and graphql_public (Supabase's own). Every client in the app names `suqa` explicitly.
--   To put it back: the same command with 'public, graphql_public, suqa'.
-- No table change. Safe to run twice.

alter role authenticator set pgrst.db_schemas = 'suqa, graphql_public';
notify pgrst, 'reload config';
