-- CivicFix Phase 2 — Storage
--
-- The "report-media" bucket is private. There are no storage.objects RLS
-- policies here on purpose: every upload and every read goes through a
-- Next.js Server Action using the service-role client, which authorizes
-- the request in application code (does this user own/get assigned to this
-- report?) before touching Storage, then hands the browser a short-lived
-- signed URL. Nothing ever talks to this bucket directly from the browser.

insert into storage.buckets (id, name, public)
values ('report-media', 'report-media', false)
on conflict (id) do nothing;
