-- CivicFix Phase 2 — reference data seed
--
-- Departments are the application's configured routing targets (Step 7):
-- the AI only ever *recommends* one of these names; it never invents a
-- department or an official. Idempotent — safe to re-run.

insert into public.departments (name, description) values
  ('Roads & Infrastructure', 'Potholes, road damage, public infrastructure upkeep'),
  ('Sanitation', 'Garbage collection, illegal dumping, sewage'),
  ('Water Supply', 'Water leakage and supply issues'),
  ('Drainage', 'Storm drains and waterlogging'),
  ('Electrical', 'Streetlights and public electrical fixtures'),
  ('General Administration', 'Issues that do not fit a specialized department')
on conflict (name) do nothing;
