-- 113: a fixed search path on the helper functions that had none (Supabase advisor: "function search path mutable").
--   A function without one resolves unqualified names through whatever path its caller has. None of these runs with elevated
--   rights, so this is hardening, not a hole being closed. The path given is the one API requests already use
--   (public, extensions), so nothing resolves differently.
--   Left alone ON PURPOSE — small pure helpers the planner inlines into queries and that run once per row in search, pricing and
--   status checks; a SET clause stops the inlining and would slow those down for no gain:
--     norm_text, skel_text, _digits, _phone_key, _unit_usd, _line_usd, _order_rate, order_stage, order_transition_allowed.
--   The advisor will keep listing those nine.
-- No table change. Safe to run twice.

alter function suqa._addr_remember(jsonb, jsonb, timestamptz) set search_path = public, extensions;
alter function suqa._policy(text, text, text, text, text, text) set search_path = public, extensions;
alter function suqa.order_items_fill_cents() set search_path = public, extensions;
alter function suqa.orders_fill_cents() set search_path = public, extensions;
alter function suqa.set_updated_at() set search_path = public, extensions;
alter function suqa._backup_filter(text) set search_path = public, extensions;
alter function suqa._backup_tables() set search_path = public, extensions;
alter function suqa._changed_cols(jsonb, jsonb) set search_path = public, extensions;
alter function suqa._guards_apply() set search_path = public, extensions;
alter function suqa.order_debt_cents(uuid) set search_path = public, extensions;
