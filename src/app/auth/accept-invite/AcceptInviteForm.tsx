"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { completeInvitation, type AuthFormState } from "@/lib/actions/auth";
import { createInviteClient } from "@/lib/supabase/client";
import { AUTHORIZED_SIGN_IN_PATH } from "@/lib/sign-in-mode";

const initialState: AuthFormState = {};

const inputClasses =
  "w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-civic-400 focus:ring-2 focus:ring-civic-100";

/** "no-invite": opened directly (e.g. from "Activate your invited
 * account →") with no invitation link and no invited session — shows how
 * activation works; there is nothing here that creates an account. */
type LinkStatus = "checking" | "ready" | "invalid" | "no-invite";

async function establishSession(): Promise<LinkStatus> {
  const supabase = createInviteClient();
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (window.location.hash) {
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }

  if (params.get("error") || params.get("error_description")) return "invalid";

  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (accessToken && refreshToken) {
    if (params.get("type") !== "invite") return "invalid";
    const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    return error ? "invalid" : "ready";
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.invited_at ? "ready" : "no-invite";
}

/** One attempt per page load, shared across effect re-runs: the first run
 * consumes (and strips) the URL fragment, so a second run — e.g. React
 * Strict Mode's dev double-invoke — must reuse its result, not re-read an
 * already-empty fragment. */
let sessionAttempt: Promise<LinkStatus> | null = null;

/**
 * Establishes the session from the invitation link, then lets the invited
 * user choose a password. Two link shapes reach this page:
 *   - Supabase's default "Invite user" template: tokens in the URL
 *     fragment (#access_token=...&type=invite), validated by setSession().
 *   - A customized template pointing at /auth/callback?token_hash=...&type=invite:
 *     the callback already verified it and set the session cookie.
 * The fragment is stripped from the address bar immediately either way.
 */
export function AcceptInviteForm() {
  const [status, setStatus] = useState<LinkStatus>("checking");
  const [state, formAction, pending] = useActionState(completeInvitation, initialState);

  useEffect(() => {
    let cancelled = false;

    if (!sessionAttempt || window.location.hash) {
      sessionAttempt = establishSession().catch(() => "invalid" as const);
    }
    sessionAttempt.then((result) => {
      if (!cancelled) setStatus(result);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "checking") {
    return (
      <div role="status" className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-white p-8 text-sm text-foreground-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Checking your invitation…
      </div>
    );
  }

  if (status === "no-invite") {
    return (
      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm text-foreground">
          Government and department accounts can&apos;t be created here. A CivicFix administrator creates
          your account and emails you an invitation.
        </p>
        <ol className="mt-4 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-foreground-muted">
          <li>Open the invitation email from your CivicFix administrator.</li>
          <li>Click the invitation link — it brings you back here to choose your password.</li>
          <li>Your dashboard opens automatically once your password is set.</li>
        </ol>
        <p className="mt-4 text-xs text-foreground-muted">
          Link expired or can&apos;t find the email? Ask your CivicFix administrator to send a new invitation.
        </p>
        <p className="mt-6 border-t border-border pt-5 text-center text-sm">
          <Link href={AUTHORIZED_SIGN_IN_PATH} className="font-semibold text-civic-700 underline-offset-2 hover:underline">
            ← Back to authorized sign in
          </Link>
        </p>
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
        <p role="alert" className="flex items-start gap-1.5 rounded-lg bg-priority-critical-bg px-3 py-2 text-sm text-priority-critical">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          This invitation link is invalid or has expired. Ask your CivicFix administrator to send a new one.
        </p>
        <Link href={AUTHORIZED_SIGN_IN_PATH} className="mt-4 inline-block text-sm font-medium text-civic-700 hover:underline">
          Already set a password? Sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4 rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">New password</span>
        <input name="password" type="password" required minLength={8} autoComplete="new-password" className={inputClasses} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Confirm password</span>
        <input name="confirmPassword" type="password" required minLength={8} autoComplete="new-password" className={inputClasses} />
      </label>
      {state.error && (
        <p role="alert" className="flex items-center gap-1.5 rounded-lg bg-priority-critical-bg px-3 py-2 text-sm text-priority-critical">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-1 inline-flex items-center justify-center gap-2 rounded-full bg-civic-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-civic-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        Set password and continue
      </button>
    </form>
  );
}
