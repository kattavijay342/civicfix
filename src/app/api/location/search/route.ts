import { NextResponse, type NextRequest } from "next/server";
import { performLocationSearch } from "@/lib/location/search";
import { getSessionProfile } from "@/lib/supabase/server";

/**
 * A Route Handler (not a Server Action) specifically so the browser can
 * cancel an outdated in-flight request with a real `AbortController` (see
 * LocationSearchBox) instead of only discarding a stale response after the
 * fact. Requires a signed-in session — same posture as the report form this
 * feeds — so an anonymous caller can't freely spend the app's Mapbox quota.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionProfile();
  if (!session) {
    return NextResponse.json({ status: "unavailable", reason: "Sign in to search for a location." }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get("q") ?? "";
  try {
    const outcome = await performLocationSearch(query, request.signal);
    return NextResponse.json(outcome);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // The client cancelled this request (superseded by a newer keystroke)
      // — nothing to respond with, and nothing to log as a failure.
      return new NextResponse(null, { status: 499 });
    }
    return NextResponse.json({ status: "unavailable", reason: "Location search failed unexpectedly." }, { status: 500 });
  }
}
