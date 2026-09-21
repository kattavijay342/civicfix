import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

interface JurisdictionInput {
  state?: string | null;
  district?: string | null;
  constituency?: string | null;
  area?: string | null;
}

/**
 * Finds every government user whose configured jurisdiction covers the
 * given report location — the exact same null-or-match predicate as the
 * RLS function `report_in_my_jurisdiction()` (supabase/migrations/
 * 0002_rls_policies.sql), just evaluated here in application code against
 * the (small, bounded) set of government profiles instead of per-caller in
 * SQL, because a notification needs to reach potentially MULTIPLE
 * government users, not just answer "can the current caller see this one
 * report?". A government user with every gov_* field null matches
 * nothing (same as the RLS function) — never "everyone" by default.
 */
export async function findGovernmentUsersForJurisdiction(
  admin: SupabaseClient,
  location: JurisdictionInput
): Promise<string[]> {
  const { data: govUsers } = await admin
    .from("profiles")
    .select("id, gov_state, gov_district, gov_constituency, gov_area")
    .eq("role", "government");

  if (!govUsers) return [];

  return govUsers
    .filter((u) => {
      const hasAnyScope = u.gov_state || u.gov_district || u.gov_constituency || u.gov_area;
      if (!hasAnyScope) return false;
      if (u.gov_state && u.gov_state !== location.state) return false;
      if (u.gov_district && u.gov_district !== location.district) return false;
      if (u.gov_constituency && u.gov_constituency !== location.constituency) return false;
      if (u.gov_area && u.gov_area !== location.area) return false;
      return true;
    })
    .map((u) => u.id);
}
