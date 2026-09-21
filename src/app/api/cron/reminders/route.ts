import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processDueReminders } from "@/lib/reminders";

/**
 * Real scheduler entry point for Phase 4 (Step 10). Deliberately a plain,
 * idempotent HTTP endpoint rather than any in-process timer — see
 * src/lib/reminders.ts for why repeated/concurrent calls are safe.
 * vercel.json schedules Vercel Cron to call this route every 5 minutes when
 * deployed on Vercel; any other scheduler can drive it the same way — a
 * Supabase pg_cron job calling out via pg_net, a system cron + curl, or a
 * manual authorized call all work identically. In a non-Vercel deployment
 * (e.g. local dev, or another host), nothing calls this on a timer unless
 * you configure one yourself — see the Phase 4 report for details.
 *
 * Authorization is a single shared secret (CRON_SECRET), the standard
 * pattern for Vercel Cron and for hitting this from any other scheduler.
 * If CRON_SECRET isn't configured, every request is refused — fails closed,
 * never silently open.
 */
async function handleCronRequest(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Reminder scheduler is not configured (CRON_SECRET is unset)." },
      { status: 503 }
    );
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const summary = await processDueReminders(admin);
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error("Reminder cron run failed", err);
    return NextResponse.json({ error: "Reminder processing failed." }, { status: 500 });
  }
}

// Vercel Cron issues GET requests; a manual/alternate scheduler may prefer
// POST, so both are wired to the same handler.
export async function GET(request: NextRequest) {
  return handleCronRequest(request);
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request);
}
