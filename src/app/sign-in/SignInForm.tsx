"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { AlertCircle, Loader2, MailCheck } from "lucide-react";
import { signIn, signInAuthorized, signUp, type AuthFormState } from "@/lib/actions/auth";
import { cn } from "@/lib/utils";
import { ACTIVATE_INVITE_PATH, AUTHORIZED_SIGN_IN_PATH, CITIZEN_SIGN_IN_PATH, type SignInMode } from "@/lib/sign-in-mode";

const initialState: AuthFormState = {};

const inputClasses =
  "w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-foreground placeholder:text-foreground-muted/70 outline-none transition focus:border-civic-400 focus:ring-2 focus:ring-civic-100";

interface SignInFormProps {
  /** A safe, pre-mapped message from a redirect out of
   * src/app/auth/callback/route.ts — never raw query input. */
  callbackError?: string;
  /** "authorized" = /sign-in?mode=authorized (see src/lib/sign-in-mode.ts).
   * Never grants a role: the landing page always comes from the stored
   * profile role, and authorized mode only narrows who may sign in. */
  mode?: SignInMode;
}

const linkClasses =
  "rounded font-semibold text-civic-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-civic-600";

export function SignInForm({ callbackError, mode = "citizen" }: SignInFormProps) {
  const [tab, setTab] = useState<"sign-in" | "sign-up">("sign-in");
  const [signInState, signInAction, signInPending] = useActionState(signIn, initialState);
  const [signUpState, signUpAction, signUpPending] = useActionState(signUp, initialState);
  const [authorizedState, authorizedAction, authorizedPending] = useActionState(signInAuthorized, initialState);

  const errorBanner = callbackError && (
    <p
      role="alert"
      className="mb-6 flex items-center gap-1.5 rounded-lg bg-priority-critical-bg px-3 py-2 text-sm text-priority-critical"
    >
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      {callbackError}
    </p>
  );

  // Government & Department mode: email + password only, no sign-up, no
  // role picker. Submits signInAuthorized, which only completes for a
  // stored government / department_incharge / admin role and turns a
  // citizen account away. Citizen mode below is unchanged and uses signIn.
  if (mode === "authorized") {
    return (
      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
        {errorBanner}
        <form action={authorizedAction} aria-label="Authorized government and department sign in" className="flex flex-col gap-4">
          <Field label="Email" name="email" type="email" required autoComplete="email" errorId={authorizedState.error ? "authorized-form-error" : undefined} />
          <Field label="Password" name="password" type="password" required autoComplete="current-password" errorId={authorizedState.error ? "authorized-form-error" : undefined} />
          <FormError state={authorizedState} id="authorized-form-error" />
          <SubmitButton pending={authorizedPending} label="Sign In" />
          <p className="text-center text-sm text-foreground-muted">
            Don&apos;t have an activated account?{" "}
            <Link href={ACTIVATE_INVITE_PATH} className={linkClasses}>
              Activate your invited account →
            </Link>
          </p>
          <p className="text-center text-xs text-foreground-muted">
            This sign-in is only for authorized government &amp; department users. Citizens, please use Citizen
            Sign In.
          </p>
        </form>
        <p className="mt-6 border-t border-border pt-5 text-center text-sm">
          <Link href={CITIZEN_SIGN_IN_PATH} className={linkClasses}>
            ← Back to Citizen Sign In
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
      {errorBanner}

      <div role="tablist" aria-label="Sign in or sign up" className="mb-6 flex rounded-full bg-surface-muted p-1">
        {(["sign-in", "sign-up"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`${t}-tab`}
            aria-selected={tab === t}
            aria-controls={`${t}-panel`}
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 rounded-full py-2 text-sm font-semibold transition",
              tab === t ? "bg-white text-foreground shadow-sm" : "text-foreground-muted",
            )}
          >
            {t === "sign-in" ? "Sign In" : "Citizen Sign Up"}
          </button>
        ))}
      </div>

      {tab === "sign-in" ? (
        <form
          action={signInAction}
          id="sign-in-panel"
          role="tabpanel"
          aria-labelledby="sign-in-tab"
          className="flex flex-col gap-4"
        >
          <Field label="Email" name="email" type="email" required autoComplete="email" errorId={signInState.error ? "signin-form-error" : undefined} />
          <Field label="Password" name="password" type="password" required autoComplete="current-password" errorId={signInState.error ? "signin-form-error" : undefined} />
          <FormError state={signInState} id="signin-form-error" />
          <SubmitButton pending={signInPending} label="Sign In" />
        </form>
      ) : signUpState.info ? (
        <div id="sign-up-panel" role="tabpanel" aria-labelledby="sign-up-tab" className="flex flex-col gap-4">
          <InfoMessage message={signUpState.info} />
          <button
            type="button"
            onClick={() => setTab("sign-in")}
            className="mt-1 inline-flex items-center justify-center gap-2 rounded-full bg-civic-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-civic-700"
          >
            Go to Sign In
          </button>
        </div>
      ) : (
        <form
          action={signUpAction}
          id="sign-up-panel"
          role="tabpanel"
          aria-labelledby="sign-up-tab"
          className="flex flex-col gap-4"
        >
          <p className="rounded-xl bg-civic-50 px-3.5 py-2.5 text-xs text-civic-800">
            This creates a <strong>citizen</strong> account. Government and department accounts are
            provisioned by an administrator, not through self sign-up.
          </p>
          <Field label="Full name" name="fullName" type="text" required autoComplete="name" errorId={signUpState.error ? "signup-form-error" : undefined} />
          <Field label="Mobile number" name="mobile" type="tel" required autoComplete="tel" placeholder="10-digit mobile number" errorId={signUpState.error ? "signup-form-error" : undefined} />
          <Field label="Email" name="email" type="email" required autoComplete="email" errorId={signUpState.error ? "signup-form-error" : undefined} />
          <Field
            label="Password"
            name="password"
            type="password"
            required
            autoComplete="new-password"
            minLength={8}
            errorId={signUpState.error ? "signup-form-error" : undefined}
          />
          <FormError state={signUpState} id="signup-form-error" />
          <SubmitButton pending={signUpPending} label="Create account" />
        </form>
      )}

      {/* Opens the Government & Department mode of this same page
          (/sign-in?mode=authorized). */}
      <div className="mt-6 border-t border-border pt-5 text-center text-xs text-foreground-muted">
        <p className="text-sm font-semibold text-foreground">Authorized Government &amp; Department Users</p>
        <p className="mt-2">
          Already have an account?{" "}
          <Link href={AUTHORIZED_SIGN_IN_PATH} className={linkClasses}>
            Sign in here →
          </Link>
        </p>
        <p className="mt-2">
          Use the account invited by your CivicFix administrator.
          <br />
          Your dashboard opens automatically.
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  errorId,
  ...rest
}: { label: string; name: string; errorId?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <input
        name={name}
        className={inputClasses}
        aria-invalid={!!errorId}
        aria-describedby={errorId}
        {...rest}
      />
    </label>
  );
}

function FormError({ state, id }: { state: AuthFormState; id: string }) {
  if (!state.error) return null;
  return (
    <p id={id} role="alert" className="flex items-center gap-1.5 rounded-lg bg-priority-critical-bg px-3 py-2 text-sm text-priority-critical">
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      {state.error}
    </p>
  );
}

/** Success-with-a-next-step, not a failure — deliberately styled and
 * announced differently from FormError (civic green + MailCheck icon,
 * `role="status"` rather than `role="alert"`) so it can never be mistaken
 * for something having gone wrong. */
function InfoMessage({ message }: { message: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-xl bg-civic-50 px-3.5 py-3 text-sm text-civic-800"
    >
      <MailCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function SubmitButton({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-1 inline-flex items-center justify-center gap-2 rounded-full bg-civic-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-civic-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {label}
    </button>
  );
}
