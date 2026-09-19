# CivicFix database migrations

Additive only — never edit a migration that has already been applied to a
live project; add a new numbered file instead.

## Applying to a new/empty Supabase project

No destructive statements are used, but there is no Supabase CLI project
link configured in this repo, so the simplest path is the SQL Editor in the
Supabase dashboard:

1. Open **SQL Editor** in your Supabase project.
2. Run `0001_init_schema.sql`, then `0002_rls_policies.sql`, then
   `0003_storage.sql`, in that order.
3. Run `../seed.sql` to insert the configured department list.

If you later install the Supabase CLI and link this project
(`supabase link --project-ref <ref>`), `supabase db push` applies the same
files in order.

## Before adding a new migration

Per project rules: inspect the current schema, identify existing tables /
foreign keys / RLS policies / triggers / data dependencies first, and never
drop tables or data. If a change looks destructive, stop and explain instead
of writing it.
