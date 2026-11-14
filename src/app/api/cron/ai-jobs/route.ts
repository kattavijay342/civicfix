import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AI_WORKER_POLICY, runAiWorker } from "@/lib/ai-worker";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

/**
 * AI-2 background worker entry point. Intended caller: Supabase pg_cron +
 * pg_net every 2 minutes (supabase/snippets/ai-worker-schedule.sql — NOT
 * scheduled until separately approved). Any other scheduler can call it the
 * same way.
 *
 * Authorization: `Authorization: Bearer <CRON_SECRET>`, constant-time
 * compared (src/lib/cron-auth.ts). If CRON_SECRET is unset every request
 * is refused (fails closed); anything else is a 401 with no work done.
 *
 * One run = runAiWorker with a 240s budget inside this route's 300s
 * maxDuration. Overlapping calls are safe: only the holder of the global
 * worker lease does any work; the others return `lease_held` at once.
 * Responses carry only a sanitized summary (counts/categories) — never
 * report content, error messages, keys or personal data.
 */
export const maxDuration = 300;

async function handleWorkerRequest(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "AI worker is not configured." }, { status: 503 });
  }
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const summary = await runAiWorker({
      admin: createAdminClient(),
      deadline: Date.now() + AI_WORKER_POLICY.runBudgetMs,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error("AI worker run failed", { code: err instanceof Error ? err.name : "unknown" });
    return NextResponse.json({ error: "AI worker run failed." }, { status: 500 });
  }
}

// pg_net sends POST; GET is kept for parity with the reminders route and
// manual/alternate schedulers. Both require the same secret.
export async function GET(request: NextRequest) {
  return handleWorkerRequest(request);
}

export async function POST(request: NextRequest) {
  return handleWorkerRequest(request);
}
