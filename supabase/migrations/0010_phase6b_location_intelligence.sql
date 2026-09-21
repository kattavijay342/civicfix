-- CivicFix Phase 6B — Maps & Location Intelligence
-- Additive only: one new nullable column + real CHECK constraints on
-- report_locations. No drops, no data loss, migrations 0001-0009 untouched.
--
-- Only `accuracy_meters` is added here — NOT formatted_address/postal_code/
-- municipality/etc. Those would sit permanently null since no reverse-
-- geocoding provider is configured (see src/lib/location/reverse-
-- geocoding.ts, still returns "unavailable"); adding empty columns for a
-- feature that doesn't exist yet is exactly the "unnecessary duplicate
-- columns" this migration set avoids. They belong in a future migration
-- alongside whichever real provider eventually gets configured.

-- ============================================================
-- accuracy_meters — real GPS accuracy radius, captured today from
-- navigator.geolocation's own accuracy field (src/components/report/
-- SmartLocationField.tsx) whenever a citizen uses "current location".
-- Never populated for a manual/demo location — there is no accuracy to
-- report for a value a human typed in.
-- ============================================================

alter table public.report_locations
  add column if not exists accuracy_meters double precision;

comment on column public.report_locations.accuracy_meters is
  'GPS accuracy radius in meters, only when the device actually reported one. Null for manual/demo/search-sourced locations, which have no accuracy to report.';

-- ============================================================
-- Coordinate validation at the database layer — defense in depth alongside
-- the application-level validation in src/lib/location/validation.ts.
-- Both latitude and longitude are already nullable (many reports have no
-- coordinates at all, e.g. manually-entered locations); these constraints
-- only bound the values when they ARE present. If this migration fails on
-- your project, it means an existing row already has an out-of-range
-- value — inspect it first with:
--   select id, latitude, longitude from public.report_locations
--    where (latitude is not null and (latitude < -90 or latitude > 90))
--       or (longitude is not null and (longitude < -180 or longitude > 180));
-- before deciding how to fix that row; do not blindly force this through.
-- ============================================================

alter table public.report_locations
  add constraint report_locations_latitude_range
  check (latitude is null or (latitude >= -90 and latitude <= 90));

alter table public.report_locations
  add constraint report_locations_longitude_range
  check (longitude is null or (longitude >= -180 and longitude <= 180));

alter table public.report_locations
  add constraint report_locations_accuracy_nonnegative
  check (accuracy_meters is null or accuracy_meters >= 0);
