#!/usr/bin/env bash
# Concatenate schema files (in order) into all.sql for one-shot application.
set -euo pipefail
cd "$(dirname "$0")"
{ for f in schema/0*.sql; do echo "-- ===== $f ====="; cat "$f"; echo; done; } > all.sql
echo "wrote supabase/all.sql ($(wc -l < all.sql) lines). Apply: psql \"\$SUPABASE_DB_URL\" -f supabase/all.sql && psql ... -f supabase/seed/batroun.sql"
