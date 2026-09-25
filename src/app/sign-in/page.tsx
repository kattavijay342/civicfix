import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { parseSignInMode } from "@/lib/sign-in-mode";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = {
  title: "Sign In — CivicFix",
};

/** Internal codes only (set by src/app/auth/callback/route.ts) — never
 * render an arbitrary query value as a message. */
const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  missing_code: "That confirmation link looks incomplete. Please try the link from your email again.",
  confirmation_failed: "We couldn't confirm your email — the link may have expired. Try signing up again, or sign in if you've already confirmed.",
  account_not_configured: "Your account isn't set up for CivicFix access yet. Please contact your CivicFix administrator.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; mode?: string | string[] }>;
}) {
  const params = await searchParams;
  const callbackError = params.error ? CALLBACK_ERROR_MESSAGES[params.error] : undefined;
  // UI mode only — never passed to the server action or used for access.
  const mode = parseSignInMode(params.mode);

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <Link
        href="/"
        className="mb-8 inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to home
      </Link>

      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {mode === "authorized" ? "Authorized Government & Department Users" : "Welcome to CivicFix"}
        </h1>
        <p className="mt-1.5 text-sm text-foreground-muted">
          {mode === "authorized"
            ? "Use the account invited by your CivicFix administrator."
            : "Sign in to report issues and track resolutions."}
        </p>
      </div>

      <SignInForm key={mode} mode={mode} callbackError={callbackError} />
    </div>
  );
}
